import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as vm from 'node:vm';
import { createReplySourceTracker } from '../src/main/tools/replySource';

const reply = (textContent: string) => ({ textContent });

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
