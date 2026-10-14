import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as vm from 'node:vm';
import { it } from 'node:test';
import { ReplyChangeWatcher, REPLY_WATCH_WORLD, type ReplyWatchOptions } from '../src/main/tools/replyChangeWatcher';
import type { ToolCollectionState } from '../src/shared/toolProtocol';
import { AutoCollector, type AutoReply } from '../src/main/tools/autoCollector';
import { DEEPSEEK_SEND_ICON } from '../src/main/tools/replyObservation';

function continuationControl() {
  const button: any = { textContent: '继续生成', disabled: false, hidden: false, inMessage: false,
    getAttribute: () => null, getClientRects: () => button.hidden ? [] : [{}],
    classList: { contains: () => false }, matches: () => false, querySelectorAll: () => [],
    closest: (selector: string) => selector.includes('role=') ? button : button.inMessage ? {} : null };
  return button;
}

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function fixture(change?: (userTurn: boolean) => Promise<void>, reset?: (preserve?: boolean, awaitHistory?: boolean, generated?: boolean) => void, options: ReplyWatchOptions = {}) {
  let now = 10000;
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
  const context = vm.createContext({ URL, Date: { now: () => now }, location: { get href() { return url; } }, MutationObserver: Observer, document: { documentElement: {},
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
  const health: ToolCollectionState[] = [];
  const watcher = new ReplyChangeWatcher(web, async userTurn => { checks++; await change?.(userTurn); }, (preserve, awaitHistory, generated) => { resets++; reset?.(preserve, awaitHistory, generated); }, text => messages.push(text), () => {}, { ...options, health: state => { health.push(state); options.health?.(state); } });
  const node = (relevant: boolean) => ({ nodeType: 1, closest: () => relevant ? {} : null, querySelector: () => null });
  return { watcher, web, messages, health, timers, context, listeners,
    advanceTime(milliseconds: number) { now += milliseconds; },
    userAction(extra: Record<string, unknown> = {}) { const type = String(extra.type ?? 'click'); listeners.get(type)?.({ type, isTrusted: true, target: composer, ...extra }); },
    hasRoot(value: boolean) { root = value; },
    generating(value: boolean) { generating = value; },
    tooltipGenerating(value: boolean) { tooltipGeneration = value; },
    text(value: string) { currentReply.textContent = value; },
    replaceReply(value: string) { currentReply = { ...currentReply, textContent: value }; messagesFrames[messagesFrames.length - 1] = currentReply; root = true; },
    appendReply(value: string) { currentReply = { ...currentReply, textContent: value }; messagesFrames.push(currentReply); root = true; },
    historyFooter(button: unknown) { messagesFrames.unshift({ parentElement: null, closest: (selector: string) => selector === 'pre,code' ? null : ({ parentElement: { contains: (node: unknown) => node === button } }) }); },
    latestFooter(button: unknown) { currentFooter.push(button); },
    counts: () => ({ checks, resets, executions }),
    mutation(relevant = true) { if (observer.active) observer.callback([{ type: 'characterData', target: node(relevant) }]); },
    bodyMutation() { if (observer.active) observer.callback([{ type: 'characterData', target: { nodeType: 3, parentElement: currentReply } }]); },
    source() { return (context as any).__miniAIReplyChanges.sources.source(currentReply); },
    sourceKey() { return (context as any).__miniAIReplyChanges.sources.key(currentReply); },
    burst() { for (let i = 0; i < 100; i++) this.mutation(); },
    deliver(delay?: number) { for (const [id, fn] of [...timers]) { if (delay !== undefined && delays.get(id) !== delay) continue; timers.delete(id); fn(); } },
    navigate(next: string) { url = next; web.emit('did-navigate-in-page', {}, next, true); },
    active: () => observer?.active ?? false,
  };
}

it('迟到的初始化不得替换 dom-ready 后已经接收变化的监听', async () => {
  const f = fixture(); const execute = f.web.executeJavaScriptInIsolatedWorld;
  let release: (() => void) | undefined; let held = false;
  f.web.executeJavaScriptInIsolatedWorld = (world: number, scripts: { code: string }[]) => {
    if (!held && scripts[0]!.code.includes('state.observer.observe(')) {
      held = true;
      return new Promise(resolve => { release = () => { void execute(world, scripts).then(resolve); }; });
    }
    return execute(world, scripts);
  };
  try {
    f.watcher.setEnabled(true); await flush();
    f.web.emit('dom-ready'); await flush();
    const before = f.counts().checks;
    assert.equal(before, 1, '新监听先建立一次基线');
    release!(); await flush();
    f.mutation(); f.deliver(150); await flush();
    assert.equal(f.counts().checks, before + 1, '旧初始化不能使新通知失去接收者');
  } finally { await f.watcher.dispose(); }
});

it('关闭自动采集后才执行的旧初始化不得留下监听', async () => {
  const f = fixture(); const execute = f.web.executeJavaScriptInIsolatedWorld;
  let release: (() => void) | undefined;
  f.web.executeJavaScriptInIsolatedWorld = (world: number, scripts: { code: string }[]) => scripts[0]!.code.includes('state.observer.observe(')
    ? new Promise(resolve => { release = () => { void execute(world, scripts).then(resolve); }; }) : execute(world, scripts);
  try {
    f.watcher.setEnabled(true); await flush();
    f.watcher.setEnabled(false); await flush();
    release!(); await flush();
    assert.equal(f.active(), false, '关闭后的旧注入不应复活网页监听');
    assert.equal(f.counts().checks, 0);
  } finally { await f.watcher.dispose(); }
});

it('仍开启时变化等待失效有限恢复，连续三次仍失败须清理并明确暂停', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const execute = f.web.executeJavaScriptInIsolatedWorld;
  f.web.executeJavaScriptInIsolatedWorld = (world: number, scripts: { code: string }[]) => scripts[0]!.code.includes('previous.waiter = resolve')
    ? Promise.resolve(false) : execute(world, scripts);
  try {
    f.watcher.setEnabled(true); await flush();
    assert.equal(f.health.at(-1)?.phase, 'recovering');
    const resets = f.counts().resets;
    for (const delay of [250, 1000, 3000]) { t.mock.timers.tick(delay); await flush(); }
    assert.equal(f.active(), false);
    assert.equal(f.messages.length, 1);
    assert.match(f.messages[0]!, /恢复失败.*监听已失效/);
    assert.equal(f.health.at(-1)?.phase, 'paused');
    assert.equal(f.counts().checks, 4);
    assert.equal(f.counts().resets, resets, '修复已有订阅不能重置自动采集历史基线');
  } finally { await f.watcher.dispose(); }
});

it('不支持的页面返回正式会话时重新建立历史基线，后续新变化无需重开开关', async () => {
  const baselines: unknown[]=[];const f=fixture(undefined,(preserve,history)=>baselines.push([preserve,history]));
  try {
    f.watcher.setEnabled(true);await flush();
    f.navigate('https://example.com/');f.mutation();f.deliver();await flush();
    assert.equal(f.active(),false);
    f.navigate('https://chat.deepseek.com/a/chat/s/returned');await flush();
    assert.equal(f.active(),true);assert.deepEqual(baselines.at(-1),[false,true]);
    const before=f.counts().checks;f.generating(true);f.replaceReply('new output');f.bodyMutation();f.deliver(150);await flush();
    assert.equal(f.counts().checks,before+1);
  } finally {await f.watcher.dispose();}
});

it('在不支持地址启用后进入正式会话，不得留下未安装 token 阻止监听启动', async () => {
  const f=fixture();
  try {
    f.navigate('https://example.com/');f.watcher.setEnabled(true);await flush();
    assert.equal(f.active(),false);
    f.navigate('https://chat.deepseek.com/a/chat/s/returned');await flush();
    assert.equal(f.active(),true);assert.equal(f.counts().checks,1);
    assert.notEqual(f.source(),'new','进入时已有消息必须保留为历史');
  } finally {await f.watcher.dispose();}
});

it('监听先建立基线，空闲没有计时器或重复网页检查；无关区域变化不检查回复', async () => {
  const f = fixture(); f.watcher.setEnabled(true); await flush();
  assert.equal(f.counts().checks, 1); assert.equal(f.timers.size, 0);
  const idle = f.counts().executions; await flush(); assert.equal(f.counts().executions, idle);
  f.mutation(false); assert.equal(f.timers.size, 0); await flush(); assert.equal(f.counts().checks, 1);
  f.burst(); assert.equal(f.timers.size, 1); f.deliver(); await flush();
  assert.equal(f.counts().checks, 2); assert.equal(f.timers.size, 0);
  await f.watcher.dispose(); assert.equal(f.active(), false);
});

it('合并通知期间更换历史节点，生成正文见证不能串用到另一个节点', async () => {
  const f = fixture(); f.watcher.setEnabled(true); await flush();
  f.generating(true); f.text('new partial body'); f.bodyMutation();
  f.generating(false); f.replaceReply('never mounted old command'); f.mutation();
  f.deliver(150); await flush();
  assert.notEqual(f.source(), 'new');
  await f.watcher.dispose();
});

it('自动接纳 idle 后的 acknowledge 同样封存正文，节点复用不能补挂 complete 执行旧命令', async () => {
  const f = fixture(); f.watcher.setEnabled(true); await flush();
  f.generating(true); f.text('new generated body'); f.bodyMutation(); f.deliver(150); await flush();
  f.generating(false); f.text('completed idle body'); f.bodyMutation(); f.deliver(150); await flush();
  assert.equal(f.source(), 'new');
  await f.watcher.acknowledge(false, f.sourceKey());
  f.text('never mounted historical command'); f.bodyMutation(); f.deliver(150); await flush();
  assert.notEqual(f.source(), 'new');
  await f.watcher.dispose();
});

it('自动接纳缺失来源 key 时明确拒绝且不封存，手动采集仍可按用户确认封存', async () => {
  const f = fixture();
  try {
    assert.equal(await f.watcher.acknowledge(false), false, '未建立监听不代表自动来源已确认');
    f.watcher.setEnabled(true); await flush();
    f.appendReply('new unaccepted tools'); f.mutation(); f.deliver(150); await flush();
    assert.equal(f.source(), 'new');
    const before = f.counts().executions;
    assert.equal(await f.watcher.acknowledge(false), false);
    assert.equal(f.counts().executions, before, '缺失 key 不得触发网页封存脚本');
    f.text('new body still completing'); f.mutation(); f.deliver(150); await flush();
    assert.equal(f.source(), 'new', '被拒绝的无 key 接纳不能冻结正文');
    assert.equal(await f.watcher.acknowledge(true), true, '手动入口已有独立用户确认，不要求自动来源 key');
    f.text('unwitnessed replacement'); f.mutation(); f.deliver(150); await flush();
    assert.notEqual(f.source(), 'new');
  } finally { await f.watcher.dispose(); }
});

it('idle 快照读取与 acknowledge 之间同节点被换成旧正文，必须按原快照身份封存', async () => {
  const f = fixture(); f.watcher.setEnabled(true); await flush();
  f.generating(true); f.text('accepted new idle body'); f.bodyMutation(); f.deliver(150); await flush();
  const key = f.sourceKey();
  f.generating(false); f.text('unmounted old tools after read'); f.bodyMutation();
  await f.watcher.acknowledge(false, key);
  assert.notEqual(f.source(), 'new');
  f.deliver(150); await flush(); assert.notEqual(f.source(), 'new');
  await f.watcher.dispose();
});

it('官网已确认接纳但主进程尚未收到回执时导航、关闭或销毁仍作废旧快照', async () => {
  for (const action of ['navigate', 'disable', 'dispose']) {
    const f = fixture(); const execute = f.web.executeJavaScriptInIsolatedWorld;
    let release: (() => void) | undefined;
    f.web.executeJavaScriptInIsolatedWorld = async (world: number, scripts: { code: string }[]) => {
      const metadata = await execute(world, scripts);
      if (scripts[0]!.code.includes('const accepted = expected')) return new Promise(resolve => { release = () => resolve(metadata); });
      return metadata;
    };
    try {
      f.watcher.setEnabled(true); await flush();
      f.generating(true); f.text('actual new tools'); f.bodyMutation(); f.deliver(150); await flush();
      f.generating(false);
      const accepted = f.watcher.acknowledge(false, f.sourceKey()); await flush();
      assert.ok(release);
      if (action === 'navigate') { f.navigate('https://chat.deepseek.com/a/chat/s/other'); await f.watcher.settleNavigation(); }
      else if (action === 'disable') f.watcher.setEnabled(false);
      else await f.watcher.dispose();
      release!();
      assert.equal(await accepted, false, action);
    } finally { await f.watcher.dispose(); }
  }
});

it('已有会话在空加载帧启用时等待迟到历史，不能执行第一个历史命令', async () => {
  let reply: AutoReply = { url: 'https://chat.deepseek.com/a/chat/s/one', text: '', completion: 'unknown' };
  const collected: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => { collected.push(text); }, () => {});
  const f = fixture(async () => auto.tick(), (_preserve, history) => auto.reset(history));
  f.hasRoot(false); auto.setEnabled(true); f.watcher.setEnabled(true); await flush();
  reply = { ...reply, text: 'loaded historical command', completion: 'complete' };
  f.replaceReply(reply.text); f.mutation(); f.deliver(150); await flush();
  assert.deepEqual(collected, []); assert.equal(f.source(), 'history');
  await f.watcher.dispose(); auto.dispose();
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
it('监听连续执行异常仅退避三次，到上限明确提示且停止重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.web.executeJavaScriptInIsolatedWorld = async () => { throw new Error('renderer failed'); };
  f.watcher.setEnabled(true); await flush();
  assert.equal(f.health.at(-1)?.phase, 'recovering');
  for (const delay of [250, 1000, 3000]) { t.mock.timers.tick(delay); await flush(); }
  assert.match(f.messages.join('\n'), /监听恢复失败.*renderer failed/); assert.equal(f.counts().checks, 0);
  const count = f.messages.length; await flush(); assert.equal(f.messages.length, count);
  await f.watcher.dispose();
});

it('同文档订阅短暂失败后复用来源并补采恢复期间的新输出一次', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const collected: string[] = [];
  let f: ReturnType<typeof fixture>;
  const auto = new AutoCollector(async () => { const state = (f.context as any).__miniAIReplyChanges; state.updateSources(); return { url: f.web.getURL(), text: state.replyNodes().at(-1)?.textContent ?? '', completion: 'complete', source: f.source(), sourceKey: f.sourceKey() }; }, async (text, _current, sourceKey) => {
    if (await f.watcher.acknowledge(false, sourceKey)) collected.push(text);
  }, () => {});
  f = fixture(() => auto.tick(), (_preserve, history) => auto.reset(history));
  const execute = f.web.executeJavaScriptInIsolatedWorld; let fail = true; let oldWaitResolved = false;
  f.web.executeJavaScriptInIsolatedWorld = (world: number, scripts: { code: string }[]) => {
    if (fail && scripts[0]!.code.includes('previous.waiter = resolve')) {
      fail = false;
      void execute(world, scripts).then(() => { oldWaitResolved = true; });
      return Promise.reject(new Error('temporary wait transport failure'));
    }
    return execute(world, scripts);
  };
  try {
    auto.setEnabled(true); f.watcher.setEnabled(true); await flush();
    const sources = (f.context as any).__miniAIReplyChanges.sources; const resets = f.counts().resets;
    f.generating(true); f.text('new partial tools'); f.bodyMutation();
    f.generating(false); f.text('new completed tools'); f.bodyMutation();
    t.mock.timers.tick(250); await flush();
    assert.equal(oldWaitResolved, true, '修复先撤销遗留wait，不能产生两个消费者');
    assert.equal((f.context as any).__miniAIReplyChanges.sources, sources);
    assert.equal(f.counts().resets, resets);
    assert.equal(f.active(), true);
    assert.deepEqual(collected, ['new completed tools']);
    f.deliver(150); await flush();
    assert.deepEqual(collected, ['new completed tools'], '后续遗留变化不能重复执行');
    assert.equal(f.health.at(-1)?.phase, 'watching');
  } finally { await f.watcher.dispose(); auto.dispose(); }
});

it('来源状态丢失时恢复仅重建历史，并明确报告未补采旧内容', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const execute = f.web.executeJavaScriptInIsolatedWorld; let fail = true;
  f.web.executeJavaScriptInIsolatedWorld = (world: number, scripts: { code: string }[]) => {
    if (fail && scripts[0]!.code.includes('previous.waiter = resolve')) { fail = false; return Promise.resolve(false); }
    return execute(world, scripts);
  };
  try {
    f.watcher.setEnabled(true); await flush();
    assert.equal(f.health.at(-1)?.phase, 'recovering');
    const resets = f.counts().resets;
    vm.runInContext('globalThis.__miniAIReplyChanges.dispose(); delete globalThis.__miniAIReplyChanges;', f.context);
    f.text('never executed historical tools');
    t.mock.timers.tick(250); await flush();
    assert.equal(f.active(), true);
    assert.ok((f.context as any).__miniAIReplyChanges, JSON.stringify({ counts: f.counts(), health: f.health, messages: f.messages }));
    assert.equal(f.source(), 'history');
    assert.equal(f.counts().resets, resets + 1);
    assert.equal(f.health.at(-1)?.reason, 'source-state-lost');
    assert.match(f.health.at(-1)!.message, /已有回复作为历史/);
  } finally { await f.watcher.dispose(); }
});

it('关闭、会话导航或销毁撤销尚未开始的监听恢复', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['disable', 'navigate', 'dispose']) {
    const f = fixture(); const execute = f.web.executeJavaScriptInIsolatedWorld; let fail = true; let repairs = 0;
    f.web.executeJavaScriptInIsolatedWorld = (world: number, scripts: { code: string }[]) => {
      if (scripts[0]!.code.includes('return { preserved: true, turn:')) repairs++;
      if (fail && scripts[0]!.code.includes('previous.waiter = resolve')) { fail = false; return Promise.resolve(false); }
      return execute(world, scripts);
    };
    try {
      f.watcher.setEnabled(true); await flush(); assert.equal(f.health.at(-1)?.phase, 'recovering');
      if (action === 'disable') f.watcher.setEnabled(false);
      else if (action === 'navigate') f.navigate('https://chat.deepseek.com/a/chat/s/other');
      else await f.watcher.dispose();
      await flush(); t.mock.timers.tick(5000); await flush();
      assert.equal(repairs, 0, action);
      if (action === 'navigate') assert.notEqual(f.source(), 'new');
      else assert.equal(f.active(), false, action);
    } finally { await f.watcher.dispose(); }
  }
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
  assert.deepEqual(resets.at(-1), [false, true], '已有会话的空加载帧重新启用后仍等待历史'); await f.watcher.dispose();
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

it('SPA 导航时已同步挂载完整历史则落定历史基线，下一新增回复执行一次', async () => {
  let f: ReturnType<typeof fixture>;
  const output: string[] = [];
  const auto = new AutoCollector(async () => {
    const state = (f.context as any).__miniAIReplyChanges; state.updateSources();
    return { url: f.web.getURL(), text: state.replyNodes().at(-1)?.textContent ?? '', completion: 'complete', source: f.source(), sourceKey: f.sourceKey() };
  }, async (text, _current, sourceKey) => { if (await f.watcher.acknowledge(false, sourceKey)) output.push(text); }, () => {});
  f = fixture(() => auto.tick(), (_preserve, history) => auto.reset(history));
  try {
    auto.setEnabled(true); f.watcher.setEnabled(true); await flush();
    f.replaceReply('synchronously mounted historical tools');
    f.navigate('https://chat.deepseek.com/a/chat/s/synchronous-history');
    await f.watcher.settleNavigation(); await flush();
    assert.equal((f.context as any).__miniAIReplyChanges.history.ready, true);
    f.deliver(150); await flush();
    assert.deepEqual(output, [], '同步挂载的未执行历史也只能成为基线');
    f.deliver(500); await flush();
    assert.equal((f.context as any).__miniAIReplyChanges.history, null);
    f.appendReply('actual new tools after mounted history'); f.mutation(); f.deliver(150); await flush();
    f.mutation(); f.deliver(150); await flush();
    assert.deepEqual(output, ['actual new tools after mounted history']);
  } finally { await f.watcher.dispose(); auto.dispose(); }
});

it('导航仍是原旧 DOM 或空加载帧时不启动历史安静窗口，迟到历史仍受保护', async () => {
  const f = fixture();
  try {
    f.watcher.setEnabled(true); await flush();
    f.navigate('https://chat.deepseek.com/a/chat/s/old-dom-target'); await f.watcher.settleNavigation();
    assert.equal((f.context as any).__miniAIReplyChanges.history.timer, null);
    f.deliver(500); await flush();
    assert.equal((f.context as any).__miniAIReplyChanges.history.ready, false);
    f.hasRoot(false); f.navigate('https://chat.deepseek.com/a/chat/s/empty-target'); await f.watcher.settleNavigation();
    f.deliver(500); await flush();
    assert.equal((f.context as any).__miniAIReplyChanges.history.timer, null);
    f.replaceReply('late mounted history'); f.mutation(); f.deliver(150); await flush();
    assert.equal(f.source(), 'history');
    assert.equal((f.context as any).__miniAIReplyChanges.history.ready, true);
  } finally { await f.watcher.dispose(); }
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

it('非发送的真实用户动作使本地提交标记立即失效，交接重建历史基线', async () => {
  const resets: [boolean | undefined, boolean | undefined][] = [];
  const f = fixture(undefined, (preserve, history) => resets.push([preserve, history]));
  f.hasRoot(false); f.navigate('https://chat.deepseek.com/'); f.watcher.setEnabled(true); await flush();
  await f.watcher.markLocalSubmit(); await flush();
  f.userAction({ target: { closest: () => null } }); f.navigate('https://chat.deepseek.com/a/chat/s/history'); await f.watcher.settleNavigation();
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

for (const source of ['website-click', 'website-enter', 'local'] as const) {
  for (const warm of [false, true]) it(`首轮交接 ${source} / ${warm ? '已有会话中新建' : '空首页启动'}：地址先到且生成不可识别，完成后实际采集一次`, async () => {
    let reply: AutoReply = warm
      ? { url: 'https://chat.deepseek.com/a/chat/s/old', text: 'old history', completion: 'complete' }
      : { url: 'https://chat.deepseek.com/', text: '', completion: 'unknown' };
    const output: string[] = [];
    const auto = new AutoCollector(async () => ({ ...reply }), async text => { output.push(text); }, () => {});
    const f = fixture(async () => auto.tick(), (preserve, history, generated) => {
      if (generated) auto.observeGeneration(reply.url);
      else if (preserve) auto.continueAt(reply.url);
      else auto.reset(history);
    });
    f.hasRoot(warm); f.navigate(reply.url); auto.setEnabled(true); f.watcher.setEnabled(true); await flush();
    try {
      if (warm) {
        reply = { url: 'https://chat.deepseek.com/', text: '', completion: 'unknown' };
        f.hasRoot(false); f.navigate(reply.url); await f.watcher.settleNavigation();
        f.mutation(); f.deliver(150); await flush();
      }
      f.userAction({ type: 'keydown', key: 'a' });
      if (source === 'local') await f.watcher.markLocalSubmit();
      else f.userAction(source === 'website-enter' ? { type: 'keydown', key: 'Enter' } : {});
      reply.url = 'https://chat.deepseek.com/a/chat/s/new';
      f.navigate(reply.url); await f.watcher.settleNavigation(); await flush();
      // 新地址已被处理，随后才挂载回复；没有任何可识别的生成标志。
      reply.text = 'first tools'; f.replaceReply(reply.text);
      for (const completion of ['unknown', 'interrupted', 'idle'] as const) {
        reply.completion = completion; f.mutation(); f.deliver(150); await flush();
        assert.deepEqual(output, [], '提交记录不是结束证据，不能执行未知或半成品');
      }
      reply.completion = 'complete'; f.mutation(); f.deliver(150); await flush();
      assert.deepEqual(output, ['first tools'], '首轮新工具不能记为历史');
      f.mutation(); f.deliver(150); await flush(); assert.deepEqual(output, ['first tools']);
      reply.text = 'second tools'; f.replaceReply(reply.text); f.mutation(); f.deliver(150); await flush();
      assert.deepEqual(output, ['first tools', 'second tools']);
      reply.url = 'https://chat.deepseek.com/a/chat/s/history'; f.navigate(reply.url); await f.watcher.settleNavigation();
      reply.text = 'unexecuted history tools'; f.replaceReply(reply.text); f.mutation(); f.deliver(150); await flush();
      assert.deepEqual(output, ['first tools', 'second tools'], '真正切到历史会话仍不得执行历史');
    } finally { await f.watcher.dispose(); auto.dispose(); }
  });
}

it('首轮交接记录过期、非发送动作、合成发送与监听重建均不能把历史当新轮', async () => {
  for (const invalidation of ['expired-local', 'expired-website', 'other-action', 'synthetic', 'restart', 'shift-enter', 'composing'] as const) {
    const resets: [boolean | undefined, boolean | undefined][] = [];
    const f = fixture(undefined, (preserve, history) => resets.push([preserve, history]));
    f.hasRoot(false); f.navigate('https://chat.deepseek.com/'); f.watcher.setEnabled(true); await flush();
    try {
      if (invalidation === 'expired-local') await f.watcher.markLocalSubmit();
      else f.userAction(invalidation === 'synthetic' ? { isTrusted: false }
        : invalidation === 'shift-enter' ? { type: 'keydown', key: 'Enter', shiftKey: true }
        : invalidation === 'composing' ? { type: 'keydown', key: 'Enter', isComposing: true } : {});
      if (invalidation.startsWith('expired-')) f.advanceTime(8000);
      if (invalidation === 'other-action') f.userAction({ target: { closest: () => null } });
      if (invalidation === 'restart') { f.watcher.setEnabled(false); f.watcher.setEnabled(true); await flush(); }
      f.navigate('https://chat.deepseek.com/a/chat/s/history'); await f.watcher.settleNavigation();
      assert.deepEqual(resets.at(-1), [false, true], invalidation);
    } finally { await f.watcher.dispose(); }
  }
});

it('首页点击历史时，先挂载的历史正文不能靠新节点绕过交接取消', async () => {
  for (const warm of [false, true]) {
    let reply: AutoReply = warm
      ? { url: 'https://chat.deepseek.com/a/chat/s/old', text: 'old history', completion: 'complete' }
      : { url: 'https://chat.deepseek.com/', text: '', completion: 'unknown' };
    const output: string[] = [];
    const auto = new AutoCollector(async () => ({ ...reply }), async text => { output.push(text); }, () => {});
    const f = fixture(async () => auto.tick(), (preserve, history, generated) => {
      if (generated) auto.observeGeneration(reply.url);
      else if (preserve) auto.continueAt(reply.url);
      else auto.reset(history);
    });
    f.hasRoot(warm); f.navigate(reply.url); auto.setEnabled(true); f.watcher.setEnabled(true); await flush();
    try {
      if (warm) {
        reply = { url: 'https://chat.deepseek.com/', text: '', completion: 'unknown' };
        f.hasRoot(false); f.navigate(reply.url); await f.watcher.settleNavigation(); await flush();
      }
      await f.watcher.markLocalSubmit();
      f.userAction({ target: { closest: () => null } });
      // 历史已挂载后才执行导航检查；旧提交及“新节点”都不能证明这是新生成。
      reply = { url: 'https://chat.deepseek.com/a/chat/s/history', text: 'unexecuted history tools', completion: 'complete' };
      f.replaceReply(reply.text); f.navigate(reply.url); await f.watcher.settleNavigation(); await flush();
      f.mutation(); f.deliver(150); await flush();
      assert.deepEqual(output, [], warm ? '已有会话回首页' : '空首页');
    } finally { await f.watcher.dispose(); auto.dispose(); }
  }
});
