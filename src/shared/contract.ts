/**
 * 跨进程契约（主进程 / preload / 渲染进程共用）
 *
 * 设计约束（ADR-0002）：IPC 只暴露**窄接口** —— 声明式参数，不接受任意表达式，
 * 也不接受任意路径。渲染进程没有任何直接的文件系统能力。
 */
import type { TextMeta } from './limits';

export const CHANNELS = {
  /** 渲染进程请求系统目录选择对话框（唯一取得路径的合法入口） */
  chooseRoot: 'fs:choose-root',
  /** 查询当前已打开的根目录 */
  getRoot: 'fs:get-root',
  /** 设置根目录（仅供主进程内部/自检使用，渲染进程不暴露此能力） */
  setRootInternal: 'fs:set-root-internal',
  /** 列出某个目录（路径必须落在已打开的根目录内） */
  listDir: 'fs:list-dir',
  /** 读取文件内容（返回纯文本 + 元信息） */
  readFile: 'fs:read-file',
  /** 分片读取（超限时由用户确认后调用） */
  sliceFile: 'fs:slice-file',
  /** 写回文件（编辑后保存） */
  writeFile: 'fs:write-file',
  /** 调整左右分栏比例（拖动分隔条时由编辑器渲染进程上报） */
  setSplit: 'ui:set-split',
  /** 把"输出格式要求"模板写入系统剪贴板（**由用户自己粘贴到提示词**，程序绝不注入） */
  copyFormatSpec: 'ui:copy-format-spec',
  /** 组装完整 prompt（需求 + 环境上下文 + 格式要求）并写入剪贴板；仍由用户自己粘贴 */
  copyPrompt: 'ui:copy-prompt',
  /** 取"工作环境摘要"（绝对路径 + 目录树 + 运行环境），供界面预览 */
  getContext: 'ui:get-context',
  /** 把编辑器里的选中内容格式化为"带文件真实行号"的片段并写入剪贴板 */
  copyNumberedSnippet: 'ui:copy-numbered-snippet',
  /** 主进程 → 渲染进程：记忆的根目录已失效 */
  rootStale: 'fs:root-stale',
  /** 主进程 → 渲染进程：根目录已变更 */
  rootChanged: 'fs:root-changed',
} as const;

export interface DirEntry {
  name: string;
  /** 相对根目录的路径（用 / 分隔） */
  relPath: string;
  isDirectory: boolean;
  /** 目录为 null */
  textLike: boolean | null;
}

export interface ListDirResult {
  ok: boolean;
  entries: DirEntry[];
  truncated: boolean;
  error?: string;
}

export interface ReadFileResult {
  ok: boolean;
  /** 相对根目录的路径 */
  relPath?: string;
  text?: string;
  encoding?: string;
  fellBack?: boolean;
  meta?: TextMeta;
  /** 超限时只返回元信息，text 为空 */
  tooLarge?: boolean;
  limit?: number;
  error?: string;
}

export interface SliceFileResult {
  ok: boolean;
  text?: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  error?: string;
}

export interface WriteFileResult {
  ok: boolean;
  relPath?: string;
  byteLength?: number;
  error?: string;
}

export interface RootInfo {
  /** 用户可见的根目录绝对路径（仅用于界面显示） */
  root: string | null;
  /** 是否来自"上次打开"的记忆（用于界面提示与失效告知） */
  restored?: boolean;
  /** 记忆的目录已不存在（已被删除/移动） */
  stale?: boolean;
}

export interface SplitResult {
  /** 主进程实际采用的编辑器宽度（已被最小宽度约束收敛） */
  editorWidth: number;
}

export interface CopyFormatResult {
  ok: boolean;
  /** 写入剪贴板的字符数 */
  length: number;
  error?: string;
}

export interface ContextSummary {
  root: string | null;
  environment: string;
  /** 目录树摘要（多行文本） */
  tree: string | null;
  /** 目录树是否被截断 */
  treeTruncated: boolean;
}

export interface CopyPromptResult {
  ok: boolean;
  /** 写入剪贴板的 prompt 全文（便于界面回显与自查） */
  prompt: string;
  length: number;
  error?: string;
}

export interface NumberedSnippetInput {
  /** 相对根目录的文件路径 */
  relPath: string;
  /** 片段内容（不含行号） */
  text: string;
  /** 片段第一行在文件中的真实行号（1 起） */
  startLine: number;
}

export interface CopySnippetResult {
  ok: boolean;
  /** 写入剪贴板的内容（含 `### 文件：` 与 `### 范围：` 头） */
  snippet: string;
  length: number;
  startLine?: number;
  endLine?: number;
  error?: string;
}

/** preload 通过 contextBridge 暴露给渲染进程的唯一接口面 */
export interface EditorBridge {
  chooseRoot(): Promise<RootInfo>;
  getRoot(): Promise<RootInfo>;
  listDir(relPath: string): Promise<ListDirResult>;
  readFile(relPath: string): Promise<ReadFileResult>;
  sliceFile(relPath: string, startLine: number, endLine: number): Promise<SliceFileResult>;
  writeFile(relPath: string, text: string): Promise<WriteFileResult>;
  /** 上报期望的编辑器宽度（像素）；主进程会做最小宽度约束并回传实际值 */
  setSplit(editorWidth: number): Promise<SplitResult>;
  /**
   * 请求把"输出格式要求"模板写入系统剪贴板。
   * **程序不会把它送进输入框**——需要用户自己粘贴到提示词里（零注入边界，见 ADR-0003）。
   */
  copyFormatSpec(): Promise<CopyFormatResult>;
  /** 取工作环境摘要（当前目录 + 目录树 + 运行环境），用于界面预览 */
  getContext(): Promise<ContextSummary>;
  /**
   * 组装完整 prompt 并写入剪贴板。
   * 仍**只写剪贴板**：由用户自己 Ctrl+V 到网页输入框（零注入边界）。
   */
  copyPrompt(requirement: string, targetFiles: string[]): Promise<CopyPromptResult>;
  /**
   * 把选中内容格式化为"带文件真实行号"的片段（附 `### 文件：` 与 `### 范围：` 头）写入剪贴板。
   * 用于**局部修改**：模型据此回显行区间，应用前会做三向校验。
   */
  copyNumberedSnippet(input: NumberedSnippetInput): Promise<CopySnippetResult>;
  onRootChanged(listener: (info: RootInfo) => void): void;
  /** 记忆的根目录已失效（被删除/移动）时的通知 */
  onRootStale(listener: (info: RootInfo) => void): void;
}

declare global {
  interface Window {
    /** 由 preload 注入；除此外渲染进程不得假设任何能力 */
    editorBridge: EditorBridge;
  }
}
