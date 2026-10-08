/**
 * 预加载脚本（编辑器渲染进程）
 *
 * 唯一职责：把**窄接口**暴露给渲染进程。
 *  - 不暴露任何 Node 能力（不给 require / process / fs）；
 *  - 不暴露任意路径读取（只能读已打开根目录内的内容）；
 *  - 不暴露任何写网页的能力（本项目零注入，见 ADR-0003）。
 *
 * ⚠️ 重要实现约束（踩过的坑）：
 *  在 `sandbox: true` 下，preload 的模块能力受限 —— **不能 require 相对路径模块**
 *  （会报 `Error: module not found: ../shared/contract`），只能 require `electron`
 *  等少量内置模块。因此这里的通道名必须**内联为字面量**，不能在运行期从 shared 导入。
 *
 *  为避免"通道名漂移"导致静默失效，写了两道防线：
 *   1. 下面的 CHANNEL_NAMES 列表参与 `preloadChannels` 比对；
 *   2. 主进程自检会逐个 `ipcMain` 注册表比对，缺一即 FAIL。
 */
import { contextBridge, ipcRenderer } from 'electron';

/** 与 src/shared/contract.ts 的 CHANNELS 必须逐字一致（自检会校验） */
const CH = {
  getLocalPromptOptions: 'ui:get-local-prompt-options', setLocalPromptOptions: 'ui:set-local-prompt-options',
  getSkillCatalog: 'skills:list', loadSkill: 'skills:load', sendPrompt: 'ui:send-prompt',
  getToolState: 'tools:get-state', setToolConfig: 'tools:set-config', toolState: 'tools:state',
  copyToolResults: 'tools:copy-results', cancelTools: 'tools:cancel', stopToolCommand: 'tools:stop-command', clearToolRules: 'tools:clear-rules', undoToolChange: 'tools:undo',
  getUpdateState: 'ui:get-update-state',
  checkForUpdate: 'ui:check-for-update',
  downloadUpdate: 'ui:download-update',
  installUpdate: 'ui:install-update',
  updateState: 'ui:update-state',
  openUpdatePanel: 'ui:open-update-panel',
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
  entryChanged: 'fs:entry-changed',
  confirmLeave: 'editor:confirm-leave',
  editorState: 'editor:state',
  editorRequest: 'editor:request',
  editorReply: 'editor:reply',
  getRoot: 'fs:get-root',
  listDir: 'fs:list-dir',
  readFile: 'fs:read-file',
  sliceFile: 'fs:slice-file',
  writeFile: 'fs:write-file',
  setSplit: 'ui:set-split',
  setWorkspaceLayout: 'ui:set-workspace-layout',
  copyFormatSpec: 'ui:copy-format-spec',
  copyPrompt: 'ui:copy-prompt',
  getContext: 'ui:get-context',
  copyNumberedSnippet: 'ui:copy-numbered-snippet',
  setPreviewPanel: 'ui:set-preview-panel',
  chromeState: 'ui:chrome-state',
  setSidebarVisible: 'ui:set-sidebar-visible',
  setSidebarWidth: 'ui:set-sidebar-width',
  sidebarChanged: 'ui:sidebar-changed',
  collectReply: 'return:collect',
  rootChanged: 'fs:root-changed',
  rootStale: 'fs:root-stale',
  fileChanged: 'fs:file-changed',
  openPromptPanel: 'ui:open-prompt-panel',
  getPromptStatus: 'ui:get-prompt-status',
  promptStatus: 'ui:prompt-status',
  getFormatSpecVariant: 'ui:get-format-spec-variant',
  setFormatSpecVariant: 'ui:set-format-spec-variant',
} as const;
const bridge = {
  getToolState: () => ipcRenderer.invoke(CH.getToolState),
  setToolConfig: (config: unknown) => ipcRenderer.invoke(CH.setToolConfig, config),
  onToolState: (listener: (state: unknown) => void) => ipcRenderer.on(CH.toolState, (_e, state) => listener(state)),
  copyToolResults: () => ipcRenderer.invoke(CH.copyToolResults),
  cancelTools: () => ipcRenderer.invoke(CH.cancelTools),
  stopToolCommand: (target: unknown) => ipcRenderer.invoke(CH.stopToolCommand, target),
  clearToolRules: () => ipcRenderer.invoke(CH.clearToolRules),
  undoToolChange: () => ipcRenderer.invoke(CH.undoToolChange),
  getUpdateState: () => ipcRenderer.invoke(CH.getUpdateState),
  checkForUpdate: () => ipcRenderer.invoke(CH.checkForUpdate),
  downloadUpdate: () => ipcRenderer.invoke(CH.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(CH.installUpdate),
  onUpdateState: (listener: (state: unknown) => void) => ipcRenderer.on(CH.updateState, (_e, state) => listener(state)),
  onOpenUpdatePanel: (listener: () => void) => ipcRenderer.on(CH.openUpdatePanel, () => listener()),
  chooseRoot: () => ipcRenderer.invoke(CH.chooseRoot),
  getRecentRoots: () => ipcRenderer.invoke(CH.getRecentRoots),
  openRecentRoot: (index: number) => ipcRenderer.invoke(CH.openRecentRoot, index),
  openWorkspace: (index: number) => ipcRenderer.invoke(CH.openWorkspace, index),
  removeWorkspace: (index: number) => ipcRenderer.invoke(CH.removeWorkspace, index),
  closeRoot: () => ipcRenderer.invoke(CH.closeRoot),
  createEntry: (parent: string, name: string, isDirectory: boolean, root: string) => ipcRenderer.invoke(CH.createEntry, parent, name, isDirectory, root),
  renameEntry: (relPath: string, name: string, root: string) => ipcRenderer.invoke(CH.renameEntry, relPath, name, root),
  trashEntry: (relPath: string, root: string) => ipcRenderer.invoke(CH.trashEntry, relPath, root),
  deleteEntry: (relPath: string, root: string) => ipcRenderer.invoke(CH.deleteEntry, relPath, root),
  revealEntry: (relPath: string, root: string) => ipcRenderer.invoke(CH.revealEntry, relPath, root),
  copyEntryPath: (relPath: string, relative: boolean, root: string) => ipcRenderer.invoke(CH.copyEntryPath, relPath, relative, root),
  confirmLeave: (path?: string, root?: string) => ipcRenderer.invoke(CH.confirmLeave, path, root),
  reportEditorState: (state: unknown) => ipcRenderer.send(CH.editorState, state),
  onEditorRequest: (listener: (request: { id: number; kind: 'save'; path: string }) => void) => ipcRenderer.on(CH.editorRequest, (_e, request) => listener(request)),
  editorReply: (id: number, ok: boolean) => ipcRenderer.invoke(CH.editorReply, id, ok),
  onEntryChanged: (listener: (event: unknown) => void) => ipcRenderer.on(CH.entryChanged, (_e, event) => listener(event)),
  getRoot: () => ipcRenderer.invoke(CH.getRoot),
  listDir: (relPath: string) => ipcRenderer.invoke(CH.listDir, relPath),
  readFile: (relPath: string) => ipcRenderer.invoke(CH.readFile, relPath),
  sliceFile: (relPath: string, startLine: number, endLine: number) =>
    ipcRenderer.invoke(CH.sliceFile, relPath, startLine, endLine),
  writeFile: (relPath: string, text: string, root: string) => ipcRenderer.invoke(CH.writeFile, relPath, text, root),
  setSplit: (editorWidth: number) => ipcRenderer.invoke(CH.setSplit, editorWidth),
  setWorkspaceLayout: (patch: unknown) => ipcRenderer.invoke(CH.setWorkspaceLayout, patch),
  // 不传版本 ⇒ 主进程用**当前开关状态**（不再硬编码 'short'；早期硬编码会让
  // 底部开关拨到"完整版"后，这条链路的实际行为与显示不一致）
  copyFormatSpec: () => ipcRenderer.invoke(CH.copyFormatSpec),
  getPromptStatus: () => ipcRenderer.invoke(CH.getPromptStatus),
  onPromptStatus: (listener: (status: unknown) => void) => {
    ipcRenderer.on(CH.promptStatus, (_e, status) => listener(status));
  },
  getFormatSpecVariant: () => ipcRenderer.invoke(CH.getFormatSpecVariant),
  setFormatSpecVariant: (variant: string) => ipcRenderer.invoke(CH.setFormatSpecVariant, variant),
  getContext: () => ipcRenderer.invoke(CH.getContext),
  getLocalPromptOptions: () => ipcRenderer.invoke(CH.getLocalPromptOptions),
  setLocalPromptOptions: (patch: unknown) => ipcRenderer.invoke(CH.setLocalPromptOptions, patch),
  getSkillCatalog: () => ipcRenderer.invoke(CH.getSkillCatalog),
  loadSkill: (name: string) => ipcRenderer.invoke(CH.loadSkill, name),
  sendPrompt: (input: unknown) => ipcRenderer.invoke(CH.sendPrompt, input),
  copyPrompt: (input: unknown) => ipcRenderer.invoke(CH.copyPrompt, input),
  copyNumberedSnippet: (input: unknown) => ipcRenderer.invoke(CH.copyNumberedSnippet, input),
  setPreviewPanel: (width: number) => ipcRenderer.invoke(CH.setPreviewPanel, width),
  setSidebarVisible: (visible: boolean) => ipcRenderer.invoke(CH.setSidebarVisible, visible),
  setSidebarWidth: (width: number) => ipcRenderer.invoke(CH.setSidebarWidth, width),
  /** 请求主进程打开「提示词编辑面板」（面板是独立视图，只能由主进程显示） */
  openPromptPanel: () => ipcRenderer.invoke(CH.openPromptPanel),
  onSidebarChanged: (listener: (state: unknown) => void) => {
    ipcRenderer.on(CH.sidebarChanged, (_e, state) => listener(state));
  },
  /**
   * 订阅「打开提示词编辑面板」请求。
   * 面板是**独立视图**（ADR-0002 进程边界），编辑器自己不能显示它，
   * 只能由主进程显示后广播一次，编辑器据此点亮工具栏按钮的激活态。
   */
  onOpenPromptPanel: (listener: () => void) => {
    ipcRenderer.on(CH.openPromptPanel, () => listener());
  },
  /** 网页/预览可见性变化（网页区工具条那边改了，本进程据此同步状态） */
  onChromeState: (listener: (state: unknown) => void) => {
    ipcRenderer.on(CH.chromeState, (_e, state) => listener(state));
  },
  collectReply: () => ipcRenderer.invoke(CH.collectReply),
  onRootChanged: (listener: (info: unknown) => void) => {
    ipcRenderer.on(CH.rootChanged, (_e, info) => listener(info));
  },
  onRootStale: (listener: (info: unknown) => void) => {
    ipcRenderer.on(CH.rootStale, (_e, info) => listener(info));
  },
  /**
   * 订阅「磁盘文件被回程链路改写」。
   * 落盘在主进程、编辑在另一个渲染进程，不广播的话编辑器就一直显示旧内容。
   */
  onFileChanged: (listener: (filePath: string, change: 'updated' | 'created' | 'deleted', revision: number, discardDraft?: boolean) => void) => {
    ipcRenderer.on(CH.fileChanged, (_e, filePath, change, revision, discardDraft) => listener(filePath, change, revision, discardDraft));
  },
};

contextBridge.exposeInMainWorld('editorBridge', bridge);

// 供主进程自检比对（不是暴露给页面世界的桥接口，只是模块级导出）
export const preloadChannels = CH;
