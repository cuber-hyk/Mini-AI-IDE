/** 只允许编辑器打开浮层，专用主 frame 修改四项设置；不提供工具执行和文件能力。 */
import type { IpcMain, WebContents } from 'electron';
import { CHANNELS } from '../shared/contract';
import type { ToolState } from '../shared/toolProtocol';
import type { ToolSettingsAnchor, ToolSettingsPatch, ToolSettingsState } from '../shared/toolSettings';

export function toolSettingsState(state: ToolState, hasProject: boolean): ToolSettingsState {
  return { config: { ...state.config }, busy: state.busy, hasProject, ...(state.storageError ? { storageError: state.storageError } : {}) };
}

function settingsPatch(value: unknown): ToolSettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置参数无效');
  const patch = value as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key => !['sendIntervalSeconds', 'dirtyPolicy', 'completionSound', 'autoCopyResults'].includes(key))) throw new Error('设置窗口不能修改该配置字段');
  if ('sendIntervalSeconds' in patch && (!Number.isInteger(patch.sendIntervalSeconds) || Number(patch.sendIntervalSeconds) < 0 || Number(patch.sendIntervalSeconds) > 300)) throw new Error('发送间隔须为 0–300 秒的整数');
  if ('dirtyPolicy' in patch && (typeof patch.dirtyPolicy !== 'string' || !['ask', 'continue', 'stop'].includes(patch.dirtyPolicy))) throw new Error('未保存内容策略无效');
  for (const key of ['completionSound', 'autoCopyResults']) if (key in patch && typeof patch[key] !== 'boolean') throw new Error('开关参数须为布尔值');
  return patch as ToolSettingsPatch;
}

export function registerToolSettingsIpc(ipc: Pick<IpcMain, 'handle'>, options: {
  editor: WebContents; panel: () => WebContents | null; current: () => boolean;
  viewport: () => { width: number; height: number }; getState: () => ToolSettingsState;
  open: (anchor: ToolSettingsAnchor) => Promise<void>; close: () => void;
  configure: (patch: ToolSettingsPatch) => Promise<unknown>; clearRules: () => Promise<unknown>;
}): string[] {
  ipc.handle(CHANNELS.openToolSettings, async (event, ...args: unknown[]) => {
    if (event.sender !== options.editor || event.senderFrame !== options.editor.mainFrame) throw new Error('设置浮层仅供编辑器主 frame 打开');
    const input = args[0];
    if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('浮层定位参数无效');
    const anchor = input as ToolSettingsAnchor; const viewport = options.viewport();
    if (Object.keys(anchor).length !== 4 || !['x', 'y', 'width', 'height'].every(key => typeof anchor[key as keyof ToolSettingsAnchor] === 'number' && Number.isFinite(anchor[key as keyof ToolSettingsAnchor])) ||
      anchor.x < 0 || anchor.y < 0 || anchor.width <= 0 || anchor.height <= 0 || anchor.width > 128 || anchor.height > 128 || anchor.x + anchor.width > viewport.width + 1 || anchor.y + anchor.height > viewport.height + 1) throw new Error('浮层定位必须位于当前编辑器视口内');
    await options.open(anchor);
  });
  const actions = [CHANNELS.getToolSettingsState, CHANNELS.setToolSettings, CHANNELS.clearToolRules, CHANNELS.closeToolSettings] as const;
  for (const channel of actions) ipc.handle(channel, async (event, ...args: unknown[]) => {
    const panel = options.panel();
    if (!panel || event.sender !== panel || event.senderFrame !== panel.mainFrame) throw new Error('设置操作仅供独立浮层主 frame 使用');
    if (args.length !== (channel === CHANNELS.setToolSettings ? 1 : 0)) throw new Error('设置操作参数数量无效');
    if (channel !== CHANNELS.getToolSettingsState && channel !== CHANNELS.closeToolSettings && !options.current()) throw new Error('设置浮层已关闭或项目已变化');
    if (channel === CHANNELS.setToolSettings) {
      const patch = settingsPatch(args[0]);
      if (options.getState().storageError) throw new Error('工具记录未加载，设置不可用');
      await options.configure(patch);
    } else if (channel === CHANNELS.clearToolRules) {
      const state = options.getState();
      if (!state.hasProject || state.busy || state.storageError) throw new Error('当前不能清除项目规则');
      await options.clearRules();
    } else if (channel === CHANNELS.closeToolSettings) options.close();
    return options.getState();
  });
  return [CHANNELS.openToolSettings, ...actions];
}
