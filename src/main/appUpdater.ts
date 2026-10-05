/** 更新网络与安装器仅存在于主进程，编辑器只接收状态和显式操作。 */
import { app, type BaseWindow, type MenuItemConstructorOptions } from 'electron';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { releaseNotesText, UpdateService, updateDisabledReason, type UpdateBackend } from './updateService';
import type { ApplicationUpdateState } from '../shared/applicationUpdate';
import { launchUpdateInstaller } from './updateInstaller';

export interface ApplicationUpdater {
  readonly installing: boolean;
  getState(): ApplicationUpdateState;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
  menuItems(): MenuItemConstructorOptions[];
  start(): void;
  dispose(): void;
}

export function createApplicationUpdater(options: { window: BaseWindow; approveInstall: () => Promise<boolean>;
  onStateChanged: (state: ApplicationUpdateState) => void; onOpenPanel: () => void; disabled: boolean }): ApplicationUpdater {
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
  const service = new UpdateService(backend, options.approveInstall, state => {
    if (disposed || window.isDestroyed()) return;
    window.setProgressBar(state.status === 'downloading' ? state.percent / 100 : -1);
    options.onStateChanged({ ...state, currentVersion: app.getVersion(), disabledReason });
  }, disabledReason);

  return {
    get installing() { return !disposed && service.current.status === 'installing'; },
    getState: () => ({ ...service.current, currentVersion: app.getVersion(), disabledReason }),
    check: () => service.check(),
    download: () => service.download(),
    install: () => service.install(),
    menuItems: () => [{ label: `当前版本：${app.getVersion()}`, enabled: false },
      { label: '软件更新…', enabled: !disposed, click: () => options.onOpenPanel() }],
    start: () => service.start(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      service.dispose();
      if (!window.isDestroyed()) window.setProgressBar(-1);
    },
  };
}
