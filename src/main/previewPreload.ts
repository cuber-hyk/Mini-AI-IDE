/** 右侧只读变更查看：仅接收本批执行快照，撤销仍由原工具 owner 处理。 */
import { contextBridge, ipcRenderer } from 'electron';

const CH = {
  getReviewState: 'review:get-state',
  reviewState: 'review:state',
  undoReviewChange: 'review:undo',
  setPreviewPanel: 'ui:set-preview-panel',
  chromeState: 'ui:chrome-state',
} as const;

contextBridge.exposeInMainWorld('previewBridge', {
  getReviewState: () => ipcRenderer.invoke(CH.getReviewState),
  onReviewState: (listener: (state: unknown) => void) => ipcRenderer.on(CH.reviewState, (_e, state) => listener(state)),
  undoToolChange: () => ipcRenderer.invoke(CH.undoReviewChange),
  setPreviewPanel: (width: number, temporary = false) => ipcRenderer.invoke(CH.setPreviewPanel, width, temporary),
  onChromeState: (listener: (state: unknown) => void) => ipcRenderer.on(CH.chromeState, (_e, state) => listener(state)),
});

export const previewPreloadChannels = CH;
