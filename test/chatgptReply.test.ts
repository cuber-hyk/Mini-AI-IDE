import assert from 'node:assert/strict';
import { it } from 'node:test';
import vm from 'node:vm';
import { CHATGPT_COLLECT_SCRIPT, CHATGPT_COMPLETION_SCRIPT, CHATGPT_OBSERVATION_SCRIPT, CHATGPT_SOURCE_TEXT_READER } from '../src/main/chatgptPage';
import { webPlatformOf } from '../src/shared/webConversation';
import { isFirstPromptSession, isPendingFirstPromptSession } from '../src/main/firstPromptSession';
import { collectReply } from '../src/main/replyCollector';
import { readAutoReply, ReplyMonitor } from '../src/main/tools/replyObservation';
import { parseToolBatch } from '../src/shared/toolProtocol';
import { replyWatchScript } from '../src/main/tools/replyChangeWatcher';

/** 只模拟 DOM 查询；业务判据在生产脚本中运行。 */
class Node {
  nodeType = 1; parentElement: Node | null = null; hidden = false; disabled = false;
  constructor(readonly tagName: string, readonly attrs: Record<string, string> = {}, readonly children: Node[] = [], private text = '') { children.forEach(child => child.parentElement = this); }
  get className() { return this.attrs.class || ''; }
  classList = { contains: (name: string) => this.className.split(/\s+/).includes(name) };
  get childNodes() { return this.children; }
  get textContent(): string { return this.text || this.children.map(child => child.textContent).join(''); }
  get innerText() { return this.textContent; }
  get innerHTML() { return this.children.map(child => child.tagName + child.className + child.textContent).join(''); }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  contains(node: Node): boolean { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const tag = /^([a-z][a-z0-9]*)/i.exec(part)?.[1];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      const cls = /\.([\w-]+)/.exec(part)?.[1];
      if (cls && !this.classList.contains(cls)) return false;
      return [...part.matchAll(/\[([\w-]+)(?:(\^=|\*=|~=|=)"([^"]*)")?\]/g)].every(([, key, op, value]) => {
        const actual = this.getAttribute(key!);
        return op === '=' ? actual === value : op === '^=' ? actual?.startsWith(value!) : op === '*=' ? actual?.includes(value!) : op === '~=' ? actual?.split(/\s+/).includes(value!) : actual !== null;
      });
    });
  }
  closest(selector: string): Node | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector: string): Node[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}
const el = (tag: string, attrs: Record<string, string> = {}, children: Node[] = [], text = '') => new Node(tag.toUpperCase(), attrs, children, text);
const pendingSession = 'https://chatgpt.com/c/local-chatgpt%3A12345678-1234-1234-1234-123456789abc';
it('编码 UUID 占位只用于首页首发等待，始终不获得普通网页权限', () => {
  assert.equal(isPendingFirstPromptSession('https://chatgpt.com/', pendingSession), true);
  assert.equal(webPlatformOf(pendingSession), null);
  assert.equal(isFirstPromptSession('https://chatgpt.com/', pendingSession), false);
  for (const [from,to] of [
    ['https://chatgpt.com/c/old',pendingSession], ['https://chatgpt.com/',pendingSession.replace('chatgpt.com','evil.test')],
    ['https://chatgpt.com/',pendingSession.replace('123456789abc','not-a-uuid')], ['https://chatgpt.com/',pendingSession.replace('%3A',':')],
    ['https://chatgpt.com/',pendingSession.replace('/c/','/g/anything/c/')], ['https://user@chatgpt.com/',pendingSession],
    ['https://chatgpt.com/',pendingSession.replace('/c/','/%63/')], ['https://chatgpt.com/',pendingSession.replace('https://','http://')],
    ['https://chatgpt.com/',pendingSession.replace('local-chatgpt','other')],
  ]) assert.equal(isPendingFirstPromptSession(from!,to!),false);
});
function turn(code: string, options: { complete?: boolean; role?: string; language?: string } = {}) {
  const content = el('code', { class: 'whitespace-pre CodeContent-real' }, [], code);
  const label = el('div', { class: 'truncate' }, [], options.language ?? 'mini-ai-tools');
  const bar = el('div', { class: 'StickyActionBar-real', 'data-markdown-copy': '' }, [label, el('div', {}, [el('button', { 'aria-label': '复制' }, [], '复制')])]);
  const surface = el('div', { class: 'CodeSurface-real', 'data-markdown-copy': '' }, [bar, el('div', {}, [content])]);
  const root = el('div', { class: 'DilResponseRoot-real', 'data-dil-message-id': 'message' }, [el('p', {}, [], '工具请求'), surface]);
  let wrapped = root;
  for (let depth = 0; depth < 3; depth++) wrapped = el('div', {}, [wrapped]);
  wrapped = el('div', { 'data-markdown-text-style': '' }, [wrapped]);
  for (let depth = 0; depth < 2; depth++) wrapped = el('div', {}, [wrapped]);
  const assistant = el('div', { 'data-content-search-unit-key': 'one', 'data-chatgpt-search-unit-key': 'one' }, [el('h4', { 'data-conversation-role': 'assistant' }), wrapped]);
  const user = el('div', { 'data-user-message-bubble': '' }, [el('p', {}, [], 'user request')]);
  const footer = el('div', { class: 'turn-action-controls' }, options.complete === false ? [] : [el('button', { 'aria-label': '复制' }), el('button', { 'aria-label': '朗读' })]);
  const frame = el('div', { 'data-talvt-turn-state': 'complete' }, [el('div', {}, [el('div', { class: 'group/user-message' }, [user]), ...(options.role === 'user' ? [] : [el('div', {}, [assistant])])]), footer]);
  return { frame, assistant, root, surface, content, bar, label, footer, user };
}
const run = (script: string, document: Node, extra: Record<string, unknown> = {}) => vm.runInNewContext(script, { document, URL, location: { href: 'https://chatgpt.com/c/one' }, ...extra });
const batch = JSON.stringify({ protocol_version: 1, batch_id: 'gpt-batch', requests: [{ id: 'read-one', tool: 'read_file', args: { path: 'a.txt' } }] });

it('普通会话地址 fail closed；首页交接函数可直接注入隔离世界', () => {
  for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/c/one-id?x=1']) assert.equal(webPlatformOf(url), 'chatgpt');
  for (const url of ['https://chatgpt.com/g/gpt-id', 'https://chatgpt.com/g/project/c/one', 'https://chatgpt.com/c/', 'https://chatgpt.com/c/one/more', 'https://evil.example/c/id', 'http://chatgpt.com/', 'https://user:pass@chatgpt.com/']) assert.equal(webPlatformOf(url), null);
  assert.equal(webPlatformOf('https://chat.deepseek.com/a/chat/s/one'), 'deepseek');
  assert.equal(vm.runInNewContext('(' + isFirstPromptSession.toString() + ')("https://chatgpt.com/", "https://chatgpt.com/c/new-id")', { URL }), true);
  assert.equal(isFirstPromptSession('https://chatgpt.com/c/old', 'https://chatgpt.com/c/new'), false);
});

it('只采最新正式 assistant，保留完整工具代码围栏与协议语言', () => {
  const old = turn('history'); const latest = turn(batch);
  const document = el('body', {}, [old.frame, latest.frame]);
  const replies = Array.from(run(CHATGPT_COLLECT_SCRIPT, document)) as string[];
  assert.equal(replies.length, 1); assert.ok(replies[0]!.includes('````mini-ai-tools\n' + batch + '\n````')); assert.ok(!replies[0]!.includes('history'));
  const parsed = parseToolBatch(replies[0]!); assert.equal(parsed.kind, 'batch');
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'complete');
});

it('代码首尾空行与嵌套反引号逐字保留，不混入代码框复制控件', () => {
  const source = '\n\t  first();  \n```markdown\nlast();\n```\n\n';
  const current = turn(source, { language: 'markdown' });
  const document = el('body', {}, [current.frame]);
  const result = run(CHATGPT_COLLECT_SCRIPT, document)[0];
  assert.ok(result.includes('````markdown\n' + source + '\n````'));
});

it('局部工具栏语言保持 mini-ai-tools，思考区代码排除', () => {
  const current = turn(batch);
  const thoughtRoot = el('div', { class: 'DilResponseRoot-thought', 'data-dil-message-id': 'thought' }, [el('code', { class: 'CodeContent-real' }, [], 'do not execute')]);
  const thought = el('details', { 'data-testid': 'thoughts' }, [thoughtRoot]);
  current.assistant.children.unshift(thought); thought.parentElement = current.assistant;
  const text = run(CHATGPT_COLLECT_SCRIPT, el('body', {}, [current.frame]))[0];
  assert.ok(text.includes('````mini-ai-tools\n' + batch)); assert.ok(!text.includes('do not execute'));
});

it('普通正文的协议名不能作为未标注代码框语言，展开思考区不能证明完成', () => {
  const current = turn(batch, { language: '' });
  const bodyLabel = el('p', {}, [], 'mini-ai-tools');
  current.root.children.unshift(bodyLabel); bodyLabel.parentElement = current.root;
  assert.equal(parseToolBatch(run(CHATGPT_COLLECT_SCRIPT, el('body', {}, [current.frame]))[0]).kind, 'none');
  const thinking = el('details', { open: '' }); current.assistant.children.push(thinking); thinking.parentElement = current.assistant;
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, el('body', {}, [current.frame])), 'unknown');
});

it('最新用户消息、正式回复缺失或歧义时不能回退到历史代码', () => {
  const old = turn(batch); const user = turn('new user prompt', { role: 'user' });
  assert.equal(run(CHATGPT_COLLECT_SCRIPT, el('body', {}, [old.frame, user.frame])).length, 0);
  const ambiguous = turn(batch); const other = el('div', { class: 'DilResponseRoot-second', 'data-dil-message-id': 'second' }, [el('p', {}, [], 'second')]);
  const outer = ambiguous.root.closest('div[data-markdown-text-style]')!;
  outer.children.push(other); other.parentElement = outer;
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, el('body', {}, [ambiguous.frame])), 'unknown');
  assert.equal(run(CHATGPT_COLLECT_SCRIPT, el('body', {}, [ambiguous.frame])).length, 0);
});

it('历史页脚、代码内伪按钮和缺失完成证据均不构成结束', () => {
  const old = turn('old'); const current = turn(batch, { complete: false });
  const fake = el('div', { class: 'turn-action-controls' }, [el('button', { 'aria-label': '复制' })]);
  current.root.children.push(fake); fake.parentElement = current.root;
  const document = el('body', {}, [old.frame, current.frame]);
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'unknown');
});

it('同轮用户消息操作栏与正式回复操作栏同时存在，只核验唯一正式页脚', () => {
  const current = turn(batch);
  const wrapper = current.user.parentElement!;
  const userFooter = el('div', { class: 'turn-action-controls' }, [el('button', { 'aria-label': '复制' }), el('button', { 'aria-label': '编辑' })]);
  wrapper.children.push(userFooter); userFooter.parentElement = wrapper;
  const document = el('body', {}, [current.frame]);
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'complete');
  current.frame.children.splice(current.frame.children.indexOf(current.footer), 1);
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'unknown');
});

it('完整JSON与复制页脚不能覆盖streaming或未知turn-state，busy状态先暂停', () => {
  const current = turn(batch); const document = el('body', {}, [current.frame]);
  for (const state of ['streaming', 'pending', '', 'unknown']) {
    current.frame.attrs['data-talvt-turn-state'] = state;
    assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'unknown');
  }
  current.frame.attrs['data-talvt-turn-state'] = 'complete';
  current.root.attrs['aria-busy'] = 'true';
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'generating');
  delete current.root.attrs['aria-busy']; current.content.attrs['data-is-streaming'] = 'true';
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'generating');
  delete current.content.attrs['data-is-streaming']; current.surface.attrs['aria-busy'] = 'true';
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'generating');
});

it('推荐提示词未挂载、骨架busy或已经出现均不改变正式回复结束证据', () => {
  const current = turn(batch); const document = el('body', {}, [current.frame]);
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'complete');
  const suggestions = el('div', { 'aria-busy': 'true' }, [el('button'), el('button'), el('button')]);
  document.children.push(suggestions); suggestions.parentElement = document;
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'complete');
  delete suggestions.attrs['aria-busy'];
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'complete');
  const nestedSuggestions = el('div', { 'aria-busy': 'true' }, [el('button')]);
  current.assistant.children.push(nestedSuggestions); nestedSuggestions.parentElement = current.assistant;
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'complete');
});

it('侧栏、附件加载和旧轮busy不污染最新轮；本轮思考和turn busy仍阻止采集', () => {
  const old = turn('history'); old.root.attrs['aria-busy'] = 'true';
  const current = turn(batch);
  const document = el('body', {}, [old.frame, current.frame, el('aside', { 'aria-busy': 'true' }), el('form', {}, [el('div', { 'data-is-streaming': 'true' })])]);
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'complete');
  const thought = el('details', { 'data-testid': 'thoughts', 'aria-busy': 'true' });
  current.assistant.children.push(thought); thought.parentElement = current.assistant;
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'generating');
  delete thought.attrs['aria-busy']; current.frame.attrs['data-is-streaming'] = 'true';
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, document), 'generating');
});

it('用户、代码和正式回复正文的伪stop/continue/busy控件不改变生命周期', () => {
  const current = turn(batch);
  for (const owner of [current.user, current.surface, current.root]) {
    const stop = el('button', { 'aria-label': 'Stop generating', 'aria-busy': 'true' });
    const resume = el('button', { 'aria-label': 'Continue generating' });
    owner.children.push(stop, resume); stop.parentElement = owner; resume.parentElement = owner;
  }
  current.user.attrs['aria-busy'] = 'true'; current.bar.attrs['data-is-streaming'] = 'true';
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, el('body', {}, [current.frame])), 'complete');
});

it('ChatGPT监听的生成见证与结束判据一致，不将推荐区域busy视作新生成', () => {
  const current = turn(batch); const document: any = el('body', {}, [current.frame, el('div', { 'aria-busy': 'true' })]);
  document.documentElement = document; document.addEventListener = () => {}; document.removeEventListener = () => {};
  const context = vm.createContext({ document, URL, Date, location: { href: 'https://chatgpt.com/c/one' }, clearTimeout, setTimeout, MutationObserver: class { observe() {} disconnect() {} } });
  vm.runInContext(replyWatchScript('install', 'generation', 'chatgpt'), context);
  assert.equal(vm.runInContext('globalThis.__miniAIReplyChanges.generating()', context), false);
  current.root.attrs['aria-busy'] = 'true';
  assert.equal(vm.runInContext('globalThis.__miniAIReplyChanges.generating()', context), true);
  vm.runInContext(replyWatchScript('stop', 'generation', 'chatgpt'), context);
});

it('来源正文读取保留语言及代码逐字，排除复制控件和思考正文', () => {
  const current = turn('\n  exact();\n\n');
  const thought = el('details', { 'data-testid': 'thoughts' }, [el('p', {}, [], 'private thought')]);
  current.root.children.push(thought); thought.parentElement = current.root;
  const text = run(`${CHATGPT_SOURCE_TEXT_READER}(document)`, current.root);
  assert.equal(text, '工具请求mini-ai-tools\n  exact();\n\n');
});

it('监听来源seal后复制与朗读控件变化保持新资格，正文变化仍失效', () => {
  const current = turn(batch); const document: any = el('body');
  document.documentElement = document; document.addEventListener = () => {}; document.removeEventListener = () => {};
  const context = vm.createContext({ document, URL, Date, location: { href: 'https://chatgpt.com/' }, clearTimeout, setTimeout, MutationObserver: class { observe() {} disconnect() {} } });
  vm.runInContext(replyWatchScript('install', 'source-reader', 'chatgpt'), context);
  document.children.push(current.frame); current.frame.parentElement = document;
  const first = vm.runInContext(CHATGPT_OBSERVATION_SCRIPT, context);
  assert.equal(first.source, 'new');
  const copyParent = current.bar.children[1]!;
  const translated = el('button', { 'aria-label': 'copy' }, [], 'copy');
  copyParent.children[0] = translated; translated.parentElement = copyParent;
  const readAloud = el('button', { 'aria-label': '朗读' }, [], 'Read aloud');
  current.footer.children[1] = readAloud; readAloud.parentElement = current.footer;
  const controlsChanged = vm.runInContext(CHATGPT_OBSERVATION_SCRIPT, context);
  assert.equal(controlsChanged.source, 'new'); assert.equal(controlsChanged.sourceKey, first.sourceKey);
  const changed = el('p', {}, [], 'new body'); current.root.children.push(changed); changed.parentElement = current.root;
  assert.notEqual(vm.runInContext(CHATGPT_OBSERVATION_SCRIPT, context).source, 'new');
  vm.runInContext(replyWatchScript('stop', 'source-reader', 'chatgpt'), context);
});

it('伪停止控件的真实点击不能建立中断见证', () => {
  const current = turn(batch); const listeners = new Map<string, (event: any) => void>();
  const stop = el('button', { 'aria-label': 'Stop generating', 'data-testid': 'stop-button' });
  current.surface.children.push(stop); stop.parentElement = current.surface;
  const document: any = el('body', {}, [current.frame]);
  document.documentElement = document; document.addEventListener = (name: string, fn: any) => listeners.set(name, fn); document.removeEventListener = (name: string) => listeners.delete(name);
  const context = vm.createContext({ document, URL, Date, location: { href: 'https://chatgpt.com/c/one' }, clearTimeout, setTimeout, MutationObserver: class { observe() {} disconnect() {} } });
  vm.runInContext(replyWatchScript('install', 'fake-stop', 'chatgpt'), context);
  listeners.get('click')!({ type: 'click', isTrusted: true, target: stop });
  assert.equal(vm.runInContext(CHATGPT_COMPLETION_SCRIPT, context), 'complete');
  vm.runInContext(replyWatchScript('stop', 'fake-stop', 'chatgpt'), context);
});

it('同turn用户代码和正文内复制控件不授权正式回复或结束', () => {
  const current = turn(batch); const userCode = turn('user must not execute');
  const userOuter = userCode.root.closest('div[data-markdown-text-style]')!;
  current.user.children.push(userOuter); userOuter.parentElement = current.user;
  const text = run(CHATGPT_COLLECT_SCRIPT, el('body', {}, [current.frame]))[0];
  assert.ok(!text.includes('user must not execute'));
  current.footer.children[0]!.disabled = true;
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT, el('body', {}, [current.frame])), 'unknown');
});

it('代码框多正文或多语言栏明确失败，不交付前半批请求', () => {
  const current = turn(batch); const document = el('body', {}, [current.frame]);
  const second = el('code', { class: 'CodeContent-other' }, [], 'other');
  current.surface.children.push(second); second.parentElement = current.surface;
  assert.throws(() => run(CHATGPT_COLLECT_SCRIPT, document), /代码框结构不唯一/);
  current.surface.children.pop();
  const bar = el('div', { class: 'StickyActionBar-other', 'data-markdown-copy': '' });
  current.surface.children.push(bar); bar.parentElement = current.surface;
  assert.throws(() => run(CHATGPT_COLLECT_SCRIPT, document), /语言工具栏不唯一/);
});

it('后续代码框未标注协议不能借用上一块语言，语言歧义不提升工具权限', () => {
  const current = turn(batch); const ordinary = turn('{"example":true}', { language: '' });
  current.root.children.push(ordinary.surface); ordinary.surface.parentElement = current.root;
  const text = run(CHATGPT_COLLECT_SCRIPT, el('body', {}, [current.frame]))[0];
  assert.ok(text.includes('````\n{"example":true}\n````'));
  const otherLabel = el('div', {}, [], 'json'); current.bar.children.push(otherLabel); otherLabel.parentElement = current.bar;
  const untrusted = run(CHATGPT_COLLECT_SCRIPT, el('body', {}, [current.frame]))[0];
  assert.equal(parseToolBatch(untrusted).kind, 'none');
});

it('生成与中断优先于页脚，不读取正文摘要', () => {
  const current = turn(batch);
  Object.defineProperty(current.root, 'innerHTML', { get: () => assert.fail('生成中不得读取正文摘要') });
  const stop = el('button', { 'aria-label': '停止' });
  assert.equal(run(CHATGPT_OBSERVATION_SCRIPT, el('body', {}, [current.frame, stop])).completion, 'generating');
  const resume = el('button', { 'aria-label': 'Continue generating' });
  assert.equal(run(CHATGPT_OBSERVATION_SCRIPT, el('body', {}, [current.frame, resume])).completion, 'interrupted');
});

it('未知网页与特殊GPT工作区完全不执行采集脚本', async () => {
  for (const url of ['https://example.com/', 'https://chatgpt.com/g/g-id']) {
    const result = await collectReply({ currentUrl: () => url, evaluate: async () => assert.fail('不支持的网页不执行脚本') });
    assert.equal(result.replyText, ''); assert.equal(result.attempts.length, 0);
    assert.equal((await new ReplyMonitor({ getURL: () => url, executeJavaScript: async () => assert.fail('不支持的网页不探测') } as any).read()).completion, 'unknown');
  }
});

it('自动全文快照使用 ChatGPT 专属采集与同步完成证据', async () => {
  const current = turn(batch); const document = el('body', {}, [current.frame]);
  const web: any = { getURL: () => 'https://chatgpt.com/c/one', executeJavaScript: async () => assert.fail('ChatGPT快照只在隔离世界运行'), executeJavaScriptInIsolatedWorld: async (world: number, scripts: { code: string }[]) => { assert.equal(world, 1004); return run(scripts[0]!.code, document); } };
  const result = await readAutoReply(web);
  assert.equal(result.completion, 'complete'); assert.equal(result.collected.strategyId, 'chatgpt-latest-assistant'); assert.equal(parseToolBatch(result.text).kind, 'batch');
});

it('排队脚本执行前实际网页已导航到其他来源，不读取该页面', async () => {
  const document: any = { querySelectorAll: () => assert.fail('非官网不查询DOM') };
  const web: any = { getURL: () => 'https://chatgpt.com/c/one', executeJavaScript: async () => assert.fail('不可读主世界'),
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => run(scripts[0]!.code, document, { location: { href: 'https://example.com/' } }) };
  assert.equal((await new ReplyMonitor(web).read()).completion, 'unknown');
  assert.equal((await readAutoReply(web)).text, '');
});

it('明确只读离线探针可使用file夹具，默认file不采集；ChatGPT缺隔离执行能力暂停', async () => {
  let calls = 0;
  const web: any = { getURL: () => 'file:///fixture.html', executeJavaScript: async () => { calls++; return { replies: ['fixture'], completion: 'complete', signature: 'fixture' }; } };
  assert.equal((await readAutoReply(web)).completion, 'unknown'); assert.equal(calls, 0);
  assert.equal((await readAutoReply(web, { allowLocalFixture: true })).text, 'fixture'); assert.equal(calls, 1);
  const gpt: any = { getURL: () => 'https://chatgpt.com/c/one', executeJavaScript: async () => assert.fail('不能回落主世界') };
  assert.equal((await new ReplyMonitor(gpt).read()).completion, 'unknown');
});

it('ChatGPT变化监听复用同一生命周期，只记可信动作且不读取草稿', () => {
  const listeners = new Map<string, (event: any) => void>();
  const composer = el('div', { class: 'ProseMirror', contenteditable: 'true', role: 'textbox' });
  Object.defineProperty(composer, 'textContent', { get: () => assert.fail('动作监听不可读取草稿') });
  const send = el('button', { type: 'submit', 'aria-label': '发送' });
  const document: any = el('body', {}, [el('form', {}, [composer, send])]);
  document.documentElement = document; document.addEventListener = (name: string, fn: any) => listeners.set(name, fn); document.removeEventListener = (name: string) => listeners.delete(name);
  const context = vm.createContext({ document, URL, Date, location: { href: 'https://chatgpt.com/' }, clearTimeout, setTimeout, MutationObserver: class { observe() {} disconnect() {} } });
  const execute = (action: 'install' | 'acknowledge' | 'navigation' | 'stop' | 'local-submit') => vm.runInContext(replyWatchScript(action, 'one', 'chatgpt'), context);
  execute('install'); listeners.get('click')!({ type: 'click', isTrusted: false, target: send }); assert.equal(execute('acknowledge').turn, 0);
  listeners.get('click')!({ type: 'click', isTrusted: true, target: send }); assert.equal(execute('acknowledge').turn, 1);
  const stop = el('button', { 'aria-label': '停止' });
  listeners.get('click')!({ type: 'click', isTrusted: true, target: stop }); assert.equal(execute('acknowledge').turn, 2);
  assert.equal(vm.runInContext(CHATGPT_COMPLETION_SCRIPT, context), 'interrupted');
  listeners.get('click')!({ type: 'click', isTrusted: true, target: composer });
  assert.equal(vm.runInContext(CHATGPT_COMPLETION_SCRIPT, context), 'interrupted');
  execute('local-submit'); assert.equal(vm.runInContext(CHATGPT_COMPLETION_SCRIPT, context), 'unknown');
  vm.runInContext('location.href = "https://chatgpt.com/c/new"', context); assert.equal(execute('navigation').preserve, true);
  assert.equal(execute('stop'), true); assert.equal(listeners.size, 0);
});

it('首页首发经过临时地址仍保留监听来源，正式地址到来才交接；无提交不能保留', () => {
  for (const submitted of [true,false]) {
    const document: any = el('body');
    document.documentElement=document;document.addEventListener=()=>{};document.removeEventListener=()=>{};
    const context=vm.createContext({document,URL,Date,location:{href:'https://chatgpt.com/'},setTimeout,clearTimeout,MutationObserver:class {observe(){}disconnect(){}}});
    const execute=(action: 'install'|'local-submit'|'navigation'|'stop')=>vm.runInContext(replyWatchScript(action,'pending','chatgpt'),context);
    execute('install');const sources=vm.runInContext('globalThis.__miniAIReplyChanges.sources',context);
    if(submitted)execute('local-submit');
    (context as any).location.href=pendingSession;
    const waiting=execute('navigation');
    assert.equal(waiting?.pending,submitted);
    assert.equal(vm.runInContext('globalThis.__miniAIReplyChanges.sources',context),sources,'占位地址不能把首轮输出重置为历史');
    (context as any).location.href='https://chatgpt.com/c/allocated';
    assert.equal(execute('navigation').preserve,submitted);
    if(submitted){
      (context as any).location.href='https://chatgpt.com/';execute('navigation');execute('local-submit');
      (context as any).location.href=pendingSession.replace('123456789abc','abcdef123456');
      assert.equal(execute('navigation').pending,true,'下一次首页新需求不能被上一占位标识阻断');
    }
    execute('stop');
  }
});

it('停止见证只在旧生成结束后再次生成时释放，旧页脚及无关点击均保留阻断', () => {
  let observe: (records: unknown[]) => void = () => {};
  const listeners = new Map<string, (event: any) => void>();
  const stop = el('button', { 'aria-label': '停止' });
  const current = turn(batch); const document: any = el('body', {}, [current.frame, el('form', { 'data-chatgpt-composer': '' }, [stop])]);
  document.documentElement = document; document.addEventListener = (name: string, fn: any) => listeners.set(name, fn); document.removeEventListener = (name: string) => listeners.delete(name);
  const context = vm.createContext({ document, URL, Date, location: { href: 'https://chatgpt.com/c/one' }, clearTimeout, setTimeout,
    MutationObserver: class { constructor(callback: (records: unknown[]) => void) { observe = callback; } observe() {} disconnect() {} } });
  vm.runInContext(replyWatchScript('install', 'two', 'chatgpt'), context);
  listeners.get('click')!({ type: 'click', isTrusted: true, target: stop });
  observe([{ type: 'attributes', target: stop }]);
  assert.equal(vm.runInContext(CHATGPT_COMPLETION_SCRIPT, context), 'interrupted');
  stop.hidden = true; observe([{ type: 'attributes', target: stop }]);
  assert.equal(vm.runInContext(CHATGPT_COMPLETION_SCRIPT, context), 'interrupted');
  stop.hidden = false; observe([{ type: 'attributes', target: stop }]);
  assert.equal(vm.runInContext(CHATGPT_COMPLETION_SCRIPT, context), 'generating');
  stop.hidden = true; observe([{ type: 'attributes', target: stop }]);
  assert.equal(vm.runInContext(CHATGPT_COMPLETION_SCRIPT, context), 'complete');
  vm.runInContext(replyWatchScript('stop', 'two', 'chatgpt'), context);
});

it('role控件包裹代码及代码内子节点不能隐藏真正JSON变化的来源', () => {
  for (const area of ['role-wrapper', 'code-child']) {
    const current = turn(batch);let content=batch;
    if (area === 'role-wrapper') {
      const parent=current.surface.parentElement!;
      const index=parent.children.indexOf(current.surface);
      const wrapper=el('div',{role:'button'},[current.surface]);
      parent.children[index]=wrapper;wrapper.parentElement=parent;
      Object.defineProperty(current.content,'textContent',{get:()=>content});
    } else {
      const inline=el('button',{role:'button'});
      Object.defineProperty(inline,'textContent',{get:()=>content});
      current.content.children.push(inline);inline.parentElement=current.content;
      Object.defineProperty(current.content,'textContent',{get:()=>inline.textContent});
    }
    const document:any=el('body');document.documentElement=document;document.addEventListener=()=>{};document.removeEventListener=()=>{};
    const context=vm.createContext({document,URL,Date,location:{href:'https://chatgpt.com/'},setTimeout,clearTimeout,MutationObserver:class {observe(){}disconnect(){}}});
    vm.runInContext(replyWatchScript('install','source-body','chatgpt'),context);
    document.children.push(current.frame);current.frame.parentElement=document;
    const before=vm.runInContext(CHATGPT_COLLECT_SCRIPT,context)[0];
    const first=vm.runInContext(CHATGPT_OBSERVATION_SCRIPT,context);assert.equal(first.source,'new');
    content=batch.replace('gpt-batch','different-batch');
    const after=vm.runInContext(CHATGPT_COLLECT_SCRIPT,context)[0];assert.notEqual(after,before);
    const changed=vm.runInContext(CHATGPT_OBSERVATION_SCRIPT,context);assert.notEqual(changed.source,'new',area);assert.notEqual(changed.sourceKey,first.sourceKey,area);
    vm.runInContext(replyWatchScript('stop','source-body','chatgpt'),context);
  }
});

it('已有会话正文样式类改变或缺失时仍采最新语义消息，历史不因修复获得资格', () => {
  for (const css of ['RuntimeAnswerBlock-hash', 'DilResponseRoot', '']) {
    const old=turn('old history');const current=turn(batch);current.root.attrs.class=css;
    const document:any=el('body',{},[old.frame]);document.documentElement=document;document.addEventListener=()=>{};document.removeEventListener=()=>{};
    const context=vm.createContext({document,URL,Date,location:{href:'https://chatgpt.com/c/existing'},setTimeout,clearTimeout,MutationObserver:class {observe(){}disconnect(){}}});
    vm.runInContext(replyWatchScript('install','existing-style','chatgpt'),context);
    assert.notEqual(vm.runInContext(CHATGPT_OBSERVATION_SCRIPT,context).source,'new');
    document.children.push(current.frame);current.frame.parentElement=document;
    const text=vm.runInContext(CHATGPT_COLLECT_SCRIPT,context)[0];assert.equal(parseToolBatch(text||'').kind,'batch',css||'no class');
    const observation=vm.runInContext(CHATGPT_OBSERVATION_SCRIPT,context);assert.equal(observation.completion,'complete');assert.equal(observation.source,'new');
    vm.runInContext(replyWatchScript('stop','existing-style','chatgpt'),context);
  }
});

it('无固定样式类的多个正文、用户和思考区仍不能扩大采集资格', () => {
  const current=turn(batch);current.root.attrs.class='';
  const other=el('div',{'data-dil-message-id':'second'},[el('p',{},[],'other')]);
  const markdown=current.root.closest('div[data-markdown-text-style]')!;markdown.children.push(other);other.parentElement=markdown;
  assert.equal(run(CHATGPT_COLLECT_SCRIPT,el('body',{},[current.frame])).length,0);
  assert.equal(run(CHATGPT_COMPLETION_SCRIPT,el('body',{},[current.frame])),'unknown');
  for(const owner of [el('div',{'data-user-message-bubble':''}),el('details',{'data-testid':'thoughts'})]) {
    const current=turn(batch);current.root.attrs.class='';const parent=current.root.parentElement!,index=parent.children.indexOf(current.root);
    parent.children[index]=owner;owner.parentElement=parent;owner.children.push(current.root);current.root.parentElement=owner;
    assert.equal(run(CHATGPT_COLLECT_SCRIPT,el('body',{},[current.frame])).length,0);
  }
});
