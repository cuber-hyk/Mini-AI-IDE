/**
 * 预加载脚本（网页区顶部工具条）
 *
 * 与编辑器/preview 同样的约束：`sandbox: true` 下**不能 require 相对路径模块**，
 * 因此通道名必须内联为字面量（自检会比对，防漂移）。
 *
 * 暴露的接口刻意最小化：只允许切换显隐、读状态与触发只读采集，
 * **不能**读写文件、不能访问 Node、不能向网页写入任何内容。
 */
import { contextBridge, ipcRenderer } from 'electron';

const CH = {
  setWebVisible: 'ui:set-web-visible',
  setPreviewPanel: 'ui:set-preview-panel',
  chromeState: 'ui:chrome-state',
  collectReply: 'return:collect',
} as const;

const bridge = {
  setWebVisible: (visible: boolean) => ipcRenderer.invoke(CH.setWebVisible, visible),
  setPreviewPanel: (width: number) => ipcRenderer.invoke(CH.setPreviewPanel, width),
  collectReply: () => ipcRenderer.invoke(CH.collectReply),
  onChromeState: (listener: (state: unknown) => void) => {
    ipcRenderer.on(CH.chromeState, (_e, state) => listener(state));
  },
};

contextBridge.exposeInMainWorld('webbarBridge', bridge);

export const webbarPreloadChannels = CH;
