import type { IpcMain, WebContents } from 'electron';
import type { FileService } from './fileService';
import { readFilePreview } from './filePreview';

export function registerFilePreviewIpc(ipc: Pick<IpcMain, 'handle'>, editor: Pick<WebContents, 'id' | 'mainFrame'>, files: FileService): string[] {
  const channel = 'fs:read-file-preview';
  ipc.handle(channel, (event, relPath: unknown, root: unknown) => {
    if (event.sender.id !== editor.id || event.senderFrame !== editor.mainFrame) return { ok: false, error: '此操作仅供本地编辑器主页面使用' };
    if (typeof relPath !== 'string' || typeof root !== 'string') return { ok: false, error: '参数不合法' };
    return readFilePreview(files, relPath, root);
  });
  return [channel];
}
