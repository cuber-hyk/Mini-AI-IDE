import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

function node() {
  const listeners: Record<string, Array<(event: any) => unknown>> = {};
  const classes = new Set<string>();
  return {
    hidden: true, disabled: false, textContent: '', title: '', focused: false,
    attrs: {} as Record<string, string>,
    classList: {
      add(name: string) { classes.add(name); }, remove(name: string) { classes.delete(name); },
      contains(name: string) { return classes.has(name); },
      toggle(name: string, force: boolean) { if (force) classes.add(name); else classes.delete(name); },
    },
    addEventListener(name: string, handler: (event: any) => unknown) { (listeners[name] ??= []).push(handler); },
    fire(name: string, event: any = {}) { return Promise.all((listeners[name] ?? []).map(fn => fn(event))); },
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    focus() { this.focused = true; },
    contains: (_value: unknown): boolean => false,
    querySelectorAll: (_selector: string): any[] => [],
  };
}

function editor() {
  const wrap = node(); const trigger = node(); const menu = node(); const root = node();
  const whole = node(); const snippet = node(); const doc = node();
  const nodes: Record<string, ReturnType<typeof node>> = {
    'context-menu-wrap': wrap, 'btn-copy-context': trigger, 'context-menu': menu, 'root-label': root,
  };
  menu.querySelectorAll = () => [whole, snippet];
  wrap.contains = (value: unknown) => [wrap, trigger, menu, whole, snippet].includes(value as any);
  const timers: Array<() => void> = [];
  const context = {
    window: { setupEditorToolbar: null as any, setTimeout(fn: () => void) { timers.push(fn); } },
    document: { getElementById(id: string) { return nodes[id]; }, addEventListener: doc.addEventListener },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/editorToolbar.js'), 'utf8'), context);
  const toolbar = context.window.setupEditorToolbar();
  return { wrap, trigger, menu, root, whole, snippet, doc, toolbar, timers };
}

it('复制菜单保留复制监听，选项点击关闭菜单并回到入口', async () => {
  const ui = editor(); let copied = 0;
  ui.whole.addEventListener('click', () => copied++);
  await ui.trigger.fire('click');
  assert.equal(ui.menu.hidden, false); assert.equal(ui.trigger.attrs['aria-expanded'], 'true');
  assert.equal(ui.whole.focused, true);
  await ui.whole.fire('click');
  assert.equal(copied, 1); assert.equal(ui.menu.hidden, true); assert.equal(ui.trigger.focused, true);
});

it('复制菜单支持方向键、首尾键与 Escape，外点和离开焦点不会抢焦点', async () => {
  const ui = editor(); const event = (key: string, target: unknown = ui.trigger) => ({ key, target, preventDefault() {} });
  await ui.trigger.fire('keydown', event('ArrowUp'));
  assert.equal(ui.snippet.focused, true);
  await ui.wrap.fire('keydown', event('ArrowDown', ui.snippet)); assert.equal(ui.whole.focused, true);
  ui.snippet.focused = false;
  await ui.wrap.fire('keydown', event('End', ui.whole)); assert.equal(ui.snippet.focused, true);
  await ui.wrap.fire('keydown', event('Escape', ui.snippet)); assert.equal(ui.menu.hidden, true);
  await ui.trigger.fire('click'); ui.trigger.focused = false;
  await ui.doc.fire('pointerdown', { target: ui.root });
  assert.equal(ui.menu.hidden, true); assert.equal(ui.trigger.focused, false);
  await ui.trigger.fire('click');
  await ui.wrap.fire('focusout', { relatedTarget: ui.root }); assert.equal(ui.menu.hidden, true);
});

it('目录路径以末两级显示，完整路径保留在悬停提示', () => {
  const ui = editor(); ui.toolbar.renderRoot('C:\\Users\\胡运宽\\Desktop\\test');
  assert.equal(ui.root.textContent, 'Desktop / test'); assert.equal(ui.root.title, 'C:\\Users\\胡运宽\\Desktop\\test');
  ui.toolbar.renderRoot(null); assert.equal(ui.root.textContent, '未打开目录');
  ui.toolbar.renderRoot('C:\\'); assert.equal(ui.root.textContent, 'C:');
});

it('Tab 允许离开菜单，Shift+Tab 回到入口，菜单不困住键盘焦点', async () => {
  const ui = editor(); await ui.trigger.fire('click');
  let prevented = false;
  await ui.wrap.fire('keydown', { key: 'Tab', target: ui.whole, shiftKey: false,
    preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  ui.timers.forEach(fn => fn()); assert.equal(ui.menu.hidden, true);
  await ui.trigger.fire('click');
  await ui.wrap.fire('keydown', { key: 'Tab', target: ui.snippet, shiftKey: true,
    preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(ui.menu.hidden, true); assert.equal(ui.trigger.focused, true);
});

function webbar(overrides: Record<string, unknown> = {}) {
  const ids = ['bar', 'btn-web', 'btn-preview-toggle', 'btn-restore', 'btn-collect', 'collect-status'];
  const nodes = Object.fromEntries(ids.map(id => [id, node()]));
  let chrome: (value: unknown) => void = () => {};
  const widths: number[] = [];
  const bridge = {
    async setWebVisible(visible: boolean) { return { visible }; },
    async setPreviewPanel(width: number) { widths.push(width); return { width, visible: width > 0 }; },
    async collectReply() { return { ok: true, blocks: [1, 2] }; },
    onChromeState(fn: typeof chrome) { chrome = fn; },
    ...overrides,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/webbar.js'), 'utf8'), {
    window: { webbarBridge: bridge, setTimeout() {}, clearTimeout() {} },
    document: { getElementById(id: string) { return nodes[id]; } },
  });
  return { nodes, widths, publish(value: unknown) { chrome(value); } };
}

it('网页隐藏不清空变更列表状态，恢复列表沿用用户宽度', async () => {
  const ui = webbar(); const preview = ui.nodes['btn-preview-toggle'];
  ui.publish({ webVisible: true, previewVisible: true, previewWidth: 360 });
  await ui.nodes['btn-web'].fire('click');
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(ui.nodes.bar.classList.contains('handle-mode'), true);
  assert.equal(preview.attrs['aria-pressed'], 'true');
  await preview.fire('click'); await preview.fire('click');
  assert.deepEqual(ui.widths, [0, 360]);
});

it('采集过程中拒绝重复请求，失败恢复按钮并提供可重试的诊断', async () => {
  let reject: (reason: unknown) => void = () => {}; let requests = 0;
  const ui = webbar({ collectReply: () => { requests++; return new Promise((_yes, no) => { reject = no; }); } });
  const button = ui.nodes['btn-collect'];
  const pending = button.fire('click'); await button.fire('click');
  assert.equal(requests, 1); assert.equal(button.disabled, true);
  reject('网页不可用'); await pending;
  assert.equal(button.disabled, false); assert.equal(button.textContent, '采集回复');
  assert.match(button.title, /采集失败.*网页不可用/);
  assert.equal(ui.nodes['collect-status'].classList.contains('warn'), true);
});

it('成功采集在网页栏显示变更数量，重复回复提供无新内容反馈', async () => {
  const ui = webbar(); await ui.nodes['btn-collect'].fire('click');
  assert.equal(ui.nodes['collect-status'].textContent, '已采集 2 个变更');
  const duplicate = webbar({ collectReply: async () => ({ ok: true, noNewContent: true }) });
  await duplicate.nodes['btn-collect'].fire('click');
  assert.match(duplicate.nodes['collect-status'].textContent, /无新内容/);
});
