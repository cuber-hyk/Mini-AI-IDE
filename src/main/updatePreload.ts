/** 独立更新窗口的窄桥：无文件、工具、官网或任意 URL 能力。 */
import { contextBridge, ipcRenderer } from 'electron';

const CH = { getUpdateState: 'ui:get-update-state', checkForUpdate: 'ui:check-for-update',
  downloadUpdate: 'ui:download-update', installUpdate: 'ui:install-update',
  updateState: 'ui:update-state', closeUpdatePanel: 'ui:close-update-panel' } as const;

contextBridge.exposeInMainWorld('updateBridge', {
  getUpdateState: () => ipcRenderer.invoke(CH.getUpdateState),
  checkForUpdate: () => ipcRenderer.invoke(CH.checkForUpdate),
  downloadUpdate: () => ipcRenderer.invoke(CH.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(CH.installUpdate),
  closeUpdatePanel: () => ipcRenderer.invoke(CH.closeUpdatePanel),
  onUpdateState: (listener: (state: unknown) => void) => ipcRenderer.on(CH.updateState, (_event, state) => listener(state)),
});
