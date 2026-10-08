import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

const source = readFileSync(path.join(__dirname, '../src/renderer/localPrompt.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function node() {
  const listeners: Record<string, Array<(event: any) => unknown>> = {};
  return {
    value: '', checked: false, disabled: false, hidden: true, textContent: '', id: '', type: '', className: '',
    attrs: {} as Record<string, string>, children: [] as ReturnType<typeof node>[], selectionStart: 0, focused: false,
    addEventListener(name: string, fn: (event: any) => unknown) { (listeners[name] ||= []).push(fn); },
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    removeAttribute(name: string) { delete this.attrs[name]; },
    replaceChildren() { this.children = []; }, appendChild(child: ReturnType<typeof node>) { this.children.push(child); },
    focus() { this.focused = true; }, scrollIntoView() {},
    setRangeText(value: string, start: number, end: number) { this.value = this.value.slice(0, start) + value + this.value.slice(end); this.selectionStart = start + value.length; },
    dispatchEvent(event: { type: string }) { this.fire(event.type); },
    fire(name: string, event: any = {}) { for (const listener of listeners[name] || []) listener(event); },
  };
}
const skills = [{ name: 'build', description: '构建项目', source: 'project' }, { name: 'review', description: '代码审查', source: 'global' }];
function setup(overrides: Record<string, unknown> = {}) {
  const ids = ['requirement', 'prompt-initialization', 'prompt-send-on-enter', 'btn-send-prompt', 'skill-menu', 'skill-chips', 'skill-preview', 'skill-preview-close'];
  const nodes = Object.fromEntries(ids.map(id => [id, node()]));
  let rootListener: (next: { root: string }) => void = () => {};
  const sends: any[] = [];
  const writes: any[] = [];
  const messages: string[] = [];
  const bridge = {
    async getLocalPromptOptions() { return { includeInitialization: true, sendOnEnter: false }; },
    async setLocalPromptOptions(value: unknown) { writes.push(value); return value; },
    async getSkillCatalog() { return { root: 'C:\\project', skills, errors: [] }; },
    async loadSkill(name: string) { return { ok: true, skill: { content: name + '说明' } }; },
    async sendPrompt(value: unknown) { sends.push(value); return { ok: true }; },
    onRootChanged(fn: typeof rootListener) { rootListener = fn; },
    ...overrides,
  };
  const sandbox = {
    window: { setupLocalPrompt: undefined as any },
    document: { getElementById: (id: string) => nodes[id], createElement: node, dispatchEvent() {} },
    Event: class { constructor(readonly type: string) {} },
  };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const owner = sandbox.window.setupLocalPrompt(bridge, (message: string) => messages.push(message));
  function input(text: string) { nodes.requirement.value = text; nodes.requirement.selectionStart = text.length; nodes.requirement.fire('input'); }
  function key(key: string, extra: Record<string, unknown> = {}) {
    let prevented = false;
    nodes.requirement.fire('keydown', { key, preventDefault() { prevented = true; }, ...extra }); return prevented;
  }
  return { nodes, owner, input, key, sends, writes, messages, changeRoot: (root: string) => rootListener({ root }) };
}

it('/ 技能菜单只识别词边界，普通文件路径不会弹出或成为技能', async () => {
  const ui = setup(); await flush();
  for (const text of ['src/build', 'C:/review', '/a/b']) { ui.input(text); assert.equal(ui.nodes['skill-menu'].hidden, true); }
  ui.input('请 /'); assert.equal(ui.nodes['skill-menu'].children.length, 2);
  assert.equal(ui.key('ArrowDown'), true); assert.equal(ui.key('Enter'), true);
  assert.equal(ui.nodes.requirement.value, '请 /review ');
  assert.deepEqual(Array.from(ui.owner.getSubmission().skills), ['review']);
  assert.equal(ui.nodes['skill-chips'].children[0].textContent, '/review · 全局');
  ui.input('请审查'); assert.equal(ui.owner.getSubmission().skills.length, 0);
  ui.input('/build'); ui.key('Escape'); assert.equal(ui.nodes['skill-menu'].hidden, true);
});

it('关闭回车发送时 Enter 换行，菜单确认、Shift 和中文输入法都不发送', async () => {
  const ui = setup(); await flush(); ui.input('需求');
  assert.equal(ui.key('Enter'), false); assert.equal(ui.sends.length, 0);
  ui.nodes['prompt-send-on-enter'].checked = true; ui.nodes['prompt-send-on-enter'].fire('change'); await flush();
  assert.equal(ui.nodes['btn-send-prompt'].hidden, false);
  assert.equal(ui.key('Enter', { shiftKey: true }), false);
  ui.nodes.requirement.fire('compositionstart'); assert.equal(ui.key('Enter'), false);
  ui.nodes.requirement.fire('compositionend'); assert.equal(ui.key('Enter', { isComposing: true }), false);
  assert.equal(ui.key('Enter', { keyCode: 229 }), false);
  ui.input('/build'); ui.key('Enter'); await flush(); assert.equal(ui.sends.length, 0);
  ui.key('Enter', { repeat: true }); ui.key('Enter', { repeat: true }); await flush(); assert.equal(ui.sends.length, 0);
  ui.key('Enter'); await flush(); assert.equal(ui.sends.length, 1);
  assert.equal(ui.nodes['prompt-initialization'].checked, true);
});

it('跨项目同名技能保持引用但刷新来源标签并使旧预览失效', async () => {
  let project = true;
  const ui = setup({ getSkillCatalog: async () => ({ root: project ? 'old' : 'new', skills: [{ ...skills[0], source: project ? 'project' : 'global' }], errors: [] }) });
  await flush(); ui.input('/build'); ui.key('Enter'); ui.nodes['skill-chips'].children[0].fire('click'); await flush();
  assert.equal(ui.nodes['skill-chips'].children[0].textContent, '/build · 项目');
  assert.equal(ui.nodes['skill-preview'].hidden, false);
  project = false; ui.changeRoot('new'); await flush();
  assert.equal(ui.nodes['skill-chips'].children[0].textContent, '/build · 全局');
  assert.deepEqual(Array.from(ui.owner.getSubmission().skills), ['build']); assert.equal(ui.nodes['skill-preview'].hidden, true);
});

it('已选技能后面的中英文标点是引用边界，不清除选择也不再次打开菜单', async () => {
  const ui = setup(); await flush(); ui.input('/review'); ui.key('Enter');
  for (const punctuation of ['，', '。', '；', '：', '！', '？', ',', '.', '!', '?', ';', ':']) {
    ui.input('/review' + punctuation + '检查代码');
    assert.deepEqual(Array.from(ui.owner.getSubmission().skills), ['review']);
    assert.equal(ui.nodes['skill-menu'].hidden, true);
  }
  ui.input('/review-other'); assert.equal(ui.owner.getSubmission().skills.length, 0);
  ui.input('/review'); ui.key('Enter'); ui.input('/review/file'); assert.equal(ui.owner.getSubmission().skills.length, 0);
});

it('技能菜单打开时 Shift+Enter 仍换行，不选择技能也不发送', async () => {
  const ui = setup(); await flush();
  ui.nodes['prompt-send-on-enter'].checked = true; ui.nodes['prompt-send-on-enter'].fire('change'); await flush();
  ui.input('/rev'); assert.equal(ui.nodes['skill-menu'].hidden, false);
  assert.equal(ui.key('Enter', { shiftKey: true }), false);
  assert.equal(ui.nodes.requirement.value, '/rev'); assert.equal(ui.nodes['skill-menu'].hidden, true);
  assert.equal(ui.owner.getSubmission().skills.length, 0); assert.equal(ui.sends.length, 0);
});

it('发送冻结需求和技能快照，忙时禁止重复，未知结果不重试且保留草稿', async () => {
  let finish: (value: unknown) => void = () => {};
  const sent: any[] = [];
  const ui = setup({ sendPrompt(value: unknown) { sent.push(value); return new Promise(resolve => { finish = resolve; }); } });
  await flush(); ui.nodes['prompt-send-on-enter'].checked = true; ui.nodes['prompt-send-on-enter'].fire('change'); await flush();
  ui.input('需求 /build'); ui.key('Enter'); ui.key('Enter'); ui.key('Enter');
  ui.input('后续草稿'); ui.key('Enter'); assert.equal(sent.length, 1);
  assert.equal(sent[0].requirement, '需求 /build'); assert.deepEqual(Array.from(sent[0].skills), ['build']);
  finish({ ok: false, uncertain: true, error: '确认超时' }); await flush();
  assert.equal(sent.length, 1); assert.equal(ui.nodes.requirement.value, '后续草稿');
  assert.match(ui.messages.at(-1)!, /状态未知/); assert.equal(ui.nodes['btn-send-prompt'].disabled, false);
});

it('切项目时旧查询与技能说明不能覆盖新项目，刷新保留需求并移除失效技能', async () => {
  const queries: Array<(value: unknown) => void> = [];
  let show: (value: unknown) => void = () => {};
  const ui = setup({
    getSkillCatalog: () => new Promise(resolve => queries.push(resolve)),
    loadSkill: () => new Promise(resolve => { show = resolve; }),
  });
  queries.shift()!({ root: 'old', skills, errors: [] }); await flush();
  ui.input('草稿 /build'); ui.key('Enter'); ui.nodes['skill-chips'].children[0].fire('click');
  ui.changeRoot('middle'); ui.changeRoot('new');
  const stale = queries.shift()!; const fresh = queries.shift()!;
  fresh({ root: 'new', skills: [skills[1]], errors: [] }); await flush();
  stale({ root: 'middle', skills, errors: [] }); show({ ok: true, skill: { content: '旧项目说明' } }); await flush();
  assert.equal(ui.owner.getSubmission().root, 'new'); assert.equal(ui.owner.getSubmission().skills.length, 0);
  assert.equal(ui.nodes.requirement.value, '草稿 /build '); assert.equal(ui.nodes['skill-preview'].hidden, true);
});

it('加载目录期间不可复制或发送，跨 owner 忙状态恢复不会死锁', async () => {
  let catalog: (value: unknown) => void = () => {};
  const ui = setup({ getSkillCatalog: () => new Promise(resolve => { catalog = resolve; }) });
  const states: boolean[] = []; ui.owner.onBusy((busy: boolean) => { states.push(busy); ui.owner.setComposerBusy(false); });
  await flush(); assert.equal(states.at(-1), true);
  catalog({ root: null, skills: [], errors: [] }); await flush(); assert.equal(states.at(-1), false);
  ui.owner.setComposerBusy(true); ui.nodes['prompt-send-on-enter'].checked = true;
  ui.input('需求'); ui.key('Enter'); await flush(); assert.equal(ui.sends.length, 0);
  ui.owner.setComposerBusy(false); ui.key('Enter'); await flush(); assert.equal(ui.sends.length, 1);
});

it('选项保存失败恢复实际设置', async () => {
  const ui = setup({ setLocalPromptOptions: async () => { throw new Error('磁盘不可写'); } }); await flush();
  ui.nodes['prompt-initialization'].checked = false; ui.nodes['prompt-initialization'].fire('change'); await flush();
  assert.equal(ui.nodes['prompt-initialization'].checked, true); assert.match(ui.messages.at(-1)!, /保存.*失败/);
});

it('无可用技能或目录加载失败仅保留空列表，不显示原因且不锁住输入', async () => {
  for (const getSkillCatalog of [
    async () => ({ root: null, skills: [], errors: ['无效技能'] }),
    async () => { throw new Error('目录不可读'); },
  ]) {
    const ui = setup({ getSkillCatalog }); await flush(); ui.input('/');
    assert.equal(ui.nodes['skill-menu'].children.length, 0);
    assert.equal(ui.messages.length, 0);
    const states: boolean[] = []; ui.owner.onBusy((busy: boolean) => states.push(busy));
    assert.equal(states.at(-1), false);
  }
});

it('成功发送保留用户关闭的初始化选项，关闭发送开关仍调用主进程持久化取消入口', async () => {
  const ui = setup(); await flush();
  ui.nodes['prompt-initialization'].checked = false; ui.nodes['prompt-send-on-enter'].checked = true;
  ui.nodes['prompt-initialization'].fire('change'); await flush();
  ui.input('后续需求'); ui.key('Enter'); await flush();
  assert.equal(ui.nodes['prompt-initialization'].checked, false); assert.equal(ui.nodes.requirement.value, '后续需求');
  ui.nodes['prompt-send-on-enter'].checked = false; ui.nodes['prompt-send-on-enter'].fire('change'); await flush();
  assert.equal(ui.writes.at(-1).sendOnEnter, false); assert.equal(ui.nodes['btn-send-prompt'].hidden, true);
});
