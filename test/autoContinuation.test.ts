import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ToolState, ToolResult } from '../src/shared/toolProtocol';
import { AutoContinuation } from '../src/main/tools/autoContinuation';
import { formatToolResults } from '../src/main/tools/resultClipboard';

const config = { permission: 'full' as const, automatic: true, dirtyPolicy: 'ask' as const, completionSound: false, autoCopyResults: true, sendIntervalSeconds: 3 };
const completed = (id = 1, tool: ToolResult['tool'] = 'read_file', status: ToolResult['status'] = 'done'): ToolState => ({
  config: { ...config }, busy: false, message: '', completion: { id, batch_id: 'batch-' + id, outcome: status === 'done' ? 'success' : 'error' },
  results: [{ batch_id: 'batch-' + id, request_id: 'request', tool, status, started_at: 10, finished_at: 20, data: { text: '<script>原样工具输出</script>' } }],
});
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture() {
  let context = { root: 'root' as string | null, session: 'chat', state: { config: { ...config }, busy: false, results: [], message: '' } as ToolState };
  const sent: Array<{ text: string; session: string }> = []; let cancelled = 0;
  let send: (text: string, session: string) => Promise<{ ok: boolean; error?: string; uncertain?: boolean }> = async (text, session) => { sent.push({ text, session }); return { ok: true }; };
  const owner = new AutoContinuation({ current: () => context, send: (text, session) => send(text, session), cancelSend: async () => { cancelled++; }, changed() {} });
  owner.observe(context);
  return { owner, sent, get cancellations() { return cancelled; }, setSend(fn: typeof send) { send = fn; },
    update(state: ToolState, scope?: { root: string | null; session: string }) { context = { ...context, ...scope, state }; owner.observe(context); },
    replaceScope(session: string) { context = { ...context, session }; },
  };
}
it('所有正式工具完成后按间隔发送当前整批，重复状态不发送第二次，下一轮继续', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 }); const f = fixture(); t.after(() => f.owner.dispose());
  const first = completed(); f.update(first); assert.equal(f.owner.getState().phase, 'countdown');
  t.mock.timers.tick(2999); await flush(); assert.equal(f.sent.length, 0);
  t.mock.timers.tick(1); await flush(); assert.deepEqual(f.sent, [{ text: formatToolResults(first.results), session: 'chat' }]);
  assert.equal(f.owner.getState().phase, 'waiting_reply'); f.update(first); t.mock.timers.tick(9000); await flush(); assert.equal(f.sent.length, 1);
  const second = completed(2, 'apply_changes', 'failed'); f.update(second); t.mock.timers.tick(3000); await flush();
  assert.equal(f.sent.length, 2); assert.equal(JSON.parse(f.sent[1]!.text).tool_results[0].status, 'failed', '实际失败结果也发送，让 AI 修复');
});
it('后台启动、权限等待及清理未结束不会作为完成结果发送', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  const running = completed(1, 'run_command'); running.results[0]!.data = { status: 'running' }; f.update(running);
  t.mock.timers.tick(10000); await flush(); assert.equal(f.sent.length, 0); assert.equal(f.owner.getState().phase, 'waiting_tools');
  running.results[0]!.data = { status: 'failed', cleanup_pending: true }; f.update(running); t.mock.timers.tick(10000); await flush(); assert.equal(f.sent.length, 0);
  running.results[0]!.data = { status: 'failed', exit_code: 1 }; f.update(running); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 1);
});
it('关闭取消本批发送，不取消工具或回滚结果；重开不发送已完成旧轮', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  const state = completed(); f.update(state); f.update({ ...state, config: { ...state.config, automatic: false } });
  assert.equal(f.owner.getState().phase, 'off'); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 0);
  assert.equal(state.results[0]!.status, 'done'); f.update(state); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 0);
  assert.equal(f.owner.getState().phase, 'waiting_user', '重新开启应反映运行状态，但不能复活旧发送');
  f.update(completed(2)); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 1);
});
it('纯对话、无实际执行、拒绝、中断、未知和 JSON 错误等待用户处理', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  f.update({ config, busy: false, results: [], message: '普通对话' }); assert.equal(f.owner.getState().phase, 'waiting_user');
  for (const [index, status] of ['permission_denied', 'cancelled', 'unknown'].entries()) {
    f.update(completed(index + 1, 'read_file', status as ToolResult['status'])); assert.equal(f.owner.getState().phase, 'paused');
    t.mock.timers.tick(3000); await flush();
  }
  const stopped = completed(4, 'run_command'); stopped.results[0]!.data = { status: 'stopped' }; f.update(stopped); assert.equal(f.owner.getState().phase, 'paused');
  const noExecution = completed(5); delete noExecution.results[0]!.started_at; f.update(noExecution); assert.equal(f.owner.getState().phase, 'waiting_user');
  f.update({ config, busy: false, results: [], message: '', batchError: { status: 'failed', error: 'invalid JSON' } }); assert.equal(f.owner.getState().phase, 'paused');
  t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 0);
});
it('切换项目、会话、批次或用户主动发送都取消旧结果；计时结束再次核验 scope', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  f.update(completed()); f.replaceScope('new-chat'); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 0);
  f.update(completed(2)); f.owner.userTurn(); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 0);
  f.update(completed(3)); f.update({ config, busy: true, results: [], message: '' }, { root: 'new-root', session: 'other-chat' });
  t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 0);
});
it('初始化历史完成状态和重绘不会自动发送', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const historical = completed(); let sent = 0;
  const owner = new AutoContinuation({ current: () => ({ root: 'r', session: 's', state: historical }), send: async () => { sent++; return { ok: true }; }, cancelSend: async () => {}, changed() {} }); t.after(() => owner.dispose());
  owner.observe({ root: 'r', session: 's', state: historical }); t.mock.timers.tick(10000); await flush(); assert.equal(sent, 0);
});
it('发送无法确认或失败只尝试一次，关闭期间迟到成功不重启循环', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose()); let tries = 0;
  f.setSend(async () => { tries++; return { ok: false, uncertain: true, error: 'timeout' }; }); f.update(completed());
  t.mock.timers.tick(3000); await flush(); assert.equal(f.owner.getState().phase, 'paused'); assert.match(f.owner.getState().message, /不会重复/);
  f.update(completed()); t.mock.timers.tick(10000); await flush(); assert.equal(tries, 1);
  let finish!: (result: { ok: boolean }) => void; f.setSend(() => new Promise(resolve => { finish = resolve; }));
  const next = completed(2); f.update(next); t.mock.timers.tick(3000); await flush(); assert.equal(f.owner.getState().phase, 'sending');
  f.update({ ...next, config: { ...config, automatic: false } }); finish({ ok: true }); await flush(); assert.equal(f.owner.getState().phase, 'off');
});
it('倒计时途中取消当前批次，不能仍把已完成结果自动发送', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  const state = completed(); f.update(state); assert.equal(f.owner.getState().phase, 'countdown');
  f.update({ ...state, completion: { ...state.completion!, cancelled: true } });
  t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 0); assert.equal(f.owner.getState().phase, 'paused');
});
it('发送间隔修改更新本批倒计时，无需轮次计数或固定轮询', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 }); const f = fixture(); t.after(() => f.owner.dispose());
  const state = completed(); f.update(state); t.mock.timers.tick(1000); f.update({ ...state, config: { ...config, sendIntervalSeconds: 1 } });
  assert.equal(f.owner.getState().dueAt, 2100); t.mock.timers.tick(999); await flush(); assert.equal(f.sent.length, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(f.sent.length, 1);
});
