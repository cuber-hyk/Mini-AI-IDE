/**
 * 预加载脚本（网页区顶部工具条）
 *
 * 与编辑器/preview 同样的约束：`sandbox: true` 下**不能 require 相对路径模块**，
 * 因此通道名必须内联为字面量（自检会比对，防漂移）。
 *
 * 暴露的接口刻意最小化：只允许只读采集、工具摘要与单一面板恢复，
 * **不能**读写文件、不能访问 Node、不能向网页写入任何内容。
 */
import { contextBridge, ipcRenderer } from 'electron';

const CH = {
  restoreFileWorkspace: 'ui:restore-file-workspace',
  toggleWorkspace: 'ui:toggle-workspace',
  chromeState: 'ui:chrome-state',
  collectReply: 'return:collect',
  getToolWorkspaceStatus: 'tools:get-workspace-status',
  toolWorkspaceStatus: 'tools:workspace-status',
  openToolWorkspace: 'tools:open-workspace',
} as const;

const bridge = {
  restoreFileWorkspace: () => ipcRenderer.invoke(CH.restoreFileWorkspace),
  toggleWorkspace: () => ipcRenderer.invoke(CH.toggleWorkspace),
  onChromeState: (listener: (state: unknown) => void) => ipcRenderer.on(CH.chromeState, (_event, state) => listener(state)),
  collectReply: () => ipcRenderer.invoke(CH.collectReply),
  getToolWorkspaceStatus: () => ipcRenderer.invoke(CH.getToolWorkspaceStatus),
  openToolWorkspace: () => ipcRenderer.invoke(CH.openToolWorkspace),
  onToolWorkspaceStatus: (listener: (state: unknown) => void) => ipcRenderer.on(CH.toolWorkspaceStatus, (_event, state) => listener(state)),
};

contextBridge.exposeInMainWorld('webbarBridge', bridge);

export const webbarPreloadChannels = CH;
