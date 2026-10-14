import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

function element(hidden = false) {
  const listeners: Record<string, Array<(event: any) => unknown>> = {};
  const classes = new Set<string>();
  return { hidden, disabled: false, open: false, focused: false, value: '', textContent: '', attrs: {} as Record<string, string>,
    addEventListener(name: string, handler: (event: any) => unknown) { (listeners[name] ??= []).push(handler); },
    fire(name: string, event: any = {}) { return Promise.all((listeners[name] ?? []).map(fn => fn({ preventDefault() {}, ...event }))); },
    setAttribute(name: string, value: string) { this.attrs[name] = value; }, focus() { this.focused = true; },
    classList: { toggle(name: string, on: boolean) { if (on) classes.add(name); else classes.delete(name); }, contains(name: string) { return classes.has(name); } },
    set innerHTML(_value: string) { assert.fail('原始 JSON 和错误必须纯文本展示'); },
  };
}
const platform = { platform: 'deepseek', switching: false };
const state = { busy: false, hasRunningProcesses: false };
function setup(execute: (text: string) => Promise<any> = async () => ({ ok: true })) {
  const names = ['open', 'panel', 'input', 'status', 'execute', 'cancel'];
  const nodes = Object.fromEntries(names.map(name => [name, element(name === 'panel')]));
  const tool = element(); const calls: string[] = []; let rootChanged = () => {};
  const bridge = { onRootChanged(fn: () => void) { rootChanged = fn; },
    async executeToolJson(text: string) { calls.push(text); return execute(text); },
  };
  const window: any = {};
  vm.runInNewContext(readFileSync(path.join(__dirname, '../src/renderer/toolJsonPanel.js'), 'utf8'), { window,
    document: { getElementById(id: string) { return id === 'tool-panel' ? tool : nodes[id.replace('tool-json-', '')]; } } });
  const panel = window.setupToolJsonPanel(bridge); panel.update(state, platform);
  return { nodes, calls, panel, tool, window, rootChanged: () => rootChanged(),
    async open() { await nodes.open!.fire('click'); }, async input(text: string) { nodes.input!.value = text; await nodes.input!.fire('input'); } };
}

it('粘贴不触发工具，单次执行提交完整原文并显示原工具层结果', async () => {
  const ui = setup(); await ui.open(); await ui.input('{"original":"<img onerror=alert(1)>"}');
  assert.equal(ui.calls.length, 0); assert.equal(ui.tool.open, true);
  assert.equal(ui.nodes.status!.textContent, '', '打开时不重复常驻操作提示');
  await ui.nodes.execute!.fire('click'); await ui.nodes.execute!.fire('click');
  assert.deepEqual(ui.calls, ['{"original":"<img onerror=alert(1)>"}']);
  assert.equal(ui.nodes.panel!.hidden, true); assert.equal(ui.nodes.input!.value, ui.calls[0]);
  assert.equal(ui.nodes.open!.attrs['aria-expanded'], 'false'); assert.equal(ui.nodes.open!.focused, true);
});

it('工具层已接纳格式错误诊断也关闭输入区，让用户查看并复制结果', async () => {
  const ui = setup(async () => ({ ok: true })); await ui.open(); await ui.input('broken JSON');
  await ui.nodes.execute!.fire('click'); assert.equal(ui.nodes.panel!.hidden, true); assert.deepEqual(ui.calls, ['broken JSON']);
});

it('等待提交时防止重复执行及关闭，不将关闭误称停止真实工具', async () => {
  let finish!: (value: any) => void;
  const ui = setup(() => new Promise(resolve => { finish = resolve; })); await ui.open(); await ui.input('original');
  const waiting = ui.nodes.execute!.fire('click');
  await ui.nodes.execute!.fire('click'); await ui.nodes.cancel!.fire('click'); await ui.nodes.panel!.fire('keydown', { key: 'Escape' });
  assert.equal(ui.nodes.input!.disabled, true); assert.equal(ui.nodes.cancel!.disabled, true); assert.equal(ui.nodes.panel!.hidden, false); assert.equal(ui.calls.length, 1);
  assert.equal(ui.nodes.execute!.attrs['aria-busy'], 'true'); assert.equal(ui.nodes.execute!.attrs['aria-label'], '正在提交工具请求');
  ui.panel.update({ busy: true }, platform); finish({ ok: true }); await waiting;
  assert.equal(ui.nodes.panel!.hidden, true); assert.equal(ui.nodes.input!.disabled, false);
  assert.equal(ui.nodes.execute!.attrs['aria-busy'], 'false'); assert.equal(ui.nodes.execute!.attrs['aria-label'], '执行工具 JSON');
});

it('入口拒绝保留输入和错误，状态恢复后允许用户主动再次执行', async () => {
  const ui = setup(async () => ({ ok: false, error: '<img> 项目已变化' })); await ui.open(); await ui.input('original');
  await ui.nodes.execute!.fire('click'); assert.equal(ui.nodes.input!.value, 'original'); assert.equal(ui.nodes.panel!.hidden, false);
  assert.equal(ui.nodes.status!.textContent, '<img> 项目已变化'); assert.equal(ui.nodes.status!.classList.contains('is-error'), true);
  assert.equal(ui.nodes.execute!.disabled, false); assert.equal(ui.calls.length, 1);
});

it('运输异常保留输入，不自动重试并提示核对工具真实状态', async () => {
  const ui = setup(async () => { throw new Error('IPC interrupted'); }); await ui.open(); await ui.input('original');
  await ui.nodes.execute!.fire('click'); assert.equal(ui.nodes.panel!.hidden, false); assert.equal(ui.calls.length, 1);
  assert.match(ui.nodes.status!.textContent, /状态未确认.*请勿重复提交/); assert.equal(ui.nodes.input!.value, 'original');
});

it('切项目、平台来回或输入变化后，迟到接纳回执不能关闭当前输入区', async () => {
  for (const change of [async (ui: any) => ui.rootChanged(), async (ui: any) => { ui.panel.update(state, { platform: 'chatgpt' }); ui.panel.update(state, platform); }, async (ui: any) => ui.input('changed')]) {
    let finish!: (value: any) => void;
    const ui = setup(() => new Promise(resolve => { finish = resolve; })); await ui.open(); await ui.input('original');
    const waiting = ui.nodes.execute!.fire('click'); await change(ui); finish({ ok: true }); await waiting;
    assert.equal(ui.nodes.panel!.hidden, false); assert.equal(ui.calls.length, 1); assert.equal(ui.nodes.input!.disabled, false);
  }
});

it('工具、后台命令、存储、发送与平台切换阻止操作，正常恢复后可直接执行', async () => {
  for (const next of [{ busy: true }, { hasRunningProcesses: true }, { resultReturn: { phase: 'sending' } }, { continuation: { phase: 'sending' } }, { continuation: { phase: 'countdown' } }, { storageError: 'broken' }]) {
    const ui = setup(); await ui.open(); await ui.input('original'); ui.panel.update(next, platform);
    assert.equal(ui.nodes.open!.disabled, true); await ui.nodes.execute!.fire('click'); assert.equal(ui.calls.length, 0);
    ui.panel.update(state, platform); await ui.nodes.execute!.fire('click'); assert.equal(ui.calls.length, 1);
  }
  for (const target of [undefined, { platform: 'unsupported' }, { ...platform, switching: true }]) {
    const ui = setup(); ui.panel.update(state, target); assert.equal(ui.nodes.open!.disabled, true);
  }
});

it('需求准备与发送共用面板owner，不重复接线或绕过需求忙状态', async () => {
  const ui = setup(); ui.panel.setPromptBusy(true);
  const same = ui.window.setupToolJsonPanel({ executeToolJson() { assert.fail('不得创建第二owner'); } });
  assert.equal(same, ui.panel); same.update(state, platform); assert.equal(ui.nodes.open!.disabled, true);
  ui.panel.setPromptBusy(false); await ui.open(); await ui.input('one'); ui.panel.setPromptBusy(true);
  await ui.nodes.execute!.fire('click'); assert.equal(ui.calls.length, 0); ui.panel.setPromptBusy(false);
  await ui.nodes.execute!.fire('click'); assert.equal(ui.calls.length, 1);
});

it('关闭与Escape保留输入且零执行，空文本与UTF16超长不能提交', async () => {
  const ui = setup(); await ui.open(); await ui.input('   '); assert.equal(ui.nodes.execute!.disabled, true);
  await ui.input('😀'.repeat(100001)); assert.equal(ui.nodes.execute!.disabled, true); assert.match(ui.nodes.status!.textContent, /200000/);
  await ui.input('original'); await ui.nodes.cancel!.fire('click'); assert.equal(ui.calls.length, 0);
  await ui.open(); assert.equal(ui.nodes.input!.value, 'original'); await ui.nodes.panel!.fire('keydown', { key: 'Escape' });
  assert.equal(ui.nodes.panel!.hidden, true); assert.equal(ui.calls.length, 0);
});

it('摘要仅有一个JSON入口，正文只有执行与关闭，脚本初始化与安全文本边界保持', () => {
  const html = readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const section = html.slice(html.indexOf('id="tool-panel-body"'), html.indexOf('id="tool-results"'));
  assert.equal((html.match(/id="tool-json-open"/g) || []).length, 1);
  assert.match(section, /label for="tool-json-input"/); assert.match(section, /textarea[^>]*maxlength="200000"/);
  assert.match(section, /id="tool-json-execute"[^>]*title="执行"[^>]*aria-label="执行工具 JSON"[^>]*disabled><svg[^>]*aria-hidden="true"/);
  assert.match(section, /id="tool-json-cancel"[^>]*title="关闭"[^>]*aria-label="关闭工具 JSON 输入区"><svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(section, /tool-json-preview|tool-json-validate|确认执行|校验并预览/);
  const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g), match => match[1]);
  assert.equal(scripts.filter(src => src === './toolJsonPanel.js').length, 1);
  assert.ok(scripts.indexOf('./toolJsonPanel.js') < scripts.indexOf('./renderer.js'));
  assert.ok(scripts.indexOf('./toolJsonPanel.js') < scripts.indexOf('./toolHarness.js'));
  const source = readFileSync(path.join(__dirname, '../src/renderer/toolJsonPanel.js'), 'utf8');
  assert.doesNotMatch(source, /clipboard|innerHTML|sendPrompt|collectReply|sendToolResults|previewToolJson/);
  const css = readFileSync(path.join(__dirname, '../src/renderer/toolHarness.css'), 'utf8');
  assert.match(css, /\.tool-panel-body[^}]*overflow-y: auto/); assert.doesNotMatch(css, /\.tool-json-panel[^\{]*\{[^}]*overflow(?:-y)?: auto/);
});
