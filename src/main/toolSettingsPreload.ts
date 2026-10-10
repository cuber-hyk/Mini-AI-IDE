/** 原生设置浮层窄桥：无文件、命令、附件、结果正文或官网能力。 */
import { contextBridge, ipcRenderer } from 'electron';
import type { ToolSettingsPatch } from '../shared/toolSettings';

const CH = { getState: 'tools:get-settings-state', configure: 'tools:set-settings', clearRules: 'tools:clear-rules',
  openPrompt: 'tools:open-prompt-settings', close: 'tools:close-settings', state: 'tools:settings-state' } as const;
contextBridge.exposeInMainWorld('toolSettingsBridge', {
  getState: () => ipcRenderer.invoke(CH.getState),
  configure: (patch: ToolSettingsPatch) => ipcRenderer.invoke(CH.configure, patch),
  clearRules: () => ipcRenderer.invoke(CH.clearRules),
  openPrompt: () => ipcRenderer.invoke(CH.openPrompt),
  close: () => ipcRenderer.invoke(CH.close),
  onState: (listener: (state: unknown) => void) => { ipcRenderer.on(CH.state, (_event, state) => listener(state)); },
});
