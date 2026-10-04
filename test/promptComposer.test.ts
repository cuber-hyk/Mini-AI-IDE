import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/promptComposer.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
type Status = { variant: string; shortIsCustom: boolean; fullIsCustom: boolean };

function element(variant = '') {
  const listeners: Record<string, (event: unknown) => unknown> = {};
  return {
    dataset: { variant }, style: {} as Record<string, string>, attrs: {} as Record<string, string>,
    disabled: false, hidden: true, textContent: '复制提示词', value: '',
    clientWidth: 500, scrollHeight: 40, focused: false,
    addEventListener(name: string, fn: (event: unknown) => unknown) { listeners[name] = fn; },
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    focus() { this.focused = true; },
    fire(name: string, event = {}) { return listeners[name]?.(event); },
    querySelectorAll: (_selector: string): ReturnType<typeof element>[] => [],
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const input = element(); const short = element('short'); const full = element('full');
  const sw = element(); const copy = element(); const custom = element();
  sw.querySelectorAll = () => [short, full];
  let current: Status = { variant: 'full', shortIsCustom: false, fullIsCustom: true };
  let listener: (status: Status) => void = () => {};
  let resized = () => {};
  let observer = () => {};
  let timer: (() => void) | undefined;
  const messages: Array<{ text: string; warn: boolean }> = [];
  const writes: string[] = [];
  const nodes: Record<string, unknown> = {
    requirement: input, 'variant-switch': sw, 'btn-copy-prompt': copy, 'prompt-custom': custom,
  };
  const bridge = {
    async getPromptStatus() { return current; },
    onPromptStatus(fn: typeof listener) { listener = fn; },
    async setFormatSpecVariant(v: string) { writes.push(v); current = { ...current, variant: v }; listener(current); return v; },
    async copyPrompt() { return { ok: true, length: 88 }; },
    ...overrides,
  };
  const sandbox = {
    window: {
      requestAnimationFrame(fn: () => void) { fn(); },
      addEventListener(_name: string, fn: () => void) { resized = fn; },
      setTimeout(fn: () => void) { timer = fn; return 1; },
      clearTimeout() { timer = undefined; },
      setupPromptComposer: undefined as unknown as (bridge: unknown, info: unknown) => void,
    },
    ResizeObserver: class { constructor(fn: () => void) { observer = fn; } observe() {} },
    document: { getElementById: (id: string) => nodes[id] },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  sandbox.window.setupPromptComposer(bridge, (text: string, warn = false) => messages.push({ text, warn }));
  return { input, short, full, sw, copy, custom, messages, writes,
    publish(next: Status) { current = next; listener(next); },
    resize() { resized(); }, observe() { observer(); }, expire() { timer?.(); },
  };
}

it('读取持久化版本，并在切换、保存或恢复默认后显示对应自定义状态', async () => {
  const ui = setup(); await flush();
  assert.equal(ui.sw.dataset.variant, 'full'); assert.equal(ui.custom.hidden, false);
  ui.short.fire('click'); await flush();
  assert.deepEqual(ui.writes, ['short']); assert.equal(ui.custom.hidden, true);
  ui.publish({ variant: 'short', shortIsCustom: true, fullIsCustom: true });
  assert.equal(ui.custom.hidden, false);
  ui.publish({ variant: 'short', shortIsCustom: false, fullIsCustom: true });
  assert.equal(ui.custom.hidden, true);
});

it('切换失败保持实际版本；切换期间禁止复制，避免界面与发出的版本不同', async () => {
  let reject: (err: Error) => void = () => {};
  const ui = setup({ setFormatSpecVariant: () => new Promise((_resolve, no) => { reject = no; }) });
  await flush(); ui.short.fire('click');
  assert.equal(ui.copy.disabled, true);
  reject(new Error('落盘失败')); await flush();
  assert.equal(ui.sw.dataset.variant, 'full'); assert.equal(ui.copy.disabled, false);
  assert.match(ui.messages.at(-1)!.text, /切换.*失败/);
});

it('子按钮的原生键盘点击只切换一次，容器键盘操作也能切换', async () => {
  const ui = setup(); await flush();
  ui.sw.fire('keydown', { target: ui.short, key: 'Enter', preventDefault() { throw new Error('不应拦截子按钮'); } });
  assert.equal(ui.writes.length, 0);
  ui.short.fire('click'); await flush();
  ui.sw.fire('keydown', { target: ui.sw, key: ' ', preventDefault() {} }); await flush();
  assert.deepEqual(ui.writes, ['short', 'full']);
});

it('初始查询晚于设置广播时，旧查询不会覆盖已生效的新设置', async () => {
  let resolve: (status: Status) => void = () => {};
  const ui = setup({ getPromptStatus: () => new Promise((yes) => { resolve = yes; }) });
  ui.publish({ variant: 'short', shortIsCustom: true, fullIsCustom: false });
  resolve({ variant: 'full', shortIsCustom: false, fullIsCustom: false }); await flush();
  assert.equal(ui.sw.dataset.variant, 'short'); assert.equal(ui.custom.hidden, false);
});

it('读取和连续重试都失败时保留版本按钮，服务恢复后能继续切换并复制', async () => {
  let available = false;
  const ui = setup({
    getPromptStatus: async () => {
      if (!available) throw null;
      return { variant: 'short', shortIsCustom: false, fullIsCustom: false };
    },
    setFormatSpecVariant: async () => {
      if (!available) throw new Error('暂时不可用');
      return 'short';
    },
  });
  await flush();
  assert.equal(ui.copy.disabled, true); assert.equal(ui.short.disabled, false);
  for (let i = 0; i < 2; i++) {
    ui.short.fire('click'); await flush();
    assert.equal(ui.short.disabled, false); assert.equal(ui.copy.disabled, true);
  }
  available = true; ui.short.fire('click'); await flush();
  assert.equal(ui.sw.dataset.variant, 'short'); assert.equal(ui.copy.disabled, false);
});

it('空需求聚焦输入；复制成功反馈复位；异常与结构化失败均不显示成功', async () => {
  const ok = setup(); await flush(); await ok.copy.fire('click');
  assert.equal(ok.input.focused, true);
  ok.input.value = '修改标题'; await ok.copy.fire('click');
  assert.equal(ok.copy.textContent, '已复制'); assert.equal(ok.copy.disabled, false);
  ok.expire(); assert.equal(ok.copy.textContent, '复制提示词');
  for (const copyPrompt of [async () => { throw new Error('IPC 失败'); }, async () => ({ ok: false, error: '没有目录' })]) {
    const ui = setup({ copyPrompt }); await flush(); ui.input.value = '修改标题';
    await ui.copy.fire('click');
    assert.equal(ui.copy.textContent, '复制提示词'); assert.equal(ui.copy.disabled, false);
    assert.match(ui.messages.at(-1)!.text, /复制提示词失败/);
  }
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
