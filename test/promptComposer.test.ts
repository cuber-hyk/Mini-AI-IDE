import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';
import { FORMAT_SPEC } from '../src/shared/formatSpec';
import { buildWholeFileText } from '../src/shared/snippet';

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/promptComposer.js'), 'utf8');
const panelSource = fs.readFileSync(path.join(__dirname, '../src/renderer/prompt.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
type Status = { isCustom: boolean };

function element(variant = '') {
  const listeners: Record<string, (event: unknown) => unknown> = {};
  return {
    dataset: { variant }, style: {} as Record<string, string>, attrs: {} as Record<string, string>,
    disabled: false, hidden: true, textContent: '', value: '',
    clientWidth: 500, scrollHeight: 40, focused: false,
    addEventListener(name: string, fn: (event: unknown) => unknown) { listeners[name] = fn; },
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    focus() { this.focused = true; },
    fire(name: string, event = {}) { return listeners[name]?.(event); },
    querySelectorAll: (_selector: string): ReturnType<typeof element>[] => [],
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const input = element(); const custom = element();
  const requirementPanel = { ...element(), open: true };
  const actions = { offsetHeight: 30 };
  let current: Status = { isCustom: true };
  let listener: (status: Status) => void = () => {};
  let resized = () => {};
  let observer = () => {};
  let composerBusy = false;
  const messages: Array<{ text: string; warn: boolean }> = [];
  const writes: string[] = [];
  const nodes: Record<string, unknown> = {
    requirement: input, 'requirement-panel': requirementPanel, 'prompt-custom': custom, 'prompt-actions': actions,
  };
  const bridge = {
    async getPromptStatus() { return current; },
    onPromptStatus(fn: typeof listener) { listener = fn; },
    ...overrides,
  };
  const sandbox = {
    window: {
      innerHeight: 960,
      requestAnimationFrame(fn: () => void) { fn(); },
      addEventListener(_name: string, fn: () => void) { resized = fn; },
      setupPromptComposer: undefined as unknown as (bridge: unknown, info: unknown, local: unknown) => void,
    },
    ResizeObserver: class { constructor(fn: () => void) { observer = fn; } observe() {} },
    Event: class { constructor(readonly type: string) {} },
    document: { getElementById: (id: string) => nodes[id], dispatchEvent() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  sandbox.window.setupPromptComposer(bridge, (text: string, warn = false) => messages.push({ text, warn }), {
    setComposerBusy(value: boolean) { composerBusy = value; }, onBusy() {},
  });
  return { input, custom, requirementPanel, messages, writes,
    narrow() { sandbox.window.innerHeight = 600; actions.offsetHeight = 80; resized(); },
    publish(next: Status) { current = next; listener(next); },
    resize() { resized(); }, observe() { observer(); },
    get composerBusy() { return composerBusy; },
};
}

it('收起需求保留草稿与高度，重新展开时按当前内容调整', () => {
  const ui = setup();
  ui.input.value = '需要保留的需求草稿';
  const before = ui.input.style.height;
  ui.requirementPanel.open = false;
  ui.input.scrollHeight = 170;
  ui.input.fire('input');
  assert.equal(ui.input.style.height, before);
  assert.equal(ui.input.value, '需要保留的需求草稿');
  ui.requirementPanel.open = true;
  ui.requirementPanel.fire('toggle');
  assert.equal(ui.input.style.height, '174px');
});

it('初始化与保存广播只更新唯一自定义状态，不存在版本切换', async () => {
  const ui = setup(); await flush();
  assert.equal(ui.custom.hidden, false); assert.equal(ui.composerBusy, false);
  assert.equal(ui.custom.attrs['aria-label'], '使用自定义提示词');
  ui.publish({ isCustom: false }); assert.equal(ui.custom.hidden, true);
});
it('初始查询晚于设置广播时，旧查询不会覆盖已生效的新设置', async () => {
  let resolve: (status: Status) => void = () => {};
  const ui = setup({ getPromptStatus: () => new Promise((yes) => { resolve = yes; }) });
  ui.publish({ isCustom: true });
  resolve({ isCustom: false }); await flush();
  assert.equal(ui.custom.hidden, false);
});
it('状态读取失败显式报告并保持提交禁用，设置广播后恢复', async () => {
  const ui = setup({ getPromptStatus: async () => { throw new Error('暂时不可用'); } });
  await flush(); assert.equal(ui.composerBusy, true);
  assert.match(ui.messages.at(-1)!.text, /读取提示词设置失败/);
  ui.publish({ isCustom: false }); assert.equal(ui.composerBusy, false);
});

it('长输入到上限后滚动；删除与宽度变化后收缩，观察高度变化不会循环增长', async () => {
  const ui = setup(); await flush();
  assert.equal(ui.input.style.height, '44px');
  ui.input.scrollHeight = 400; ui.input.fire('input');
  assert.equal(ui.input.style.height, '220px'); assert.equal(ui.input.style.overflowY, 'auto');
  ui.input.scrollHeight = 70; ui.resize(); assert.equal(ui.input.style.height, '74px');
  ui.input.scrollHeight = 100; ui.observe(); assert.equal(ui.input.style.height, '104px');
  ui.input.scrollHeight = 400; ui.observe(); assert.equal(ui.input.style.height, '104px');
  ui.input.clientWidth = 300; ui.observe(); assert.equal(ui.input.style.height, '220px');
  ui.input.scrollHeight = 40; ui.input.fire('input'); assert.equal(ui.input.style.height, '44px');
});

it('窄窗口操作栏换行后压缩长输入，常用控件仍保留高度预算', async () => {
  const ui = setup(); await flush(); ui.input.scrollHeight = 1000; ui.narrow();
  assert.equal(ui.input.style.height, '160px'); assert.equal(ui.input.style.overflowY, 'auto');
});

function panelFixture(fail = false, saveFail = false) {
  const names = ['close', 'editor', 'status', 'count', 'hint', 'usage', 'reset', 'cancel', 'save'];
  const nodes = Object.fromEntries(names.map(name => ['pm-' + name, Object.assign(element(), { className: '', classList: { toggle() {} } })]));
  const state = { maxLength: 10000, updatedAt: null, defaultSpec: FORMAT_SPEC, isCustom: true, customSpec: '\n我的自定义原文\n' as string | null };
  const saves: string[] = [];
  const sandbox = { window: { formatSpecDefaults: FORMAT_SPEC,
    setTimeout(fn: () => void) { fn(); }, promptBridge: {
      async getState() { if (fail) throw new Error('未能读取状态'); return state; },
      async save(text: string) {
        saves.push(text); if (saveFail) throw new Error('设置落盘失败');
        state.isCustom = text !== FORMAT_SPEC; state.customSpec = state.isCustom ? text : null;
        return { ok: true, state, resetToDefault: !state.isCustom };
      }, async close() {} } },
    document: { getElementById: (name: string) => nodes[name], addEventListener() {} } };
  vm.createContext(sandbox); vm.runInContext(panelSource, sandbox);
  return { nodes, state, saves };
}
it('唯一提示词编辑原文保留，恢复默认仅载入，保存后才替换生效内容', async () => {
  const f = panelFixture(); await flush();
  assert.equal(f.nodes['pm-editor'].value, f.state.customSpec);
  assert.match(f.nodes['pm-hint'].textContent, /请检查/);
  f.nodes['pm-reset'].fire('click'); assert.equal(f.nodes['pm-editor'].value, FORMAT_SPEC);
  assert.equal(f.saves.length, 0); assert.equal(f.state.customSpec, '\n我的自定义原文\n');
  await f.nodes['pm-save'].fire('click');
  assert.deepEqual(f.saves, [FORMAT_SPEC]); assert.equal(f.state.customSpec, null);
  assert.equal(f.nodes['pm-save'].disabled, true);
});
it('设置读取失败显示权威完整默认，但不能覆盖未知自定义', async () => {
  const f = panelFixture(true); await flush(); await flush(); await flush();
  assert.equal(f.nodes['pm-editor'].value, FORMAT_SPEC);
  assert.equal(f.nodes['pm-reset'].disabled, true); assert.equal(f.nodes['pm-save'].disabled, true);
  assert.match(f.nodes['pm-hint'].textContent, /读取设置失败/); assert.equal(f.saves.length, 0);
});
it('设置保存失败保留唯一草稿并可重试', async () => {
  const f = panelFixture(false, true); await flush();
  const draft = '\n未保存草稿\n'; f.nodes['pm-editor'].value = draft; f.nodes['pm-editor'].fire('input');
  await f.nodes['pm-save'].fire('click');
  assert.equal(f.nodes['pm-editor'].value, draft); assert.equal(f.nodes['pm-save'].disabled, false);
  assert.match(f.nodes['pm-hint'].textContent, /保存失败/); assert.equal(f.state.customSpec, '\n我的自定义原文\n');
});

it('选区复制没有全文回退，纯空白选区仍保留原文', async () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const handlers = renderer.slice(renderer.indexOf('  async function copyNumberedSelection()'), renderer.indexOf('  /* ---------------- 选区'));
  const snippets: any[] = []; let selected = false;
  const state: any = { root: 'C:/root', currentPath: 'a.txt', editor: {
    getModel: () => ({ getValueInRange: () => '  \n\t' }),
    getSelection: () => ({ isEmpty: () => !selected, startLineNumber: 6 }),
  } };
  const sandbox: any = { state, setInfo() {}, bridge: {
    async copyNumberedSnippet(input: any) { snippets.push(input); return { ok: true, startLine: 6, endLine: 7, length: 12 }; },
  } };
  vm.createContext(sandbox); vm.runInContext(handlers, sandbox);
  assert.equal(await sandbox.copyNumberedSelection(), false); assert.equal(snippets.length, 0);
  selected = true; assert.equal(await sandbox.copyNumberedSelection(), true);
  assert.equal(snippets[0].text, '  \n\t'); assert.equal(snippets[0].startLine, 6);
  state.currentPath = null; assert.equal(await sandbox.copyNumberedSelection(), false); assert.equal(snippets.length, 1);
  assert.doesNotMatch(renderer, /copyWholeFileContext|bridge\.copyWholeFile/);
});
