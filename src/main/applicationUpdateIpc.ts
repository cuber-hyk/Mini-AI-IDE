/** 更新动作仅接受本地编辑器主frame的无参数请求，不提供路径或URL入口。 */
import type { IpcMain, WebContents } from 'electron';
import { CHANNELS } from '../shared/contract';
import type { ApplicationUpdater } from './appUpdater';

export function registerApplicationUpdateIpc(ipc: Pick<IpcMain, 'handle'>, editor: WebContents,
  updater: Pick<ApplicationUpdater, 'getState' | 'check' | 'download' | 'install'>): string[] {
  const actions = [
    [CHANNELS.getUpdateState, null],
    [CHANNELS.checkForUpdate, () => updater.check()],
    [CHANNELS.downloadUpdate, () => updater.download()],
    [CHANNELS.installUpdate, () => updater.install()],
  ] as const;
  for (const [channel, action] of actions) {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (event.sender !== editor || event.senderFrame !== editor.mainFrame) throw new Error('更新操作仅供本地编辑器使用。');
      if (args.length !== 0) throw new Error('更新操作不接受参数。');
      if (action) await action();
      return updater.getState();
    });
  }
  return actions.map(([channel]) => channel);
}
