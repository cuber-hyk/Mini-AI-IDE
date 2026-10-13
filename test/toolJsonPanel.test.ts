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
    set innerHTML(_value: string) { assert.fail('原始 JSON 和参数必须纯文本展示'); },
  };
}
const platform = { platform: 'deepseek', switching: false };
const state = { busy: false, hasRunningProcesses: false };
const parsed = { ok: true, token: 'one-use-token', project: 'C:\\project', batch_id: 'batch-1', requests: [{ id: 'read', tool: 'read_file', args: { path: '<img onerror=alert(1)>' } }] };
function setup(options: { preview?: (text: string) => Promise<any>; execute?: (token: string) => Promise<any> } = {}) {
  const names = ['open', 'panel', 'input', 'status', 'preview', 'project', 'batch', 'requests', 'validate', 'execute', 'cancel'];
  const nodes = Object.fromEntries(names.map(name => [name, element(name === 'panel' || name === 'preview')]));
  const tool = element(); const calls: any[] = []; let rootChanged = () => {};
  const documentEvents: Record<string, (event: any) => void> = {};
  const bridge = { onRootChanged(fn: () => void) { rootChanged = fn; },
    async previewToolJson(text: string) { calls.push(['preview', text]); return options.preview ? options.preview(text) : parsed; },
    async executeToolJson(token: string) { calls.push(['execute', token]); return options.execute ? options.execute(token) : { ok: true }; },
  };
  const window: any = {};
  vm.runInNewContext(readFileSync(path.join(__dirname, '../src/renderer/toolJsonPanel.js'), 'utf8'), { window,
    document: { getElementById(id: string) { return id === 'tool-panel' ? tool : nodes[id.replace('tool-json-', '')]; }, addEventListener(name: string, fn: any) { documentEvents[name] = fn; } } });
  const panel = window.setupToolJsonPanel(bridge); panel.update(state, platform);
  return { nodes, calls, panel, tool, window, rootChanged: () => rootChanged(), localSending(value: boolean) { panel.setPromptBusy(value); },
    async open() { await nodes.open!.fire('click'); }, async input(text: string) { nodes.input!.value = text; await nodes.input!.fire('input'); } };
}

it('粘贴只校验预览，项目和参数纯文本展示，明确确认才执行一次且只传令牌', async () => {
  const ui = setup(); await ui.open(); await ui.input('{"complete":"original"}');
  assert.equal(ui.calls.length, 0); assert.equal(ui.tool.open, true);
  await ui.nodes.validate!.fire('click');
  assert.deepEqual(ui.calls, [['preview', '{"complete":"original"}']]);
  assert.equal(ui.nodes.project!.textContent, '项目：C:\\project');
  assert.match(ui.nodes.requests!.textContent, /<img onerror=alert\(1\)>/);
  assert.equal(ui.nodes.execute!.disabled, false);
  await ui.nodes.execute!.fire('click'); await ui.nodes.execute!.fire('click');
  assert.deepEqual(ui.calls[1], ['execute', 'one-use-token']); assert.equal(ui.calls.length, 2);
  assert.equal(ui.nodes.panel!.hidden, true); assert.equal(ui.nodes.input!.value, '{"complete":"original"}');
});

it('输入编辑即使同文也撤销已校验令牌，取消零执行并保留输入', async () => {
  const ui = setup(); await ui.open(); await ui.input('original'); await ui.nodes.validate!.fire('click');
  await ui.input('original'); assert.equal(ui.nodes.execute!.disabled, true); assert.equal(ui.nodes.preview!.hidden, true);
  await ui.nodes.execute!.fire('click'); await ui.nodes.cancel!.fire('click');
  assert.equal(ui.calls.length, 1); assert.equal(ui.nodes.input!.value, 'original');
  await ui.open(); assert.equal(ui.nodes.execute!.disabled, true);
});

it('改输入、取消、切项目或忙状态后迟到的校验不能恢复执行资格', async () => {
  for (const invalidate of [async (ui: any) => ui.input('changed'), async (ui: any) => ui.nodes.cancel.fire('click'), async (ui: any) => ui.rootChanged(), async (ui: any) => ui.panel.update({ busy: true }, platform)]) {
    let release!: (result: any) => void;
    const ui = setup({ preview: () => new Promise(resolve => { release = resolve; }) });
    await ui.open(); await ui.input('original'); const waiting = ui.nodes.validate!.fire('click');
    await invalidate(ui); release(parsed); await waiting;
    assert.equal(ui.nodes.execute!.disabled, true); assert.equal(ui.nodes.preview!.hidden, true);
    assert.equal(ui.calls.length, 1);
  }
});

it('正在校验时继续编辑并重校验，只呈现最新返回的项目和令牌', async () => {
  const releases: Array<(value: any) => void> = [];
  const ui = setup({ preview: () => new Promise(resolve => releases.push(resolve)) });
  await ui.open(); await ui.input('first'); const first = ui.nodes.validate!.fire('click');
  await ui.input('second'); const second = ui.nodes.validate!.fire('click');
  releases[1]!({ ...parsed, token: 'second', batch_id: 'second' }); await second;
  releases[0]!({ ...parsed, token: 'first' }); await first;
  assert.match(ui.nodes.batch!.textContent, /second/); await ui.nodes.execute!.fire('click');
  assert.deepEqual(ui.calls.at(-1), ['execute', 'second']);
});

it('工具、后台命令、运输和平台切换期间均禁用，恢复后必须重校验', async () => {
  for (const next of [{ busy: true }, { hasRunningProcesses: true }, { resultReturn: { phase: 'sending' } }, { continuation: { phase: 'sending' } }, { continuation: { phase: 'countdown' } }, { storageError: 'broken' }]) {
    const ui = setup(); await ui.open(); await ui.input('original'); await ui.nodes.validate!.fire('click');
    ui.panel.update(next, platform); assert.equal(ui.nodes.open!.disabled, true); assert.equal(ui.nodes.validate!.disabled, true); assert.equal(ui.nodes.execute!.disabled, true);
    ui.panel.update(state, platform); assert.equal(ui.nodes.execute!.disabled, true);
  }
  const ui = setup(); ui.panel.update(state, { ...platform, switching: true }); assert.equal(ui.nodes.open!.disabled, true);
  const switched = setup(); await switched.open(); await switched.input('original'); await switched.nodes.validate!.fire('click');
  switched.panel.update(state, { platform: 'chatgpt', switching: false }); assert.equal(switched.nodes.execute!.disabled, true);
});

it('本地主动发送开始撤销预览，结束后不能复活旧令牌', async () => {
  const ui = setup(); await ui.open(); await ui.input('original'); await ui.nodes.validate!.fire('click');
  ui.localSending(true); assert.equal(ui.nodes.open!.disabled, true); assert.equal(ui.nodes.execute!.disabled, true);
  ui.localSending(false); assert.equal(ui.nodes.open!.disabled, false); assert.equal(ui.nodes.execute!.disabled, true);
});

it('需求和工具两个接线顺序共用面板owner，初始需求忙状态保留', async () => {
  const ui = setup(); ui.localSending(true);
  const same = ui.window.setupToolJsonPanel({ previewToolJson() { assert.fail('不得创建第二owner'); } });
  assert.equal(same, ui.panel); same.update(state, platform); assert.equal(ui.nodes.open!.disabled, true);
  ui.localSending(false); await ui.open(); await ui.input('one'); await ui.nodes.validate!.fire('click'); assert.equal(ui.calls.length, 1);
});

it('超过UTF16上限、错误JSON及执行失败保留输入，不恢复执行或读取剪贴板', async () => {
  const ui = setup({ preview: async () => ({ ok: false, error: 'JSON 第2行错误' }) }); await ui.open();
  await ui.input('😀'.repeat(100001)); assert.equal(ui.nodes.validate!.disabled, true); assert.match(ui.nodes.status!.textContent, /200000/);
  await ui.input('broken original'); await ui.nodes.validate!.fire('click'); assert.match(ui.nodes.status!.textContent, /第2行/); assert.equal(ui.nodes.input!.value, 'broken original');
  const failed = setup({ execute: async () => ({ ok: false, error: '上下文已变化' }) }); await failed.open(); await failed.input('original'); await failed.nodes.validate!.fire('click'); await failed.nodes.execute!.fire('click');
  assert.equal(failed.nodes.input!.value, 'original'); assert.equal(failed.nodes.panel!.hidden, false); assert.equal(failed.nodes.execute!.disabled, true); assert.match(failed.nodes.status!.textContent, /上下文已变化/);
});

it('确认运输等待中不能重复执行或以取消按钮误称停止实际工具', async () => {
  let finish!: (value: any) => void;
  const ui = setup({ execute: () => new Promise(resolve => { finish = resolve; }) }); await ui.open(); await ui.input('original'); await ui.nodes.validate!.fire('click');
  const waiting = ui.nodes.execute!.fire('click'); await ui.nodes.execute!.fire('click'); await ui.nodes.cancel!.fire('click');
  assert.equal(ui.nodes.cancel!.disabled, true); assert.equal(ui.nodes.panel!.hidden, false); assert.equal(ui.calls.length, 2);
  finish({ ok: false, error: '未执行' }); await waiting; assert.equal(ui.nodes.cancel!.disabled, false);
});

it('入口及确认留在工具正文，具名标签、maxlength和脚本加载完整', () => {
  const html = readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const section = html.slice(html.indexOf('id="tool-panel-body"'), html.indexOf('id="tool-results"'));
  assert.match(section, /id="tool-json-open"[^>]*>执行 JSON/);
  assert.match(section, /label for="tool-json-input"/); assert.match(section, /textarea[^>]*maxlength="200000"/);
  assert.match(section, /id="tool-json-execute"[^>]*disabled>确认执行/);
  assert.ok(html.indexOf('src="./toolJsonPanel.js"') < html.indexOf('src="./toolHarness.js"'));
  const source = readFileSync(path.join(__dirname, '../src/renderer/toolJsonPanel.js'), 'utf8');
  assert.doesNotMatch(source, /clipboard|innerHTML|sendPrompt|collectReply|sendToolResults/);
  const css = readFileSync(path.join(__dirname, '../src/renderer/toolHarness.css'), 'utf8');
  assert.match(css, /\.tool-panel-body[^}]*overflow-y: auto/); assert.doesNotMatch(css, /\.tool-json-(?:panel|preview)[^{]*\{[^}]*overflow(?:-y)?: auto/);
});


it('同步执行的主界面入口调用手动JSON owner之前加载该模块，工作区初始化不会因未定义入口中断', () => {
  const html = readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g), match => match[1]);
  assert.equal(scripts.filter(src => src === './toolJsonPanel.js').length, 1);
  assert.ok(scripts.indexOf('./toolJsonPanel.js') >= 0 && scripts.indexOf('./toolJsonPanel.js') < scripts.indexOf('./renderer.js'));
});
