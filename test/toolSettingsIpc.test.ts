import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { CHANNELS } from '../src/shared/contract';
import type { ToolState } from '../src/shared/toolProtocol';
import { registerToolSettingsIpc, toolSettingsState } from '../src/main/toolSettingsIpc';

function fixture() {
  const handlers = new Map<string, Function>(); const calls: unknown[] = [];
  const editor = { mainFrame: {} } as WebContents, panel = { mainFrame: {} } as WebContents;
  let current = true;
  const state = toolSettingsState({ config: { permission: 'full', automatic: true, dirtyPolicy: 'ask', sendIntervalSeconds: 3, completionSound: false, autoCopyResults: true }, busy: false,
    results: [{ batch_id: 'batch', request_id: 'read', tool: 'read_file', status: 'done', data: { text: 'private file' } }], message: 'private output' }, true);
  const channels = registerToolSettingsIpc({ handle(channel, handler) { handlers.set(channel, handler); } }, {
    editor, panel: () => panel, current: () => current, viewport: () => ({ width: 1200, height: 800 }), getState: () => state,
    open: async anchor => { calls.push(anchor); }, close: () => { calls.push('close'); },
    configure: async patch => { calls.push(patch); Object.assign(state.config, patch); }, clearRules: async () => { calls.push('clear'); },
  });
  const event = (sender: WebContents) => ({ sender, senderFrame: sender.mainFrame }) as IpcMainInvokeEvent;
  return { state, calls, channels, editor, panel, event, setCurrent(value: boolean) { current = value; },
    invoke(channel: string, input = event(panel), ...args: unknown[]) { return handlers.get(channel)!(input, ...args); } };
}

it('浮层只读状态不携带工具正文、路径或完成结果，查询不保存配置', async () => {
  const f = fixture(); const state = await f.invoke(CHANNELS.getToolSettingsState);
  assert.deepEqual(Object.keys(state).sort(), ['busy', 'config', 'hasProject']); assert.doesNotMatch(JSON.stringify(state), /private|results/);
  assert.deepEqual(f.calls, []);
});
it('仅编辑器主 frame 可打开，设置修改仅专用浮层主 frame 可调用', async () => {
  const f = fixture();
  for (const channel of f.channels) {
    const owner = channel === CHANNELS.openToolSettings ? f.editor : f.panel;
    for (const input of [{ sender: {}, senderFrame: owner.mainFrame }, { sender: owner, senderFrame: {} }, f.event(channel === CHANNELS.openToolSettings ? f.panel : f.editor)]) {
      await assert.rejects(f.invoke(channel, input as IpcMainInvokeEvent), /主 frame/);
    }
  }
  assert.deepEqual(f.calls, []);
});
it('定位限定编辑器当前视口，参数不能携带路径和任意位置', async () => {
  const f = fixture(); const anchor = { x: 1000, y: 700, width: 30, height: 30 };
  await f.invoke(CHANNELS.openToolSettings, f.event(f.editor), anchor); assert.deepEqual(f.calls, [anchor]);
  for (const invalid of [{ ...anchor, x: -1 }, { ...anchor, x: 1500 }, { ...anchor, width: 200 }, { ...anchor, height: NaN }, { ...anchor, path: 'C:\\file' }]) {
    await assert.rejects(f.invoke(CHANNELS.openToolSettings, f.event(f.editor), invalid), /视口内/);
  }
  assert.equal(f.calls.length, 1);
});
it('只能保存四项声明式设置，不能提升权限、开启 automatic 或调用文件/命令', async () => {
  const f = fixture();
  for (const patch of [{ permission: 'full' }, { automatic: true }, { path: 'C:\\file' }, { command: 'anything' }, { sendIntervalSeconds: -1 },
    { sendIntervalSeconds: 301 }, { sendIntervalSeconds: 0.5 }, { dirtyPolicy: ['ask'] }, { completionSound: 1 }, {}]) {
    await assert.rejects(f.invoke(CHANNELS.setToolSettings, undefined, patch), /配置字段|整数|策略|布尔/);
  }
  assert.deepEqual(f.calls, []);
  const patch = { sendIntervalSeconds: 0, dirtyPolicy: 'stop', completionSound: true, autoCopyResults: false };
  await f.invoke(CHANNELS.setToolSettings, undefined, patch); assert.deepEqual(f.calls, [patch]); assert.equal(f.state.config.dirtyPolicy, 'stop');
});
it('关闭或切项目使旧浮层修改失效，忙碌/无项目/存储损坏时不清除规则', async () => {
  const f = fixture(); f.setCurrent(false);
  for (const channel of [CHANNELS.setToolSettings, CHANNELS.clearToolRules]) {
    await assert.rejects(f.invoke(channel, undefined, ...(channel === CHANNELS.setToolSettings ? [{ autoCopyResults: false }] : [])), /已关闭或项目已变化/);
  }
  f.setCurrent(true);
  for (const patch of [{ busy: true }, { hasProject: false }, { storageError: 'corrupt' }]) {
    Object.assign(f.state, { busy: false, hasProject: true, storageError: undefined }, patch);
    await assert.rejects(f.invoke(CHANNELS.clearToolRules), /不能清除/);
  }
  assert.deepEqual(f.calls, []);
});
it('清理和关闭均为无参数动作，浮层不提供提示词编辑通道', async () => {
  const f = fixture();
  for (const channel of [CHANNELS.getToolSettingsState, CHANNELS.clearToolRules, CHANNELS.closeToolSettings]) {
    await assert.rejects(f.invoke(channel, undefined, { root: 'other' }), /参数数量/);
  }
  await f.invoke(CHANNELS.clearToolRules); await f.invoke(CHANNELS.closeToolSettings);
  assert.deepEqual(f.calls, ['clear', 'close']);
  assert.ok(!f.channels.includes('tools:open-prompt-settings'));
});
