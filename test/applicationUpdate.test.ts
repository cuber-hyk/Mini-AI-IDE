import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

function element() {
  const listeners: Record<string, Array<(event: any) => unknown>> = {};
  const classes = new Set<string>();
  return {
    hidden: false, disabled: false, textContent: '', title: '', focused: false, className: '', value: 0,
    attrs: {} as Record<string, string>, children: [] as any[],
    classList: { contains(name: string) { return classes.has(name); }, toggle(name: string, on: boolean) { if (on) classes.add(name); else classes.delete(name); } },
    addEventListener(name: string, handler: (event: any) => unknown) { (listeners[name] ??= []).push(handler); },
    fire(name: string, event: any = {}) { return Promise.all((listeners[name] ?? []).map(fn => fn(event))); },
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    focus() { this.focused = true; },
    replaceChildren() { this.children = []; },
    appendChild(child: unknown) { this.children.push(child); },
    contains: (_value: unknown): boolean => false,
    // 若实现意外把远程说明转成 HTML，行为测试立即失败。
    set innerHTML(_value: string) { throw new Error('Remote markup must never enter HTML'); },
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return { status: 'idle', release: null, percent: 0, busy: false, error: null, checked: false,
    revision: 0, currentVersion: '0.1.0', disabledReason: null, ...overrides };
}

function updateUi(overrides: Record<string, unknown> = {}) {
  const ids = ['update-wrap', 'btn-update', 'update-panel', 'update-heading', 'update-versions', 'update-message',
    'update-notes-section', 'update-notes', 'update-notes-toggle', 'update-progress-wrap', 'update-progress',
    'update-percent', 'update-hint', 'update-action', 'update-close'];
  const nodes = Object.fromEntries(ids.map(id => [id, element()]));
  nodes['update-panel'].hidden = true;
  const doc = element(); const win = element();
  nodes['update-wrap'].contains = value => Object.values(nodes).includes(value as any);
  let publish: (value: unknown) => void = () => {};
  let open: () => void = () => {};
  const calls: string[] = [];
  const bridge = {
    async getUpdateState() { calls.push('get'); return state(); },
    async checkForUpdate() { calls.push('check'); return state({ checked: true, revision: 1 }); },
    async downloadUpdate() { calls.push('download'); return state({ status: 'downloading', busy: true, revision: 2 }); },
    async installUpdate() { calls.push('install'); return state({ status: 'installing', busy: true, revision: 3 }); },
    onUpdateState(fn: typeof publish) { publish = fn; }, onOpenUpdatePanel(fn: typeof open) { open = fn; },
    ...overrides,
  };
  const window = { ...win, setupApplicationUpdate: null as any };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/applicationUpdate.js'), 'utf8'), {
    window, document: { getElementById(id: string) { return nodes[id]; }, createElement() { return element(); }, addEventListener: doc.addEventListener },
  });
  const controller = window.setupApplicationUpdate(bridge);
  return { nodes, doc, win, calls, controller, publish(value: unknown) { publish(value); }, open() { open(); } };
}

async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
const release = { version: '0.1.1', notes: '改进更新体验。' };

it('启动只订阅和读取状态，发现新版只点亮图标且不打开面板、不抢焦点', async () => {
  const ui = updateUi(); await flush();
  assert.deepEqual(ui.calls, ['get']);
  ui.publish(state({ status: 'available', release, revision: 1 }));
  assert.equal(ui.nodes['update-panel'].hidden, true);
  assert.equal(ui.nodes['btn-update'].classList.contains('has-update'), true);
  assert.equal(ui.nodes['update-panel'].focused, false);
  assert.deepEqual(ui.calls, ['get']);
  await ui.nodes['btn-update'].fire('click');
  assert.equal(ui.nodes['update-panel'].hidden, false);
  assert.equal(ui.nodes['update-heading'].textContent, '有新版本可用');
  assert.equal(ui.nodes['update-action'].textContent, '下载更新');
});

it('迟到的初始快照或请求结果不会覆盖更高 revision 的进度', async () => {
  let resolve: (value: unknown) => void = () => {};
  const ui = updateUi({ getUpdateState: () => new Promise(yes => { resolve = yes; }) });
  ui.publish(state({ status: 'downloading', release, percent: 42.4, busy: true, revision: 5 }));
  resolve(state({ revision: 0 })); await flush();
  assert.equal(ui.nodes['update-progress'].value, 42.4);
  assert.equal(ui.nodes['update-percent'].textContent, '42%');
  assert.equal(ui.nodes['update-action'].disabled, true);
  assert.equal(ui.nodes['btn-update'].classList.contains('is-busy'), true);
});

it('远程更新说明使用纯文本，摘要可展开与收起且不改变任务', async () => {
  const ui = updateUi(); await flush();
  const untrusted = '<img src=x onerror="steal()">\n' + '更新内容 '.repeat(80);
  ui.publish(state({ status: 'available', release: { ...release, notes: untrusted }, revision: 1 }));
  assert.equal(ui.nodes['update-notes'].textContent.startsWith('<img'), true);
  assert.equal(ui.nodes['update-notes'].textContent.endsWith('…'), true);
  assert.equal(ui.nodes['update-notes-toggle'].hidden, false);
  await ui.nodes['update-notes-toggle'].fire('click');
  assert.equal(ui.nodes['update-notes'].textContent, untrusted.trim());
  assert.equal(ui.nodes['update-notes'].classList.contains('is-expanded'), true);
  assert.equal(ui.nodes['update-notes-toggle'].attrs['aria-expanded'], 'true');
  await ui.nodes['update-notes-toggle'].fire('click');
  assert.equal(ui.nodes['update-notes-toggle'].attrs['aria-expanded'], 'false');
  assert.deepEqual(ui.calls, ['get']);
});

it('短但多行的说明也可展开，折叠摘要只取前三个非空行', async () => {
  const ui = updateUi(); await flush();
  const fullNotes = '第一项\n\n第二项\n\n第三项\n\n第四项';
  ui.publish(state({ status: 'available', release: { ...release, notes: fullNotes }, revision: 1 }));
  assert.equal(ui.nodes['update-notes'].textContent, '第一项\n第二项\n第三项…');
  assert.equal(ui.nodes['update-notes-toggle'].hidden, false);
  await ui.nodes['update-notes-toggle'].fire('click');
  assert.equal(ui.nodes['update-notes'].textContent, fullNotes);
  assert.equal(ui.nodes['update-notes'].classList.contains('is-expanded'), true);
  await ui.nodes['update-notes-toggle'].fire('click');
  assert.equal(ui.nodes['update-notes'].classList.contains('is-expanded'), false);
  assert.deepEqual(ui.calls, ['get']);
});

it('下载只能由主按钮触发，关闭浮层后继续接收进度且不会安装', async () => {
  const ui = updateUi(); await flush();
  ui.publish(state({ status: 'available', release, revision: 1 })); await ui.nodes['btn-update'].fire('click');
  await ui.nodes['update-action'].fire('click');
  await ui.nodes['update-close'].fire('click');
  ui.publish(state({ status: 'downloading', release, busy: true, percent: 70, revision: 3 }));
  assert.equal(ui.nodes['update-panel'].hidden, true);
  assert.equal(ui.nodes['update-percent'].textContent, '70%');
  ui.publish(state({ status: 'ready', release, revision: 4 }));
  assert.equal(ui.nodes['btn-update'].classList.contains('is-ready'), true);
  assert.equal(ui.nodes['update-action'].textContent, '重启并安装');
  assert.deepEqual(ui.calls, ['get', 'download']);
  await ui.nodes['btn-update'].fire('click'); await ui.nodes['update-action'].fire('click');
  assert.deepEqual(ui.calls, ['get', 'download', 'install']);
});

it('Escape 与关闭按钮回到图标，外点、失焦和后台事件不会抢编辑焦点', async () => {
  const ui = updateUi(); await flush(); ui.open();
  await ui.nodes['update-wrap'].fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(ui.nodes['update-panel'].hidden, true); assert.equal(ui.nodes['btn-update'].focused, true);
  ui.nodes['btn-update'].focused = false; ui.open();
  await ui.doc.fire('pointerdown', { target: {} });
  assert.equal(ui.nodes['update-panel'].hidden, true); assert.equal(ui.nodes['btn-update'].focused, false);
  ui.open(); await ui.nodes['update-wrap'].fire('focusout', { relatedTarget: ui.nodes['update-action'] });
  assert.equal(ui.nodes['update-panel'].hidden, false);
  await ui.nodes['update-wrap'].fire('focusout', { relatedTarget: {} });
  assert.equal(ui.nodes['update-panel'].hidden, true);
  ui.open(); await ui.win.fire('blur'); assert.equal(ui.nodes['update-panel'].hidden, true);
});

it('下载失败重试下载，检查失败重试检查，不支持环境说明原因并禁用动作', async () => {
  const ui = updateUi(); await flush();
  ui.publish(state({ status: 'error', release, error: '下载中断', revision: 1 }));
  assert.equal(ui.nodes['update-message'].textContent, '下载中断');
  assert.equal(ui.nodes['update-action'].textContent, '重试');
  await ui.nodes['update-action'].fire('click'); assert.deepEqual(ui.calls, ['get', 'download']);
  ui.publish(state({ status: 'error', error: '网络不可用', revision: 3 }));
  await ui.nodes['update-action'].fire('click'); assert.deepEqual(ui.calls, ['get', 'download', 'check']);
  ui.publish(state({ disabledReason: 'Portable 版本不支持原地更新。', revision: 5 }));
  assert.equal(ui.nodes['update-message'].textContent, 'Portable 版本不支持原地更新。');
  assert.equal(ui.nodes['update-action'].disabled, true);
  await ui.nodes['update-action'].fire('click'); assert.deepEqual(ui.calls, ['get', 'download', 'check']);
});

it('用户动作等待期间防止重复请求，安装确认期间不允许再次安装', async () => {
  let resolve: (value: unknown) => void = () => {}; let checks = 0;
  const ui = updateUi({ checkForUpdate: () => { checks++; return new Promise(yes => { resolve = yes; }); } });
  await flush(); const pending = ui.nodes['update-action'].fire('click');
  await ui.nodes['update-action'].fire('click'); assert.equal(checks, 1);
  resolve(state({ checked: true, revision: 1 })); await pending;
  assert.equal(ui.nodes['update-action'].disabled, false);
  assert.equal(ui.nodes['update-heading'].textContent, '已是最新版本');
  ui.publish(state({ status: 'confirming', release, busy: true, revision: 2 }));
  await ui.nodes['update-action'].fire('click'); assert.equal(checks, 1);
  assert.equal(ui.nodes['update-action'].disabled, true);
});

it('IPC 请求被拒绝时提供可见错误和重试，不触发未选择的操作', async () => {
  let requests = 0;
  const ui = updateUi({ getUpdateState: async () => { requests++; if (requests === 1) throw '状态读取失败'; return state(); } });
  await flush();
  assert.equal(ui.nodes['update-message'].textContent, '状态读取失败');
  assert.equal(ui.nodes['update-action'].textContent, '重试读取');
  assert.equal(ui.nodes['update-action'].disabled, false);
  await ui.nodes['update-action'].fire('click');
  assert.equal(requests, 2);
  assert.equal(ui.nodes['update-message'].textContent, '检查是否有新的稳定版本。');
  assert.deepEqual(ui.calls, []);
});

it('迟到的读取错误不覆盖已经收到的有效状态', async () => {
  let reject: (value: unknown) => void = () => {};
  const ui = updateUi({ getUpdateState: () => new Promise((_yes, no) => { reject = no; }) });
  ui.publish(state({ status: 'ready', release, revision: 5 }));
  reject('旧请求失败'); await flush();
  assert.equal(ui.nodes['update-heading'].textContent, '更新已准备就绪');
  assert.equal(ui.nodes['update-action'].textContent, '重启并安装');
  assert.equal(ui.nodes['update-message'].classList.contains('is-error'), false);
});
