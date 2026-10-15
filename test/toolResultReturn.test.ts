import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ToolResultReturn } from '../src/main/tools/resultReturn';
import type { ToolState } from '../src/shared/toolProtocol';
import type { WebSendResult } from '../src/main/webComposerSender';
import type { ToolDiagnostic } from '../src/main/tools/harness';
import { formatToolResults } from '../src/main/tools/resultClipboard';

function fixture(automatic = false) {
  const selection = { root: 'root', session: 'chat', batch: { protocol_version: 1 as const, batch_id: 'batch', requests: [{ id: 'file', tool: 'attach_file' as const, args: { path: 'figure.png' } }] } };
  const state: ToolState = { config: { permission: 'full', automatic, dirtyPolicy: 'ask', completionSound: false, autoCopyResults: true, sendIntervalSeconds: 0 },
    busy: false, message: '', completion: { id: 1, batch_id: 'batch', outcome: 'success' }, results: [{ batch_id: 'batch', request_id: 'file', tool: 'attach_file', status: 'done', started_at: 1, data: { id: 'owned', name: 'figure.png' } }] };
  const context = { root: 'root', session: 'chat', state, diagnostic: null as ToolDiagnostic | null }; const sent: unknown[][] = [];
  let verify: () => Promise<WebSendResult> = async () => ({ ok: true });
  let transport: () => Promise<WebSendResult> = async () => ({ ok: true });
  let resolved = 0;
  const file = { id: 'owned', name: 'figure.png', size: 1, mediaType: 'image/png', async *stream() { yield new Uint8Array([1]); } };
  const owner = new ToolResultReturn({ current: () => context, verify: () => verify(), attachments: async () => { resolved++; return [file]; },
    send: async (...args) => { sent.push(args); return transport(); }, changed() {} });
  owner.begin({ kind: 'batch', selection });
  return { owner, context, selection, file, sent, get resolved() { return resolved; }, setVerify(fn: typeof verify) { verify = fn; }, setTransport(fn: typeof transport) { transport = fn; } };
}

it('结果发送完成或暂停都保留原网页草稿备份位置供用户恢复', async () => {
  for (const ok of [true, false]) {
    const f = fixture(true);
    f.setTransport(async () => ({ ok, ...(ok ? {} : { error: 'input changed' }), draftBackupPath: '/project/.mini-ai-ide/composer-drafts/one.txt' }));
    const result = await f.owner.send('automatic'); assert.equal(result.ok, ok);
    assert.match(f.owner.getState(f.context).message, /原网页草稿已备份：\/project/);
    assert.equal((await f.owner.send('automatic')).ok, false);
  }
});

it('当前完整真实批次手动发送正文及字节流一次，自动与手动入口互斥', async () => {
  const f = fixture(); assert.equal(f.owner.getState(f.context).canSend, true);
  assert.equal((await f.owner.send('automatic')).ok, false);
  assert.equal((await f.owner.send('manual')).ok, true);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0]![3], [f.file]);
  assert.equal(JSON.parse(f.sent[0]![0] as string).tool_results[0].data.name, 'figure.png');
  assert.equal(f.owner.getState(f.context).phase, 'sent'); assert.equal(f.owner.getState(f.context).canSend, false);
  f.context.state.config.automatic = true;
  assert.equal((await f.owner.send('automatic')).ok, false); assert.equal(f.sent.length, 1);
  const automatic = fixture(true); assert.equal((await automatic.owner.send('manual')).ok, false);
  assert.equal((await automatic.owner.send('automatic')).ok, true);
});

it('用户主动新一轮仅使旧回执失效，不表示回传失败，空来源同样不产生暂停', async () => {
  for (const previous of ['empty', 'sent'] as const) {
    const f = fixture();
    if (previous === 'empty') { f.owner.begin(null); f.context.state.results = []; delete f.context.state.completion; }
    else await f.owner.send('manual');
    f.owner.invalidate();
    const state = f.owner.getState(f.context);
    assert.equal(state.phase, 'invalidated'); assert.equal(state.canSend, false);
    assert.match(state.message, /已发起新一轮/);
    assert.equal((await f.owner.send('manual')).ok, false);
  }
});

it('超时及工具停止的部分输出可回传，整批取消和清理中仍不能发送', async () => {
  for (const status of ['failed', 'cancelled', 'done'] as const) {
    for (const block of ['none', 'batch-cancel', 'cleanup'] as const) {
      const f = fixture(true);
      f.owner.begin({ kind: 'batch', selection: { root: 'root', session: 'chat', batch: { protocol_version: 1, batch_id: 'batch', requests: [{ id: 'run', tool: 'run_command', args: { command: 'test', shell: 'powershell' } }] } } });
      f.context.state.results = [{ batch_id: 'batch', request_id: 'run', tool: 'run_command', status, started_at: 1, finished_at: 2,
        data: { status: 'stopped', timed_out: status === 'failed', cleanup_pending: block === 'cleanup', stdout: 'before-stop' } }];
      if (block === 'batch-cancel') f.context.state.completion!.cancelled = true;
      assert.equal((await f.owner.send('automatic')).ok, block === 'none', status + '/' + block);
      assert.equal(f.sent.length, block === 'none' ? 1 : 0);
      if (block === 'none') assert.equal(f.sent[0]![0], formatToolResults(f.context.state.results));
    }
  }
});
it('用户中断在发送前或异步复核期间都阻止自动正文与附件运输', async () => {
  for (const timing of ['before', 'verify'] as const) {
    const f = fixture(true);
    if (timing === 'before') f.context.state.userInterrupted = true;
    else f.setVerify(async () => { f.context.state.userInterrupted = true; return { ok: true }; });
    assert.equal((await f.owner.send('automatic')).ok, false);
    assert.equal(f.resolved, 0); assert.equal(f.sent.length, 0);
    f.context.state.config.automatic = false;
    f.context.state.config.automatic = true;
    assert.equal((await f.owner.send('automatic')).ok, false);
  }
});

it('纯权限拒绝自动回传拒绝事实，不读取或上传被拒绝附件且不重试', async () => {
  const f = fixture(true);
  f.context.state.results = [{ batch_id: 'batch', request_id: 'file', tool: 'attach_file', status: 'permission_denied', error: '权限拒绝；工具未执行' }];
  assert.equal((await f.owner.send('automatic')).ok, true);
  assert.equal(f.sent[0]![0], formatToolResults(f.context.state.results));
  assert.deepEqual(f.sent[0]![3], []); assert.equal(f.resolved, 0);
  assert.equal((await f.owner.send('automatic')).ok, false); assert.equal(f.sent.length, 1);
});

it('拒绝、取消、未知、历史、未执行及后台清理都不能发送附件', async () => {
  for (const scenario of ['denied', 'cancelled', 'unknown', 'history', 'no-execution', 'busy', 'process', 'cleanup', 'scope']) {
    const f = fixture(); const state = f.context.state;
    if (scenario === 'denied') state.results[0]!.status = 'permission_denied';
    if (scenario === 'cancelled') state.completion!.cancelled = true;
    if (scenario === 'unknown') state.results[0]!.status = 'unknown';
    if (scenario === 'history') delete state.completion;
    if (scenario === 'no-execution') delete state.results[0]!.started_at;
    if (scenario === 'busy') state.busy = true;
    if (scenario === 'scope') f.context.session = 'other';
    if (scenario === 'process' || scenario === 'cleanup') {
      f.selection.batch.requests.push({ id: 'process', tool: 'attach_file', args: { path: 'other' } });
      state.results.push({ batch_id: 'batch', request_id: 'process', tool: 'run_command', status: 'done', started_at: 1, data: scenario === 'process' ? { status: 'running' } : { status: 'failed', cleanup_pending: true } });
    }
    assert.equal(f.owner.getState(f.context).canSend, false, scenario);
    assert.equal((await f.owner.send('manual')).ok, false, scenario); assert.equal(f.sent.length, 0); assert.equal(f.resolved, 0);
  }
});

it('解析层 batchError 可通过自动入口发送，正文含 batch_error', async () => {
  const f = fixture(true); f.context.state.batchError = { status: 'failed', error: 'invalid JSON' };
  f.context.state.results = []; delete f.context.state.completion;
  f.context.diagnostic = { id: 1, root: 'root', session: 'chat', sourceText: 'bad JSON', error: f.context.state.batchError };
  f.owner.begin({ kind: 'diagnostic', diagnostic: f.context.diagnostic });
  const result = await f.owner.send('automatic');
  assert.equal(result.ok, true); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]![0], formatToolResults([], f.context.state.batchError));
  assert.deepEqual(f.sent[0]![3], []); assert.equal(f.resolved, 0, '解析诊断不读取附件');
  assert.equal((await f.owner.send('automatic')).ok, false);
});

it('单独注入 batchError 不授予发送资格，执行层结果不能混入诊断回执', async () => {
  for (const scenario of ['no-source', 'batch-source', 'denied', 'cancelled', 'unknown', 'stopped', 'completion', 'diagnostic-cancelled', 'scope', 'id'] as const) {
    const f = fixture(true); const error = { status: 'failed' as const, error: 'invalid JSON' };
    f.context.state.batchError = error;
    if (scenario === 'batch-source') { assert.equal((await f.owner.send('automatic')).ok, false); continue; }
    f.context.diagnostic = { id: 1, root: 'root', session: 'chat', sourceText: 'bad JSON', error };
    f.owner.begin(scenario === 'no-source' ? null : { kind: 'diagnostic', diagnostic: structuredClone(f.context.diagnostic) });
    delete f.context.state.completion;
    if (scenario === 'denied') f.context.state.results[0]!.status = 'permission_denied';
    if (scenario === 'cancelled') f.context.state.results[0]!.status = 'cancelled';
    if (scenario === 'unknown') f.context.state.results[0]!.status = 'unknown';
    if (scenario === 'stopped') { f.context.state.results[0]!.tool = 'run_command'; f.context.state.results[0]!.data = { status: 'stopped' }; }
    if (scenario === 'completion') f.context.state.completion = { id: 1, batch_id: 'old', outcome: 'error' };
    if (scenario === 'diagnostic-cancelled') { f.context.state.results = []; f.context.diagnostic.cancelled = true; }
    if (scenario === 'scope') { f.context.state.results = []; f.context.session = 'other'; }
    if (scenario === 'id') { f.context.state.results = []; f.context.diagnostic.id++; }
    assert.equal((await f.owner.send('automatic')).ok, false, scenario); assert.equal(f.sent.length, 0); assert.equal(f.resolved, 0);
  }
});

it('诊断校验期间取消、替换诊断或发起新轮不会发送；手动附件入口不发送解析诊断', async () => {
  for (const scenario of ['cancel', 'replace', 'turn', 'manual'] as const) {
    const f = fixture(true); const error = { status: 'failed' as const, error: 'invalid JSON' };
    f.context.state = { ...f.context.state, results: [], batchError: error }; delete f.context.state.completion;
    f.context.diagnostic = { id: 1, root: 'root', session: 'chat', sourceText: 'bad JSON', error };
    f.owner.begin({ kind: 'diagnostic', diagnostic: structuredClone(f.context.diagnostic) });
    if (scenario === 'manual') {
      f.context.state.config.automatic = false; assert.equal((await f.owner.send('manual')).ok, false); continue;
    }
    let finish!: (result: WebSendResult) => void;
    f.setVerify(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.owner.send('automatic');
    if (scenario === 'cancel') f.context.diagnostic.cancelled = true;
    if (scenario === 'replace') f.context.diagnostic.id++;
    if (scenario === 'turn') f.owner.invalidate();
    finish({ ok: true }); assert.equal((await pending).ok, false); assert.equal(f.sent.length, 0); assert.equal(f.resolved, 0);
  }
});

it('官网校验等待期间切会话、关闭开关、替换正文或发起新轮均不读取并上传旧附件', async () => {
  for (const scenario of ['scope', 'toggle', 'body', 'new-turn', 'new-selection']) {
    const f = fixture(true); let finish!: (value: WebSendResult) => void;
    f.setVerify(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.owner.send('automatic');
    assert.equal((await f.owner.send('automatic')).ok, false, '发送等待期间不可并发');
    if (scenario === 'scope') f.context.session = 'other';
    if (scenario === 'toggle') f.context.state.config.automatic = false;
    if (scenario === 'body') f.context.state.results[0]!.data = { name: 'changed.png' };
    if (scenario === 'new-turn') f.owner.invalidate();
    if (scenario === 'new-selection') f.owner.begin(null);
    finish({ ok: true }); assert.equal((await pending).ok, false); assert.equal(f.sent.length, 0); assert.equal(f.resolved, 0);
  }
});

it('上传失败、发送未知及官网批次不匹配明确暂停，不从任何入口重试', async () => {
  for (const result of [{ ok: false, error: '官网批次已变化' }, { ok: false, uncertain: true, error: '点击结果未知' }] as WebSendResult[]) {
    const f = fixture();
    if (result.uncertain) f.setTransport(async () => result); else f.setVerify(async () => result);
    assert.deepEqual(await f.owner.send('manual'), { ...result, transportStarted: !!result.uncertain, ...(!result.uncertain ? { stage: 'preflight' } : {}) });
    assert.equal(f.owner.getState(f.context).phase, 'paused'); assert.match(f.owner.getState(f.context).message, /不重复上传/);
    assert.equal((await f.owner.send('manual')).ok, false); assert.ok(f.sent.length <= 1);
  }
});

it('manual 诊断的来源或当前身份任何一侧为手动都不能授予官网发送资格', async () => {
  for (const side of ['source', 'current'] as const) {
    const f = fixture(true);
    const diagnostic: ToolDiagnostic = { id: 1, root: 'root', session: 'chat', sourceText: '{bad', error: { status: 'failed', error: 'bad json' } };
    f.context.state.results = []; delete f.context.state.completion; f.context.state.batchError = diagnostic.error;
    f.context.diagnostic = { ...diagnostic, ...(side === 'current' ? { source: 'manual' as const } : {}) };
    f.owner.begin({ kind: 'diagnostic', diagnostic: { ...diagnostic, ...(side === 'source' ? { source: 'manual' as const } : {}) } });
    assert.equal((await f.owner.send('automatic')).ok, false);
    f.context.state.config.automatic = false; assert.equal((await f.owner.send('manual')).ok, false);
    assert.equal(f.sent.length, 0); assert.equal(f.resolved, 0);
  }
});

it('明确的临时预检失败只重新核验同批，成功前不读取附件或进入运输', async () => {
  const f = fixture(true); let checked = 0;
  f.setVerify(async () => ++checked < 3
    ? { ok: false, error: '网页暂未完成', retryable: true, transportStarted: false, stage: 'preflight' }
    : { ok: true });
  for (let index = 0; index < 2; index++) {
    const result = await f.owner.send('automatic'); assert.equal(result.retryable, true);
    assert.equal(f.sent.length, 0); assert.equal(f.resolved, 0); assert.equal(f.owner.getState(f.context).phase, 'ready');
  }
  assert.equal((await f.owner.send('automatic')).ok, true);
  assert.equal(checked, 3); assert.equal(f.resolved, 1); assert.equal(f.sent.length, 1);
  assert.equal((await f.owner.send('automatic')).ok, false); assert.equal(checked, 3);
});

it('缺少明确无运输证据、点击未知、手动或运输阶段的失败均不能释放一次资格', async () => {
  const candidates: WebSendResult[] = [
    { ok: false, error: 'unknown', retryable: true, stage: 'preflight' },
    { ok: false, error: 'started', retryable: true, transportStarted: true, stage: 'preflight' },
    { ok: false, error: 'uncertain', retryable: true, transportStarted: false, stage: 'preflight', uncertain: true },
    { ok: false, error: 'clicked', retryable: true, transportStarted: false, stage: 'clicked' },
  ];
  for (const candidate of candidates) {
    const f = fixture(true); f.setVerify(async () => candidate);
    assert.equal((await f.owner.send('automatic')).retryable, undefined);
    assert.equal((await f.owner.send('automatic')).ok, false); assert.equal(f.resolved, 0);
  }
  for (const automatic of [false, true]) {
    const f = fixture(automatic);
    const candidate: WebSendResult = { ok: false, retryable: true, transportStarted: false, stage: 'preflight' };
    if (automatic) f.setTransport(async () => candidate); else f.setVerify(async () => candidate);
    assert.equal((await f.owner.send(automatic ? 'automatic' : 'manual')).retryable, undefined);
    assert.equal((await f.owner.send(automatic ? 'automatic' : 'manual')).ok, false);
    assert.equal(f.sent.length, automatic ? 1 : 0);
  }
});

it('临时预检结束时关闭或用户接管仍取消旧资格，重开不能复活', async () => {
  for (const scenario of ['off', 'interrupted', 'new-turn'] as const) {
    const f = fixture(true);
    f.setVerify(async () => {
      if (scenario === 'off') f.context.state.config.automatic = false;
      if (scenario === 'interrupted') f.context.state.userInterrupted = true;
      if (scenario === 'new-turn') f.owner.invalidate();
      return { ok: false, retryable: true, transportStarted: false, stage: 'preflight' };
    });
    assert.equal((await f.owner.send('automatic')).retryable, undefined);
    f.context.state.config.automatic = true;
    assert.equal((await f.owner.send('automatic')).ok, false);
    assert.equal(f.resolved, 0); assert.equal(f.sent.length, 0);
  }
});


it('旧取消阻断拒绝当前纯文本时保留未运输事实，但不补发本批或释放一次资格', async () => {
  const selection = { root: 'root', session: 'chat', batch: { protocol_version: 1 as const, batch_id: 'blocked', requests: [{ id: 'read', tool: 'read_file' as const, args: { path: 'a.txt' } }] } };
  const state: ToolState = { config: { permission: 'full', automatic: true, dirtyPolicy: 'ask', completionSound: false, autoCopyResults: true, sendIntervalSeconds: 0 },
    busy: false, message: '', completion: { id: 1, batch_id: 'blocked', outcome: 'success' },
    results: [{ batch_id: 'blocked', request_id: 'read', tool: 'read_file', status: 'done', started_at: 1, data: { text: 'real output' } }] };
  const context = { root: 'root', session: 'chat', state };
  let sends = 0;
  const owner = new ToolResultReturn({ current: () => context, verify: async () => ({ ok: true }), attachments: async () => [],
    send: async () => { sends++; return { ok: false, blockedByPreviousCancellation: true, transportStarted: false, stage: 'preflight', error: '上次取消状态未确认，本批结果未发送' } as WebSendResult; }, changed() {} });
  owner.begin({ kind: 'batch', selection });
  const result = await owner.send('automatic');
  assert.equal(result.transportStarted, false); assert.equal(result.uncertain, undefined); assert.equal(result.retryable, undefined);
  assert.match(owner.getState(context).message, /本批结果未发送/);
  await owner.send('automatic'); assert.equal(sends, 1, '旧阻断不自动复活本批发送资格');
});
