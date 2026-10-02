/**
 * 预加载脚本（右下角回程预览面板）
 *
 * 与编辑器 preload 同样的约束：`sandbox: true` 下**不能 require 相对路径模块**，
 * 因此通道名必须内联为字面量（自检会比对，防漂移）。
 *
 * 暴露的接口刻意最小化：只够"显示预览 + 触发一次应用/撤销"。
 * 面板**不能**读写文件、不能访问 Node、不能向网页写入任何内容。
 */
import { contextBridge, ipcRenderer } from 'electron';

const CH = {
  applyChange: 'return:apply',
  undoSave: 'return:undo',
  previewData: 'preview:data',
  setPreviewPanel: 'ui:set-preview-panel',
} as const;

const bridge = {
  applyChange: (input: unknown) => ipcRenderer.invoke(CH.applyChange, input),
  undoSave: () => ipcRenderer.invoke(CH.undoSave),
  setPreviewPanel: (height: number) => ipcRenderer.invoke(CH.setPreviewPanel, height),
  onPreviewData: (listener: (preview: unknown) => void) => {
    ipcRenderer.on(CH.previewData, (_e, preview) => listener(preview));
  },
};

contextBridge.exposeInMainWorld('previewBridge', bridge);

export const previewPreloadChannels = CH;
