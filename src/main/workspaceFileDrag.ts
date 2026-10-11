/** 用户目录树拖拽的原生运输，接收方自行处理附件，不写官网或发送消息。 */
import type { IpcMain, NativeImage, WebContents } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CHANNELS } from '../shared/contract';
import type { FileService } from './fileService';

export function registerWorkspaceFileDrag(ipc: Pick<IpcMain, 'handle'>, editor: WebContents, files: FileService,
  iconForFile: (file: string) => Promise<NativeImage>): string[] {
  let dragging = false;
  ipc.handle(CHANNELS.startWorkspaceFileDrag, async (event, relative: unknown, root: unknown) => {
    if (event.sender !== editor || event.senderFrame !== editor.mainFrame) return { ok: false, error: '拖拽仅供本地编辑器主页面使用' };
    if (typeof root !== 'string' || root !== files.getRoot()) return { ok: false, error: '项目已切换，请重新拖拽' };
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative))
      return { ok: false, error: '拖拽路径无效' };
    if (dragging) return { ok: false, error: '已有文件拖拽正在处理' };
    dragging = true;
    try {
      const target = await files.resolveSafePath(relative);
      if (!target.ok) return target;
      const before = await fs.lstat(target.absolute);
      if (!before.isFile() || before.isSymbolicLink()) return { ok: false, error: '只能拖拽普通文件，不能拖拽文件夹或链接' };
      const absolute = await fs.realpath(target.absolute);
      const icon = await iconForFile(absolute);
      if (icon.isEmpty()) return { ok: false, error: '无法取得文件拖拽图标，请重新拖拽' };
      const current = await files.resolveSafePath(relative);
      if (!current.ok) return current;
      const after = await fs.lstat(current.absolute);
      const real = await fs.realpath(current.absolute);
      if (real !== absolute || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]) ||
        !after.isFile() || after.isSymbolicLink()) return { ok: false, error: '文件已变化，请重新拖拽' };
      if (!files.isCurrentRoot(target.rootRevision) || current.rootRevision !== target.rootRevision || editor.isDestroyed())
        return { ok: false, error: '项目或窗口已变化，拖拽已取消' };
      editor.startDrag({ file: absolute, icon });
      return { ok: true };
    } catch (error) { return { ok: false, error: '无法拖拽文件：' + (error instanceof Error ? error.message : String(error)) }; }
    finally { dragging = false; }
  });
  return [CHANNELS.startWorkspaceFileDrag];
}
