import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

function node() {
  const listeners: Record<string, Function[]> = {}, classes = new Set<string>();
  return { value: '', checked: false, disabled: false, textContent: '',
    addEventListener(type: string, fn: Function) { (listeners[type] ??= []).push(fn); },
    async fire(type: string, extra = {}) { await Promise.all((listeners[type] ?? []).map(fn => fn({ preventDefault() {}, ...extra }))); },
    classList: { toggle(key: string, on: boolean) { if (on) classes.add(key); else classes.delete(key); }, contains(key: string) { return classes.has(key); } },
    set innerHTML(_value: string) { throw new Error('Settings must use textContent'); },
  };
}
const initial = () => ({ config: { permission: 'full', automatic: true, dirtyPolicy: 'ask', sendIntervalSeconds: 3, completionSound: false, autoCopyResults: true }, busy: false, hasProject: true });
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function fixture(overrides: Record<string, unknown> = {}, AudioContext?: unknown) {
  const ids = ['tool-send-interval', 'tool-interval-down', 'tool-interval-up', 'tool-dirty-policy', 'tool-completion-sound', 'tool-auto-copy', 'tool-clear-rules', 'tool-settings-notice', 'tool-permission-hint', 'tool-settings-close', 'btn-settings'];
  const nodes = Object.fromEntries(ids.map(id => [id, node()])); let current = initial(), publish: (state: any) => void = () => {};
  const calls: unknown[] = [];
  const bridge = { getState: async () => current, onState(fn: typeof publish) { publish = fn; },
    async configure(patch: any) { calls.push(JSON.parse(JSON.stringify(patch))); current = { ...current, config: { ...current.config, ...patch } }; return current; },
    async clearRules() { calls.push('clear'); return current; }, async openPrompt() { calls.push('prompt'); }, async close() { calls.push('close'); }, ...overrides };
  const document = { ...node(), activeElement: null as unknown, getElementById(id: string) { return nodes[id]; } };
  const window = { ...node(), toolSettingsBridge: bridge, AudioContext };
  const context = { window, document };
  for (const name of ['toolCompletionSound.js', 'toolSettings.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8'), context);
  return { nodes, calls, document, publish(value: any) { current = value; publish(value); } };
}
function audioMock() {
  let plays = 0; const volumes: number[] = [];
  class AudioContext {
    state = 'suspended'; currentTime = 0; destination = {};
    async resume() { this.state = 'running'; }
    createOscillator() { return { type: '', frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start() { plays++; }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime(value: number) { volumes.push(value); }, linearRampToValueAtTime(value: number) { volumes.push(value); } }, connect() {}, disconnect() {} }; }
  }
  return { AudioContext, volumes, get plays() { return plays; } };
}

it('所有设置控件只在专用浮层模板存在，编辑器仅保留原生窗口触发按钮', () => {
  const native = fs.readFileSync(path.join(__dirname, '../src/renderer/toolSettings.html'), 'utf8');
  const editor = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const f = fixture();
  for (const id of Object.keys(f.nodes)) { assert.ok(native.includes('id="' + id + '"'), id); assert.ok(!editor.includes('id="' + id + '"'), id); }
  assert.match(editor, /id="tool-settings-toggle"/); assert.doesNotMatch(editor, /id="tool-settings-panel"/);
});

it('浮层初始读取不写配置或预听，间隔加减按一秒保存且上下界禁用', async () => {
  const audio = audioMock(), f = fixture({}, audio.AudioContext); await flush();
  assert.equal(f.nodes['tool-send-interval'].value, '3'); assert.deepEqual(f.calls, []); assert.equal(audio.plays, 0);
  await f.nodes['tool-interval-up'].fire('click'); await flush(); assert.equal(f.nodes['tool-send-interval'].value, '4');
  await f.nodes['tool-interval-down'].fire('click'); await flush(); assert.equal(f.nodes['tool-send-interval'].value, '3');
  f.publish({ ...initial(), config: { ...initial().config, sendIntervalSeconds: 0 } }); assert.equal(f.nodes['tool-interval-down'].disabled, true);
  f.publish({ ...initial(), config: { ...initial().config, sendIntervalSeconds: 300 } }); assert.equal(f.nodes['tool-interval-up'].disabled, true);
});
it('间隔拒绝空值、小数及越界，未保存策略与自动复制只保存用户选择', async () => {
  const f = fixture(); await flush();
  for (const input of ['', '0.5', '-1', '301']) { f.nodes['tool-send-interval'].value = input; await f.nodes['tool-send-interval'].fire('change'); assert.equal(f.calls.length, 0); }
  f.nodes['tool-dirty-policy'].value = 'stop'; await f.nodes['tool-dirty-policy'].fire('change'); await flush();
  f.nodes['tool-auto-copy'].checked = false; await f.nodes['tool-auto-copy'].fire('change'); await flush();
  assert.deepEqual(f.calls, [{ dirtyPolicy: 'stop' }, { autoCopyResults: false }]);
  assert.equal(f.nodes['tool-auto-copy'].checked, false);
});
it('保存失败恢复真实配置并显示错误，保存中不提交第二次用户更改', async () => {
  let reject!: (error: Error) => void;
  const f = fixture({ configure: () => new Promise((_resolve, fail) => { reject = fail; }) }); await flush();
  f.nodes['tool-auto-copy'].checked = false; await f.nodes['tool-auto-copy'].fire('change'); await flush();
  assert.equal(f.nodes['tool-auto-copy'].disabled, true);
  await f.nodes['tool-interval-up'].fire('click'); reject(new Error('cannot persist')); await flush();
  assert.equal(f.nodes['tool-auto-copy'].checked, true); assert.equal(f.nodes['tool-auto-copy'].disabled, false);
  assert.match(f.nodes['tool-settings-notice'].textContent, /cannot persist/);
});
it('旧查询快照不会覆盖更新广播，运行状态广播不清除正在编辑的间隔', async () => {
  let finish!: (value: any) => void;
  const f = fixture({ getState: () => new Promise(resolve => { finish = resolve; }) });
  f.publish({ ...initial(), config: { ...initial().config, sendIntervalSeconds: 8 } }); finish(initial()); await flush();
  assert.equal(f.nodes['tool-send-interval'].value, '8');
  f.document.activeElement = f.nodes['tool-send-interval']; f.nodes['tool-send-interval'].value = '12';
  f.publish({ ...initial(), busy: true }); assert.equal(f.nodes['tool-send-interval'].value, '12');
});
it('清除规则只由点击触发，无项目、忙碌及记录损坏时禁用', async () => {
  const f = fixture(); await flush(); assert.deepEqual(f.calls, []);
  for (const patch of [{ hasProject: false }, { busy: true }, { storageError: 'bad record' }]) {
    f.publish({ ...initial(), ...patch }); await f.nodes['tool-clear-rules'].fire('click'); assert.equal(f.calls.length, 0);
  }
  f.publish(initial()); await f.nodes['tool-clear-rules'].fire('click'); await flush(); assert.deepEqual(f.calls, ['clear']);
  assert.match(f.nodes['tool-settings-notice'].textContent, /已清除本项目/);
});
it('关闭与 Escape 调同一窄入口，编辑提示词通过独立入口打开', async () => {
  const f = fixture(); await flush();
  await f.nodes['tool-settings-close'].fire('click'); await f.document.fire('keydown', { key: 'Escape' }); await f.nodes['btn-settings'].fire('click');
  assert.deepEqual(f.calls, ['close', 'close', 'prompt']);
});
it('开启音效先保存，成功后只预听一次；重新读取及关闭不播放', async () => {
  const audio = audioMock(), f = fixture({}, audio.AudioContext); await flush();
  f.nodes['tool-completion-sound'].checked = true; await f.nodes['tool-completion-sound'].fire('change');
  assert.equal(audio.plays, 1); assert.deepEqual(f.calls, [{ completionSound: true }]); assert.ok(Math.max(...audio.volumes) <= 0.035);
  f.publish({ ...initial(), config: { ...initial().config, completionSound: true } }); assert.equal(audio.plays, 1);
  f.nodes['tool-completion-sound'].checked = false; await f.nodes['tool-completion-sound'].fire('change'); assert.equal(audio.plays, 1);
});
it('音效配置保存失败和迟到的准备结果不能播放被取消的预听', async () => {
  const audio = audioMock(), failed = fixture({ configure: async () => { throw new Error('not saved'); } }, audio.AudioContext); await flush();
  failed.nodes['tool-completion-sound'].checked = true; await failed.nodes['tool-completion-sound'].fire('change');
  assert.equal(audio.plays, 0); assert.equal(failed.nodes['tool-completion-sound'].checked, false);
  let resume!: () => void; let played = 0;
  class DelayedAudio { state = 'suspended'; resume() { return new Promise<void>(resolve => { resume = () => { this.state = 'running'; resolve(); }; }); } createOscillator() { played++; throw new Error('Must not play'); } }
  const f = fixture({}, DelayedAudio); await flush(); f.nodes['tool-completion-sound'].checked = true;
  const enabling = f.nodes['tool-completion-sound'].fire('change'); await flush();
  f.nodes['tool-completion-sound'].checked = false; await f.nodes['tool-completion-sound'].fire('change'); resume(); await enabling; assert.equal(played, 0);
});
