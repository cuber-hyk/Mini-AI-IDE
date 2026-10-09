import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

function element() {
  const listeners: Record<string, Array<() => unknown>> = {};
  const classes = new Set<string>();
  return {
    disabled: false, checked: false, open: false, value: '', textContent: '', className: '',
    dataset: {} as Record<string, string>, children: [] as any[],
    addEventListener(name: string, handler: () => unknown) { (listeners[name] ??= []).push(handler); },
    fire(name: string) { return Promise.all((listeners[name] ?? []).map(fn => (fn as any)({ preventDefault() {}, stopPropagation() {} }))); },
    classList: { toggle(name: string, on: boolean) { if (on) classes.add(name); else classes.delete(name); }, contains(name: string) { return classes.has(name); } },
    replaceChildren() { this.children = []; },
    appendChild(child: unknown) { this.children.push(child); },
    set innerHTML(_value: string) { throw new Error('Tool output must never become HTML'); },
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return { config: { permission: 'ask', automatic: false, dirtyPolicy: 'ask', completionSound: false }, results: [], busy: false, message: '等待工具请求', canUndo: false, ...overrides };
}

function setup(overrides: Record<string, unknown> = {}, audioConstructor?: unknown) {
  const ids = ['tool-permission-control', 'tool-permission', 'tool-automatic', 'tool-dirty-policy', 'tool-permission-hint', 'tool-count',
    'tool-activity', 'tool-message', 'tool-results', 'tool-copy', 'tool-cancel', 'tool-clear-rules', 'tool-undo',
    'tool-panel', 'tool-completion-notice', 'tool-sound-notice', 'tool-completion-sound', 'tool-more-toggle', 'tool-copy-notice', 'tool-auto-copy', 'tool-send-interval', 'tool-continue-notice', 'tool-interval-down', 'tool-interval-up', 'tool-send-results', 'tool-return-notice'];
  const nodes = Object.fromEntries(ids.map(id => [id, element()]));
  let current = state();
  let publish: (value: any) => void = () => {};
  let ready: () => void = () => {};
  const calls: any[] = [];
  const bridge = {
    async getToolState() { calls.push('get'); return current; },
    onToolState(fn: typeof publish) { publish = fn; },
    async setToolConfig(patch: any) { calls.push(JSON.parse(JSON.stringify(patch))); current = state({ ...current, config: { ...current.config, ...patch } }); return current; },
    async copyToolResults() { calls.push('copy'); return { ok: true }; },
    async sendToolResults(...args: unknown[]) { calls.push(['send', ...args]); return { ok: true }; },
    async stopToolCommand(target: any) { calls.push(JSON.parse(JSON.stringify(target))); return current; },
    async clearToolRules() { calls.push('clear'); return current; },
    async undoToolChange() { calls.push('undo'); publish(state({ ...current, canUndo: false })); return { ok: true }; },
    ...overrides,
  };
  const window = { editorBridge: bridge, setupToolHarness: null as any, setupToolPanelLayout: () => ({ refresh() {} }), createToolExecutionClock: () => ({ replace() {} }), AudioContext: audioConstructor };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/toolResultPresentation.js'), 'utf8'), { window });
  const timers = new Map<number, () => void>();
  let timerId = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/toolHarness.js'), 'utf8'), {
    window, setTimeout(callback: () => void) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); }, document: {
      readyState: 'loading', getElementById(id: string) { return nodes[id]; }, createElement() { return element(); },
      addEventListener(name: string, handler: () => void) { if (name === 'DOMContentLoaded') ready = handler; },
    },
  });
  ready();
  return { nodes, calls, timers, expireFeedback() { for (const callback of [...timers.values()]) callback(); }, publish(value: any) { current = value; publish(value); } };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
const result = { batch_id: 'inspect', request_id: 'read', tool: 'read_file', status: 'done', data: { text: '真实文件内容' } };

function attachmentState(overrides: Record<string, unknown> = {}) {
  return state({
    results: [{ ...result, tool: 'attach_file', data: { id: 'attachment-a', name: '论文.pdf', size: 1024 } }],
    completion: { id: 1, batch_id: 'inspect', outcome: 'success' },
    resultReturn: { canSend: true, attachmentCount: 1, phase: 'ready', message: '1 个附件待发送' }, ...overrides,
  });
}

it('附件手动发送入口仅显示当前批附件，依owner资格与自动开关禁用，不改变自动继续摘要', async () => {
  const ui = setup(); await flush();
  assert.equal(ui.nodes['tool-send-results'].hidden, true);
  ui.publish(attachmentState());
  assert.equal(ui.nodes['tool-send-results'].hidden, false); assert.equal(ui.nodes['tool-send-results'].disabled, false);
  assert.equal(ui.nodes['tool-return-notice'].textContent, '1 个附件待发送');
  ui.publish(attachmentState({ busy: true })); assert.equal(ui.nodes['tool-send-results'].disabled, true);
  ui.publish(attachmentState({ resultReturn: { canSend: false, attachmentCount: 1, phase: 'paused', message: '当前批已失效' } }));
  assert.equal(ui.nodes['tool-send-results'].disabled, true); assert.equal(ui.nodes['tool-return-notice'].textContent, '当前批已失效');
  assert.equal(ui.nodes['tool-return-notice'].classList.contains('is-error'), true);
  ui.publish(attachmentState({ config: { automatic: true }, continuation: { phase: 'sending', message: '自动上传中' }, resultReturn: { canSend: true, attachmentCount: 1, phase: 'sending', message: '正在上传1个附件' } }));
  assert.equal(ui.nodes['tool-send-results'].disabled, true); assert.equal(ui.nodes['tool-activity'].textContent, '正在发送结果');
  assert.equal(ui.nodes['tool-return-notice'].textContent, '正在上传1个附件');
});

it('发送当前批附件的IPC不携带正文路径ID，等待期间防双击，成功回执不重复发送', async () => {
  let finish!: (result: unknown) => void; const args: unknown[][] = [];
  const ui = setup({ sendToolResults: (...input: unknown[]) => { args.push(input); return new Promise(resolve => { finish = resolve; }); } }); await flush();
  ui.publish(attachmentState());
  const pending = ui.nodes['tool-send-results'].fire('click'); await flush();
  assert.equal(ui.nodes['tool-send-results'].disabled, true); assert.equal(ui.nodes['tool-send-results'].textContent, '正在发送附件…');
  await ui.nodes['tool-send-results'].fire('click'); assert.deepEqual(args, [[]]);
  finish({ ok: true }); await pending;
  assert.equal(ui.nodes['tool-send-results'].disabled, true); assert.match(ui.nodes['tool-return-notice'].textContent, /已发送/);
  await ui.nodes['tool-send-results'].fire('click'); assert.equal(args.length, 1);
});

it('未知附件发送回执与IPC异常显示具体原因，不能当作发送成功或再次点击', async () => {
  for (const sendToolResults of [async () => ({ ok: false, uncertain: true, error: '发送按钮点击后无法确认' }), async () => { throw new Error('IPC disconnected'); }]) {
    const ui = setup({ sendToolResults }); await flush(); ui.publish(attachmentState());
    await ui.nodes['tool-send-results'].fire('click');
    assert.equal(ui.nodes['tool-send-results'].disabled, true);
    assert.match(ui.nodes['tool-return-notice'].textContent, /状态未知/);
    assert.match(ui.nodes['tool-return-notice'].textContent, /无法确认|IPC disconnected/);
    assert.equal(ui.nodes['tool-return-notice'].classList.contains('is-error'), true);
    assert.doesNotMatch(ui.nodes['tool-return-notice'].textContent, /已发送/);
  }
});

it('旧批附件发送回执不能覆盖新批状态，新批是否可发送仍由owner判断', async () => {
  let fail!: (error: Error) => void;
  const ui = setup({ sendToolResults: () => new Promise((_resolve, reject) => { fail = reject; }) }); await flush(); ui.publish(attachmentState());
  const pending = ui.nodes['tool-send-results'].fire('click'); await flush();
  ui.publish(attachmentState({ completion: { id: 2, batch_id: 'new', outcome: 'success' }, resultReturn: { canSend: true, attachmentCount: 1, phase: 'ready', message: '新批附件待发送' } }));
  fail(new Error('旧批已失效')); await pending;
  assert.equal(ui.nodes['tool-return-notice'].textContent, '新批附件待发送');
  assert.equal(ui.nodes['tool-send-results'].disabled, false);
});

it('附件发送失败保留owner原因和暂停状态，按钮有键盘名称且窄列动作可换行', async () => {
  const ui = setup({ async sendToolResults() { ui.publish(attachmentState({ resultReturn: { canSend: false, attachmentCount: 1, phase: 'paused', message: '官网已有草稿' } })); return { ok: false, error: '官网已有草稿，未覆盖' }; } }); await flush(); ui.publish(attachmentState());
  await ui.nodes['tool-send-results'].fire('click');
  assert.equal(ui.nodes['tool-send-results'].disabled, true); assert.match(ui.nodes['tool-return-notice'].textContent, /官网已有草稿，未覆盖/);
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  assert.match(html, /id="tool-send-results"[^>]*type="button"[^>]*class="ui-button"[^>]*>发送本批附件<\/button>/);
  assert.match(html, /id="tool-return-notice"[^>]*aria-live="polite"/);
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/toolHarness.css'), 'utf8');
  assert.match(css, /\.tool-panel\.has-attachments \+ \.tool-result-actions\s*\{[^}]*position: static[^}]*flex-wrap: wrap/);
});

it('自动继续显示倒计时或暂停原因，间隔设置可修改，无轮次输入', async () => {
  const ui = setup(); await flush();
  ui.publish(state({ config: { permission: 'full', automatic: true, sendIntervalSeconds: 7 }, continuation: { phase: 'countdown', message: '即将发送', dueAt: Date.now() + 7000 } }));
  assert.equal(ui.nodes['tool-automatic'].checked, true); assert.match(ui.nodes['tool-activity'].textContent, /[67]s 后发送/);
  assert.equal(ui.nodes['tool-send-interval'].value, '7');
  ui.publish(state({ config: { permission: 'full', automatic: true }, continuation: { phase: 'off', message: '已立即关闭，配置正在保存' } }));
  assert.equal(ui.nodes['tool-automatic'].checked, false);
  ui.publish(state({ config: { permission: 'full', automatic: true }, continuation: { phase: 'paused', message: '输入框已有草稿，未覆盖' } }));
  assert.equal(ui.nodes['tool-activity'].textContent, '自动已暂停'); assert.match(ui.nodes['tool-continue-notice'].textContent, /未覆盖/);
  ui.nodes['tool-send-interval'].value = '4'; await ui.nodes['tool-send-interval'].fire('change'); assert.deepEqual(ui.calls.at(-1), { sendIntervalSeconds: 4 });
  const calls = ui.calls.length; ui.nodes['tool-send-interval'].value = ''; await ui.nodes['tool-send-interval'].fire('change'); assert.equal(ui.calls.length, calls);
});
it('JSON格式错误归入批次失败卡片，复制统一结果；不伪造具体工具调用', async () => {
  const ui = setup(); await flush();
  const diagnostic = '工具 JSON 无效\nSyntaxError: position 700\n第 1 行，第 701 列';
  ui.publish(state({ batchError: { status: 'failed', error: diagnostic }, message: '工具批次校验失败，未执行' }));
  assert.equal(ui.nodes['tool-panel'].open, true);
  assert.equal(ui.nodes['tool-activity'].textContent, '格式错误');
  assert.equal(ui.nodes['tool-copy'].title, '复制本批结果');
  assert.equal(ui.nodes['tool-copy'].disabled, false);
  assert.equal(ui.nodes['tool-message'].hidden, true);
  const items = ui.nodes['tool-results'].children;
  assert.equal(items.length, 1); assert.equal(items[0].open, true);
  const failure = JSON.parse(items[0].children[1].textContent);
  assert.equal(failure.batch_error.error, diagnostic);
  assert.equal(failure.batch_error.request_id, undefined);
  assert.equal(ui.nodes['tool-count'].textContent, '1 项校验失败');
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
  assert.equal(buttons[0].textContent, '中断'); assert.equal(buttons[1].disabled, false); assert.equal(buttons[2], undefined);
  assert.equal(ui.nodes['tool-more-toggle'].hidden, true);
  await buttons[1].fire('click'); assert.deepEqual(ui.calls, ['get', { batch_id: 'inspect', request_id: 'background', process_id: 'proc-b' }]);
});

it('旧进程中断尚未返回时，新作用域同批同请求的新进程仍可中断且不接收旧错误', async () => {
  let fail!: (error: Error) => void;
  const ui = setup({ stopToolCommand: () => new Promise((_resolve, reject) => { fail = reject; }) }); await flush();
  const running = { ...result, tool: 'run_command', status: 'running', data: { process_id: 'old-instance', status: 'running' } };
  ui.publish(state({ results: [running] }));
  const button = () => ui.nodes['tool-results'].children[0].children[0].children.find((node: any) => node.className === 'ui-button tool-command-stop');
  const pending = button().fire('click'); await flush(); assert.equal(button().disabled, true);
  ui.publish(state({ results: [{ ...running, data: { ...running.data, process_id: 'new-instance' } }] }));
  assert.equal(button().disabled, false);
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

it('自动复制开关持久保存，勾选设置不主动复制历史输出', async () => {
  const ui = setup(); await flush();
  ui.nodes['tool-auto-copy'].checked = true; await ui.nodes['tool-auto-copy'].fire('change');
  assert.deepEqual(ui.calls, ['get', { autoCopyResults: true }]);
  assert.equal(ui.nodes['tool-auto-copy'].checked, true);
  ui.nodes['tool-auto-copy'].checked = false; await ui.nodes['tool-auto-copy'].fire('change');
  assert.deepEqual(ui.calls, ['get', { autoCopyResults: true }, { autoCopyResults: false }]);
  assert.equal(ui.nodes['tool-auto-copy'].checked, false);
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
  assert.equal(ui.nodes['tool-dirty-policy'].value, 'continue');
  assert.match(ui.nodes['tool-permission-hint'].textContent, /项目外文件/);
  assert.deepEqual(ui.calls, []);
});

it('底部选择权限、自动采集与草稿处理都通过同一持久配置接口', async () => {
  const ui = setup(); await flush();
  ui.nodes['tool-permission'].value = 'rules'; await ui.nodes['tool-permission'].fire('change');
  ui.nodes['tool-automatic'].checked = true; await ui.nodes['tool-automatic'].fire('change');
  ui.nodes['tool-dirty-policy'].value = 'stop'; await ui.nodes['tool-dirty-policy'].fire('change');
  assert.deepEqual(ui.calls, ['get', { permission: 'rules' }, { automatic: true }, { dirtyPolicy: 'stop' }]);
  assert.equal(ui.nodes['tool-permission'].value, 'rules');
  assert.equal(ui.nodes['tool-automatic'].checked, true);
  assert.equal(ui.nodes['tool-dirty-policy'].value, 'stop');
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
  const body = ui.nodes['tool-results'].children[0].children[1];
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

it('最新批次等待时清空旧详情并禁用复制，只在收到本批真实结果后启用', async () => {
  const ui = setup(); await flush();
  ui.publish(state({ results: [result] }));
  assert.equal(ui.nodes['tool-copy'].title, '复制本批结果');
  assert.equal(ui.nodes['tool-results'].children.length, 1);
  ui.publish(state({ busy: true, results: [], message: '等待新批次执行' }));
  assert.equal(ui.nodes['tool-results'].children.length, 0);
  assert.equal(ui.nodes['tool-count'].textContent, '0 项 · 已返回 0');
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
  assert.equal(ui.nodes['tool-results'].children[1].children[0].children.find((node: any) => node.className === 'tool-result-status').textContent, '执行结果未知');
  assert.equal(ui.nodes['tool-results'].children.some((item: any) => item.children[0].children.some((node: any) => node.className === 'ui-button tool-command-stop')), false);
  assert.deepEqual(ui.calls, ['get']);
});

it('清除规则与撤销文件修改必须由用户点击，撤销可用性来自主进程', async () => {
  const ui = setup(); await flush();
  await ui.nodes['tool-undo'].fire('click'); assert.deepEqual(ui.calls, ['get']);
  ui.publish(state({ canUndo: true, results: [{ ...result, tool: 'apply_changes' }] }));
  assert.equal(ui.nodes['tool-undo'].disabled, false);
  await ui.nodes['tool-undo'].fire('click');
  assert.equal(ui.nodes['tool-undo'].disabled, true);
  await ui.nodes['tool-clear-rules'].fire('click');
  assert.deepEqual(ui.calls, ['get', 'undo', 'clear']);
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
  assert.deepEqual(ui.calls, ['get']);
  ui.expireFeedback();
  assert.equal(ui.nodes['tool-panel'].classList.contains('has-completion'), false);
  assert.equal(ui.nodes['tool-completion-notice'].textContent, '');
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

it('音效默认关闭，开启保存成功后预听一次，随后每批只播放一次本地短音', async () => {
  const audio = audioMock(); const ui = setup({}, audio.AudioContext); await flush();
  assert.equal(ui.nodes['tool-completion-sound'].checked, false);
  ui.publish(state({ completion, results: [result] })); await flush();
  assert.equal(audio.creations, 0);
  ui.nodes['tool-completion-sound'].checked = true; await ui.nodes['tool-completion-sound'].fire('change');
  assert.deepEqual(ui.calls, ['get', { completionSound: true }]);
  assert.equal(ui.nodes['tool-completion-sound'].checked, true);
  assert.equal(audio.plays.length, 1, '用户主动开启时预听，不重放上次完成事件');
  const next = state({ config: { ...state().config, completionSound: true }, completion: { ...completion, id: 2 }, results: [result] });
  ui.publish(next); await flush(); ui.publish(next); await flush();
  assert.equal(audio.plays.length, 2, '一次预听，加一次新批完成，相同完成不重播');
  assert.equal(audio.plays[0].start, 20);
  assert.ok(Math.abs(audio.plays[0].stop! - 20.15) < 0.001);
  assert.ok(Math.max(...audio.volumes) <= 0.035);
  ui.nodes['tool-completion-sound'].checked = false; await ui.nodes['tool-completion-sound'].fire('change');
  ui.publish(state({ completion: { ...completion, id: 3 }, results: [result] })); await flush();
  assert.equal(audio.plays.length, 2);
  assert.match(ui.nodes['tool-completion-notice'].textContent, /结果已就绪/);
});

it('音效播放失败单独可见，不覆盖本批完成事实', async () => {
  class BrokenAudio { constructor() { throw new Error('Audio is blocked'); } }
  const ui = setup({}, BrokenAudio); await flush();
  ui.nodes['tool-completion-sound'].checked = true; await ui.nodes['tool-completion-sound'].fire('change');
  assert.match(ui.nodes['tool-sound-notice'].textContent, /音效未播放/);
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

it('音效设置保存失败恢复关闭状态，准备声音不产生通知音', async () => {
  const audio = audioMock();
  const ui = setup({ setToolConfig: async () => { throw new Error('设置未写入'); } }, audio.AudioContext); await flush();
  ui.nodes['tool-completion-sound'].checked = true; await ui.nodes['tool-completion-sound'].fire('change');
  assert.equal(ui.nodes['tool-completion-sound'].checked, false);
  assert.match(ui.nodes['tool-message'].textContent, /设置未写入/);
  ui.publish(state({ completion, results: [result] })); await flush();
  assert.equal(audio.plays.length, 0);
  assert.match(ui.nodes['tool-completion-notice'].textContent, /结果已就绪/);
});

it('音效预听准备迟到时，已经关闭的设置不能发出声音', async () => {
  let finish: () => void = () => {}; let played = 0;
  class DelayedAudio {
    state = 'suspended';
    resume() { return new Promise<void>(resolve => { finish = () => { this.state = 'running'; resolve(); }; }); }
    createOscillator() { played += 1; throw new Error('Cancelled preview must not play'); }
  }
  const ui = setup({}, DelayedAudio); await flush();
  ui.nodes['tool-completion-sound'].checked = true; const enabling = ui.nodes['tool-completion-sound'].fire('change'); await flush();
  ui.nodes['tool-completion-sound'].checked = false; await ui.nodes['tool-completion-sound'].fire('change');
  finish(); await enabling; assert.equal(played, 0); assert.equal(ui.nodes['tool-sound-notice'].textContent, '');
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
