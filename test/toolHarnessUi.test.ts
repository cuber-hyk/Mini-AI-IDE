import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

function element(): any {
  const listeners: Record<string, Array<() => unknown>> = {};
  const classes = new Set<string>();
  let text = '';
  return {
    disabled: false, checked: false, open: false, value: '', className: '', hidden: false, focused: false, textWrites: 0,
    get textContent() { return text; }, set textContent(value: string) { text = value; this.textWrites += 1; },
    attrs: {} as Record<string, string>,
    dataset: {} as Record<string, string>, children: [] as any[], parentElement: null as any,
    addEventListener(name: string, handler: () => unknown) { (listeners[name] ??= []).push(handler); },
    fire(name: string) { return Promise.all((listeners[name] ?? []).map(fn => (fn as any)({ preventDefault() {}, stopPropagation() {} }))); },
    classList: { toggle(name: string, on: boolean) { if (on) classes.add(name); else classes.delete(name); }, contains(name: string) { return classes.has(name); }, add(name: string) { classes.add(name); }, remove(name: string) { classes.delete(name); } },
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    getBoundingClientRect() { return { x: 500, y: 600, width: 30, height: 30 }; }, focus() { this.focused = true; },
    replaceChildren() { this.children.forEach((child: any) => { child.parentElement = null; }); this.children = []; },
    appendChild(child: any) { this.insertBefore(child, null); },
    insertBefore(child: any, reference: any) { child.remove(); child.parentElement = this; const index = reference ? this.children.indexOf(reference) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, child); },
    remove() { if (this.parentElement) { const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this), 1); this.parentElement = null; } },
    set innerHTML(_value: string) { throw new Error('Tool output must never become HTML'); },
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return { config: { permission: 'ask', automatic: false, dirtyPolicy: 'ask', completionSound: false }, results: [], busy: false, message: '等待工具请求', canUndo: false, ...overrides };
}

function setup(overrides: Record<string, unknown> = {}, audioConstructor?: unknown) {
  const ids = ['tool-permission-control', 'tool-permission', 'tool-automatic', 'tool-count',
    'tool-activity', 'tool-message', 'tool-results', 'tool-copy', 'tool-undo', 'tool-settings-toggle',
    'tool-panel', 'tool-completion-notice', 'tool-sound-notice', 'tool-more-toggle', 'tool-copy-notice', 'tool-continue-notice', 'tool-return-notice', 'tool-source-notice'];
  const nodes = Object.fromEntries(ids.map(id => [id, element()]));
  let current = state();
  let publish: (value: any) => void = () => {};
  let ready: () => void = () => {};
  let visibility: (state: any) => void = () => {};
  const calls: any[] = [];
  const attentionEvents: any[] = [];
  const bridge = {
    async getWebPlatform() { return { platform: 'deepseek', switching: false }; },
    onWebPlatformState() {},
    async getToolState() { calls.push('get'); return current; },
    onToolState(fn: typeof publish) { publish = fn; },
    async setToolConfig(patch: any) { calls.push(JSON.parse(JSON.stringify(patch))); current = state({ ...current, config: { ...current.config, ...patch } }); return current; },
    async copyToolResults() { calls.push('copy'); return { ok: true }; },
    async sendToolResults(...args: unknown[]) { calls.push(['send', ...args]); return { ok: true }; },
    async stopToolCommand(target: any) { calls.push(JSON.parse(JSON.stringify(target))); return current; },
    async openToolSettings(anchor: unknown) { calls.push(['settings', JSON.parse(JSON.stringify(anchor))]); },
    onToolSettingsVisibility(fn: typeof visibility) { visibility = fn; },
    async undoToolChange() { calls.push('undo'); publish(state({ ...current, canUndo: false })); return { ok: true }; },
    ...overrides,
  };
  const window = { editorBridge: bridge, setupToolHarness: null as any, setupToolJsonPanel: () => ({ update() {} }), setupToolPanelLayout: () => ({ refresh() {} }), createToolExecutionClock: () => ({ replace() {} }), AudioContext: audioConstructor, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/toolResultPresentation.js'), 'utf8'), { window });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/toolAttention.js'), 'utf8'), { window });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/toolCompletionSound.js'), 'utf8'), { window });
  const timers = new Map<number, () => void>();
  const work = { created: 0, detailedSerializations: 0, serializedCharacters: 0 };
  let timerId = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/toolHarness.js'), 'utf8'), {
    window, JSON: { stringify(value: unknown, replacer?: any, space?: any) {
      const text = JSON.stringify(value, replacer, space);
      if (space === 2) { work.detailedSerializations += 1; work.serializedCharacters += text.length; }
      return text;
    } }, CustomEvent: class { constructor(readonly type: string, readonly init: any) {} }, setTimeout(callback: () => void) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); }, document: {
      readyState: 'loading', getElementById(id: string) { return nodes[id]; }, createElement() { work.created += 1; return element(); },
      addEventListener(name: string, handler: () => void) { if (name === 'DOMContentLoaded') ready = handler; },
      dispatchEvent(event: any) { attentionEvents.push(event.init.detail); },
    },
  });
  ready();
  return { nodes, calls, attentionEvents, timers, visibility, work, expireFeedback() { for (const callback of [...timers.values()]) callback(); }, publish(value: any) { current = value; publish(value); } };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
const result = { batch_id: 'inspect', request_id: 'read', tool: 'read_file', status: 'done', data: { text: '真实文件内容' } };

it('手动导入明确仅查看复制，即使附带旧发送状态也不显示或请求网页发送', async () => {
  const ui = setup(); await flush();
  ui.publish(attachmentState({ source: 'manual' }));
  assert.equal(ui.nodes['tool-source-notice'].hidden, false);
  assert.equal(ui.nodes['tool-copy'].dataset.action, 'copy'); assert.equal(ui.nodes['tool-return-notice'].textContent, '');
  await ui.nodes['tool-copy'].fire('click'); assert.ok(ui.calls.includes('copy'));
  assert.equal(ui.calls.some(call => Array.isArray(call) && call[0] === 'send'), false);
  ui.publish(state({ results: [result] })); assert.equal(ui.nodes['tool-source-notice'].hidden, true);
});

it('工具页只为新批准、失败或暂停发出一次打开事件，普通完成不抢占', async () => {
  const ui = setup(); await flush();
  ui.publish(state({ results: [result] })); assert.equal(ui.attentionEvents.length, 0);
  const approval = state({ results: [{ ...result, status: 'pending_permission' }] });
  ui.publish(approval); assert.equal(ui.attentionEvents.length, 1);
  ui.nodes['tool-panel'].open = false;
  ui.publish(approval); assert.equal(ui.attentionEvents.length, 1); assert.equal(ui.nodes['tool-panel'].open, false);
  ui.publish(state({ results: [{ ...result, status: 'failed' }] }));
  assert.equal(ui.attentionEvents.length, 2); assert.equal(ui.nodes['tool-panel'].open, true);
  ui.publish(state({ continuation: { phase: 'paused', message: '官网已有草稿' } }));
  ui.publish(state({ continuation: { phase: 'paused', message: '官网已有草稿' } }));
  assert.equal(ui.attentionEvents.length, 3);
});

it('首次广播先于状态查询返回时仍作为历史基线，旧查询不能覆盖新状态', async () => {
  let finish!: (value: any) => void;
  const ui = setup({ getToolState: () => new Promise(resolve => { finish = resolve; }) });
  ui.publish(state({ results: [{ ...result, status: 'failed' }] }));
  assert.equal(ui.attentionEvents.length, 0);
  finish(state()); await flush();
  assert.equal(ui.nodes['tool-count'].textContent, '1 项');
  ui.publish(state({ results: [{ ...result, batch_id: 'new', status: 'pending_permission' }] }));
  assert.equal(ui.attentionEvents.length, 1);
});

function attachmentState(overrides: Record<string, unknown> = {}) {
  return state({
    results: [{ ...result, tool: 'attach_file', data: { id: 'attachment-a', name: '论文.pdf', size: 1024 } }],
    completion: { id: 1, batch_id: 'inspect', outcome: 'success' },
    resultReturn: { canSend: true, attachmentCount: 1, phase: 'ready', message: '1 个附件待发送' }, ...overrides,
  });
}

it('结果操作根据附件资格切换发送与复制，自动继续关闭时才手动发送附件', async () => {
  const ui = setup(); await flush();
  assert.equal(ui.nodes['tool-copy'].disabled, true);
  ui.publish(attachmentState());
  assert.equal(ui.nodes['tool-copy'].dataset.action, 'send'); assert.equal(ui.nodes['tool-copy'].disabled, false);
  assert.equal(ui.nodes['tool-return-notice'].textContent, '1 个附件待发送');
  ui.publish(attachmentState({ busy: true })); assert.equal(ui.nodes['tool-copy'].dataset.action, 'copy');
  ui.publish(attachmentState({ resultReturn: { canSend: false, attachmentCount: 1, phase: 'paused', message: '当前批已失效' } }));
  assert.equal(ui.nodes['tool-copy'].dataset.action, 'copy'); assert.equal(ui.nodes['tool-return-notice'].textContent, '当前批已失效');
  assert.equal(ui.nodes['tool-return-notice'].classList.contains('is-error'), true);
  ui.publish(attachmentState({ config: { automatic: true }, continuation: { phase: 'sending', message: '自动上传中' }, resultReturn: { canSend: true, attachmentCount: 1, phase: 'sending', message: '正在上传1个附件' } }));
  assert.equal(ui.nodes['tool-copy'].dataset.action, 'copy'); assert.equal(ui.nodes['tool-activity'].textContent, '正在发送结果');
  assert.equal(ui.nodes['tool-return-notice'].textContent, '正在上传1个附件');
});

it('ChatGPT 启用纯文本自动继续但不回传附件，已有结果仍可复制', async () => {
  let platform!: (value: any) => void;
  const ui = setup({ onWebPlatformState: (fn: any) => { platform = fn; } }); await flush();
  ui.publish(attachmentState({ config: { automatic: true } })); platform({ platform: 'chatgpt', switching: false });
  assert.equal(ui.nodes['tool-automatic'].disabled, false); assert.equal(ui.nodes['tool-automatic'].checked, true);
  assert.equal(ui.nodes['tool-copy'].dataset.action, 'copy');
  await ui.nodes['tool-copy'].fire('click'); assert.ok(ui.calls.includes('copy')); assert.equal(ui.calls.some(call => Array.isArray(call) && call[0] === 'send'), false);
  await ui.nodes['tool-automatic'].fire('change'); assert.equal(ui.calls.some(call => call && call.automatic !== undefined), true);
  platform({ platform: 'deepseek', switching: false }); assert.equal(ui.nodes['tool-automatic'].disabled, false);
});
it('复制附件结果等待期间切 ChatGPT 后不继续发送，平台未知时同样只复制', async () => {
  let platform!: (value: any) => void; let finish!: (value: any) => void;
  const ui = setup({ onWebPlatformState: (fn: any) => { platform = fn; }, copyToolResults: () => new Promise(yes => { finish = yes; }) }); await flush(); ui.publish(attachmentState());
  const copying = ui.nodes['tool-copy'].fire('click'); platform({ platform: 'chatgpt', switching: false }); finish({ ok: true }); await copying;
  assert.equal(ui.calls.some(call => Array.isArray(call) && call[0] === 'send'), false);
  const unavailable = setup({ getWebPlatform: async () => { throw new Error('不可用'); } }); await flush(); unavailable.publish(attachmentState());
  assert.equal(unavailable.nodes['tool-copy'].dataset.action, 'copy'); assert.equal(unavailable.nodes['tool-automatic'].disabled, true);
});

it('发送当前批附件的IPC不携带正文路径ID，等待期间防双击，成功回执不重复发送', async () => {
  let finish!: (result: unknown) => void; const args: unknown[][] = [];
  const ui = setup({ sendToolResults: (...input: unknown[]) => { args.push(input); return new Promise(resolve => { finish = resolve; }); } }); await flush();
  ui.publish(attachmentState());
  const pending = ui.nodes['tool-copy'].fire('click'); await flush();
  assert.equal(ui.nodes['tool-copy'].disabled, true); assert.match(ui.nodes['tool-copy'].title, /复制并发送/);
  await ui.nodes['tool-copy'].fire('click'); assert.deepEqual(args, [[]]);
  finish({ ok: true }); await pending;
  assert.equal(ui.nodes['tool-copy'].dataset.action, 'copy'); assert.match(ui.nodes['tool-return-notice'].textContent, /已发送/);
  await ui.nodes['tool-copy'].fire('click'); assert.equal(args.length, 1);
});

it('未知附件发送回执与IPC异常显示具体原因，不能当作发送成功或再次点击', async () => {
  for (const sendToolResults of [async () => ({ ok: false, uncertain: true, error: '发送按钮点击后无法确认' }), async () => { throw new Error('IPC disconnected'); }]) {
    const ui = setup({ sendToolResults }); await flush(); ui.publish(attachmentState());
    await ui.nodes['tool-copy'].fire('click');
    assert.equal(ui.nodes['tool-copy'].dataset.action, 'copy');
    assert.match(ui.nodes['tool-return-notice'].textContent, /状态未知/);
    assert.match(ui.nodes['tool-return-notice'].textContent, /无法确认|IPC disconnected/);
    assert.equal(ui.nodes['tool-return-notice'].classList.contains('is-error'), true);
    assert.doesNotMatch(ui.nodes['tool-return-notice'].textContent, /已发送/);
  }
});

it('旧批附件发送回执不能覆盖新批状态，新批是否可发送仍由owner判断', async () => {
  let fail!: (error: Error) => void;
  const ui = setup({ sendToolResults: () => new Promise((_resolve, reject) => { fail = reject; }) }); await flush(); ui.publish(attachmentState());
  const pending = ui.nodes['tool-copy'].fire('click'); await flush();
  ui.publish(attachmentState({ completion: { id: 2, batch_id: 'new', outcome: 'success' }, resultReturn: { canSend: true, attachmentCount: 1, phase: 'ready', message: '新批附件待发送' } }));
  fail(new Error('旧批已失效')); await pending;
  assert.equal(ui.nodes['tool-return-notice'].textContent, '新批附件待发送');
  assert.equal(ui.nodes['tool-copy'].dataset.action, 'send'); assert.equal(ui.nodes['tool-copy'].disabled, false);
});

it('附件发送失败保留owner原因和暂停状态，按钮有键盘名称且窄列动作可换行', async () => {
  const ui = setup({ async sendToolResults() { ui.publish(attachmentState({ resultReturn: { canSend: false, attachmentCount: 1, phase: 'paused', message: '官网已有草稿' } })); return { ok: false, error: '官网已有草稿，未覆盖' }; } }); await flush(); ui.publish(attachmentState());
  await ui.nodes['tool-copy'].fire('click');
  assert.equal(ui.nodes['tool-copy'].dataset.action, 'copy'); assert.match(ui.nodes['tool-return-notice'].textContent, /官网已有草稿，未覆盖/);
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  assert.match(html, /id="tool-copy"[^>]*aria-label="[^"]+"/);
  assert.match(html, /id="tool-return-notice"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /id="tool-send-results"/);
});

it('自动继续显示倒计时或暂停原因，间隔控件由独立设置浮层持有', async () => {
  const ui = setup(); await flush();
  ui.publish(state({ config: { permission: 'full', automatic: true, sendIntervalSeconds: 7 }, continuation: { phase: 'countdown', message: '即将发送', dueAt: Date.now() + 7000 } }));
  assert.equal(ui.nodes['tool-automatic'].checked, true); assert.match(ui.nodes['tool-activity'].textContent, /[67]s 后发送/);
  ui.publish(state({ config: { permission: 'full', automatic: true }, continuation: { phase: 'off', message: '已立即关闭，配置正在保存' } }));
  assert.equal(ui.nodes['tool-automatic'].checked, false);
  ui.publish(state({ config: { permission: 'full', automatic: true }, continuation: { phase: 'paused', message: '输入框已有草稿，未覆盖' } }));
  assert.equal(ui.nodes['tool-activity'].textContent, '自动已暂停'); assert.match(ui.nodes['tool-continue-notice'].textContent, /未覆盖/);
  assert.equal(ui.nodes['tool-send-interval'], undefined);
});
it('JSON格式错误归入批次失败卡片，复制统一结果；不伪造具体工具调用', async () => {
  const ui = setup(); await flush();
  const diagnostic = '工具 JSON 无效\nSyntaxError: position 700\n第 1 行，第 701 列';
  ui.publish(state({ batchError: { status: 'failed', error: diagnostic }, message: '工具批次校验失败，未执行' }));
  assert.equal(ui.nodes['tool-panel'].open, true);
  assert.equal(ui.nodes['tool-activity'].textContent, '格式错误');
  assert.match(ui.nodes['tool-copy'].title, /复制本批结果/);
  assert.equal(ui.nodes['tool-copy'].disabled, false);
  assert.equal(ui.nodes['tool-message'].hidden, true);
  const items = ui.nodes['tool-results'].children;
  assert.equal(items.length, 1); assert.equal(items[0].open, true);
  const failure = JSON.parse(items[0].children[1].textContent);
  assert.equal(failure.batch_error.error, diagnostic);
  assert.equal(failure.batch_error.request_id, undefined);
  assert.equal(ui.nodes['tool-count'].textContent, '1 项');
  assert.equal(ui.nodes['tool-count'].title, '1 项校验失败');
  ui.publish(state({ results: [result] }));
  assert.equal(ui.nodes['tool-results'].children.length, 1);
  assert.equal(ui.nodes['tool-results'].children[0].className, 'tool-result');
  await ui.nodes['tool-copy'].fire('click'); assert.deepEqual(ui.calls, ['get', 'copy']);
});

it('每条前后台命令有独立中断按钮，只发送被点击的批次和请求身份', async () => {
  const ui = setup(); await flush();
  ui.publish(state({ hasRunningProcesses: true, results: [
    { ...result, tool: 'run_command', status: 'running', data: { process_id: 'proc-a', status: 'running' } },
    { ...result, request_id: 'background', tool: 'run_command', data: { process_id: 'proc-b', status: 'running' } },
    { ...result, request_id: 'finished', tool: 'run_command', data: { process_id: 'proc-c', status: 'done' } },
  ] }));
  const buttons = ui.nodes['tool-results'].children.map((item: any) => item.children[0].children.find((node: any) => node.className === 'ui-button tool-command-stop'));
  assert.equal(buttons[0].textContent, '', '中断仅显示图标');
  assert.match(buttons[0].attrs['aria-label'], /中断此命令及其子进程/);
  assert.equal(buttons[0].attrs['aria-busy'], 'false');
  assert.equal(buttons[1].disabled, false); assert.equal(buttons[2], undefined);
  assert.equal(ui.nodes['tool-more-toggle'].hidden, false, '窄列查看改动需要保留菜单入口');
  assert.equal(ui.nodes['tool-panel'].classList.contains('has-undo'), false);
  await buttons[1].fire('click'); assert.deepEqual(ui.calls, ['get', { batch_id: 'inspect', request_id: 'background', process_id: 'proc-b' }]);
});

it('旧进程中断尚未返回时，新作用域同批同请求的新进程仍可中断且不接收旧错误', async () => {
  let fail!: (error: Error) => void;
  const ui = setup({ stopToolCommand: () => new Promise((_resolve, reject) => { fail = reject; }) }); await flush();
  const running = { ...result, tool: 'run_command', status: 'running', data: { process_id: 'old-instance', status: 'running' } };
  ui.publish(state({ results: [running] }));
  const button = () => ui.nodes['tool-results'].children[0].children[0].children.find((node: any) => node.className === 'ui-button tool-command-stop');
  const pending = button().fire('click'); await flush(); assert.equal(button().disabled, true);
  assert.equal(button().attrs['aria-busy'], 'true');
  assert.match(button().attrs['aria-label'], /正在中断/);
  ui.publish(state({ results: [{ ...running, data: { ...running.data, process_id: 'new-instance' } }] }));
  assert.equal(button().disabled, false);
  assert.equal(button().attrs['aria-busy'], 'false');
  fail(new Error('old scope failure')); await pending;
  assert.equal(button().disabled, false); assert.doesNotMatch(ui.nodes['tool-message'].textContent, /old scope failure/);
});

it('执行状态只显示一份，独立摘要保留真实原因；自动复制通知不由UI再次执行复制', async () => {
  const ui = setup(); await flush();
  ui.publish(state({ busy: true, results: [{ ...result, tool: 'run_command', status: 'running' }] }));
  const summary = ui.nodes['tool-results'].children[0].children[0];
  assert.equal(summary.children.find((node: any) => node.className === 'tool-result-status').textContent, '执行中');
  assert.equal(summary.children.find((node: any) => node.className === 'tool-result-detail').textContent, '');
  ui.publish(state({ results: [result], clipboard: { id: 1, ok: true } }));
  assert.match(ui.nodes['tool-copy-notice'].textContent, /已自动复制/);
  assert.deepEqual(ui.calls, ['get']);
  ui.publish(state({ results: [result], clipboard: { id: 1, ok: false, error: 'denied' } }));
  assert.match(ui.nodes['tool-copy-notice'].textContent, /自动复制失败.*denied/);
  assert.equal(ui.nodes['tool-copy'].disabled, false);
});

it('后台工具启动回执done仍显示真实进程运行/失败，不能让完成徽标掩盖报错', async () => {
  const ui = setup(); await flush();
  ui.publish(state({ hasRunningProcesses: true, results: [{ ...result, tool: 'run_command', data: { status: 'running' } }] }));
  const displayed = () => ui.nodes['tool-results'].children[0].children[0].children.find((node: any) => node.className === 'tool-result-status').textContent;
  assert.equal(displayed(), '执行中');
  ui.publish(state({ results: [{ ...result, tool: 'run_command', data: { status: 'failed', exit_code: 7 } }], completion: { id: 1, batch_id: 'inspect', outcome: 'error' } }));
  assert.equal(displayed(), '失败'); assert.equal(ui.nodes['tool-activity'].classList.contains('is-error'), true);
});

it('先读取用户已选择权限，启动不会执行工具或复制结果', async () => {
  const ui = setup({ getToolState: async () => state({ config: { permission: 'full', automatic: true, dirtyPolicy: 'continue' } }) });
  await flush();
  assert.equal(ui.nodes['tool-permission'].value, 'full');
  assert.equal(ui.nodes['tool-automatic'].checked, true);
  assert.match(ui.nodes['tool-permission'].title, /项目外文件/);
  assert.deepEqual(ui.calls, []);
});

it('底部选择权限与自动继续使用原配置 owner，草稿处理迁至独立浮层', async () => {
  const ui = setup(); await flush();
  ui.nodes['tool-permission'].value = 'rules'; await ui.nodes['tool-permission'].fire('change');
  ui.nodes['tool-automatic'].checked = true; await ui.nodes['tool-automatic'].fire('change');
  assert.deepEqual(ui.calls, ['get', { permission: 'rules' }, { automatic: true }]);
  assert.equal(ui.nodes['tool-permission'].value, 'rules');
  assert.equal(ui.nodes['tool-automatic'].checked, true);
  assert.equal(ui.nodes['tool-dirty-policy'], undefined);
});

it('配置失败恢复真实权限，错误在折叠面板的摘要也可见', async () => {
  const ui = setup({ setToolConfig: async () => { throw new Error('落盘失败'); } }); await flush();
  ui.nodes['tool-permission'].value = 'full'; await ui.nodes['tool-permission'].fire('change');
  assert.equal(ui.nodes['tool-permission'].value, 'ask');
  assert.equal(ui.nodes['tool-permission'].disabled, false);
  assert.equal(ui.nodes['tool-activity'].textContent, '操作失败');
  assert.match(ui.nodes['tool-activity'].title, /落盘失败/);
  assert.equal(ui.nodes['tool-message'].classList.contains('is-error'), true);
});

it('配置保存中拒绝第二次选择，避免并发请求把权限改回旧值', async () => {
  let resolve: (next: any) => void = () => {};
  const writes: any[] = [];
  const ui = setup({ setToolConfig: (patch: any) => { writes.push(patch); return new Promise(yes => { resolve = yes; }); } }); await flush();
  ui.nodes['tool-permission'].value = 'full'; const pending = ui.nodes['tool-permission'].fire('change');
  assert.equal(ui.nodes['tool-permission'].disabled, true);
  ui.nodes['tool-permission'].value = 'rules'; await ui.nodes['tool-permission'].fire('change');
  assert.equal(writes.length, 1);
  resolve(state({ config: { permission: 'full', automatic: false, dirtyPolicy: 'ask' } })); await pending;
  assert.equal(ui.nodes['tool-permission'].value, 'full');
});

it('初始状态查询迟到时，不能覆盖已经广播的新权限和结果', async () => {
  let resolve: (next: any) => void = () => {};
  const ui = setup({ getToolState: () => new Promise(yes => { resolve = yes; }) });
  ui.publish(state({ config: { permission: 'full', automatic: true, dirtyPolicy: 'stop' }, results: [result] }));
  resolve(state()); await flush();
  assert.equal(ui.nodes['tool-permission'].value, 'full');
  assert.equal(ui.nodes['tool-results'].children.length, 1);
});

it('工具输出中的 HTML 和调用块只作为原始文本展示，广播不会复制或执行', async () => {
  const ui = setup(); await flush();
  const text = '<img src=x onerror="steal()">\n```mini-ai-tools\n{"command":"danger"}\n```';
  ui.publish(state({ results: [{ ...result, data: { text } }] }));
  const item = ui.nodes['tool-results'].children[0];
  assert.equal(item.children.length, 1, '折叠时不生成大正文');
  item.open = true; await item.fire('toggle');
  const body = item.children[1];
  assert.equal(JSON.parse(body.textContent).data.text, text);
  assert.deepEqual(ui.calls, ['get']);
  await ui.nodes['tool-copy'].fire('click');
  assert.deepEqual(ui.calls, ['get', 'copy']);
  assert.match(ui.nodes['tool-message'].textContent, /粘贴并发送/);
});

it('新状态刷新保留已展开的工具详情，不自动打开其他结果', async () => {
  const ui = setup(); await flush(); ui.publish(state({ results: [result] }));
  ui.nodes['tool-results'].children[0].open = true;
  ui.publish(state({ results: [{ ...result, data: { text: '新增输出' } }, { ...result, request_id: 'second' }] }));
  assert.equal(ui.nodes['tool-results'].children[0].open, true);
  assert.equal(ui.nodes['tool-results'].children[1].open, false);
});

it('大结果在100次IPC克隆状态广播中不重建行或序列化折叠详情，其他行进度不破坏展开正文', async () => {
  const ui = setup(); await flush();
  const rows = Array.from({ length: 20 }, (_, index) => ({ ...result, request_id: 'large-' + index, data: { path: 'file-' + index, text: '内容'.repeat(65536) } }));
  ui.publish(state({ results: structuredClone(rows) }));
  const items = [...ui.nodes['tool-results'].children];
  assert.equal(ui.work.detailedSerializations, 0);
  assert.ok(items.every(item => item.children.length === 1));
  const created = ui.work.created;
  for (let i = 0; i < 100; i++) ui.publish(state({ results: structuredClone(rows), message: '进度 ' + i, continuation: { phase: 'waiting_reply', message: String(i) } }));
  assert.equal(ui.work.created, created, '状态变化不重建结果行');
  assert.equal(ui.work.detailedSerializations, 0, '折叠的约2.6MB数据不生成JSON正文');
  items[0].open = true; await items[0].fire('toggle');
  const body = items[0].children[1]; const writes = body.textWrites;
  items[0].children[0].focus();
  assert.equal(ui.work.detailedSerializations, 1);
  for (let i = 0; i < 100; i++) {
    const progress = structuredClone(rows); progress[1] = { ...progress[1], status: i % 2 ? 'done' : 'failed' };
    ui.publish(state({ results: progress }));
  }
  assert.equal(ui.work.detailedSerializations, 1, '其他行状态变化不重复序列化已展开的未变正文');
  assert.equal(items[0].children[1], body); assert.equal(body.textWrites, writes, '保持正文文本节点以保留选区');
  assert.equal(ui.nodes['tool-results'].children[0], items[0]); assert.equal(items[0].children[0].focused, true);
  assert.equal(ui.work.created, created + 1, '仅展开的这一项创建一个pre');
});

it('收起释放大正文，折叠期间变化不序列化，再展开显示最新全部字段且不改变复制入口', async () => {
  const ui = setup(); await flush(); ui.publish(state({ results: [result] }));
  const item = ui.nodes['tool-results'].children[0];
  item.open = true; await item.fire('toggle'); const body = item.children[1];
  item.open = false; await item.fire('toggle');
  assert.equal(item.children.length, 1); assert.equal(body.parentElement, null);
  const latest = { ...result, data: { text: '<script>最新原文</script>', extra: { arbitrary: [1, 2, 3] } }, error: '真实错误' };
  ui.publish(state({ results: [latest] }));
  assert.equal(ui.work.detailedSerializations, 1);
  item.open = true; await item.fire('toggle');
  assert.deepEqual(JSON.parse(item.children[1].textContent), latest);
  assert.equal(ui.work.detailedSerializations, 2);
  await item.fire('toggle'); assert.equal(ui.work.detailedSerializations, 2, '重复toggle不重写相同正文');
  await ui.nodes['tool-copy'].fire('click'); assert.ok(ui.calls.includes('copy'));
});

it('同键命令更新保留中断按钮并使用最新进程ID，结束后移除按钮且显示最终状态', async () => {
  const ui = setup(); await flush();
  const command = (process_id: string, status = 'running') => ({ ...result, tool: 'run_command', data: { process_id, status, started_at: 1000, finished_at: status === 'done' ? 2000 : undefined } });
  ui.publish(state({ results: [command('old')] }));
  const row = ui.nodes['tool-results'].children[0];
  const stop = row.children[0].children.find((node: any) => node.className.includes('tool-command-stop'));
  ui.publish(state({ results: [command('latest')] }));
  assert.equal(row.children[0].children.find((node: any) => node.className.includes('tool-command-stop')), stop);
  await stop.fire('click');
  assert.deepEqual(ui.calls[1], { batch_id: 'inspect', request_id: 'read', process_id: 'latest' });
  ui.publish(state({ results: [command('latest', 'done')] }));
  assert.equal(stop.parentElement, null);
  assert.equal(row.children[0].children.find((node: any) => node.className === 'tool-result-status').textContent, '完成');
});

it('请求顺序调整复用原节点，旧批和已移除请求不保留详情或展开状态', async () => {
  const ui = setup(); await flush();
  const second = { ...result, request_id: 'second' };
  ui.publish(state({ results: [result, second] }));
  const [firstRow, secondRow] = ui.nodes['tool-results'].children;
  firstRow.open = true; await firstRow.fire('toggle');
  ui.publish(state({ results: [second, result] }));
  assert.equal(ui.nodes['tool-results'].children[0], secondRow); assert.equal(ui.nodes['tool-results'].children[1], firstRow);
  ui.publish(state({ results: [second] })); assert.equal(firstRow.parentElement, null);
  ui.publish(state({ results: [{ ...second, batch_id: 'new' }] })); assert.equal(secondRow.parentElement, null);
  assert.equal(ui.nodes['tool-results'].children[0].open, false);
});

it('最新批次等待时清空旧详情并禁用复制，只在收到本批真实结果后启用', async () => {
  const ui = setup(); await flush();
  ui.publish(state({ results: [result] }));
  assert.match(ui.nodes['tool-copy'].title, /复制本批结果/);
  assert.equal(ui.nodes['tool-results'].children.length, 1);
  ui.publish(state({ busy: true, results: [], message: '等待新批次执行' }));
  assert.equal(ui.nodes['tool-results'].children.length, 0);
  assert.equal(ui.nodes['tool-count'].textContent, '0 项');
  assert.equal(ui.nodes['tool-count'].title, '0 项 · 已返回 0');
  assert.equal(ui.nodes['tool-copy'].disabled, true);
  await ui.nodes['tool-copy'].fire('click');
  assert.deepEqual(ui.calls, ['get']);
  ui.publish(state({ results: [{ ...result, batch_id: 'latest' }] }));
  assert.equal(ui.nodes['tool-results'].children.length, 1);
  assert.equal(ui.nodes['tool-copy'].disabled, false);
  await ui.nodes['tool-copy'].fire('click');
  assert.deepEqual(ui.calls, ['get', 'copy']);
});

it('停止只在用户点击且本批运行时触发，权限拒绝与未知结果显示实际状态', async () => {
  const ui = setup(); await flush();
  ui.publish(state({ busy: true, results: [{ ...result, status: 'permission_denied', error: '权限拒绝' }, { ...result, request_id: 'cmd', status: 'unknown' }] }));
  assert.equal(ui.nodes['tool-results'].children[0].children[0].children.find((node: any) => node.className === 'tool-result-status').textContent, '权限拒绝');
  const unknownStatus = ui.nodes['tool-results'].children[1].children[0].children.find((node: any) => node.className === 'tool-result-status');
  assert.equal(unknownStatus.textContent, '结果未知');
  assert.equal(unknownStatus.title, '执行结果未知');
  assert.equal(ui.nodes['tool-results'].children.some((item: any) => item.children[0].children.some((node: any) => node.className === 'ui-button tool-command-stop')), false);
  assert.deepEqual(ui.calls, ['get']);
});

it('撤销文件修改必须由用户点击，可用性来自主进程', async () => {
  const ui = setup(); await flush();
  await ui.nodes['tool-undo'].fire('click'); assert.deepEqual(ui.calls, ['get']);
  ui.publish(state({ canUndo: true, results: [{ ...result, tool: 'apply_changes' }] }));
  assert.equal(ui.nodes['tool-undo'].disabled, false);
  await ui.nodes['tool-undo'].fire('click');
  assert.equal(ui.nodes['tool-undo'].disabled, true);
  assert.deepEqual(ui.calls, ['get', 'undo']);
});

it('复制结构化失败不能显示复制成功，也不能触发后续发送', async () => {
  const ui = setup({ copyToolResults: async () => ({ ok: false, error: '剪贴板不可用' }) }); await flush();
  ui.publish(state({ results: [result] })); await ui.nodes['tool-copy'].fire('click');
  assert.match(ui.nodes['tool-message'].textContent, /复制结果失败.*剪贴板不可用/);
  assert.equal(ui.nodes['tool-copy'].disabled, false);
  assert.deepEqual(ui.calls, ['get']);
});

const completion = { id: 1, batch_id: 'inspect', outcome: 'success' };

function audioMock() {
  const plays: Array<{ start: number; stop?: number }> = [];
  const volumes: number[] = [];
  let creations = 0;
  class AudioContext {
    state = 'suspended'; currentTime = 20; destination = {};
    constructor() { creations += 1; }
    async resume() { this.state = 'running'; }
    createOscillator() {
      const play = { start: -1 } as { start: number; stop?: number };
      return { type: '', frequency: { setValueAtTime() {} }, connect() {}, disconnect() {},
        start(time: number) { play.start = time; plays.push(play); }, stop(time: number) { play.stop = time; } };
    }
    createGain() { return { gain: { setValueAtTime(value: number) { volumes.push(value); }, linearRampToValueAtTime(value: number) { volumes.push(value); } }, connect() {}, disconnect() {} }; }
  }
  return { AudioContext, plays, volumes, get creations() { return creations; } };
}

it('启动只建立完成基线，不为上次结果提示或播放；相同事件不重复提示', async () => {
  const audio = audioMock();
  const initial = state({ results: [result], completion, config: { ...state().config, completionSound: true } });
  const ui = setup({ getToolState: async () => initial }, audio.AudioContext); await flush();
  ui.publish(initial);
  assert.equal(ui.nodes['tool-completion-notice'].textContent, '');
  assert.equal(ui.timers.size, 0);
  assert.equal(audio.creations, 0);
  ui.publish(state({ completion: { ...completion, id: 2 }, results: [result] }));
  assert.match(ui.nodes['tool-completion-notice'].textContent, /✓.*结果已就绪/);
  const timer = [...ui.timers.keys()][0];
  ui.publish(state({ completion: { ...completion, id: 2 }, results: [result], message: '本批已执行，未重复执行' }));
  assert.deepEqual([...ui.timers.keys()], [timer]);
  ui.expireFeedback();
  ui.publish(state({ completion: { ...completion, id: 2 }, results: [result] }));
  assert.equal(ui.nodes['tool-completion-notice'].textContent, '');
  assert.equal(audio.plays.length, 0);
});

it('新批成功提供短暂摘要动画，保持面板折叠和实际状态，不自动复制', async () => {
  const ui = setup(); await flush();
  ui.publish(state({ results: [result], completion, message: '工具输出已返回' }));
  assert.equal(ui.nodes['tool-panel'].classList.contains('has-completion'), true);
  assert.equal(ui.nodes['tool-panel'].open, false);
  assert.equal(ui.nodes['tool-results'].children[0].open, false);
  assert.equal(ui.nodes['tool-activity'].textContent, '已返回');
  assert.equal(ui.nodes['tool-completion-notice'].classList.contains('is-visible'), true);
  assert.deepEqual(ui.calls, ['get']);
  ui.expireFeedback();
  assert.equal(ui.nodes['tool-panel'].classList.contains('has-completion'), false);
  assert.equal(ui.nodes['tool-completion-notice'].textContent, '');
  assert.equal(ui.nodes['tool-completion-notice'].classList.contains('is-visible'), false, '反馈消失后必须恢复常规状态的可见性');
  assert.equal(ui.nodes['tool-activity'].classList.contains('is-visible'), true);
});

it('旧自动复制成功提示不能盖住本次操作失败、授权等待或后台进程状态', async () => {
  const ui = setup({ copyToolResults: async () => ({ ok: false, error: '剪贴板暂不可用' }) }); await flush();
  ui.publish(state({ results: [result], clipboard: { ok: true } }));
  assert.equal(ui.nodes['tool-copy-notice'].classList.contains('is-visible'), true);
  await ui.nodes['tool-copy'].fire('click');
  assert.equal(ui.nodes['tool-activity'].textContent, '操作失败');
  assert.equal(ui.nodes['tool-activity'].classList.contains('is-visible'), true);
  assert.equal(ui.nodes['tool-copy-notice'].classList.contains('is-visible'), false);
  assert.match(ui.nodes['tool-activity'].title, /剪贴板暂不可用/);
  assert.match(ui.nodes['tool-activity'].title, /已自动复制/);
  for (const next of [
    state({ busy: true, results: [{ ...result, status: 'pending_permission' }], clipboard: { ok: true } }),
    state({ hasRunningProcesses: true, results: [result], clipboard: { ok: true } }),
    state({ storageError: '记录不可用', results: [], clipboard: { ok: true } }),
  ]) {
    ui.publish(next);
    assert.equal(ui.nodes['tool-activity'].classList.contains('is-visible'), true);
    assert.equal(ui.nodes['tool-copy-notice'].classList.contains('is-visible'), false);
  }
});

it('权限拒绝或失败完成提示明确，未完成及切会话清空不会假报成功', async () => {
  const ui = setup(); await flush();
  ui.publish(state({ busy: true, results: [{ ...result, status: 'pending_permission' }] }));
  assert.equal(ui.nodes['tool-completion-notice'].textContent, '');
  ui.publish(state({ completion: { ...completion, outcome: 'error' }, results: [{ ...result, status: 'permission_denied' }], message: '权限拒绝' }));
  assert.match(ui.nodes['tool-completion-notice'].textContent, /本批存在失败或未执行请求/);
  assert.equal(ui.nodes['tool-panel'].classList.contains('completion-error'), true);
  assert.equal(ui.nodes['tool-activity'].textContent, '需检查');
  assert.equal(ui.nodes['tool-message'].hidden, false);
  ui.publish(state());
  assert.equal(ui.nodes['tool-completion-notice'].textContent, '');
  assert.equal(ui.timers.size, 0);
  // 重复批恢复原事件，也不能重新提醒。
  ui.publish(state({ completion: { ...completion, outcome: 'error' }, results: [result] }));
  assert.equal(ui.nodes['tool-completion-notice'].textContent, '');
});

it('原生设置保存音效后，主编辑器每批只播放一次完成短音', async () => {
  const audio = audioMock(); const ui = setup({}, audio.AudioContext); await flush();
  ui.publish(state({ completion, results: [result] })); await flush();
  assert.equal(audio.creations, 0);
  const next = state({ config: { ...state().config, completionSound: true }, completion: { ...completion, id: 2 }, results: [result] });
  ui.publish(next); await flush(); ui.publish(next); await flush();
  assert.equal(audio.plays.length, 1, '主编辑器只播放本批完成；预听在原生设置浮层');
  assert.equal(audio.plays[0].start, 20);
  assert.ok(Math.abs(audio.plays[0].stop! - 20.15) < 0.001);
  assert.ok(Math.max(...audio.volumes) <= 0.035);
  ui.publish(state({ completion: { ...completion, id: 3 }, results: [result] })); await flush();
  assert.equal(audio.plays.length, 1);
  assert.match(ui.nodes['tool-completion-notice'].textContent, /结果已就绪/);
});

it('音效播放失败单独可见，不覆盖本批完成事实', async () => {
  class BrokenAudio { constructor() { throw new Error('Audio is blocked'); } }
  const ui = setup({}, BrokenAudio); await flush();
  ui.publish(state({ config: { ...state().config, completionSound: true }, completion, results: [result], message: '完整工具结果已返回' })); await flush();
  assert.match(ui.nodes['tool-sound-notice'].textContent, /音效未播放/);
  assert.match(ui.nodes['tool-completion-notice'].textContent, /结果已就绪/);
  assert.equal(ui.nodes['tool-activity'].textContent, '已返回');
  assert.equal(ui.nodes['tool-message'].classList.contains('is-error'), false);
});

it('音频准备迟到时不能为已经切走的会话播放旧完成提示', async () => {
  let resume: () => void = () => {};
  let played = 0;
  class DelayedAudio {
    state = 'suspended';
    resume() { return new Promise<void>(yes => { resume = () => { this.state = 'running'; yes(); }; }); }
    createOscillator() { played += 1; throw new Error('Old audio must not be created'); }
  }
  const config = { ...state().config, completionSound: true };
  const ui = setup({ getToolState: async () => state({ config }) }, DelayedAudio); await flush();
  ui.publish(state({ config, completion, results: [result] }));
  ui.publish(state({ config }));
  resume(); await flush();
  assert.equal(played, 0);
  assert.equal(ui.nodes['tool-sound-notice'].textContent, '');
  assert.equal(ui.nodes['tool-completion-notice'].textContent, '');
});

it('齿轮只打开原生浮层并同步可访问状态，关闭恢复焦点无需 DOM 设置面板', async () => {
  const ui = setup(); await flush();
  await ui.nodes['tool-settings-toggle'].fire('click');
  assert.deepEqual(ui.calls, ['get', ['settings', { x: 500, y: 600, width: 30, height: 30 }]]);
  ui.visibility({ open: true, restoreFocus: false }); assert.equal(ui.nodes['tool-settings-toggle'].attrs['aria-expanded'], 'true');
  ui.visibility({ open: false, restoreFocus: true }); assert.equal(ui.nodes['tool-settings-toggle'].focused, true);
  assert.equal(ui.nodes['tool-clear-rules'], undefined);
});
it('工具完成样式遵守减少动画偏好且反馈和声音说明在折叠摘要内可访问', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/toolHarness.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*animation: none/);
  const summary = html.match(/<summary class="tool-panel-summary">([\s\S]*?)<\/summary>/)![1];
  assert.match(summary, /id="tool-completion-notice"[^>]*aria-live="polite"/);
  assert.match(summary, /id="tool-sound-notice"[^>]*aria-live="polite"/);
});

it('等待继续生成显示续写状态和原因，保持面板收起且不产生完成动画或音效', async () => {
  const audio = audioMock(); const ui = setup({}, audio.AudioContext); await flush();
  ui.publish(state({ message: 'AI 回复已中断，等待继续生成；当前工具批次未执行' }));
  assert.equal(ui.nodes['tool-activity'].textContent, '等待续写'); assert.equal(ui.nodes['tool-message'].hidden, false);
  assert.equal(ui.nodes['tool-panel'].open, false); assert.equal(ui.nodes['tool-completion-notice'].textContent, '');
  assert.equal(audio.plays.length, 0);
});

it('采集来源暂停覆盖旧等待AI回复与成功复制反馈，重复广播只提示一次', async () => {
  const ui = setup(); await flush();
  const paused = state({ config: { automatic: true }, results: [result], continuation: { phase: 'waiting_reply', message: '结果已发送' },
    collection: { phase: 'paused', reason: 'source_unknown', message: '无法确认回复是新增输出，请手动采集' } });
  ui.publish(paused);
  assert.equal(ui.nodes['tool-activity'].textContent, '采集已暂停');
  assert.match(ui.nodes['tool-continue-notice'].textContent, /无法确认回复/);
  assert.equal(ui.nodes['tool-continue-notice'].classList.contains('is-visible'), true);
  const notifications = ui.attentionEvents.length;
  ui.publish(paused); assert.equal(ui.attentionEvents.length, notifications);
  await ui.nodes['tool-copy'].fire('click');
  assert.equal(ui.nodes['tool-activity'].textContent, '采集已暂停');
  assert.equal(ui.nodes['tool-continue-notice'].classList.contains('is-visible'), true);
  ui.publish({ ...paused, collection: { phase: 'recovering', message: '正在恢复网页采集' } });
  assert.equal(ui.nodes['tool-activity'].textContent, '正在恢复采集');
  ui.publish({ ...paused, collection: { phase: 'watching', message: '监听正常' } });
  assert.equal(ui.nodes['tool-activity'].textContent, '等待 AI 回复');
});
