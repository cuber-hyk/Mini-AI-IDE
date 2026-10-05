/** 更新网络与安装器仅存在于主进程，网页和编辑器无更新 IPC。 */
import { app, dialog, type BaseWindow, type MenuItemConstructorOptions } from 'electron';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { releaseNotesText, UpdateService, updateDisabledReason, type UpdateBackend, type UpdatePresenter } from './updateService';
import { launchUpdateInstaller } from './updateInstaller';

export interface ApplicationUpdater {
  readonly installing: boolean;
  menuItems(): MenuItemConstructorOptions[];
  start(): void;
  dispose(): void;
}

export function createApplicationUpdater(options: { window: BaseWindow; approveInstall: () => Promise<boolean>;
  onStateChanged: () => void; disabled: boolean }): ApplicationUpdater {
  const window = options.window;
  // electron-builder v26 的 NSIS common.nsh / installer.nsh 将卸载器写入 $INSTDIR。
  // app.isPackaged 也包括 win-unpacked，所以单独判断安装目录中的卸载器。
  let installed = false;
  try { installed = statSync(join(dirname(process.execPath), 'Uninstall Mini-AI-IDE.exe')).isFile(); } catch { /* 未安装 */ }
  const disabledReason = updateDisabledReason({ packaged: app.isPackaged, platform: process.platform,
    disabled: options.disabled, portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE), installed });
  let disposed = false;
  let updater: import('electron-updater').AppUpdater | null = null;
  let cancellation: import('electron-updater').CancellationToken | null = null;
  let installerPath: string | null = null;

  const show = async (settings: Electron.MessageBoxOptions): Promise<number> => {
    if (disposed || window.isDestroyed()) return 1;
    return (await dialog.showMessageBox(window, { noLink: true, ...settings })).response;
  };
  const presenter: UpdatePresenter = {
    available: async info => await show({ type: 'info', title: '发现新版本',
      message: `Mini-AI-IDE ${info.version} 已发布`, detail: `当前版本：${app.getVersion()}\n\n${info.notes || '此版本暂无更新说明。'}`,
      buttons: ['下载更新', '稍后'], defaultId: 1, cancelId: 1 }) === 0,
    downloaded: async info => await show({ type: 'info', title: '更新已下载', message: `Mini-AI-IDE ${info.version} 已准备好安装`,
      detail: '重启前会确认未保存的文件。安装向导将更新当前应用，用户设置和网页登录数据会保留。',
      buttons: ['重启并安装', '稍后'], defaultId: 1, cancelId: 1 }) === 0,
    current: async () => { await show({ type: 'info', title: '检查更新', message: `当前版本 ${app.getVersion()} 已是最新版本。`, buttons: ['确定'] }); },
    error: async message => { await show({ type: 'error', title: '更新失败', message, buttons: ['确定'] }); },
    unsupported: async reason => { await show({ type: 'info', title: '检查更新', message: reason, buttons: ['确定'] }); },
  };
  const onProgress = (progress: { percent: number }) => service.progress(progress.percent);
  const ignoreLateError = () => {};
  const resetUpdater = () => {
    if (!updater) return;
    updater.removeListener('download-progress', onProgress);
    updater = null;
    cancellation = null;
    installerPath = null;
  };
  const backend: UpdateBackend = {
    check: async () => {
      installerPath = null;
      if (!updater) {
        // 延迟加载，开发/Portable/探针不创建 updater，也不会注册退出安装 hook。
        const library = await import('electron-updater');
        if (disposed) return null;
        updater = new library.NsisUpdater();
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        updater.allowPrerelease = false;
        updater.allowDowngrade = false;
        updater.disableWebInstaller = true;
        updater.on('download-progress', onProgress);
        // 查询和下载的错误由 Promise 接收；关闭后 late error 也不会成为未处理事件。
        updater.on('error', ignoreLateError);
      }
      if (disposed) return null;
      const result = await updater.checkForUpdates();
      if (disposed) { result?.cancellationToken?.cancel(); return null; }
      cancellation = result?.cancellationToken ?? null;
      return result?.isUpdateAvailable ? { version: result.updateInfo.version, notes: releaseNotesText(result.updateInfo.releaseNotes) } : null;
    },
    download: async () => {
      if (!updater) throw new Error('更新检查尚未完成。');
      installerPath = null;
      cancellation = new (await import('electron-updater')).CancellationToken();
      if (disposed) { cancellation.cancel(); return; }
      const paths = await updater.downloadUpdate(cancellation);
      if (disposed) return;
      const executable = paths[0];
      if (paths.length !== 1 || !executable || !isAbsolute(executable) || !executable.toLowerCase().endsWith('.exe')) {
        throw new Error('更新文件必须是已校验的 NSIS 完整安装器。');
      }
      installerPath = executable;
    },
    install: async () => {
      if (!installerPath || disposed) throw new Error('更新安装器未准备好。');
      try {
        await launchUpdateInstaller({ installerPath, installDirectory: dirname(process.execPath) });
      } catch (error) { installerPath = null; throw error; }
    },
    quit: () => { if (!disposed && !window.isDestroyed()) app.quit(); },
    dispose: () => {
      cancellation?.cancel();
      resetUpdater();
      // 已在途的请求仍可能触发 error；保留吞掉 late error 的监听器，避免 EventEmitter 抛出。
      // 旧实例的监听器不捕获 window/service，完成在途请求后可回收。
    },
  };
  const service = new UpdateService(backend, presenter, options.approveInstall, state => {
    if (disposed || window.isDestroyed()) return;
    window.setProgressBar(state.status === 'downloading' ? state.percent / 100 : -1);
    options.onStateChanged();
  }, disabledReason);

  return {
    get installing() { return !disposed && service.current.status === 'installing'; },
    menuItems: () => {
      const state = service.current;
      const idle = !state.busy && !['ready', 'confirming', 'installing', 'downloading'].includes(state.status);
      const items: MenuItemConstructorOptions[] = [{ label: `当前版本：${app.getVersion()}`, enabled: false },
        { label: state.status === 'checking' ? '正在检查更新…' : '检查更新…',
        enabled: !disposed && idle, click: () => { void service.check(); } }];
      if (state.release) {
        if (state.status === 'downloading') items.push({ label: `正在下载 ${state.release.version}：${state.percent}%`, enabled: false });
        else if (['ready', 'confirming', 'installing'].includes(state.status)) items.push({
          label: state.status === 'installing' ? '正在启动安装…' : `重启并安装 ${state.release.version}…`,
          enabled: !disposed && !state.busy && state.status === 'ready', click: () => { void service.install(); } });
        else items.push({ label: `${state.status === 'error' ? '重试下载' : '下载'}更新 ${state.release.version}…`,
          enabled: !disposed && !state.busy, click: () => { void service.download(); } });
      }
      return items;
    },
    start: () => service.start(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      service.dispose();
      if (!window.isDestroyed()) window.setProgressBar(-1);
    },
  };
}
