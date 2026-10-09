/** 编辑器只查询和打开更新窗口；更新动作只接受专用窗口主 frame 的无参数请求。 */
import type { IpcMain, WebContents } from 'electron';
import { CHANNELS } from '../shared/contract';
import type { ApplicationUpdater } from './appUpdater';

export function registerApplicationUpdateIpc(ipc: Pick<IpcMain, 'handle'>, options: { editor: WebContents;
  dialog: () => WebContents | null; updater: Pick<ApplicationUpdater, 'getState' | 'check' | 'download' | 'install'>;
  open: () => Promise<void>; close: () => void }): string[] {
  const updater = options.updater;
  const actions = [
    [CHANNELS.getUpdateState, null],
    [CHANNELS.checkForUpdate, () => updater.check()],
    [CHANNELS.downloadUpdate, () => updater.download()],
    [CHANNELS.installUpdate, () => updater.install()],
  ] as const;
  for (const [channel, action] of actions) {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      const allowed = channel === CHANNELS.getUpdateState ? [options.editor, options.dialog()] : [options.dialog()];
      if (!allowed.some(view => view && event.sender === view && event.senderFrame === view.mainFrame)) throw new Error('更新操作仅供指定本地界面主 frame 使用。');
      if (args.length !== 0) throw new Error('更新操作不接受参数。');
      if (action) await action();
      return updater.getState();
    });
  }
  for (const [channel, owner, action] of [
    [CHANNELS.openUpdatePanel, () => options.editor, options.open],
    [CHANNELS.closeUpdatePanel, options.dialog, options.close],
  ] as const) {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      const view = owner();
      if (!view || event.sender !== view || event.senderFrame !== view.mainFrame) throw new Error('更新窗口操作仅供指定本地界面主 frame 使用。');
      if (args.length !== 0) throw new Error('更新窗口操作不接受参数。');
      return action();
    });
  }
  return [...actions.map(([channel]) => channel), CHANNELS.openUpdatePanel, CHANNELS.closeUpdatePanel];
}
