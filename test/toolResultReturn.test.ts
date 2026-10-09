import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ToolResultReturn } from '../src/main/tools/resultReturn';
import type { ToolState } from '../src/shared/toolProtocol';
import type { WebSendResult } from '../src/main/webComposerSender';

function fixture(automatic = false) {
  const selection = { root: 'root', session: 'chat', batch: { protocol_version: 1 as const, batch_id: 'batch', requests: [{ id: 'file', tool: 'attach_file' as const, args: { path: 'figure.png' } }] } };
  const state: ToolState = { config: { permission: 'full', automatic, dirtyPolicy: 'ask', completionSound: false, autoCopyResults: true, sendIntervalSeconds: 0 },
    busy: false, message: '', completion: { id: 1, batch_id: 'batch', outcome: 'success' }, results: [{ batch_id: 'batch', request_id: 'file', tool: 'attach_file', status: 'done', started_at: 1, data: { id: 'owned', name: 'figure.png' } }] };
  const context = { root: 'root', session: 'chat', state }; const sent: unknown[][] = [];
  let verify: () => Promise<WebSendResult> = async () => ({ ok: true });
  let transport: () => Promise<WebSendResult> = async () => ({ ok: true });
  let resolved = 0;
  const file = { id: 'owned', name: 'figure.png', size: 1, mediaType: 'image/png', async *stream() { yield new Uint8Array([1]); } };
  const owner = new ToolResultReturn({ current: () => context, verify: () => verify(), attachments: async () => { resolved++; return [file]; },
    send: async (...args) => { sent.push(args); return transport(); }, changed() {} });
  owner.begin(selection);
  return { owner, context, selection, file, sent, get resolved() { return resolved; }, setVerify(fn: typeof verify) { verify = fn; }, setTransport(fn: typeof transport) { transport = fn; } };
}

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

it('拒绝、取消、未知、历史、未执行及后台清理都不能发送附件', async () => {
  for (const scenario of ['denied', 'cancelled', 'unknown', 'history', 'no-execution', 'busy', 'process', 'cleanup', 'scope', 'batch-error']) {
    const f = fixture(); const state = f.context.state;
    if (scenario === 'denied') state.results[0]!.status = 'permission_denied';
    if (scenario === 'cancelled') state.completion!.cancelled = true;
    if (scenario === 'unknown') state.results[0]!.status = 'unknown';
    if (scenario === 'history') delete state.completion;
    if (scenario === 'no-execution') delete state.results[0]!.started_at;
    if (scenario === 'busy') state.busy = true;
    if (scenario === 'scope') f.context.session = 'other';
    if (scenario === 'batch-error') state.batchError = { status: 'failed', error: 'invalid' };
    if (scenario === 'process' || scenario === 'cleanup') {
      f.selection.batch.requests.push({ id: 'process', tool: 'attach_file', args: { path: 'other' } });
      state.results.push({ batch_id: 'batch', request_id: 'process', tool: 'run_command', status: 'done', started_at: 1, data: scenario === 'process' ? { status: 'running' } : { status: 'failed', cleanup_pending: true } });
    }
    assert.equal(f.owner.getState(f.context).canSend, false, scenario);
    assert.equal((await f.owner.send('manual')).ok, false, scenario); assert.equal(f.sent.length, 0); assert.equal(f.resolved, 0);
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
    assert.deepEqual(await f.owner.send('manual'), result);
    assert.equal(f.owner.getState(f.context).phase, 'paused'); assert.match(f.owner.getState(f.context).message, /不重复上传/);
    assert.equal((await f.owner.send('manual')).ok, false); assert.ok(f.sent.length <= 1);
  }
});
