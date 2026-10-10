/**
 * 预加载脚本（提示词编辑面板）
 *
 * 与其它面板同样的约束：`sandbox: true` 下**不能 require 相对路径模块**，
 * 因此通道名必须内联为字面量（自检会比对，防漂移）。
 *
 * 暴露的接口刻意最小化：**只能读/写这一份设置**（点四个动作）。
 * 面板不能读文件、不能访问 Node、不能向网页写入任何内容 —— 与其余面板同一条边界。
 */
import { contextBridge, ipcRenderer } from 'electron';

const CH = {
  getState: 'ui:prompt-panel-state',
  save: 'ui:save-prompt-spec',
  reset: 'ui:reset-prompt-spec',
  close: 'ui:close-prompt-panel',
} as const;

const bridge = {
  getState: () => ipcRenderer.invoke(CH.getState),
  save: (spec: string) => ipcRenderer.invoke(CH.save, spec),
  reset: () => ipcRenderer.invoke(CH.reset),
  close: () => ipcRenderer.invoke(CH.close),
};

contextBridge.exposeInMainWorld('promptBridge', bridge);

export const promptPreloadChannels = CH;
