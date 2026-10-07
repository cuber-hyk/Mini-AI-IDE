import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as vm from 'node:vm';
import { it } from 'node:test';
import { ReplyChangeWatcher, REPLY_WATCH_WORLD } from '../src/main/tools/replyChangeWatcher';
import { AutoCollector } from '../src/main/tools/autoCollector';
import { DEEPSEEK_SEND_ICON } from '../src/main/tools/replyObservation';
import { parseToolBatch } from '../src/shared/toolProtocol';

function continuationControl() {
  const button: any = { textContent: '继续生成', disabled: false, hidden: false, inMessage: false,
    getAttribute: () => null, getClientRects: () => button.hidden ? [] : [{}],
    classList: { contains: () => false }, matches: () => false, querySelectorAll: () => [],
    closest: (selector: string) => selector.includes('role=') ? button : button.inMessage ? {} : null };
  return button;
}

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function fixture(change?: (userTurn: boolean) => Promise<void>, reset?: () => void) {
  const timers = new Map<number, () => void>(); let timerId = 0; let checks = 0; let resets = 0; let executions = 0;
  let observer: any; let url = 'https://chat.deepseek.com/a/chat/one';
  class Observer {
    active = false;
    constructor(readonly callback: (records: unknown[]) => void) { observer = this; }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }
  const listeners = new Map<string, (event: any) => void>(); let root = true;
  const currentFooter: unknown[] = [];
  const currentReply: any = { contains: () => false, closest: () => ({ parentElement: {
    contains: (node: unknown) => node === currentReply || currentFooter.includes(node),
  } }) };
  const messagesFrames: any[] = [currentReply];
  const composer: any = { disabled: false, classList: { contains: () => false }, getAttribute: () => null,
    closest: () => composer, matches: () => true, querySelectorAll: () => [{ getAttribute: () => DEEPSEEK_SEND_ICON }] };
  Object.defineProperty(composer, 'value', { get: () => assert.fail('不得读取输入内容') });
  const context = vm.createContext({ MutationObserver: Observer, document: { documentElement: {},
    querySelector: (selector: string) => selector.includes('primary') ? composer : root ? {} : null,
    querySelectorAll: () => messagesFrames,
    addEventListener: (name: string, fn: any) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name),
  },
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
  });
  const web: any = new EventEmitter(); const messages: string[] = [];
  web.isDestroyed = () => false; web.getURL = () => url;
  web.executeJavaScriptInIsolatedWorld = async (world: number, scripts: any[]) => {
    assert.equal(world, REPLY_WATCH_WORLD); executions++; return vm.runInContext(scripts[0].code, context);
  };
  const watcher = new ReplyChangeWatcher(web, async userTurn => { checks++; await change?.(userTurn); }, () => { resets++; reset?.(); }, text => messages.push(text));
  const node = (relevant: boolean) => ({ nodeType: 1, closest: () => relevant ? {} : null, querySelector: () => null });
  return { watcher, web, messages, timers, context, listeners,
    userAction(extra: Record<string, unknown> = {}) { const type = String(extra.type ?? 'click'); listeners.get(type)?.({ type, isTrusted: true, target: composer, ...extra }); },
    hasRoot(value: boolean) { root = value; },
    historyFooter(button: unknown) { messagesFrames.unshift({ closest: () => ({ parentElement: { contains: (node: unknown) => node === button } }) }); },
    latestFooter(button: unknown) { currentFooter.push(button); },
    counts: () => ({ checks, resets, executions }),
    mutation(relevant = true) { if (observer.active) observer.callback([{ type: 'characterData', target: node(relevant) }]); },
    burst() { for (let i = 0; i < 100; i++) this.mutation(); },
    deliver() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
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
  f.navigate('https://chat.deepseek.com/a/chat/one?tracking=2'); await flush(); assert.equal(f.counts().checks, 2);
  f.navigate('https://chat.deepseek.com/a/chat/two'); await flush(); assert.equal(f.counts().checks, 3);
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

it('只读发送动作只记新轮，合成事件、Shift+Enter和输入法回车均不启动采集', async () => {
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

it('SPA先改网址后异步加载历史，包括未消费的旧发送标记，都不能执行历史工具', async () => {
  let reply = { url: 'https://chat.deepseek.com/a/chat/one', text: 'OLD_HISTORY', completion: 'complete' as const };
  const output: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => { output.push(text); }, () => {});
  const f = fixture(async turn => { if (turn) auto.noteUserTurn(); await auto.tick(); }, () => auto.reset());
  auto.setEnabled(true); f.watcher.setEnabled(true); await flush();
  f.userAction(); // 旧会话发送通知尚未消费时切走，不能沿用该标记。
  reply = { ...reply, url: 'https://chat.deepseek.com/a/chat/two' }; f.navigate(reply.url); await flush();
  reply = { ...reply, text: 'HISTORICAL_TOOLS_FROM_CHAT_TWO' }; f.mutation(); f.deliver(); await flush(); assert.deepEqual(output, []);
  f.userAction(); reply = { ...reply, text: 'ACTUAL_NEW_USER_TURN' }; f.mutation(); f.deliver(); await flush();
  assert.deepEqual(output, ['ACTUAL_NEW_USER_TURN']); await f.watcher.dispose(); auto.dispose();
});

it('空新对话由用户发送后分配会话网址，保留这一次新轮而不重放旧对话', async () => {
  const turns: boolean[] = []; const f = fixture(async turn => { turns.push(turn); });
  f.hasRoot(false); f.watcher.setEnabled(true); await flush(); f.userAction();
  f.navigate('https://chat.deepseek.com/a/chat/newly-created'); await flush(); assert.equal(turns.at(-1), true);
  f.hasRoot(true); f.navigate('https://chat.deepseek.com/a/chat/history'); await flush(); assert.equal(turns.at(-1), false);
  await f.watcher.dispose();
});

it('首回复生成根先挂载后分配会话网址，仍只采集用户真实发起的首轮一次', async () => {
  let reply = { url: 'https://chat.deepseek.com/a/chat/new', text: '', completion: 'complete' as 'complete' | 'generating' };
  const output: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => { output.push(text); }, () => {});
  const f = fixture(async turn => { if (turn) auto.noteUserTurn(); await auto.tick(); }, () => auto.reset());
  f.hasRoot(false); auto.setEnabled(true); f.watcher.setEnabled(true); await flush(); f.userAction();
  f.hasRoot(true); reply = { ...reply, text: 'partial first response', completion: 'generating' }; f.mutation(); f.deliver(); await flush();
  reply = { ...reply, url: 'https://chat.deepseek.com/a/chat/assigned' }; f.navigate(reply.url); await flush();
  reply = { ...reply, text: 'ACTUAL_FIRST_REPLY', completion: 'complete' }; f.mutation(); f.deliver(); await flush();
  assert.deepEqual(output, ['ACTUAL_FIRST_REPLY']);
  f.userAction({ target: { closest: () => null, matches: () => false } });
  reply = { ...reply, url: 'https://chat.deepseek.com/a/chat/history' }; f.navigate(reply.url); await flush();
  reply = { ...reply, text: 'ASYNC_HISTORY' }; f.mutation(); f.deliver(); await flush(); assert.deepEqual(output, ['ACTUAL_FIRST_REPLY']);
  await f.watcher.dispose(); auto.dispose();
});

it('首轮完成后释放地址关联，输入区聚焦的历史返回也不能执行旧工具', async () => {
  let reply = { url: 'https://chat.deepseek.com/a/chat/one', text: '', completion: 'complete' as const };
  const output: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => { await f.watcher.acknowledge(); output.push(text); }, () => {});
  const f = fixture(async turn => { if (turn) auto.noteUserTurn(); await auto.tick(); }, () => auto.reset());
  f.hasRoot(false); auto.setEnabled(true); f.watcher.setEnabled(true); await flush();
  f.userAction(); f.hasRoot(true); reply = { ...reply, text: 'ACTUAL_REPLY' }; f.mutation(); f.deliver(); await flush();
  assert.deepEqual(output, ['ACTUAL_REPLY']);
  f.userAction({ type: 'keydown', key: 'ArrowLeft', altKey: true });
  reply = { ...reply, url: 'https://chat.deepseek.com/a/chat/history' }; f.navigate(reply.url); await flush();
  reply = { ...reply, text: 'HISTORICAL_TOOLS' }; f.mutation(); f.deliver(); await flush();
  assert.deepEqual(output, ['ACTUAL_REPLY']); await f.watcher.dispose(); auto.dispose();
});

it('手动完成消费待通知的旧发送标记，自动完成不会清除后续新发送关联', async () => {
  const turns: boolean[] = []; const f = fixture(async turn => { turns.push(turn); });
  f.hasRoot(false); f.watcher.setEnabled(true); await flush();
  f.userAction(); f.mutation(); await f.watcher.acknowledge(true);
  f.deliver(); await flush(); assert.equal(turns.at(-1), false);
  f.navigate('https://chat.deepseek.com/a/chat/history'); await flush(); assert.equal(turns.at(-1), false);
  f.userAction(); f.mutation(); f.deliver(); await flush(); assert.equal(turns.at(-1), true);
  f.userAction(); await f.watcher.acknowledge();
  f.navigate('https://chat.deepseek.com/a/chat/newly-assigned'); await flush(); assert.equal(turns.at(-1), true);
  await f.watcher.dispose();
});

it('输入区的真实历史导航快捷键释放未完成首轮的地址关联', async () => {
  const turns: boolean[] = []; const f = fixture(async turn => { turns.push(turn); });
  f.hasRoot(false); f.watcher.setEnabled(true); await flush(); f.userAction();
  f.userAction({ type: 'keydown', key: 'ArrowLeft', altKey: true });
  f.navigate('https://chat.deepseek.com/a/chat/history'); await flush(); assert.equal(turns.at(-1), false);
  await f.watcher.dispose();
});

it('首次半条JSON失败后，最新回复页脚的真实继续生成重新取得资格，补全只采集一次', async () => {
  let reply = { url: 'https://chat.deepseek.com/a/chat/one', text: 'history', completion: 'complete' as 'complete' | 'generating' };
  const output: string[] = [];
  const batches: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => {
    await f.watcher.acknowledge(); output.push(text);
    const parsed = parseToolBatch(text); if (parsed.kind === 'batch') batches.push(parsed.batch.batch_id);
  }, () => {});
  const f = fixture(async turn => { if (turn) auto.noteUserTurn(); await auto.tick(); }, () => auto.reset());
  const resume = continuationControl();
  f.latestFooter(resume);
  const complete = '```mini-ai-tools\n{"protocol_version":1,"batch_id":"resumed","requests":[{"id":"info","tool":"get_project_info","args":{}}]}\n```';
  const partial = complete.slice(0, 85);
  auto.setEnabled(true); f.watcher.setEnabled(true); await flush(); f.userAction();
  reply.text = partial; f.mutation(); f.deliver(); await flush();
  assert.equal(parseToolBatch(partial).kind, 'error'); assert.deepEqual(batches, []);
  f.userAction({ target: resume }); const before = f.counts().checks; await flush(); assert.equal(f.counts().checks, before);
  reply = { ...reply, completion: 'generating' }; f.mutation(); f.deliver(); await flush();
  reply = { ...reply, text: complete, completion: 'complete' }; f.mutation(); f.deliver(); await flush();
  f.mutation(); f.deliver(); await flush(); assert.deepEqual(output, [partial, complete]); assert.deepEqual(batches, ['resumed']);
  await f.watcher.dispose(); auto.dispose();
});

it('代码或历史消息内、隐藏、禁用及合成的继续按钮不能赋予执行资格，续写后导航也不携带资格', async () => {
  const turns: boolean[] = []; const f = fixture(async turn => { turns.push(turn); });
  f.watcher.setEnabled(true); await flush();
  const button = continuationControl();
  for (const mode of ['message', 'hidden', 'disabled', 'synthetic']) {
    button.inMessage = mode === 'message'; button.hidden = mode === 'hidden'; button.disabled = mode === 'disabled';
    f.userAction({ target: button, isTrusted: mode !== 'synthetic' }); f.mutation(); f.deliver(); await flush();
    assert.equal(turns.at(-1), false, mode);
  }
  button.disabled = false; f.userAction({ target: button });
  f.navigate('https://chat.deepseek.com/a/chat/history'); await flush();
  f.mutation(); f.deliver(); await flush(); assert.equal(turns.at(-1), false);
  await f.watcher.dispose();
});

it('历史消息父级页脚的同名继续控件不能触发采集资格', async () => {
  const turns: boolean[] = []; const f = fixture(async turn => { turns.push(turn); });
  f.watcher.setEnabled(true); await flush(); const button = continuationControl(); f.historyFooter(button);
  f.userAction({ target: button }); f.mutation(); f.deliver(); await flush();
  assert.equal(turns.at(-1), false); await f.watcher.dispose();
});
