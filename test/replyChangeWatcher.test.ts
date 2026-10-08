import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as vm from 'node:vm';
import { it } from 'node:test';
import { ReplyChangeWatcher, REPLY_WATCH_WORLD } from '../src/main/tools/replyChangeWatcher';
import { AutoCollector } from '../src/main/tools/autoCollector';
import { DEEPSEEK_SEND_ICON } from '../src/main/tools/replyObservation';

function continuationControl() {
  const button: any = { textContent: '继续生成', disabled: false, hidden: false, inMessage: false,
    getAttribute: () => null, getClientRects: () => button.hidden ? [] : [{}],
    classList: { contains: () => false }, matches: () => false, querySelectorAll: () => [],
    closest: (selector: string) => selector.includes('role=') ? button : button.inMessage ? {} : null };
  return button;
}

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function fixture(change?: (userTurn: boolean) => Promise<void>, reset?: (preserve?: boolean, awaitHistory?: boolean, generated?: boolean) => void) {
  const timers = new Map<number, () => void>(); const delays = new Map<number, number>(); let timerId = 0; let checks = 0; let resets = 0; let executions = 0;
  let observer: any; let url = 'https://chat.deepseek.com/a/chat/s/one';
  class Observer {
    active = false;
    constructor(readonly callback: (records: unknown[]) => void) { observer = this; }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }
  const listeners = new Map<string, (event: any) => void>(); let root = true; let generating = false; let tooltipGeneration = false;
  const currentFooter: unknown[] = [];
  let currentReply: any = { textContent: 'initial', parentElement: null, contains: () => false, closest: (selector: string) => selector === 'pre,code' ? null : ({ parentElement: {
    contains: (node: unknown) => node === currentReply || currentFooter.includes(node),
  } }) };
  const messagesFrames: any[] = [currentReply];
  const composer: any = { disabled: false, classList: { contains: () => false }, getAttribute: () => null,
    closest: () => composer, matches: () => true, querySelectorAll: () => [{ getAttribute: () => DEEPSEEK_SEND_ICON }] };
  Object.defineProperty(composer, 'value', { get: () => assert.fail('不得读取输入内容') });
  const context = vm.createContext({ URL, location: { get href() { return url; } }, MutationObserver: Observer, document: { documentElement: {},
    querySelector: (selector: string) => selector.includes('primary') ? composer : root ? currentReply : null,
    querySelectorAll: (selector: string) => selector.includes('assistant') || selector.includes('markdown') ? root ? messagesFrames : [] : selector.includes('aria-busy') ? generating ? [{ getClientRects: () => [{}] }] : [] : selector.startsWith('button') ? tooltipGeneration ? [{ textContent: '', getClientRects: () => [{}], getAttribute: (name: string) => name === 'data-tooltip' ? '停止生成' : null }] : [] : messagesFrames,
    addEventListener: (name: string, fn: any) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name),
  },
    setTimeout: (fn: () => void, delay: number) => { timers.set(++timerId, fn); delays.set(timerId, delay); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
  });
  const web: any = new EventEmitter(); const messages: string[] = [];
  web.isDestroyed = () => false; web.getURL = () => url;
  web.executeJavaScriptInIsolatedWorld = async (world: number, scripts: any[]) => {
    assert.equal(world, REPLY_WATCH_WORLD); executions++; return vm.runInContext(scripts[0].code, context);
  };
  const watcher = new ReplyChangeWatcher(web, async userTurn => { checks++; await change?.(userTurn); }, (preserve, awaitHistory, generated) => { resets++; reset?.(preserve, awaitHistory, generated); }, text => messages.push(text));
  const node = (relevant: boolean) => ({ nodeType: 1, closest: () => relevant ? {} : null, querySelector: () => null });
  return { watcher, web, messages, timers, context, listeners,
    userAction(extra: Record<string, unknown> = {}) { const type = String(extra.type ?? 'click'); listeners.get(type)?.({ type, isTrusted: true, target: composer, ...extra }); },
    hasRoot(value: boolean) { root = value; },
    generating(value: boolean) { generating = value; },
    tooltipGenerating(value: boolean) { tooltipGeneration = value; },
    text(value: string) { currentReply.textContent = value; },
    replaceReply(value: string) { currentReply = { ...currentReply, textContent: value }; messagesFrames[messagesFrames.length - 1] = currentReply; root = true; },
    historyFooter(button: unknown) { messagesFrames.unshift({ parentElement: null, closest: (selector: string) => selector === 'pre,code' ? null : ({ parentElement: { contains: (node: unknown) => node === button } }) }); },
    latestFooter(button: unknown) { currentFooter.push(button); },
    counts: () => ({ checks, resets, executions }),
    mutation(relevant = true) { if (observer.active) observer.callback([{ type: 'characterData', target: node(relevant) }]); },
    burst() { for (let i = 0; i < 100; i++) this.mutation(); },
    deliver(delay?: number) { for (const [id, fn] of [...timers]) { if (delay !== undefined && delays.get(id) !== delay) continue; timers.delete(id); fn(); } },
    navigate(next: string) { url = next; web.emit('did-navigate-in-page', {}, next, true); },
    active: () => observer?.active ?? false,
  };
}

it('监听先建立基线，空闲没有计时器或重复网页检查；无关区域变化不检查回复', async () => {
  const f = fixture(); f.watcher.setEnabled(true); await flush();
  assert.equal(f.counts().checks, 1); assert.equal(f.timers.size, 0);
  const idle = f.counts().executions; await flush(); assert.equal(f.counts().executions, idle);
  f.mutation(false); assert.equal(f.timers.size, 0); await flush(); assert.equal(f.counts().checks, 1);
  f.burst(); assert.equal(f.timers.size, 1); f.deliver(); await flush();
  assert.equal(f.counts().checks, 2); assert.equal(f.timers.size, 0);
  await f.watcher.dispose(); assert.equal(f.active(), false);
});
it('处理工具期间的多次页面变化只保留一次，完成后不会丢失新回复通知', async () => {
  let finish: (() => void) | undefined; let calls = 0;
  const f = fixture(async () => { if (++calls === 2) await new Promise<void>(resolve => { finish = resolve; }); });
  f.watcher.setEnabled(true); await flush(); f.mutation(); f.deliver(); await flush();
  assert.equal(f.counts().checks, 2);
  f.burst(); f.deliver(); f.burst(); assert.equal(f.timers.size, 0);
  finish!(); await flush(); assert.equal(f.counts().checks, 3); await f.watcher.dispose();
});
it('关闭、页面导航和销毁使旧通知失效，重新启用或新会话建立新基线', async () => {
  const f = fixture(); f.watcher.setEnabled(true); await flush(); f.mutation();
  f.watcher.setEnabled(false); await flush(); f.deliver(); await flush();
  assert.equal(f.counts().checks, 1); assert.equal(f.active(), false);
  f.watcher.setEnabled(true); await flush(); assert.equal(f.counts().checks, 2);
  f.navigate('https://chat.deepseek.com/a/chat/s/one?tracking=2'); await flush(); assert.equal(f.counts().checks, 2);
  f.navigate('https://chat.deepseek.com/a/chat/s/two'); await flush(); assert.equal(f.counts().checks, 2); f.replaceReply('target history'); f.mutation(); f.deliver(); await flush(); assert.equal(f.counts().checks, 3);
  f.web.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); await flush();
  assert.equal(f.active(), false); f.web.emit('dom-ready'); await flush(); assert.equal(f.counts().checks, 4);
  await f.watcher.dispose(); assert.equal(f.web.listenerCount('dom-ready'), 0); assert.equal(f.active(), false);
});
it('监听失败明确提示，不自动退回轮询或静默重试', async () => {
  const f = fixture(); f.web.executeJavaScriptInIsolatedWorld = async () => { throw new Error('renderer failed'); };
  f.watcher.setEnabled(true); await flush();
  assert.match(f.messages.join('\n'), /监听失败.*renderer failed/); assert.equal(f.counts().checks, 0);
  const count = f.messages.length; await flush(); assert.equal(f.messages.length, count);
  await f.watcher.dispose();
});

it('真实发送动作只通知取消待回传；合成事件、Shift+Enter和输入法回车不通知发送动作', async () => {
  const turns: boolean[] = []; const f = fixture(async turn => { turns.push(turn); });
  f.watcher.setEnabled(true); await flush();
  for (const event of [{ isTrusted: false }, { type: 'keydown', key: 'Enter', shiftKey: true }, { type: 'keydown', key: 'Enter', isComposing: true }]) {
    f.userAction(event); f.mutation(); f.deliver(); await flush(); assert.equal(turns.at(-1), false);
  }
  f.userAction({ type: 'keydown', key: 'Enter' });
  const checks = f.counts().checks; await flush(); assert.equal(f.counts().checks, checks, '发送动作本身不读取网页');
  f.mutation(); f.deliver(); await flush(); assert.equal(turns.at(-1), true);
  f.mutation(); f.deliver(); await flush(); assert.equal(turns.at(-1), false);
  await f.watcher.dispose(); assert.equal(f.listeners.size, 0);
});

it('会话导航旧DOM仍在时不读取，目标历史异步出现只建立基线，后续新输出无需发送动作', async () => {
  let reply = { url: 'https://chat.deepseek.com/a/chat/s/one', text: 'OLD_HISTORY', completion: 'complete' as const };
  const output: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => { output.push(text); }, () => {});
  const f = fixture(async () => { await auto.tick(); }, (preserve, history) => { if (preserve) auto.continueAt(reply.url); else auto.reset(history); });
  auto.setEnabled(true); f.watcher.setEnabled(true); await flush();
  reply = { ...reply, url: 'https://chat.deepseek.com/a/chat/s/two' }; f.navigate(reply.url); await flush();
  assert.equal(f.counts().checks, 1, '旧DOM不能结束目标会话的历史基线');
  f.mutation(); f.deliver(); await flush(); assert.equal(f.counts().checks, 1);
  reply.text = 'TARGET_HISTORY'; f.replaceReply(reply.text); f.mutation(); f.deliver(); await flush();
  assert.deepEqual(output, []);
  reply.text = 'NEW_TOOLS_WITHOUT_SEND_EVENT'; f.text(reply.text); f.mutation(); f.deliver(); await flush();
  assert.deepEqual(output, ['NEW_TOOLS_WITHOUT_SEND_EVENT']); await f.watcher.dispose(); auto.dispose();
});

it('旧会话正在生成时导航，旧正文变化和遗留通知不能消耗目标历史基线', async () => {
  const f = fixture(); f.watcher.setEnabled(true); await flush();
  f.generating(true); f.mutation();
  f.navigate('https://chat.deepseek.com/a/chat/s/target'); await f.watcher.settleNavigation();
  f.deliver(); await flush(); assert.equal(f.counts().checks, 1);
  f.text('old final frame'); f.mutation(); f.deliver(); await flush(); assert.equal(f.counts().checks, 1);
  f.generating(false); f.replaceReply('target history'); f.mutation(); f.deliver(); await flush();
  assert.equal(f.counts().checks, 2); await f.watcher.dispose();
});

it('完整导航dom-ready保留异步历史基线，重新打开自动采集仍使用当前内容基线', async () => {
  const resets: [boolean | undefined, boolean | undefined][] = [];
  const f = fixture(undefined, (preserve, history) => resets.push([preserve, history]));
  f.watcher.setEnabled(true); await flush();
  f.web.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  f.hasRoot(false); f.web.emit('dom-ready'); await flush();
  assert.deepEqual(resets.at(-1), [false, true]);
  f.watcher.setEnabled(false); f.watcher.setEnabled(true); await flush();
  assert.deepEqual(resets.at(-1), [false, false]); await f.watcher.dispose();
});

it('历史回复分批挂载期间持续更新基线，500ms历史安静后新输出才可执行', async () => {
  let reply = { url: 'https://chat.deepseek.com/a/chat/s/one', text: 'old', completion: 'complete' as const };
  const output: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => { output.push(text); }, () => {});
  const f = fixture(async () => { await auto.tick(); }, (preserve, history) => { if (preserve) auto.continueAt(reply.url); else auto.reset(history); });
  auto.setEnabled(true); f.watcher.setEnabled(true); await flush();
  reply.url = 'https://chat.deepseek.com/a/chat/s/target'; f.navigate(reply.url); await f.watcher.settleNavigation();
  for (const text of ['history one', 'history two', 'history three']) {
    reply.text = text; f.replaceReply(text); f.mutation(); f.deliver(150); await flush(); assert.deepEqual(output, []);
  }
  f.deliver(500); await flush();
  reply.text = 'new output'; f.replaceReply(reply.text); f.mutation(); f.deliver(150); await flush();
  assert.deepEqual(output, ['new output']); await f.watcher.dispose(); auto.dispose();
});

it('启用时已有未知结束状态回复，原生结束控件后挂不执行历史', async () => {
  let reply = { url: 'https://chat.deepseek.com/a/chat/s/one', text: '', completion: 'unknown' as 'unknown' | 'complete' };
  const output: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => { output.push(text); }, () => {});
  const f = fixture(async () => { await auto.tick(); }, (_preserve, history) => auto.reset(history));
  auto.setEnabled(true); f.watcher.setEnabled(true); await flush();
  reply = { ...reply, text: 'existing history tools', completion: 'complete' }; f.mutation(); f.deliver(); await flush();
  assert.deepEqual(output, []);
  reply.text = 'actual new tools'; f.text(reply.text); f.mutation(); f.deliver(); await flush();
  assert.deepEqual(output, ['actual new tools']); await f.watcher.dispose(); auto.dispose();
});

it('首页首回复同步挂载后马上分配地址，不等待MutationObserver也保留正文连续性', async () => {
  const resets: [boolean | undefined, boolean | undefined][] = [];
  const f = fixture(undefined, (preserve, history) => resets.push([preserve, history]));
  f.hasRoot(false); f.navigate('https://chat.deepseek.com/'); f.watcher.setEnabled(true); await flush();
  f.replaceReply('first complete'); f.navigate('https://chat.deepseek.com/a/chat/s/assigned'); await f.watcher.settleNavigation();
  assert.deepEqual(resets.at(-1), [true, false]); await f.watcher.dispose();
});

it('首页首轮新增回复根连续分配地址，无需真实发送动作或本地回执', async () => {
  const resets: [boolean | undefined, boolean | undefined][] = [];
  const f = fixture(undefined, (preserve, history) => resets.push([preserve, history]));
  f.hasRoot(false); f.navigate('https://chat.deepseek.com/'); f.watcher.setEnabled(true); await flush();
  f.replaceReply('first partial'); f.mutation(); f.deliver(); await flush();
  f.navigate('https://chat.deepseek.com/a/chat/s/allocated'); await f.watcher.settleNavigation(); await flush();
  assert.deepEqual(resets.at(-1), [true, false]);
  f.navigate('https://chat.deepseek.com/a/chat/s/another'); await f.watcher.settleNavigation();
  assert.deepEqual(resets.at(-1), [false, true]); await f.watcher.dispose();
});

it('首页先出现生成标志再分配地址，即使正文尚未挂载也保留内容基线', async () => {
  const resets: [boolean | undefined, boolean | undefined][] = [];
  const f = fixture(undefined, (preserve, history) => resets.push([preserve, history]));
  f.hasRoot(false); f.navigate('https://chat.deepseek.com/'); f.watcher.setEnabled(true); await flush();
  f.generating(true); f.navigate('https://chat.deepseek.com/a/chat/s/allocated'); await f.watcher.settleNavigation();
  assert.deepEqual(resets.at(-1), [true, false]); await f.watcher.dispose();
});

it('空首页打开历史及首页既有回复根都不能保留采集资格', async () => {
  for (const existing of [false, true]) {
    const resets: [boolean | undefined, boolean | undefined][] = [];
    const f = fixture(undefined, (preserve, history) => resets.push([preserve, history]));
    f.hasRoot(existing); f.navigate('https://chat.deepseek.com/'); f.watcher.setEnabled(true); await flush();
    if (existing) { f.mutation(); f.deliver(); await flush(); }
    f.navigate('https://chat.deepseek.com/a/chat/s/history'); await f.watcher.settleNavigation();
    assert.deepEqual(resets.at(-1), [false, true]); await f.watcher.dispose();
  }
});

it('本地提交标记使首页地址交接在回复与生成态都不可观测时仍保留新轮', async () => {
  const resets: [boolean | undefined, boolean | undefined][] = [];
  const f = fixture(undefined, (preserve, history) => resets.push([preserve, history]));
  f.hasRoot(false); f.navigate('https://chat.deepseek.com/'); f.watcher.setEnabled(true); await flush();
  await f.watcher.markLocalSubmit(); await flush();
  f.navigate('https://chat.deepseek.com/a/chat/s/allocated'); await f.watcher.settleNavigation(); await flush();
  assert.deepEqual(resets.at(-1), [true, false]);
  f.navigate('https://chat.deepseek.com/a/chat/s/another'); await f.watcher.settleNavigation();
  assert.deepEqual(resets.at(-1), [false, true]); await f.watcher.dispose();
});

it('真实用户动作使本地提交标记立即失效，交接重建历史基线', async () => {
  const resets: [boolean | undefined, boolean | undefined][] = [];
  const f = fixture(undefined, (preserve, history) => resets.push([preserve, history]));
  f.hasRoot(false); f.navigate('https://chat.deepseek.com/'); f.watcher.setEnabled(true); await flush();
  await f.watcher.markLocalSubmit(); await flush();
  f.userAction(); f.navigate('https://chat.deepseek.com/a/chat/s/history'); await f.watcher.settleNavigation();
  assert.deepEqual(resets.at(-1), [false, true]); await f.watcher.dispose();
});

it('导航处理不等待尚在处理的回复，目标生成期间无需发送识别也通知采集', async () => {
  let release: (() => void) | undefined; let calls = 0;
  const f = fixture(async () => { if (++calls === 2) await new Promise<void>(resolve => { release = resolve; }); });
  f.watcher.setEnabled(true); await flush(); f.mutation(); f.deliver(); await flush();
  f.navigate('https://chat.deepseek.com/a/chat/s/new'); await f.watcher.settleNavigation();
  f.generating(true); f.mutation(); f.deliver(); await flush();
  release!(); await flush(); assert.equal(f.counts().checks, 3); await f.watcher.dispose();
});

it('手动采集仅消费旧发送通知，不影响后续内容变化检查', async () => {
  const turns: boolean[] = []; const f = fixture(async turn => { turns.push(turn); });
  f.watcher.setEnabled(true); await flush(); f.userAction(); f.mutation(); await f.watcher.acknowledge(true);
  f.deliver(); await flush(); assert.equal(turns.at(-1), false);
  f.userAction(); f.mutation(); f.deliver(); await flush(); assert.equal(turns.at(-1), true);
  await f.watcher.dispose();
});

it('代码内、隐藏、禁用及合成的继续按钮不通知真实用户动作，导航不沿用旧动作', async () => {
  const turns: boolean[] = []; const f = fixture(async turn => { turns.push(turn); });
  f.watcher.setEnabled(true); await flush();
  const button = continuationControl();
  for (const mode of ['message', 'hidden', 'disabled', 'synthetic']) {
    button.inMessage = mode === 'message'; button.hidden = mode === 'hidden'; button.disabled = mode === 'disabled';
    f.userAction({ target: button, isTrusted: mode !== 'synthetic' }); f.mutation(); f.deliver(); await flush();
    assert.equal(turns.at(-1), false, mode);
  }
  button.disabled = false; f.userAction({ target: button });
  f.navigate('https://chat.deepseek.com/a/chat/s/history'); await flush();
  f.mutation(); f.deliver(); await flush(); assert.equal(turns.at(-1), false);
  await f.watcher.dispose();
});

it('历史消息父级页脚的同名继续控件不通知真实用户动作', async () => {
  const turns: boolean[] = []; const f = fixture(async turn => { turns.push(turn); });
  f.watcher.setEnabled(true); await flush(); const button = continuationControl(); f.historyFooter(button);
  f.userAction({ target: button }); f.mutation(); f.deliver(); await flush();
  assert.equal(turns.at(-1), false); await f.watcher.dispose();
});

it('首轮生成开始与结束都发生在合并通知前，完整首回复仍执行且只执行一次', async () => {
 let reply={url:'https://chat.deepseek.com/',text:'',completion:'unknown' as any};const output:string[]=[];
 const auto=new AutoCollector(async()=>reply,async text=>{output.push(text);},()=>{});
 const f=fixture(async()=>{await auto.tick();},(preserve,history,generated)=>{
  if(generated)auto.observeGeneration(reply.url);else if(preserve)auto.continueAt(reply.url);else auto.reset(history);
 });
 f.hasRoot(false);f.navigate(reply.url);auto.setEnabled(true);f.watcher.setEnabled(true);await flush();
 reply.url='https://chat.deepseek.com/a/chat/s/first';f.navigate(reply.url);await f.watcher.settleNavigation();
 f.generating(true);f.mutation();
 f.generating(false);f.replaceReply('first complete');reply.text='first complete';reply.completion='complete';f.mutation();
 f.deliver(150);await flush();assert.deepEqual(output,['first complete']);
 f.mutation();f.deliver(150);await flush();assert.deepEqual(output,['first complete']);
 await f.watcher.dispose();auto.dispose();
});

it('未送达的快速生成证据在二次导航或关闭后作废', async () => {
 for(const cancel of ['navigate','disable'] as const){
  const generated:boolean[]=[];
  const f=fixture(undefined,(_preserve,_history,newGeneration)=>generated.push(newGeneration===true));
  f.hasRoot(false);f.navigate('https://chat.deepseek.com/');f.watcher.setEnabled(true);await flush();
  f.navigate('https://chat.deepseek.com/a/chat/s/first');await f.watcher.settleNavigation();
  f.generating(true);f.mutation();f.generating(false);f.replaceReply('complete');f.mutation();
  if(cancel==='navigate'){f.navigate('https://chat.deepseek.com/a/chat/s/other');await f.watcher.settleNavigation();}
  else f.watcher.setEnabled(false);
  f.deliver(150);await flush();assert.equal(generated.some(Boolean),false,cancel);await f.watcher.dispose();
 }
});

it('仅tooltip可见的新生成证据跨合并保留，未知或中断不执行直到完成', async () => {
 for(const phase of ['unknown','interrupted'] as const){
 let reply={url:'https://chat.deepseek.com/',text:'',completion:'unknown' as any};const output:string[]=[];
 const auto=new AutoCollector(async()=>reply,async text=>{output.push(text);},()=>{});
 const f=fixture(async()=>{await auto.tick();},(preserve,history,generated)=>{
  if(generated)auto.observeGeneration(reply.url);else if(preserve)auto.continueAt(reply.url);else auto.reset(history);
 });
 f.hasRoot(false);f.navigate(reply.url);auto.setEnabled(true);f.watcher.setEnabled(true);await flush();
 reply.url='https://chat.deepseek.com/a/chat/s/first';f.navigate(reply.url);await f.watcher.settleNavigation();
 f.tooltipGenerating(true);f.mutation();f.tooltipGenerating(false);f.replaceReply('new');reply.text='new';reply.completion=phase;f.mutation();
 f.deliver(150);await flush();assert.deepEqual(output,[]);
 reply.completion='complete';f.mutation();f.deliver(150);await flush();assert.deepEqual(output,['new']);
 await f.watcher.dispose();auto.dispose();
 }
});
