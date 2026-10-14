import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as vm from 'node:vm';
import { createReplySourceTracker } from '../src/main/tools/replySource';

const reply = (textContent: string) => ({ textContent });
const bodyText = new WeakMap<object, string>();
const bodyReply = (body: string, control = '复制') => {
  const node = reply(body + control); bodyText.set(node, body); return node;
};
const readBody = (node: object) => bodyText.get(node) ?? '';

it('正式正文不变时控件文案改变不撤销已封存的新输出资格', () => {
  const tail = bodyReply('baseline'), next = bodyReply('new tools');
  const raw = createReplySourceTracker([tail]);
  const tracker = createReplySourceTracker([tail], 'body', readBody);
  raw.observe([tail, next]); raw.seal(next);
  tracker.observe([tail, next]); tracker.seal(next);
  const accepted = tracker.key(next);
  next.textContent = 'new toolscopy';
  raw.observe([tail, next]); tracker.observe([tail, next]);
  assert.equal(raw.source(next), 'unknown', '整节点文案指纹会误判无关控件变化');
  assert.equal(tracker.source(next), 'new');
  assert.equal(tracker.key(next), accepted, '正文、节点和作用域均未改变');
  tracker.seal(next, accepted);
  assert.equal(tracker.source(next), 'new');
});

it('正文读取器不允许已封存节点在无生成见证时替换真正的工具正文', () => {
  const tail = bodyReply('baseline'), next = bodyReply('new tools');
  const tracker = createReplySourceTracker([tail], 'body', readBody);
  tracker.observe([tail, next]); tracker.seal(next);
  bodyText.set(next, 'unseen historical tools');
  tracker.observe([tail, next]);
  assert.equal(tracker.source(next), 'unknown');
});

it('历史正式正文覆盖新节点仍是历史，不受控件文案差异影响', () => {
  const tail = bodyReply('old tools'), next = bodyReply('new tools');
  const tracker = createReplySourceTracker([tail], 'body', readBody);
  tracker.observe([tail, next]); tracker.seal(next);
  bodyText.set(next, 'old tools'); next.textContent = 'old toolscopy';
  tracker.observe([tail, next]);
  assert.equal(tracker.source(next), 'history');
});

it('正文读取器不能把同正文重挂载或未知整段替换授予新输出身份', () => {
  const tail = bodyReply('baseline'), next = bodyReply('new tools');
  const tracker = createReplySourceTracker([tail], 'body', readBody);
  tracker.observe([tail, next]); tracker.seal(next);
  const remounted = bodyReply('new tools', 'copy');
  tracker.observe([tail, remounted]);
  assert.equal(tracker.source(remounted), 'history');
  const unknown = bodyReply('unseen tools');
  assert.equal(tracker.source(unknown), 'unknown');
  tracker.observe([unknown]);
  assert.notEqual(tracker.source(unknown), 'new');
});

it('正文读取器参数可与来源跟踪一起注入隔离世界，不依赖宿主闭包', () => {
  const tracker = vm.runInNewContext(`(${createReplySourceTracker.toString()})([], 'body', node => node.body)`);
  const first = { body: 'first tools', textContent: 'first tools复制' };
  tracker.observe([first]); tracker.seal(first);
  const accepted = tracker.key(first);
  first.textContent = 'first toolscopy'; tracker.observe([first]);
  assert.equal(tracker.source(first), 'new');
  assert.equal(tracker.key(first), accepted);
});

it('开启时全部消息都是历史；向上滚动露出未执行的旧批次不能成为新输出', () => {
  const old = reply('unexecuted dangerous tools'), tail = reply('conversation finished');
  const tracker = createReplySourceTracker([old, tail]);
  tracker.observe([old]);
  assert.equal(tracker.source(old), 'history');
  const remounted = reply(old.textContent);
  tracker.observe([remounted]);
  assert.equal(tracker.source(remounted), 'history');
});

it('整段替换与尾部卸载不授予新输出资格，即使历史批次从未被见过', () => {
  const tail = reply('finished');
  const tracker = createReplySourceTracker([tail]);
  const old = reply('previously unmounted old tools');
  tracker.observe([]); tracker.observe([old]);
  assert.equal(tracker.source(old), 'history');
  const different = reply('another unmounted old tools');
  tracker.observe([old, different]);
  assert.equal(tracker.source(different), 'history', '失去原尾部后不能把历史互相当成新消息锚点');
});

it('保留尾部的瞬时完成追加可以执行，不要求观察到发送动作或生成控件', () => {
  const tail = reply('finished');
  const tracker = createReplySourceTracker([tail]);
  const next = reply('new tools');
  tracker.observe([tail, next]);
  assert.equal(tracker.source(next), 'new');
  tracker.observe([tail, next]);
  assert.equal(tracker.source(next), 'new', '重复状态仍由调度和持久账本去重');
});

it('前插旧消息不推进尾部；新输出后回看旧错误和重新挂载均为历史', () => {
  const old = reply('old broken JSON'), tail = reply('finished');
  const tracker = createReplySourceTracker([old, tail]);
  const prepended = reply('another old batch');
  tracker.observe([prepended, old, tail]);
  assert.equal(tracker.source(tail), 'history');
  const next = reply('new broken JSON'); tracker.observe([prepended, old, tail, next]);
  assert.equal(tracker.source(next), 'new');
  tracker.observe([reply('old broken JSON')]);
  assert.equal(tracker.source(old), 'history');
  tracker.observe([reply('new broken JSON')]);
  assert.equal(tracker.source(reply('new broken JSON')), 'history');
});

it('真实生成中的正文变化可继续同一回复；历史内容覆盖活动正文不能执行', () => {
  const old = reply('old tools'), tail = reply('partial');
  const tracker = createReplySourceTracker([old, tail]);
  tail.textContent = 'continued partial'; tracker.observe([old, tail], false, true);
  assert.equal(tracker.source(tail), 'new');
  tail.textContent = 'completed tools'; tracker.observe([old, tail]);
  assert.equal(tracker.source(tail), 'new');
  tail.textContent = 'old tools'; tracker.observe([old, tail]);
  assert.equal(tracker.source(tail), 'history');
});

it('历史分批加载持续建立历史见证；真正新生成与导航后的来源彼此隔离', () => {
  const old = reply('previous session'), loaded = reply('loaded history');
  const tracker = createReplySourceTracker([old]);
  tracker.observe([loaded], true);
  const late = reply('late loaded history'); tracker.observe([loaded, late], true);
  assert.equal(tracker.source(late), 'history');
  const next = reply('new partial'); tracker.observe([next], false, true);
  assert.equal(tracker.source(next), 'new');
  const otherSession = createReplySourceTracker([next]);
  assert.equal(otherSession.source(next), 'history');
});

it('已完成消息节点被复用显示未见过的旧正文时必须失去自动资格', () => {
  const tail = reply('finished'), next = reply('new tools');
  const tracker = createReplySourceTracker([tail]);
  tracker.observe([tail, next]); tracker.seal(next);
  next.textContent = 'never-seen historical command'; tracker.observe([next]);
  assert.notEqual(tracker.source(next), 'new');
  next.textContent = 'actually generating new text'; tracker.observe([next], false, true);
  assert.equal(tracker.source(next), 'new', '真实续写见证仍可释放已完成节点的旧正文冻结');
});

it('接纳快照到封存之间的节点复用不能把新身份授予旧正文，也不冻结真正新增的下一条', () => {
  const tail = reply('finished'), next = reply('accepted idle tools');
  const tracker = createReplySourceTracker([tail]); tracker.observe([tail, next]);
  const acceptedKey = tracker.key(next);
  next.textContent = 'unmounted history after read';
  tracker.seal(next, acceptedKey); tracker.observe([next]);
  assert.notEqual(tracker.source(next), 'new');
  const actualNext = reply('actual next output'); tracker.observe([next, actualNext]);
  assert.equal(tracker.source(actualNext), 'new');
  tracker.seal(actualNext, acceptedKey);
  actualNext.textContent = 'final next output'; tracker.observe([next, actualNext]);
  assert.equal(tracker.source(actualNext), 'new', '不同节点的新回复不能被上一快照封存');
});

it('读取后节点临时卸载也封存原快照；导航的新来源不能继承旧封存身份', () => {
  const tail = reply('baseline'), accepted = reply('accepted idle');
  const tracker = createReplySourceTracker([tail], 'one'); tracker.observe([tail, accepted]);
  const key = tracker.key(accepted);
  const temporaryHistory = reply('temporary historical viewport');
  tracker.seal(temporaryHistory, key); tracker.observe([temporaryHistory]);
  accepted.textContent = 'never seen old command'; tracker.observe([accepted]);
  assert.notEqual(tracker.source(accepted), 'new');
  const other = createReplySourceTracker([tail], 'two'); const next = reply('new actual tools');
  other.observe([tail, next]); other.seal(next, key);
  next.textContent = 'growing actual tools'; other.observe([tail, next]);
  assert.equal(other.source(next), 'new');
});

it('来源跟踪可直接放入隔离世界，不依赖构建器或网页主世界函数', () => {
  const tracker = vm.runInNewContext(`(${createReplySourceTracker.toString()})([])`);
  const first = reply('first tools'); tracker.observe([first]);
  assert.equal(tracker.source(first), 'new');
});

it('历史见证上限不淘汰旧指纹或重新授权，达到上限后明确返回未知', () => {
  const nodes = Array.from({ length: 10_000 }, (_, i) => reply('history-' + i));
  const tracker = createReplySourceTracker(nodes);
  const next = reply('new tools'); tracker.observe([...nodes, next]);
  assert.equal(tracker.source(next), 'unknown');
  assert.equal(tracker.source(nodes[0]), 'unknown');
});

it('同会话唯一消息 ID 和原正文确认重挂载后，只让下一条新回复推进', () => {
  const withId = (id: string, textContent: string) => ({ id, textContent });
  const readId = (node: object) => 'id' in node ? String(node.id) : undefined;
  const baseline = withId('baseline', 'history'), accepted = withId('accepted', 'accepted tools');
  const tracker = createReplySourceTracker([baseline], 'session-one', undefined, readId);
  tracker.observe([baseline, accepted]); tracker.seal(accepted, tracker.key(accepted));
  const remounted = withId('accepted', 'accepted tools');
  tracker.observe([remounted]);
  assert.equal(tracker.source(remounted), 'history', '重挂载不得重放已执行请求');
  const next = withId('next', 'new completed tools'); tracker.observe([remounted, next]);
  assert.equal(tracker.source(next), 'new', '恢复尾部连续性后不要求碰巧观察到生成过程');
  const otherSession = createReplySourceTracker([next], 'session-two', undefined, readId);
  assert.equal(otherSession.source(next), 'history', '另一会话必须独立建立历史基线');
});

it('同消息重挂载身份重复、缺失或正文不同均不能修复尾部资格', () => {
  for (const kind of ['duplicate', 'missing', 'different-id', 'different-body']) {
    const original = { id: 'accepted', textContent: 'accepted tools' };
    const readId = (node: object) => 'id' in node ? String(node.id) : undefined;
    const tracker = createReplySourceTracker([original], kind, undefined, readId);
    const replacement = { id: kind === 'missing' ? '' : kind === 'different-id' ? 'other' : 'accepted', textContent: kind === 'different-body' ? 'unseen old tools' : original.textContent };
    const nodes = kind === 'duplicate' ? [replacement, { ...replacement }] : [replacement];
    const next = { id: 'next', textContent: 'not witnessed output' };
    tracker.observe(nodes); tracker.observe([...nodes, next]);
    assert.notEqual(tracker.source(next), 'new', kind);
  }
});

it('尚未接纳的 DOM 节点被换成另一消息 ID 时不能继承新增资格', () => {
  const tail = { id: 'history', textContent: 'history tools' }, next = { id: 'new', textContent: 'unaccepted tools' };
  const readId = (node: object) => 'id' in node ? String(node.id) : undefined;
  const tracker = createReplySourceTracker([tail], 'session', undefined, readId);
  tracker.observe([tail, next]); assert.equal(tracker.source(next), 'new');
  next.id = 'another-history'; next.textContent = 'never mounted historical tools';
  tracker.observe([next]);
  assert.equal(tracker.source(next), 'unknown', '只有同条尚未接纳回复的补全可保留资格');
});

it('连续六十轮含尾部重挂载不重放旧批次且下一批仍获得新资格', () => {
  const readId = (node: object) => 'id' in node ? String(node.id) : undefined;
  let tail = { id: 'initial', textContent: 'initial history' };
  const tracker = createReplySourceTracker([tail], 'long-session', undefined, readId);
  for (let round = 1; round <= 60; round++) {
    if (round % 5 === 0) {
      tail = { ...tail }; tracker.observe([tail]);
      assert.equal(tracker.source(tail), 'history');
    }
    const next = { id: `message-${round}`, textContent: `completed tools ${round}` };
    tracker.observe([tail, next]); assert.equal(tracker.source(next), 'new');
    tracker.seal(next, tracker.key(next)); tail = next;
  }
});
