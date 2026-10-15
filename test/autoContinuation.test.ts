import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ToolState, ToolResult } from '../src/shared/toolProtocol';
import { AutoContinuation } from '../src/main/tools/autoContinuation';
import { formatToolResults } from '../src/main/tools/resultClipboard';
import type { ToolDiagnostic } from '../src/main/tools/harness';
import type { WebSendResult } from '../src/main/webComposerSender';

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
  let send: (text: string, session: string) => Promise<WebSendResult> = async (text, session) => { sent.push({ text, session }); return { ok: true }; };
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
const pendingPreflight = (): WebSendResult => ({ ok: false, error: '网页回复暂未确认结束', retryable: true, transportStarted: false, stage: 'preflight' });

it('无运输的临时预检按退避复核同批，恢复后只运输一次', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  let checked = 0; const bodies: string[] = [];
  f.setSend(async (text, session) => {
    bodies.push(text); checked++;
    if (checked < 3) return pendingPreflight();
    f.sent.push({ text, session }); return { ok: true, transportStarted: true };
  });
  const state = completed(); f.update(state);
  t.mock.timers.tick(3000); await flush(); assert.equal(checked, 1); assert.equal(f.sent.length, 0);
  t.mock.timers.tick(999); await flush(); assert.equal(checked, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(checked, 2);
  f.update(state); t.mock.timers.tick(2999); await flush(); assert.equal(checked, 2, '重复广播不提前重试');
  t.mock.timers.tick(1); await flush(); assert.equal(checked, 3); assert.equal(f.sent.length, 1);
  assert.equal(f.owner.getState().phase, 'waiting_reply');
  assert.deepEqual([...new Set(bodies)], [formatToolResults(state.results)]);
  f.update(state); t.mock.timers.tick(10000); await flush(); assert.equal(checked, 3);
});

it('预检最多额外复核三次，达到上限后重复广播及重开不复活旧批', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  let checked = 0; f.setSend(async () => { checked++; return pendingPreflight(); });
  const state = completed(); f.update(state);
  for (const delay of [3000, 1000, 3000, 5000]) { t.mock.timers.tick(delay); await flush(); }
  assert.equal(checked, 4); assert.equal(f.owner.getState().phase, 'paused'); assert.match(f.owner.getState().message, /复核已达上限/);
  f.update(state); f.update({ ...state, config: { ...config, automatic: false } }); f.update(state);
  t.mock.timers.tick(100000); await flush(); assert.equal(checked, 4); assert.equal(f.sent.length, 0);
});

it('退避期间关闭、用户中断、新轮、会话或正文变化均撤销旧批复核', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const scenario of ['off', 'interrupted', 'turn', 'session', 'body'] as const) {
    const f = fixture(); let checked = 0; f.setSend(async () => { checked++; return pendingPreflight(); });
    const state = completed(); f.update(state); t.mock.timers.tick(3000); await flush(); assert.equal(checked, 1);
    if (scenario === 'off') f.update({ ...state, config: { ...config, automatic: false } });
    if (scenario === 'interrupted') { state.userInterrupted = true; f.update(state); }
    if (scenario === 'turn') f.owner.userTurn();
    if (scenario === 'session') f.update(state, { root: 'root', session: 'other' });
    if (scenario === 'body') { state.results[0]!.data = 'changed'; f.update(state); }
    t.mock.timers.tick(10000); await flush(); assert.equal(checked, 1, scenario); assert.equal(f.sent.length, 0);
    f.owner.dispose();
  }
});

it('预检复核不消耗也不重置连续五次诊断运输额度', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  let checked = 0; f.setSend(async (text, session) => {
    checked++;
    if (checked % 2) return pendingPreflight();
    f.sent.push({ text, session }); return { ok: true, transportStarted: true };
  });
  for (let index = 0; index < 6; index++) {
    f.update({ config, busy: false, results: [], message: '', batchError: { status: 'failed', error: 'invalid-' + index } });
    t.mock.timers.tick(3000); await flush(); t.mock.timers.tick(1000); await flush();
  }
  assert.equal(checked, 10); assert.equal(f.sent.length, 5); assert.equal(f.owner.getState().phase, 'paused');
  assert.match(f.owner.getState().message, /连续 5 次/);
});

it('终止于预检且尚未运输的诊断失败同样不占用回传额度', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  let checked = 0;
  f.setSend(async (text, session) => {
    checked++;
    if (checked === 5) return { ok: false, error: '当前来源已失效', transportStarted: false, stage: 'preflight' };
    f.sent.push({ text, session }); return { ok: true, transportStarted: true };
  });
  for (let index = 0; index < 7; index++) {
    f.update({ config, busy: false, results: [], message: '', batchError: { status: 'failed', error: 'invalid-' + index } });
    t.mock.timers.tick(3000); await flush();
  }
  assert.equal(checked, 6); assert.equal(f.sent.length, 5); assert.match(f.owner.getState().message, /连续 5 次/);
});

it('正常结果清零后迟到的旧预检不倒扣额度，后续仍严格限制五次', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  let finish!: (result: WebSendResult) => void; let first = true;
  f.setSend(async (text, session) => {
    if (first) { first = false; return new Promise(resolve => { finish = resolve; }); }
    f.sent.push({ text, session }); return { ok: true, transportStarted: true };
  });
  f.update({ config, busy: false, results: [], message: '', batchError: { status: 'failed', error: 'old' } });
  t.mock.timers.tick(3000); await flush();
  f.update(completed()); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 1);
  finish(pendingPreflight()); await flush();
  for (let index = 0; index < 6; index++) {
    f.update({ config, busy: false, results: [], message: '', batchError: { status: 'failed', error: 'invalid-' + index } });
    t.mock.timers.tick(3000); await flush();
  }
  assert.equal(f.sent.length, 6, '一个正常结果与五次诊断；旧预检不能制造第六次额度');
  assert.match(f.owner.getState().message, /连续 5 次/);
});

it('已开始运输或未知状态即使携带retryable也绝不重新发送', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const result of [
    { ...pendingPreflight(), transportStarted: true },
    { ...pendingPreflight(), uncertain: true },
    { ...pendingPreflight(), stage: 'clicked' as const },
  ]) {
    const f = fixture(); let checked = 0; f.setSend(async () => { checked++; return result; });
    const state = completed(); f.update(state); t.mock.timers.tick(3000); await flush();
    f.update(state); t.mock.timers.tick(100000); await flush(); assert.equal(checked, 1); assert.equal(f.owner.getState().phase, 'paused');
    f.owner.dispose();
  }
});
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
it('纯对话、无实际执行、普通取消、未知和未确认结束的停止仍等待用户处理', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  f.update({ config, busy: false, results: [], message: '普通对话' }); assert.equal(f.owner.getState().phase, 'waiting_user');
  for (const [index, status] of ['cancelled', 'unknown'].entries()) {
    f.update(completed(index + 1, 'read_file', status as ToolResult['status'])); assert.equal(f.owner.getState().phase, 'paused');
    t.mock.timers.tick(3000); await flush();
  }
  const stopped = completed(4, 'run_command'); stopped.results[0]!.data = { status: 'stopped' }; delete stopped.results[0]!.finished_at; f.update(stopped); assert.equal(f.owner.getState().phase, 'paused');
  const noExecution = completed(5); delete noExecution.results[0]!.started_at; f.update(noExecution); assert.equal(f.owner.getState().phase, 'waiting_user');
  t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 0);
});
it('超时及工具停止可回传真实部分输出一次，整批取消仍阻断', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const status of ['failed', 'cancelled', 'done'] as const) {
    const f = fixture(); t.after(() => f.owner.dispose());
    const state = completed(1, 'run_command', status);
    state.results[0]!.data = { status: 'stopped', timed_out: status === 'failed', cleanup_pending: false, stdout: 'before-stop', exit_code: 1 };
    f.update(state); assert.equal(f.owner.getState().phase, 'countdown', status);
    t.mock.timers.tick(3000); await flush();
    assert.deepEqual(f.sent, [{ text: formatToolResults(state.results), session: 'chat' }]);
    f.update(state); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 1);
    const cancelled = completed(2, 'run_command', status); cancelled.results[0]!.data = state.results[0]!.data;
    cancelled.completion!.cancelled = true; f.update(cancelled);
    t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 1); assert.equal(f.owner.getState().phase, 'paused');
  }
});
it('用户中断立即取消倒计时，清理与结束或重新开启都不补发，下一批继续', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  const state = completed(); f.update(state);
  assert.equal(f.owner.getState().phase, 'countdown');
  const cancellations = f.cancellations;
  state.userInterrupted = true; state.busy = true;
  f.update(state);
  assert.equal(f.owner.getState().phase, 'paused');
  assert.match(f.owner.getState().message, /用户已中断.*仍可复制/);
  assert.ok(f.cancellations > cancellations);
  t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 0);
  state.busy = false; f.update(state);
  f.update({ ...state, config: { ...config, automatic: false } });
  f.update(state); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 0);
  f.update(completed(2)); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 1);
});
it('全批权限拒绝及依赖跳过回传未执行事实，普通依赖跳过不产生发送资格', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  const denied = completed(1, 'run_command', 'permission_denied');
  delete denied.results[0]!.started_at; delete denied.results[0]!.finished_at; delete denied.results[0]!.data;
  denied.results[0]!.error = '权限拒绝；工具未执行';
  denied.results.push({ batch_id: 'batch-1', request_id: 'dependent', tool: 'read_file', status: 'skipped_dependency', error: '前置请求被拒绝' });
  f.update(denied); assert.equal(f.owner.getState().phase, 'countdown');
  t.mock.timers.tick(3000); await flush(); assert.equal(f.sent[0]!.text, formatToolResults(denied.results));
  const skipped = completed(2, 'read_file', 'skipped_dependency'); delete skipped.results[0]!.started_at;
  f.update(skipped); t.mock.timers.tick(3000); await flush(); assert.equal(f.sent.length, 1); assert.equal(f.owner.getState().phase, 'waiting_user');
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

it('手动解析诊断来源阻断自动计时，状态省略 source 也不回传，随后官网新批正常发送', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state: ToolState = { config: { ...config }, busy: false, results: [], message: '', batchError: { status: 'failed', error: 'bad json' } };
  const context = { root: 'root', session: 'chat', state, diagnostic: null as ToolDiagnostic | null }; const sent: string[] = [];
  const owner = new AutoContinuation({ current: () => context, changed() {}, cancelSend: async () => {}, send: async text => { sent.push(text); return { ok: true }; } });
  t.after(() => owner.dispose()); owner.observe(context);
  context.diagnostic = { id: 1, source: 'manual', root: 'root', session: 'chat', sourceText: '{bad', error: state.batchError! };
  owner.observe(context); assert.equal(owner.getState().phase, 'paused'); t.mock.timers.tick(9000); await flush(); assert.equal(sent.length, 0);
  context.state = { ...state, config: { ...config, automatic: false } }; owner.observe(context);
  context.state = state; owner.observe(context); t.mock.timers.tick(9000); await flush(); assert.equal(sent.length, 0);
  context.state = completed(1); context.diagnostic = null; owner.observe(context); t.mock.timers.tick(3000); await flush(); assert.equal(sent.length, 1);
});


it('旧取消阻断显示本批未发送，不循环重试，后续新批可在运输恢复后继续', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture(); t.after(() => f.owner.dispose());
  let calls = 0;
  f.setSend(async () => { calls++; return { ok: false, error: '上次取消未确认', transportStarted: false, stage: 'preflight', blockedByPreviousCancellation: true } as WebSendResult; });
  const first = completed(); f.update(first); t.mock.timers.tick(3000); await flush();
  assert.equal(f.owner.getState().phase, 'paused'); assert.match(f.owner.getState().message, /^本批未发送：/);
  f.update(first); t.mock.timers.tick(10000); await flush(); assert.equal(calls, 1);
  f.setSend(async () => { calls++; return { ok: true, transportStarted: true }; });
  f.update(completed(2)); t.mock.timers.tick(3000); await flush();
  assert.equal(calls, 2); assert.equal(f.owner.getState().phase, 'waiting_reply');
});
