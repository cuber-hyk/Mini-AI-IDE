import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ChangeReviewOwner, type ToolChangeEvent } from '../src/main/tools/changeReview';
import type { ToolBatch } from '../src/shared/toolProtocol';

const scope = { root: 'C:/project', session: 'chat', batchId: 'batch', contentKey: 'contents' };
const applied: ToolChangeEvent = { id: 'edit:0', requestId: 'edit', path: 'src/a.ts', operation: 'replace', status: 'applied', before: 'A\nunchanged\n', after: 'C\nunchanged\n' };
const batch: ToolBatch = { protocol_version: 1, batch_id: 'batch', requests: [{ id: 'edit', tool: 'apply_changes', args: { changes: [{ path: 'src/a.ts', operation: 'replace', edits: [{ old_string: 'A', new_string: 'C' }] }] } }] };

it('当前批次捕获实际差异，重复采集保留快照，消费者不能改写内存证据', () => {
  const review = new ChangeReviewOwner(); const token = review.begin(scope, batch);
  assert.equal('edits' in review.getState().records[0]!, false);
  review.record(token, applied);
  const state = review.getState(); assert.equal(state.records[0]?.diff?.added, 1); assert.equal(state.records[0]?.diff?.removed, 1);
  state.records[0]!.after = 'external mutation'; state.records[0]!.diff!.hunks[0]!.lines[0]!.text = 'mutated';
  assert.equal(review.begin({ ...scope }, batch), token); assert.equal(review.getState().records[0]?.after, applied.after);
  assert.notEqual(review.getState().records[0]?.diff?.hunks[0]?.lines[0]?.text, 'mutated');
});
it('项目、对话、同ID不同内容切换均清理，迟到执行或旧撤销不能污染当前批次', () => {
  const review = new ChangeReviewOwner(); let token = review.begin(scope, batch); review.record(token, applied);
  for (const next of [{ ...scope, root: 'C:/next' }, { ...scope, session: 'other' }, { ...scope, contentKey: 'new-contents' }]) {
    const old = token; token = review.begin(next, batch);
    review.record(old, applied); review.record(old, { ...applied, status: 'undone' });
    assert.equal(review.getState().records[0]?.status, 'pending'); assert.equal(review.getState().records[0]?.before, undefined);
  }
  review.clear(); review.record(token, applied); assert.equal(review.getState().scope, null); assert.deepEqual(review.getState().records, []);
});
it('拒绝和依赖跳过以未执行显示，失败不伪造前后文，真实成功与撤销不会被请求汇总覆盖', () => {
  const review = new ChangeReviewOwner(); const token = review.begin(scope, batch);
  review.updateResults([{ batch_id: 'batch', request_id: 'edit', tool: 'apply_changes', status: 'permission_denied', error: '权限拒绝' }]);
  assert.equal(review.getState().records[0]?.status, 'skipped'); assert.equal(review.getState().records[0]?.error, '权限拒绝');
  assert.equal(review.getState().records[0]?.diff, undefined);
  const second = review.begin({ ...scope, contentKey: 'second' }, batch); review.record(second, applied);
  review.updateResults([{ batch_id: 'batch', request_id: 'edit', tool: 'apply_changes', status: 'failed', error: '后续文件失败' }]);
  assert.equal(review.getState().records[0]?.status, 'applied');
  review.record(second, { ...applied, status: 'undone' }); assert.equal(review.getState().records[0]?.status, 'undone');
  assert.equal(review.getState().records[0]?.before, 'A\nunchanged\n');
  assert.equal(token < second, true);
});
it('旧账本成功不生成新快照；未知批次结果不能结束本批等待项', () => {
  const review = new ChangeReviewOwner(); review.begin(scope, batch);
  review.updateResults([{ batch_id: 'old', request_id: 'edit', tool: 'apply_changes', status: 'failed' }]);
  assert.equal(review.getState().records[0]?.status, 'pending');
  review.updateResults([{ batch_id: 'batch', request_id: 'edit', tool: 'apply_changes', status: 'done' }]);
  assert.equal(review.getState().records[0]?.status, 'skipped'); assert.match(review.getState().records[0]?.error || '', /未产生当前执行快照/);
});
