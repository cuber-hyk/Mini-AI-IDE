import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { it } from 'node:test';

function fixture() {
  const context: any = { window: {} };
  vm.runInNewContext(fs.readFileSync('src/renderer/toolAttention.js', 'utf8'), context);
  const owner = context.window.createToolAttention();
  return (state: any, baseline = false): any[] => JSON.parse(JSON.stringify(owner.receive({ results: [], ...state }, baseline)));
}
const request = { batch_id: 'one', request_id: 'write', tool: 'apply_changes', status: 'running' };

it('普通进度和成功不抢标签，历史初始化与重复失败广播不重新打开', () => {
  const receive = fixture();
  assert.equal(receive({ results: [{ ...request, status: 'failed' }] }, true).length, 0);
  assert.equal(receive({ results: [{ ...request, status: 'failed', error: '详细原因更新' }] }).length, 0);
  assert.equal(receive({ results: [{ ...request, batch_id: 'two' }] }).length, 0);
  assert.equal(receive({ results: [{ ...request, batch_id: 'two', status: 'done' }] }).length, 0);
});

it('真实新批次打开一次，同批刷新及间隔的历史恢复不重放打开事件', () => {
  const receive = fixture(); receive({}, true);
  const batchStart = { id: 1, batch_id: 'one' };
  assert.equal(receive({ batchStart })[0].kind, 'batch', '首个结果产生前即可打开');
  assert.equal(receive({ batchStart, results: [request] }).length, 0);
  assert.equal(receive({ batchStart, results: [{ ...request, status: 'done' }] }).length, 0);
  receive({ restored: true, results: [request], canUndo: true });
  assert.equal(receive({ batchStart }).length, 0, '重复旧批次不重新打开');
  assert.equal(receive({ batchStart: { id: 2, batch_id: 'one' } })[0].kind, 'batch', '另一会话同名真实批次仍打开');
});

it('初始查询只建立批次基线，新批次异常优先定位对应工具', () => {
  const receive = fixture(); const batchStart = { id: 8, batch_id: 'one' };
  assert.equal(receive({ batchStart }, true).length, 0);
  assert.equal(receive({ batchStart }).length, 0);
  const fresh = receive({ batchStart: { id: 9, batch_id: 'two' }, results: [{ ...request, batch_id: 'two', status: 'pending_permission' }] });
  assert.equal(fresh[0].key, JSON.stringify(['two', 'write']));
  assert.equal(fresh[1].kind, 'batch');
});

it('运行中重新采集的历史失败只更新基线，新执行仍可提醒', () => {
  const receive = fixture(); receive({}, true);
  assert.equal(receive({ restored: true, results: [{ ...request, status: 'failed' }] }).length, 0);
  assert.equal(receive({ restored: true, results: [{ ...request, status: 'failed' }], canUndo: true }).length, 0);
  assert.equal(receive({ results: [{ ...request, batch_id: 'fresh', status: 'failed' }] }).length, 1);
});

it('批准和失败是独立事件，同批新请求或新批异常可再次打开', () => {
  const receive = fixture();
  receive({}, true);
  const pending = { results: [{ ...request, status: 'pending_permission' }] };
  assert.equal(receive(pending)[0].key, JSON.stringify(['one', 'write']));
  assert.equal(receive(pending).length, 0, '用户关闭后普通状态刷新不能重新打开');
  const failed = { results: [{ ...request, status: 'failed' }] };
  assert.equal(receive(failed).length, 1, '批准之后执行失败需要展示新事件');
  assert.equal(receive(failed).length, 0);
  assert.equal(receive({ results: [...failed.results, { ...request, request_id: 'another', status: 'failed' }] }).length, 1);
  assert.equal(receive({ results: [{ ...request, batch_id: 'two', status: 'failed' }] }).length, 1);
});

it('回传暂停自动打开且去重，正常等待用户/回复不会抢标签，新暂停可以再次出现', () => {
  const receive = fixture(); receive({}, true);
  const paused = { continuation: { phase: 'paused', message: '官网已有草稿' } };
  assert.equal(receive(paused).length, 1); assert.equal(receive(paused).length, 0);
  assert.equal(receive({ continuation: { phase: 'waiting_user', message: '等待补充需求' } }).length, 0);
  assert.equal(receive({ continuation: { phase: 'waiting_reply' } }).length, 0);
  assert.equal(receive(paused).length, 1, '恢复后再次暂停属于新的事件');
  assert.equal(receive({ resultReturn: { phase: 'paused', message: '上传无法确认' } }).length, 0, '同一暂停连续由两个 owner 广播仍是一个事件');
  receive({});
  assert.equal(receive({ resultReturn: { phase: 'paused', message: '上传无法确认' } }).length, 1);
});

it('手动回传失败随后通知自动继续暂停，只打开一次且新批暂停仍提醒', () => {
  const receive = fixture(); receive({}, true);
  const state = { completion: { id: 7 }, results: [request], resultReturn: { phase: 'paused', message: '官网已有草稿' } };
  assert.equal(receive(state).length, 1);
  assert.equal(receive({ ...state, continuation: { phase: 'paused', message: '自动发送暂停：官网已有输入' } }).length, 0);
  assert.equal(receive({ ...state, completion: { id: 8 } }).length, 1);
});

it('用户主动开始新一轮使旧结果失效，空工具或已发送旧批都不抢标签', () => {
  const receive = fixture(); receive({}, true);
  const resultReturn = { phase: 'invalidated', message: '已发起新一轮，旧批结果与附件不再发送' };
  assert.equal(receive({ resultReturn }).length, 0);
  receive({ results: [{ ...request, status: 'done' }], resultReturn: { phase: 'sent' } });
  assert.equal(receive({ results: [{ ...request, status: 'done' }], resultReturn }).length, 0);
});

it('运行中后台命令的真实失败会打开，用户主动中断不误报执行失败', () => {
  const receive = fixture(); receive({}, true);
  const command = { ...request, tool: 'run_command', status: 'done' };
  assert.equal(receive({ results: [{ ...command, data: { status: 'running' } }] }).length, 0);
  assert.equal(receive({ results: [{ ...command, data: { status: 'stopped' } }] }).length, 0);
  assert.equal(receive({ results: [{ ...command, data: { status: 'stopped', timed_out: true } }] }).length, 1);
});

it('无可信请求身份的批次错误不伪造工具目标，连续同文案不重复打开', () => {
  const receive = fixture(); receive({}, true);
  const error = { batchError: { status: 'failed', error: 'JSON 未闭合' } };
  assert.equal(receive(error)[0].key, 'batch-error'); assert.equal(receive(error).length, 0);
  receive({}); assert.equal(receive(error).length, 1);
});
