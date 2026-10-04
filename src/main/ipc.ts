/**
 * 主进程 → 渲染进程的 IPC 注册
 *
 * ADR-0002：这是渲染进程**唯一**能触达文件系统的通道，参数是声明式的
 * （相对路径 / 行号），主进程负责解析与白名单校验。
 */
import { ipcMain } from 'electron';

import { CHANNELS, type ListDirResult, type ReadFileResult, type RootInfo, type SliceFileResult, type WriteFileResult } from '../shared/contract';
import { FileService } from './fileService';

/**
 * 注册渲染进程可用的 IPC 处理器。
 *
 * 返回**实际注册的通道名列表** —— 供启动自检核对"契约通道"与"已注册通道"是否一致，
 * 避免出现"契约里写了但忘了注册"的静默失效。
 */
export function registerFileIpc(service: FileService,
  workspace: { chooseRoot(): Promise<RootInfo>; getState(): RootInfo; write(relPath: string, text: string): Promise<WriteFileResult> }): string[] {
  ipcMain.handle(CHANNELS.chooseRoot, () => workspace.chooseRoot());

  ipcMain.handle(CHANNELS.getRoot, async (): Promise<RootInfo> => workspace.getState());

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

  ipcMain.handle(CHANNELS.writeFile, async (_e, relPath: unknown, text: unknown, root: unknown): Promise<WriteFileResult> => {
    if (typeof relPath !== 'string' || typeof text !== 'string') return { ok: false, error: '参数不合法' };
    if (typeof root !== 'string' || root !== service.getRoot()) return { ok: false, error: '目录已切换，请重新保存' };
    return workspace.write(relPath, text);
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
    // 「上一个 / 下一个」跳转：渲染进程 → 主进程（要读批次缓存并驱动编辑器视图）
    CHANNELS.stepDiff,
    // 提示词编辑面板（独立渲染进程）：读状态 / 保存 / 恢复默认 / 关闭 / 打开
    CHANNELS.promptPanelState,
    CHANNELS.savePromptSpec,
    CHANNELS.resetPromptSpec,
    CHANNELS.closePromptPanel,
    CHANNELS.openPromptPanel,
    // 提示词版本开关（底部双段开关的状态读写）
    CHANNELS.getPromptStatus,
    CHANNELS.getFormatSpecVariant,
    CHANNELS.setFormatSpecVariant,
  ];
  /*
   * ⚠️ 这份清单必须与 `index.ts` 里实际的 `ipcMain.handle` 保持同步。
   *
   * 为什么不能靠"运行时反射 ipcMain"：Electron 没有公开的已注册通道查询接口。
   * 之前这份清单漏了 `stepDiff`，自检 E1 就会误报"通道未注册"——
   * 而实际上 `index.ts` 早就注册了它。**断言失败时先分清是"实现缺了"还是"清单漂了"**，
   * 否则会去改本来正确的业务代码。
   *
   * 下面这几个是**单向通道**（主进程 → 渲染进程），故意不在此列，
   * 它们由 selfTest.ts 的 `oneWayChannels` 排除：
   *   - chromeState  （→ webbar，网页/预览可见状态）
   *   - activeDiff   （→ preview面板，当前正在预览第几个变更）
   *   - fileChanged  （→ editor，落盘后广播，编辑器据此重读）
   *   - openPromptPanel（→ editor，请求打开提示词面板；面板本体是独立视图）
   *   - diffData / sidebarChanged / previewData / rootChanged / rootStale
   */
}
