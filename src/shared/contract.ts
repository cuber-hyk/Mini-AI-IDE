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
  /** 把当前打开的**整个文件**（含路径声明与代码围栏）写入剪贴板，作为上下文交给模型 */
  copyWholeFile: 'ui:copy-whole-file',
  /** 从网页视图**只读**采集最新回复并解析为待应用变更（返回预览，不落盘） */
  collectReply: 'return:collect',
  /** 应用一个已选定的变更（先做三向校验；落盘前保留撤销快照） */
  applyChange: 'return:apply',
  /** 撤销一次应用（按快照恢复） */
  undoSave: 'return:undo',
  /** 显示/隐藏右下角回程预览面板并设置高度 */
  setPreviewPanel: 'ui:set-preview-panel',
  /** 主进程 → 右下角预览面板：推送待预览数据 */
  previewData: 'preview:data',
  /** 显示/隐藏右侧 AI 网页视图 */
  setWebVisible: 'ui:set-web-visible',
  /** 显示/隐藏左侧目录树（文件）面板 */
  setSidebarVisible: 'ui:set-sidebar-visible',
  /** 调整左侧目录树宽度（像素） */
  setSidebarWidth: 'ui:set-sidebar-width',
  /** 编辑器 → 主进程：请求在**编辑器内**显示某个变更的 diff */
  showDiffInEditor: 'ui:show-diff-in-editor',
  /** 主进程 → 编辑器：指示进入/退出 diff 视图 */
  diffData: 'editor:diff-data',
  /** 主进程 → 编辑器：目录树可见性/宽度变化 */
  sidebarChanged: 'ui:sidebar-changed',
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

export interface CopyWholeFileResult {
  ok: boolean;
  /** 写入剪贴板的内容（`这个文件是 <路径>` + 代码围栏 + 全文） */
  snippet: string;
  length: number;
  relPath?: string;
  lineCount?: number;
  /** 使用的围栏（内容含反引号时会自动加长） */
  fence?: string;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * 回程：采集 → 解析 → 预览 → 应用
 * ------------------------------------------------------------------ */

/** 预览里的一个变更块（由解析结果 + 文件读取结果组成，不含文件内容） */
export interface ReturnPreviewBlock {
  /** 在本次采集结果中的序号 */
  index: number;
  /** 目标文件（相对根目录）；null 表示未确定，需要用户指定 */
  filePath: string | null;
  /** 路径线索来源 */
  pathSource: 'fence-comment' | 'preceding-heading' | 'unique-mention' | 'none';
  /** 片段行区间；null 表示整文件替换 */
  range: { start: number; end: number } | null;
  /** 代码块行数 */
  codeLines: number;
  /** 代码块字符数 */
  codeChars: number;
  /**
   * 行号预览：代码块前若干行，行号是**应用后会落在文件里的真实行号**。
   * 用途：让用户在落盘前核对"这段代码是不是我复制的那段、行号对不对"。
   */
  firstLines: Array<{ lineNo: number; text: string }>;
  /** 是否还有未展示的行 */
  moreLines: number;
  /**
   * 逐行差异（与主流编辑器一致的 hunk 形式）。
   * 由主进程用 `computeApply` 算出"应用后的完整文本"再与原文对比得到；
   * **三向校验不通过时为 null**，且该块会被标为阻塞（不给用户"可以应用"的错觉）。
   */
  diff: {
    hunks: Array<{
      oldStart: number;
      newStart: number;
      added: number;
      removed: number;
      lines: Array<{
        kind: 'context' | 'add' | 'del';
        oldLine: number | null;
        newLine: number | null;
        text: string;
      }>;
    }>;
    added: number;
    removed: number;
    oldLineCount: number;
    newLineCount: number;
    identical: boolean;
  } | null;
  /** 目标文件是否存在 */
  fileExists: boolean;
  /** 目标文件当前行数（不存在时为 null） */
  fileLines: number | null;
  /** 该变更能否自动应用（false 时附 reason） */
  applicable: boolean;
  /** 不能应用的原因 */
  blockedReason?: string;
  /** 提示（例如"路径来自弱线索，请核对"） */
  hints: string[];
}

export interface ReturnPreview {
  ok: boolean;
  /** 本次采集的批次号：`applyChange` 用它引用主进程缓存的代码，避免渲染进程转手大块文本 */
  collectionId: string;
  /** 采集用的策略 id（诊断用） */
  strategyId: string | null;
  strategyDescription: string | null;
  /** 采集到的候选条数（策略返回了几段文本） */
  attempts: Array<{ strategyId: string; description: string; ok: boolean; length: number; error?: string }>;
  /** 采集到的回复原文（完整保留，便于人工兜底） */
  replyText: string;
  /** 解析备注 */
  notes: string[];
  blocks: ReturnPreviewBlock[];
  /** 采集失败时的页面结构诊断（只读探测结果，便于判断是选择器过期还是页面没输出） */
  diagnostic?: {
    url: string;
    title: string;
    counts: Record<string, number>;
    bodyTextLength: number;
    bodyHasFence: boolean;
  };
  error?: string;
}

export interface ApplyChangeInput {
  /** 采集批次号 */
  collectionId: string;
  /** 代码块序号 */
  index: number;
  /** 用户在预览里确认/修改后的目标文件路径（相对根目录） */
  filePath: string;
}

export interface ApplyChangeResult {
  ok: boolean;
  filePath?: string;
  mode?: string;
  /** 变更前的完整原文（撤销用；已存快照） */
  before?: string;
  after?: string;
  error?: string | undefined;
  /** 校验失败原因（与 computeApply 的 reason 一致） */
  reason?: string;
}

export interface UndoResult {
  ok: boolean;
  filePath?: string;
  error?: string;
}

/**
 * 编辑器内 diff 视图的数据。
 *
 * 设计说明：差异**在编辑器里渲染**（Monaco 的 DiffEditor），而不是另开一块面板 ——
 * 与主流编辑器一致：先看 diff，再决定是否应用。`original` / `modified` 是两侧完整文本。
 */
export interface EditorDiffPayload {
  /** 退出 diff 视图时为 false */
  active: boolean;
  /** 目标文件（相对根目录） */
  filePath?: string;
  /** 变更前的完整原文（左侧） */
  original?: string;
  /** 应用后的完整新文（右侧） */
  modified?: string;
  /** 语言标注（用于语法高亮） */
  language?: string;
  /** 引用该变更以便应用 */
  collectionId?: string;
  index?: number;
  /** 应用后与当前文件完全相同时为 true */
  identical?: boolean;
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
  /**
   * 把当前打开的**整个文件**（`这个文件是 <路径>` + 代码围栏 + 全文）写入剪贴板。
   * 用途：把整个文件作为**上下文**交给模型；仍由用户自己粘贴（零注入边界）。
   */
  copyWholeFile(relPath: string): Promise<CopyWholeFileResult>;
  /** 显示/隐藏右下角回程预览面板（height <= 0 表示隐藏） */
  setPreviewPanel(height: number): Promise<{ height: number; visible: boolean }>;
  /** 显示/隐藏右侧 AI 网页视图 */
  setWebVisible(visible: boolean): Promise<{ visible: boolean }>;
  /** 显示/隐藏左侧目录树面板 */
  setSidebarVisible(visible: boolean): Promise<{ visible: boolean }>;
  /** 调整左侧目录树宽度（像素） */
  setSidebarWidth(width: number): Promise<{ width: number }>;
  /** 请求在编辑器内以 diff 视图显示某个变更 */
  showDiffInEditor(collectionId: string, index: number): Promise<{ ok: boolean; error?: string }>;
  /** 主进程 → 编辑器：进入（或退出）diff 视图 */
  onDiffData(listener: (data: EditorDiffPayload) => void): void;
  /** 主进程 → 编辑器：目录树可见性/宽度变化 */
  onSidebarChanged(listener: (state: { visible: boolean; width: number }) => void): void;
  /**
   * 从网页视图**只读**采集最新回复并解析为待应用变更。
   * 不落盘、不修改页面；只回传预览数据。
   */
  collectReply(): Promise<ReturnPreview>;
  /**
   * 应用一个变更。主进程会先做三向校验，并**保留撤销快照**；
   * 默认路径下不可能静默覆盖（校验失败即拒绝）。
   */
  applyChange(input: ApplyChangeInput): Promise<ApplyChangeResult>;
  /** 撤销上一次应用（按快照恢复原文） */
  undoSave(): Promise<UndoResult>;
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
