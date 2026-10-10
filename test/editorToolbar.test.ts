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
    'context-menu-wrap': wrap, 'btn-copy-context': trigger, 'context-menu': menu, 'tree-root-path': root,
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

it('项目路径只在目录区显示，完整路径保留在悬停提示', () => {
  const ui = editor(); ui.toolbar.renderRoot('C:\\Users\\胡运宽\\Desktop\\test');
  assert.equal(ui.root.textContent, 'C:\\Users\\胡运宽\\Desktop\\test'); assert.equal(ui.root.title, 'C:\\Users\\胡运宽\\Desktop\\test');
  ui.toolbar.renderRoot(null); assert.equal(ui.root.textContent, '未选择项目');
  ui.toolbar.renderRoot('C:\\'); assert.equal(ui.root.textContent, 'C:\\');
});

function webbar(overrides: Record<string, unknown> = {}) {
  const ids = ['bar', 'btn-collect', 'collect-status', 'btn-file-restore', 'btn-workspace-toggle', 'tool-workspace-status', 'btn-tool-workspace'];
  const nodes = Object.fromEntries(ids.map(id => [id, node()]));
  nodes['btn-workspace-toggle'].hidden = false;
  let chrome: (value: unknown) => void = () => {};
  let toolStatus: (value: unknown) => void = () => {};
  const widths: number[] = [];
  const bridge = {
    async restoreFileWorkspace() { return {}; },
    async toggleWorkspace() { return {}; },
    async setPreviewPanel(width: number) { widths.push(width); return { width, visible: width > 0 }; },
    async collectReply() { return { ok: true, blocks: [1, 2] }; },
    onChromeState(fn: typeof chrome) { chrome = fn; },
    async getToolWorkspaceStatus() { return { phase: 'idle', message: '工具空闲', count: 0, automatic: false }; },
    async openToolWorkspace() { return {}; },
    onToolWorkspaceStatus(fn: typeof toolStatus) { toolStatus = fn; },
    ...overrides,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/webbar.js'), 'utf8'), {
    window: { webbarBridge: bridge, setTimeout() {}, clearTimeout() {} },
    document: { getElementById(id: string) { return nodes[id]; } },
  });
  return { nodes, widths, publish(value: unknown) { chrome(value); }, publishTools(value: unknown) { toolStatus(value); } };
}

it('官网顶栏在 DeepSeek 左侧固定提供工作区切换，不提供网页显隐或 Diff 布局接口', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/webbar.html'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/webbarPreload.ts'), 'utf8');
  assert.doesNotMatch(html, /id="btn-(web|preview-toggle|restore)"/);
  assert.doesNotMatch(preload, /setWebVisible|setPreviewPanel/);
  assert.match(html, /id="btn-workspace-toggle"[^>]*aria-pressed="true"/);
  assert.ok(html.indexOf('id="btn-workspace-toggle"') < html.indexOf('class="webbar-title"'));
  assert.match(preload, /collectReply/);
  assert.match(preload, /toggleWorkspace/);
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


it('工作区切换按钮固定在 DeepSeek 左侧，文件区收起后提供单独恢复入口', async () => {
  let restoredFiles = 0; let toggledWorkspace = 0;
  const ui = webbar({ restoreFileWorkspace: async () => { restoredFiles++; }, toggleWorkspace: async () => { toggledWorkspace++; } });
  ui.publish({ fileVisible: true, layout: { workspaceVisible: false } });
  assert.equal(ui.nodes['btn-workspace-toggle'].hidden, false);
  assert.equal(ui.nodes['btn-workspace-toggle'].title, '展开工作区');
  await ui.nodes['btn-workspace-toggle'].fire('click'); assert.equal(toggledWorkspace, 1);
  ui.publish({ fileVisible: true, layout: { workspaceVisible: true } });
  assert.equal(ui.nodes['btn-workspace-toggle'].hidden, false);
  assert.equal(ui.nodes['btn-workspace-toggle'].title, '收起工作区');
  ui.publish({ fileVisible: false }); assert.equal(ui.nodes['btn-file-restore'].hidden, false);
  await ui.nodes['btn-file-restore'].fire('click'); assert.equal(restoredFiles, 1);
  ui.publish({ fileVisible: true, layout: { workspaceVisible: true } });
  assert.equal(ui.nodes['btn-file-restore'].hidden, true);
});

it('工具详情可从顶栏零参数恢复，状态广播只更新摘要不主动打开标签', async () => {
  let opened = 0;
  const ui = webbar({ openToolWorkspace: async (...args: unknown[]) => { assert.equal(args.length, 0); opened++; } });
  ui.publishTools({ phase: 'approval', message: '工具需要批准', count: 2, automatic: true });
  assert.equal(opened, 0); assert.equal(ui.nodes['tool-workspace-status'].textContent, '工具需要批准 · 2 项');
  assert.equal(ui.nodes['tool-workspace-status'].classList.contains('warn'), true);
  await ui.nodes['btn-tool-workspace'].fire('click'); assert.equal(opened, 1);
  ui.publishTools({ phase: 'waiting_user', message: '等待需求或新的工具结果', count: 0, automatic: false });
  assert.equal(ui.nodes['tool-workspace-status'].classList.contains('warn'), false);
  assert.match(ui.nodes['tool-workspace-status'].title, /自动继续：关/);
});

it('首次状态查询迟到不能覆盖新广播，倒计时使用主进程 dueAt', async () => {
  let resolve: (value: unknown) => void = () => {};
  const ui = webbar({ getToolWorkspaceStatus: () => new Promise(yes => { resolve = yes; }) });
  ui.publishTools({ phase: 'countdown', message: '工具结果等待回传', count: 1, automatic: true, dueAt: Date.now() + 3000 });
  assert.match(ui.nodes['tool-workspace-status'].textContent, /3 秒后回传/);
  resolve({ phase: 'idle', message: '工具空闲', count: 0, automatic: false });
  await Promise.resolve();
  assert.match(ui.nodes['tool-workspace-status'].textContent, /等待回传/);
});
