/**
 * 跨进程契约（主进程 / preload / 渲染进程共用）
 *
 * 设计约束（ADR-0002）：IPC 只暴露**窄接口** —— 声明式参数，不接受任意表达式，
 * 也不接受任意路径。渲染进程没有任何直接的文件系统能力。
 */
import type { LocalPromptInput, LocalPromptOptions, LocalPromptResult } from './localPrompt';
import type { SkillCatalog, LoadedSkill } from './skills';
import type { TextMeta } from './limits';
import type { FormatSpecVariant } from './formatSpec';
import type { ApplicationUpdateState } from './applicationUpdate';
import type { ToolConfig, ToolState } from './toolProtocol';

export const CHANNELS = {
  getLocalPromptOptions: 'ui:get-local-prompt-options',
  setLocalPromptOptions: 'ui:set-local-prompt-options',
  getSkillCatalog: 'skills:list', loadSkill: 'skills:load', sendPrompt: 'ui:send-prompt',
  getToolState: 'tools:get-state',
  setToolConfig: 'tools:set-config',
  toolState: 'tools:state',
  copyToolResults: 'tools:copy-results',
  cancelTools: 'tools:cancel',
  stopToolCommand: 'tools:stop-command',
  clearToolRules: 'tools:clear-rules',
  undoToolChange: 'tools:undo',
  getUpdateState: 'ui:get-update-state',
  checkForUpdate: 'ui:check-for-update',
  downloadUpdate: 'ui:download-update',
  installUpdate: 'ui:install-update',
  updateState: 'ui:update-state',
  openUpdatePanel: 'ui:open-update-panel',
  /** 渲染进程请求系统目录选择对话框（唯一取得路径的合法入口） */
  chooseRoot: 'fs:choose-root',
  getRecentRoots: 'fs:recent-roots',
  openRecentRoot: 'fs:open-recent-root',
  openWorkspace: 'fs:open-workspace',
  removeWorkspace: 'fs:remove-workspace',
  closeRoot: 'fs:close-root',
  createEntry: 'fs:create-entry',
  renameEntry: 'fs:rename-entry',
  trashEntry: 'fs:trash-entry',
  deleteEntry: 'fs:delete-entry',
  revealEntry: 'fs:reveal-entry',
  copyEntryPath: 'fs:copy-entry-path',
  getReviewState: 'review:get-state',
  reviewState: 'review:state',
  undoReviewChange: 'review:undo',
  entryChanged: 'fs:entry-changed',
  confirmLeave: 'editor:confirm-leave',
  editorState: 'editor:state',
  editorRequest: 'editor:request',
  editorReply: 'editor:reply',
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
  restoreFileWorkspace: 'ui:restore-file-workspace',
  setWorkspaceLayout: 'ui:set-workspace-layout',
  /** 把"输出格式要求"模板写入系统剪贴板（**由用户自己粘贴到提示词**，程序绝不注入） */
  copyFormatSpec: 'ui:copy-format-spec',
  /** 组装完整 prompt（需求 + 环境上下文 + 格式要求）并写入剪贴板；仍由用户自己粘贴 */
  copyPrompt: 'ui:copy-prompt',
  /** 取"工作环境摘要"（绝对路径 + 目录树 + 运行环境），供界面预览 */
  getContext: 'ui:get-context',
  /** 把选中原文组装为只读上下文并写入剪贴板 */
  copyNumberedSnippet: 'ui:copy-numbered-snippet',
  /** 从网页视图只读采集最新回复，按预选权限执行规范工具请求 */
  collectReply: 'return:collect',
  /** 显示/隐藏文件正文中的变更预览并设置宽度 */
  setPreviewPanel: 'ui:set-preview-panel',
  /** 主进程 → 本地文件工作区：当前布局与预览状态 */
  chromeState: 'ui:chrome-state',
  /** 显示/隐藏最右目录树（文件）面板 */
  setSidebarVisible: 'ui:set-sidebar-visible',
  /** 调整最右目录树宽度（像素） */
  setSidebarWidth: 'ui:set-sidebar-width',
  /**
   * 主进程 → 编辑器：**磁盘上的文件被回程链路改写了**。
   *
   * 为什么必须有（用户实测："应用后没有及时刷新文件，显示仍然是旧代码，
   * 只有关闭文件重新打开才会显示应用后的代码"）：
   * 落盘发生在主进程，而编辑器是**另一个渲染进程**，它不会自动知道磁盘变了。
   * 此前 `applyChange` 返回后没有任何广播，于是编辑器一直显示旧内容 ——
   * 只有用户手动关掉重开才会重新读盘。
   */
  fileChanged: 'fs:file-changed',
  /** 主进程 → 编辑器：目录树可见性/宽度变化 */
  sidebarChanged: 'ui:sidebar-changed',
  /** 主进程 → 渲染进程：记忆的根目录已失效 */
  rootStale: 'fs:root-stale',
  /** 主进程 → 渲染进程：根目录已变更 */
  rootChanged: 'fs:root-changed',
  /**
   * 提示词编辑面板 ←→ 主进程：读取当前格式要求（默认原文 + 用户自定义内容 + 状态）。
   *
   * 为什么单独开一组通道而不是复用 `ui:copy-format-spec`：那个通道是**动作**
   * （读出来写剪贴板），而这里要的是**编辑状态**（默认原文用于对比/恢复、
   * 自定义内容用于呈现、更新时间用于回显）。混在一起会让"复制"这条既有链路变复杂。
   */
  promptPanelState: 'ui:prompt-panel-state',
  /** 保存用户自定义的格式要求（内容为空视同"恢复默认"） */
  savePromptSpec: 'ui:save-prompt-spec',
  /** 恢复默认（清空自定义内容） */
  resetPromptSpec: 'ui:reset-prompt-spec',
  /** 面板 → 主进程：关闭自己（隐藏面板视图） */
  closePromptPanel: 'ui:close-prompt-panel',
  /** 主进程 → 编辑器：请求打开提示词编辑面板（菜单/快捷键/设置按钮都汇聚到这里） */
  openPromptPanel: 'ui:open-prompt-panel',
  /**
   * 编辑器 ↔ 主进程：读 / 写当前使用的提示词版本（底部双段开关的状态）。
   *
   * 为什么不用 `ui:copy-format-spec` 顺带解决：那个通道是**动作**（复制到剪贴板），
   * 而开关要的是**状态**（当前是哪一版、切换后要持久化）。混在一起会让
   * "每拨一次开关就顺带复制一次"这种副作用出现。
   */
  getPromptStatus: 'ui:get-prompt-status',
  promptStatus: 'ui:prompt-status',
  getFormatSpecVariant: 'ui:get-format-spec-variant',
  setFormatSpecVariant: 'ui:set-format-spec-variant',
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
  ok?: boolean;
  canceled?: boolean;
  error?: string;
  recentRoots?: string[];
  workspaceRoots?: string[];
  revision?: number;
  /** 是否来自"上次打开"的记忆（用于界面提示与失效告知） */
  restored?: boolean;
  /** 记忆的目录已不存在（已被删除/移动） */
  stale?: boolean;
}

export interface FileOperationResult {
  ok: boolean;
  relPath?: string;
  oldRelPath?: string;
  isDirectory?: boolean;
  error?: string;
}
export interface EntryChangedEvent {
  kind: 'renamed' | 'deleted';
  oldRelPath: string;
  relPath?: string;
  isDirectory: boolean;
  revision: number;
}
export interface EditorState {
  root: string | null;
  path: string | null;
  documents: Array<{ path: string; dirty: boolean }>;
}

export interface SplitResult {
  /** 主进程实际采用的编辑器宽度（已被最小宽度约束收敛） */
  editorWidth: number;
}

export interface WorkspaceLayoutPatch {
  fileMaximized?: boolean;
  workspaceWidth?: number;
  workspaceVisible?: boolean;
  fileWidth?: number;
  fileVisible?: boolean;
  treeWidth?: number;
  treeVisible?: boolean;
  dockHeight?: number;
  previewVisible?: boolean;
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
  /** 写入剪贴板的内容（只读上下文头与原文） */
  snippet: string;
  length: number;
  startLine?: number;
  endLine?: number;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * 回程：采集 → 解析 → 预览 → 应用
 * ------------------------------------------------------------------ */

/** 预览里的一个变更块（由解析结果 + 文件读取结果组成，不含文件内容） */
export interface ReturnPreviewBlock {
  /** 在本次采集结果中的序号 */
  index: number;
  /** 无文件修改线索的围栏只读展示，不参与文件应用。 */
  kind?: 'other';
  /** AI 明确声明的操作，范围仅由 IDE 计算用于显示。 */
  operation?: 'replace' | 'create' | 'overwrite';
  locations?: Array<{ oldRange: { start: number; end: number } | null; newRange: { start: number; end: number } | null; lineDelta: number }>;
  /** 仅其他内容块携带完整只读文本。 */
  contentText?: string;
  /** 目标文件（相对根目录）；null 表示缺少明确路径 */
  filePath: string | null;
  /** 路径线索来源 */
  pathSource: 'fence-comment' | 'preceding-heading' | 'none';
  /** IDE 计算的首个原文显示区间；不作为 AI 输入或写盘坐标。 */
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
   * **预览基线复核不通过时为 null**，且该块会被标为阻塞（不给用户"可以应用"的错觉）。
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
  /**
   * 最新回复与上次采集的**内容指纹相同** ⇒ 判定为「已采集过、无新内容」。
   *
   * 语义（L2 消费判定层）：一次采集消费一条回复。为 true 时 `blocks` 必为空
   * （不解析、不产生待应用条目），UI 应显示明确提示而**不回退旧内容**。
   */
  noNewContent?: boolean;
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
  /** 成功创建了原先不存在的文件。 */
  created?: boolean;
  filePath?: string;
  mode?: string;
  /** 变更前的完整原文（撤销用；已存快照） */
  before?: string;
  after?: string;
  error?: string | undefined;
  /** 校验失败原因（与 computeApply 的 reason 一致） */
  reason?: string;
}

/**
 * 「某个变更的状态变了」——主进程 → 预览面板的广播载荷。
 *
 * 覆盖两种入口造成的变化：
 *  - `applied`：左侧编辑器工具条「应用此变更」落盘成功（面板自己的按钮不需要它，
 *    但收到也幂等）；
 *  - `undone`：撤销了一次应用，对应的条目应恢复成「可应用」。
 *
 * 用 `index`（批次内唯一）而不是文件名：用户可能刚改过路径，按名字匹配会漏。
 * 快照携带 collectionId/index，撤销只复位对应批次的片段；旧批次通知不修改当前列表。
 */
export interface AppliedChangeEvent {
  kind: 'applied' | 'undone';
  collectionId?: string;
  index?: number;
  filePath?: string;
}

export interface UndoResult {
  ok: boolean;
  /** 撤销新建已删除目标文件；普通替换撤销则不设置。 */
  deleted?: boolean;
  /** 文件撤销成功，但新建目录清理未完成时说明原因。 */
  warning?: string;
  collectionId?: string;
  index?: number;
  filePath?: string;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * 提示词编辑面板（用户自定义"输出格式要求"）
 * ------------------------------------------------------------------ */

/** 输入区只读取版本与自定义标记，不接收提示词全文。 */
export interface PromptComposerStatus {
  variant: FormatSpecVariant;
  shortIsCustom: boolean;
  fullIsCustom: boolean;
}

/**
 * 面板需要的全部状态。
 *
 * 关键设计：面板**同时**给出「内置默认原文」与「用户当前内容」两份。
 *  - 只给一份的话，面板无法回答"我改了什么 / 改回默认会变成什么"；
 *  - 面板里不做 diff 渲染，而是分成两个可见区（默认要点摘要 + 编辑框），
 *    用户随时能点「恢复默认」拿回原文 —— 比自己比对更不容易出错。
 */
/**
 * 单个版本（简洁版 / 完整版）在面板里的状态。
 *
 * 面板做成**分版本**的：每个版本各有自己的内置默认与自定义内容，
 * 用户在"A 版"上的编辑不会影响"B 版"。
 */
export interface PromptVariantState {
  /** 该版本的内置默认原文，用于「恢复默认」与"与默认不同"的判定 */
  defaultSpec: string;
  /** 该版本已保存的自定义内容；null 表示当前用内置默认 */
  customSpec: string | null;
  /** 该版本是否正在使用自定义内容 */
  isCustom: boolean;
}

export interface PromptPanelState {
  /** 当前生效版本（底部双段开关的状态） */
  variant: FormatSpecVariant;
  /** 简洁版状态 */
  short: PromptVariantState;
  /** 完整版状态 */
  full: PromptVariantState;
  /** 自定义内容的保存时间（ISO）；两版都没自定义时为 null */
  updatedAt: string | null;
  /** 自定义内容长度上限 */
  maxLength: number;
}

export interface SavePromptSpecResult {
  ok: boolean;
  /** 保存后的完整状态（面板据此刷新按钮与提示，无需再请求一次） */
  state: PromptPanelState;
  /** 保存的是哪个版本（面板据此给出准确回执） */
  variant: FormatSpecVariant;
  /** 是否回落到了默认（内容空白 ⇒ 视同恢复默认） */
  resetToDefault?: boolean;
  error?: string;
}

/**
 * 提示词面板的桥接口（独立 preload 暴露为 `window.promptBridge`）。
 *
 * 边界与其它面板一致：**不能读文件、不能访问 Node、不能触碰网页**。
 * 它能做的只有"读这一份设置 / 写这一份设置"。
 */
export interface PromptPanelBridge {
  getState(): Promise<PromptPanelState>;
  /** 保存指定版本的自定义内容（空内容 ⇒ 该版本恢复默认） */
  save(variant: FormatSpecVariant, spec: string): Promise<SavePromptSpecResult>;
  /** 把指定版本恢复为内置默认 */
  reset(variant: FormatSpecVariant): Promise<SavePromptSpecResult>;
  close(): Promise<{ ok: boolean }>;
}

/**
 * 编辑器内 diff 视图的数据。
 *
 * 设计说明：差异**内联渲染在编辑器里**（删除行标红删除线、新增行用 view zone 插在旁边），
 * 而不是另开一块对比面板 —— 用户明确要求「diff 与原文件整合一起显示，而不是分两个板块」。
 * 也不使用 Monaco 的 DiffEditor：那会变成左边「当前文件」、右边「应用后」两栏并排。
 *
 * `original` / `modified` 是两侧完整文本，由主进程算出并**已通过预览基线复核**，
 * 因此不会出现「编辑器里显示了 diff、点应用却失败」。
 */
export interface EditorDiffPayload {
  operation?: 'replace' | 'create' | 'overwrite';
  /** 新增预览使用空原文，预览本身不创建文件。 */
  newFile?: boolean;
  workspaceRevision?: number;
  /** 退出 diff 视图时为 false */
  active: boolean;
  /** 目标文件（相对根目录） */
  filePath?: string;
  /** 变更前的完整原文 —— 编辑器里显示的就是它（不改动一个字符） */
  original?: string;
  /** 应用后的完整新文（内联标记据此算出哪些行新增 / 删除） */
  modified?: string;
  /** 语言标注（用于语法高亮） */
  language?: string;
  /** 引用该变更以便应用 */
  collectionId?: string;
  index?: number;
  /** 应用后与当前文件完全相同时为 true */
  identical?: boolean;
  /** 同批次内可导航的变更列表，供「上一个 / 下一个」在文件之间跳转 */
  siblings?: EditorDiffSibling[];
  /** 本变更在 siblings 中的位置 */
  position?: number;
}

/** 批次内的一个可导航变更（只带定位信息，不带文本 —— 文本按需现算） */
export interface EditorDiffSibling {
  collectionId: string;
  index: number;
  filePath?: string;
}

/** preload 通过 contextBridge 暴露给渲染进程的唯一接口面 */
export interface EditorBridge {
  getToolState(): Promise<ToolState>;
  setToolConfig(config: Partial<ToolConfig>): Promise<ToolState>;
  onToolState(listener: (state: ToolState) => void): void;
  copyToolResults(): Promise<{ ok: boolean; error?: string }>;
  cancelTools(): Promise<ToolState>;
  stopToolCommand(target: { batch_id: string; request_id: string; process_id: string }): Promise<ToolState>;
  clearToolRules(): Promise<ToolState>;
  undoToolChange(): Promise<{ ok: boolean; error?: string }>;
  getUpdateState(): Promise<ApplicationUpdateState>;
  checkForUpdate(): Promise<ApplicationUpdateState>;
  downloadUpdate(): Promise<ApplicationUpdateState>;
  installUpdate(): Promise<ApplicationUpdateState>;
  onUpdateState(listener: (state: ApplicationUpdateState) => void): void;
  onOpenUpdatePanel(listener: () => void): void;
  chooseRoot(): Promise<RootInfo>;
  getRecentRoots(): Promise<string[]>;
  openRecentRoot(index: number): Promise<RootInfo>;
  openWorkspace(index: number): Promise<RootInfo>;
  removeWorkspace(index: number): Promise<RootInfo>;
  closeRoot(): Promise<RootInfo>;
  createEntry(parent: string, name: string, isDirectory: boolean, root: string): Promise<FileOperationResult>;
  renameEntry(relPath: string, name: string, root: string): Promise<FileOperationResult>;
  trashEntry(relPath: string, root: string): Promise<FileOperationResult>;
  deleteEntry(relPath: string, root: string): Promise<FileOperationResult>;
  revealEntry(relPath: string, root: string): Promise<FileOperationResult>;
  copyEntryPath(relPath: string, relative: boolean, root: string): Promise<FileOperationResult>;
  confirmLeave(path?: string, root?: string): Promise<{ ok: boolean }>;
  reportEditorState(state: EditorState): void;
  onEditorRequest(listener: (request: { id: number; kind: 'save'; path: string }) => void): void;
  editorReply(id: number, ok: boolean): Promise<{ ok: boolean }>;
  onEntryChanged(listener: (event: EntryChangedEvent) => void): void;
  getRoot(): Promise<RootInfo>;
  listDir(relPath: string): Promise<ListDirResult>;
  readFile(relPath: string): Promise<ReadFileResult>;
  sliceFile(relPath: string, startLine: number, endLine: number): Promise<SliceFileResult>;
  writeFile(relPath: string, text: string, root: string): Promise<WriteFileResult>;
  /** 读取/订阅输入区当前设置（版本与自定义布尔状态）。 */
  getPromptStatus(): Promise<PromptComposerStatus>;
  onPromptStatus(listener: (status: PromptComposerStatus) => void): void;
  /** 上报期望的编辑器宽度（像素）；主进程会做最小宽度约束并回传实际值 */
  setSplit(editorWidth: number): Promise<SplitResult>;
  setWorkspaceLayout(patch: WorkspaceLayoutPatch): Promise<{ ok: boolean }>;
  /**
   * 请求把"输出格式要求"模板写入系统剪贴板。
   * **程序不会把它送进输入框**——需要用户自己粘贴到提示词里（零注入边界，见 ADR-0003）。
   */
  copyFormatSpec(): Promise<CopyFormatResult>;
  /**
   * 读当前使用的提示词版本（底部双段开关的初始状态）。
   * 启动时渲染进程据此把开关拨到正确位置——不读就会"显示简洁版、实际发的是完整版"。
   */
  getFormatSpecVariant(): Promise<FormatSpecVariant>;
  /** 切换提示词版本并持久化（返回落盘后的实际值，供渲染进程校正显示） */
  setFormatSpecVariant(variant: FormatSpecVariant): Promise<FormatSpecVariant>;
  /** 取工作环境摘要（当前目录 + 目录树 + 运行环境），用于界面预览 */
  getContext(): Promise<ContextSummary>;
  /**
   * 组装完整 prompt 并写入剪贴板。
   * 仍**只写剪贴板**：由用户自己 Ctrl+V 到网页输入框（零注入边界）。
   */
  copyPrompt(input: LocalPromptInput): Promise<LocalPromptResult>;
  sendPrompt(input: LocalPromptInput): Promise<LocalPromptResult>;
  getLocalPromptOptions(): Promise<LocalPromptOptions>;
  setLocalPromptOptions(patch: Partial<LocalPromptOptions>): Promise<LocalPromptOptions>;
  getSkillCatalog(): Promise<SkillCatalog>;
  loadSkill(name: string): Promise<{ok: boolean; skill?: LoadedSkill; error?: string}>;
  /**
   * 把选中原文与只读上下文头写入剪贴板，行号仅供本地反馈。
   * 用于提供原文上下文：模型以 SEARCH/REPLACE 表达修改，应用前复核完整预览原文。
   */
  copyNumberedSnippet(input: NumberedSnippetInput & { root: string }): Promise<CopySnippetResult>;
  /** 显示/隐藏或调整最右侧变更列（width <= 0 表示隐藏） */
  setPreviewPanel(width: number): Promise<{ width: number; visible: boolean }>;
  /** 显示/隐藏左侧目录树面板 */
  setSidebarVisible(visible: boolean): Promise<{ visible: boolean }>;
  /** 调整最右目录树宽度（像素） */
  setSidebarWidth(width: number): Promise<{ width: number }>;
  /**
   * 请求打开「提示词编辑面板」。
   *
   * 面板是**独立渲染进程**（ADR-0002 进程边界），编辑器不能直接显示它；
   * 这里只上报意图，由主进程显示面板并居中摆放。
   */
  openPromptPanel(): Promise<{ ok: boolean }>;
  /** 主进程 → 编辑器：目录树可见性/宽度变化 */
  onSidebarChanged(listener: (state: { visible: boolean; width: number }) => void): void;
  /**
   * 主进程 → 编辑器：请求打开「提示词编辑面板」。
   *
   * 入口有三个（设置菜单行 / 编辑器工具栏齿轮 / 快捷键），全部汇聚到主进程，
   * 由它显示面板视图并广播一次本事件；编辑器据此点亮工具栏按钮的激活态。
   */
  onOpenPromptPanel(listener: () => void): void;
  /** 只读采集最新回复，工具权限与执行结果由 IDE 工具入口管理。 */
  collectReply(): Promise<ReturnPreview>;
  onRootChanged(listener: (info: RootInfo) => void): void;
  onFileChanged(listener: (filePath: string, change: 'updated' | 'created' | 'deleted', revision: number, discardDraft?: boolean) => void): void;
  /** 记忆的根目录已失效（被删除/移动）时的通知 */
  onRootStale(listener: (info: RootInfo) => void): void;
}

declare global {
  interface Window {
    /** 由 preload 注入；除此外渲染进程不得假设任何能力 */
    editorBridge: EditorBridge;
    /** 提示词编辑面板的独立桥（仅 prompt.html 里存在） */
    promptBridge?: PromptPanelBridge;
  }
}
