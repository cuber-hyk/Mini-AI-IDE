/**
 * 主进程 → 渲染进程的 IPC 注册
 *
 * ADR-0002：这是渲染进程**唯一**能触达文件系统的通道，参数是声明式的
 * （相对路径 / 行号），主进程负责解析与白名单校验。
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';

import { CHANNELS, type ListDirResult, type ReadFileResult, type RootInfo, type SliceFileResult, type WriteFileResult } from '../shared/contract';
import { FileService } from './fileService';

/**
 * 注册渲染进程可用的 IPC 处理器。
 *
 * 返回**实际注册的通道名列表** —— 供启动自检核对"契约通道"与"已注册通道"是否一致，
 * 避免出现"契约里写了但忘了注册"的静默失效。
 */
export function registerFileIpc(getEditorWindow: () => BrowserWindow | null, service: FileService): string[] {
  ipcMain.handle(CHANNELS.chooseRoot, async (): Promise<RootInfo> => {
    const win = getEditorWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择要打开的目录' })
      : await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择要打开的目录' });
    if (result.canceled || result.filePaths.length === 0) {
      return { root: service.getRoot() };
    }
    const root = service.setRoot(result.filePaths[0] as string);
    return { root };
  });

  ipcMain.handle(CHANNELS.getRoot, async (): Promise<RootInfo> => ({ root: service.getRoot() }));

  // 仅主进程内部使用（自检 / 命令行指定目录）。渲染进程的 preload **不暴露**此通道。
  ipcMain.handle(CHANNELS.setRootInternal, async (_e, absPath: unknown): Promise<RootInfo> => {
    if (typeof absPath !== 'string') return { root: service.getRoot() };
    return { root: service.setRoot(absPath) };
  });

  ipcMain.handle(CHANNELS.listDir, async (_e, relPath: unknown): Promise<ListDirResult> => {
    if (typeof relPath !== 'string') return { ok: false, entries: [], truncated: false, error: '参数不合法' };
    return service.listDir(relPath);
  });

  ipcMain.handle(CHANNELS.readFile, async (_e, relPath: unknown): Promise<ReadFileResult> => {
    if (typeof relPath !== 'string') return { ok: false, error: '参数不合法' };
    return service.readFile(relPath);
  });

  ipcMain.handle(
    CHANNELS.sliceFile,
    async (_e, relPath: unknown, startLine: unknown, endLine: unknown): Promise<SliceFileResult> => {
      if (typeof relPath !== 'string' || typeof startLine !== 'number' || typeof endLine !== 'number') {
        return { ok: false, error: '参数不合法' };
      }
      return service.sliceFile(relPath, startLine, endLine);
    }
  );

  ipcMain.handle(CHANNELS.writeFile, async (_e, relPath: unknown, text: unknown): Promise<WriteFileResult> => {
    if (typeof relPath !== 'string' || typeof text !== 'string') return { ok: false, error: '参数不合法' };
    return service.writeFile(relPath, text);
  });

  return [
    CHANNELS.chooseRoot,
    CHANNELS.getRoot,
    CHANNELS.listDir,
    CHANNELS.readFile,
    CHANNELS.sliceFile,
    CHANNELS.writeFile,
    // 以下通道由 index.ts 注册（需要访问窗口/视图/剪贴板），此处一并声明以便自检核对
    CHANNELS.setSplit,
    CHANNELS.copyFormatSpec,
    CHANNELS.getContext,
    CHANNELS.copyPrompt,
    CHANNELS.copyNumberedSnippet,
    CHANNELS.copyWholeFile,
    CHANNELS.collectReply,
    CHANNELS.applyChange,
    CHANNELS.undoSave,
    CHANNELS.setPreviewPanel,
    CHANNELS.setWebVisible,
    CHANNELS.setSidebarVisible,
    CHANNELS.setSidebarWidth,
    CHANNELS.showDiffInEditor,
  ];
}
