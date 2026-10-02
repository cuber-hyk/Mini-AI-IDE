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
  chooseRoot: 'fs:choose-root',
  getRoot: 'fs:get-root',
  listDir: 'fs:list-dir',
  readFile: 'fs:read-file',
  sliceFile: 'fs:slice-file',
  writeFile: 'fs:write-file',
  setSplit: 'ui:set-split',
  copyFormatSpec: 'ui:copy-format-spec',
  copyPrompt: 'ui:copy-prompt',
  getContext: 'ui:get-context',
  copyNumberedSnippet: 'ui:copy-numbered-snippet',
  copyWholeFile: 'ui:copy-whole-file',
  setPreviewPanel: 'ui:set-preview-panel',
  collectReply: 'return:collect',
  applyChange: 'return:apply',
  undoSave: 'return:undo',
  rootChanged: 'fs:root-changed',
  rootStale: 'fs:root-stale',
} as const;

const bridge = {
  chooseRoot: () => ipcRenderer.invoke(CH.chooseRoot),
  getRoot: () => ipcRenderer.invoke(CH.getRoot),
  listDir: (relPath: string) => ipcRenderer.invoke(CH.listDir, relPath),
  readFile: (relPath: string) => ipcRenderer.invoke(CH.readFile, relPath),
  sliceFile: (relPath: string, startLine: number, endLine: number) =>
    ipcRenderer.invoke(CH.sliceFile, relPath, startLine, endLine),
  writeFile: (relPath: string, text: string) => ipcRenderer.invoke(CH.writeFile, relPath, text),
  setSplit: (editorWidth: number) => ipcRenderer.invoke(CH.setSplit, editorWidth),
  copyFormatSpec: () => ipcRenderer.invoke(CH.copyFormatSpec, 'short'),
  getContext: () => ipcRenderer.invoke(CH.getContext),
  copyPrompt: (requirement: string, targetFiles: string[]) => ipcRenderer.invoke(CH.copyPrompt, requirement, targetFiles),
  copyNumberedSnippet: (input: unknown) => ipcRenderer.invoke(CH.copyNumberedSnippet, input),
  copyWholeFile: (relPath: string) => ipcRenderer.invoke(CH.copyWholeFile, relPath),
  setPreviewPanel: (height: number) => ipcRenderer.invoke(CH.setPreviewPanel, height),
  collectReply: () => ipcRenderer.invoke(CH.collectReply),
  applyChange: (input: unknown) => ipcRenderer.invoke(CH.applyChange, input),
  undoSave: () => ipcRenderer.invoke(CH.undoSave),
  onRootChanged: (listener: (info: unknown) => void) => {
    ipcRenderer.on(CH.rootChanged, (_e, info) => listener(info));
  },
  onRootStale: (listener: (info: unknown) => void) => {
    ipcRenderer.on(CH.rootStale, (_e, info) => listener(info));
  },
};

contextBridge.exposeInMainWorld('editorBridge', bridge);

// 供主进程自检比对（不是暴露给页面世界的桥接口，只是模块级导出）
export const preloadChannels = CH;
