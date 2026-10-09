import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ToolState, ToolResult } from '../src/shared/toolProtocol';
import { AutoContinuation } from '../src/main/tools/autoContinuation';
import { formatToolResults } from '../src/main/tools/resultClipboard';
import type { ToolDiagnostic } from '../src/main/tools/harness';

const config = { permission: 'full' as const, automatic: true, dirtyPolicy: 'ask' as const, completionSound: false, autoCopyResults: true, sendIntervalSeconds: 3 };
const completed = (id = 1, tool: ToolResult['tool'] = 'read_file', status: ToolResult['status'] = 'done'): ToolState => ({
  config: { ...config }, busy: false, message: '', completion: { id, batch_id: 'batch-' + id, outcome: status === 'done' ? 'success' : 'error' },
  results: [{ batch_id: 'batch-' + id, request_id: 'request', tool, status, started_at: 10, finished_at: 20, data: { text: '<script>原样工具输出</script>' } }],
});
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture() {
  let context = { root: 'root' as string | null, session: 'chat', state: { config: { ...config }, busy: false, results: [], message: '' } as ToolState, diagnostic: null as ToolDiagnostic | null };
  let diagnosticId = 0; const diagnostics = new WeakMap<ToolState, ToolDiagnostic>();
  const sent: Array<{ text: string; session: string }> = []; let cancelled = 0;
  let send: (text: string, session: string) => Promise<{ ok: boolean; error?: string; uncertain?: boolean }> = async (text, session) => { sent.push({ text, session }); return { ok: true }; };
  const owner = new AutoContinuation({ current: () => context, send: (text, session) => send(text, session), cancelSend: async () => { cancelled++; }, changed() {} });
  owner.observe(context);
  return { owner, sent, get cancellations() { return cancelled; }, setSend(fn: typeof send) { send = fn; },
    update(state: ToolState, scope?: { root: string | null; session: string }) {
      context = { ...context, ...scope, state, diagnostic: null };
      if (state.batchError) {
        let diagnostic = diagnostics.get(state);
        if (!diagnostic) {
          diagnostic = { id: ++diagnosticId, root: context.root, session: context.session, sourceText: 'reply-' + diagnosticId, error: state.batchError };
          diagnostics.set(state, diagnostic);
        }
        context.diagnostic = diagnostic;
      }
      owner.observe(context);
    },
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
it('纯对话、无实际执行、拒绝、中断、未知和停止等待用户处理', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  f.update({ config, busy: false, results: [], message: '普通对话' }); assert.equal(f.owner.getState().phase, 'waiting_user');
  for (const [index, status] of ['permission_denied', 'cancelled', 'unknown'].entries()) {
    f.update(completed(index + 1, 'read_file', status as ToolResult['status'])); assert.equal(f.owner.getState().phase, 'paused');
    t.mock.timers.tick(3000); await flush();
  }
  const stopped = completed(4, 'run_command'); stopped.results[0]!.data = { status: 'stopped' }; f.update(stopped); assert.equal(f.owner.getState().phase, 'paused');
  const noExecution = completed(5); delete noExecution.results[0]!.started_at; f.update(noExecution); assert.equal(f.owner.getState().phase, 'waiting_user');
  t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 0);
});
it('解析层格式错误也自动发送，正文与复制结果同源', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 }); const f = fixture(); t.after(() => f.owner.dispose());
  const batchError = { status: 'failed' as const, error: '工具 JSON 无效，本批工具未执行。SyntaxError: ... position 16453 (line 1 column 16454)' };
  f.update({ config, busy: false, results: [], message: '', batchError }); assert.equal(f.owner.getState().phase, 'countdown');
  t.mock.timers.tick(3000); await flush();
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0], { text: formatToolResults([], batchError), session: 'chat' });
});
it('连续 5 次格式错误后停止自动发送', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 }); const f = fixture(); t.after(() => f.owner.dispose());
  for (let i = 1; i <= 5; i++) {
    const batchError = { status: 'failed' as const, error: 'invalid JSON #' + i };
    f.update({ config, busy: false, results: [], message: '', batchError });
    t.mock.timers.tick(3000); await flush();
    if (i < 5) assert.equal(f.owner.getState().phase, 'waiting_reply', '第 ' + i + ' 次应发送');
  }
  assert.equal(f.sent.length, 5, '前 5 次格式错误都发送');
  f.update({ config, busy: false, results: [], message: '', batchError: { status: 'failed' as const, error: 'invalid JSON #6' } });
  assert.equal(f.owner.getState().phase, 'paused', '第 6 次应暂停');
  t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 5);
});
it('正常工具结果发送后连续计数归零', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 }); const f = fixture(); t.after(() => f.owner.dispose());
  for (let i = 1; i <= 3; i++) { f.update({ config, busy: false, results: [], message: '', batchError: { status: 'failed' as const, error: 'invalid JSON #' + i } }); t.mock.timers.tick(3000); await flush(); }
  assert.equal(f.sent.length, 3);
  f.update(completed(4)); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 4, '正常结果发送，计数归零');
  for (let i = 5; i <= 8; i++) { f.update({ config, busy: false, results: [], message: '', batchError: { status: 'failed' as const, error: 'invalid JSON #' + i } }); t.mock.timers.tick(3000); await flush(); }
  assert.equal(f.sent.length, 8, '归零后又能发 4 次');
});
it('正常结果取消倒计时、失败或未知运输均不能清空连续诊断计数', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const scenario of ['cancel-countdown', 'failure', 'unknown'] as const) {
    const f = fixture(); t.after(() => f.owner.dispose());
    for (let i = 1; i <= 5; i++) {
      f.update({ config, busy: false, results: [], message: '', batchError: { status: 'failed', error: 'same diagnostic' } });
      t.mock.timers.tick(3000); await flush();
    }
    f.setSend(async () => ({ ok: false, ...(scenario === 'unknown' ? { uncertain: true } : {}), error: 'failed' }));
    f.update(completed());
    if (scenario === 'cancel-countdown') f.owner.userTurn(); else { t.mock.timers.tick(3000); await flush(); }
    f.update({ config, busy: false, results: [], message: '', batchError: { status: 'failed', error: 'next diagnostic' } });
    assert.equal(f.owner.getState().phase, 'paused', scenario); assert.match(f.owner.getState().message, /连续 5 次/);
    t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 5);
  }
});
it('诊断按来源 ID 去重且关闭或取消的旧诊断不复活，未发送的倒计时不占用额度', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  const state: ToolState = { config, busy: false, results: [], message: '', batchError: { status: 'failed', error: 'same error' } };
  f.update(state); f.update(state); assert.equal(f.owner.getState().phase, 'countdown');
  f.owner.userTurn(); f.update(state); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 0);
  f.update(state); assert.equal(f.owner.getState().phase, 'waiting_reply');
  for (let i = 1; i <= 5; i++) {
    f.owner.reset({ root: 'root', session: 'chat' }); f.update({ ...state }); t.mock.timers.tick(3000); await flush();
    assert.equal(f.sent.length, i, '批次 reset 不能清零；不同来源即使正文相同仍算新诊断');
  }
  f.owner.reset({ root: 'root', session: 'chat' }); const sixth = { ...state }; f.update(sixth); assert.equal(f.owner.getState().phase, 'paused');
  f.update(sixth); assert.equal(f.owner.getState().phase, 'paused', '广播不能覆盖上限暂停');
  const off = { ...state, config: { ...config, automatic: false } }; f.update(off);
  off.config.automatic = true; f.update(off); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 5);
});
it('解析诊断发送失败或未知后保持暂停且重复广播不重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const uncertain of [false, true]) {
    const f = fixture(); t.after(() => f.owner.dispose()); let tries = 0;
    f.setSend(async () => { tries++; return { ok: false, uncertain, error: 'failed' }; });
    const state: ToolState = { config, busy: false, results: [], message: '', batchError: { status: 'failed', error: 'bad JSON' } };
    f.update(state); t.mock.timers.tick(3000); await flush(); assert.equal(f.owner.getState().phase, 'paused');
    f.update(state); t.mock.timers.tick(3000); await flush(); assert.equal(f.owner.getState().phase, 'paused'); assert.equal(tries, 1);
  }
});
it('scope 往返切换即使中间没有结果广播也清零，相同 scope 的 reset 不清零', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const scenario of ['session', 'root'] as const) {
    const f = fixture(); t.after(() => f.owner.dispose());
    const state: ToolState = { config, busy: false, results: [], message: '', batchError: { status: 'failed', error: 'same error' } };
    for (let i = 1; i <= 5; i++) { f.update({ ...state }); t.mock.timers.tick(3000); await flush(); }
    f.owner.reset({ root: 'root', session: 'chat' }); f.update({ ...state }); assert.equal(f.owner.getState().phase, 'paused');
    f.owner.reset(scenario === 'session' ? { root: 'root', session: 'other' } : { root: 'other', session: 'chat' });
    f.owner.reset({ root: 'root', session: 'chat' });
    f.update({ ...state }); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 6, scenario);
  }
});
it('初始化已有解析诊断或仅有 batchError 无来源时不自动发送', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state: ToolState = { config, busy: false, results: [], message: '', batchError: { status: 'failed', error: 'bad JSON' } };
  for (const diagnostic of [null, { id: 1, root: 'root', session: 'chat', sourceText: 'bad', error: state.batchError! }]) {
    let sent = 0; const context = { root: 'root', session: 'chat', state, diagnostic };
    const owner = new AutoContinuation({ current: () => context, send: async () => { sent++; return { ok: true }; }, cancelSend: async () => {}, changed() {} });
    t.after(() => owner.dispose()); owner.observe(context); t.mock.timers.tick(3000); await flush(); assert.equal(sent, 0);
  }
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
