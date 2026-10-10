import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createToolIntegration } from '../src/main/tools/integration';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { CHANNELS } from '../src/shared/contract';
import type { ToolState } from '../src/shared/toolProtocol';

async function fixture(t: { after(fn: () => Promise<void>): void }, enableAutomatic = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-execution-ui-'));
  const files = new FileService(); files.setRoot(root);
  const handlers = new Map<string, (...args: any[]) => any>(); const broadcasts: ToolState[] = []; const copies: string[] = [];
  const editor: any = { mainFrame: {}, isDestroyed: () => false, send(_channel: string, state: ToolState) { broadcasts.push(state); } };
  let url = 'https://chat.deepseek.com/a/chat/native'; let reply = ''; let approvalResponse = 0;
  const sent: string[] = [];
  let waiter: ((value: unknown) => void) | undefined;
  const web: any = Object.assign(new EventEmitter(), { getURL: () => url, isDestroyed: () => false,
    executeJavaScript: async () => ({ replies: [reply], completion: 'complete' }),
    executeJavaScriptInIsolatedWorld: async (_world: number, entries: { code: string }[]) => {
      if (entries[0]!.code.includes('previous.waiter = resolve')) return new Promise(resolve => { waiter = resolve; });
      if (entries[0]!.code.includes('previous.dispose();')) { waiter?.(false); waiter = undefined; }
      return true;
    } });
  const system = await createToolIntegration({ files, web, editor, ipc: { handle(c: string, f: any) { handlers.set(c, f); } } as any,
    returnPath: new ReturnPathService(files), workspace: { editor: { isDirty: () => false, current: { documents: [] } }, run: (fn: any) => fn() } as any,
    sender: { async send(text, _session, _kind, current) { assert.equal(current(), true); sent.push(text); return { ok: true }; }, async cancel() {}, async dispose() {} },
    storePath: path.join(root, 'state.json'), disabled: !enableAutomatic, ask: async () => ({ response: approvalResponse, checkboxChecked: false }), notifyFile() {}, copy(text) { copies.push(text); } });
  t.after(async () => { await system.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: editor, senderFrame: editor.mainFrame }, ...args);
  await call(CHANNELS.setToolConfig, { permission: 'full' });
  return { root, files, system, copies, broadcasts, sent, call, setReply(text: string) { reply = text; }, deny() { approvalResponse = 2; }, switchSession() { url = 'https://chat.deepseek.com/a/chat/other'; system.reset(); } };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, '真实进程应在限时内完成'); await delay(25); }
}
const batch = (id: string, windowsCommand: string, unixCommand: string, background = false) => '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: id, requests: [{ id: 'cmd', tool: 'run_command', args: { command: process.platform === 'win32' ? windowsCommand : unixCommand, shell: process.platform === 'win32' ? 'powershell' : 'bash', background, timeout_ms: 60_000 } }] }) + '\n```';

it('真实超时、逐条中断及权限拒绝通过完整执行与回传链路一次发送，取消整批仍停止', async t => {
  for (const scenario of ['timeout', 'stop', 'denied', 'cancel-batch'] as const) {
    const f = await fixture(t, true);
    await f.call(CHANNELS.setToolConfig, { automatic: true, permission: scenario === 'denied' ? 'ask' : 'full', sendIntervalSeconds: 0 });
    if (scenario === 'denied') f.deny();
    const text = batch('terminal-' + scenario, "Write-Output 'before-stop'; Start-Sleep -Seconds 30", 'printf before-stop; sleep 30').replace('60000', scenario === 'timeout' ? '3000' : '60000');
    f.setReply(text); await f.system.accept(text, 'complete');
    if (scenario === 'stop' || scenario === 'cancel-batch') {
      await until(() => !!(f.system.getState().results[0]?.data as any)?.process_id);
      await delay(1000);
      const processId = (f.system.getState().results[0]!.data as any).process_id;
      if (scenario === 'stop') await f.call(CHANNELS.stopToolCommand, { batch_id: 'terminal-' + scenario, request_id: 'cmd', process_id: processId });
      else await f.call(CHANNELS.cancelTools);
    }
    await until(() => !!f.system.getState().completion && !f.system.getState().busy);
    if (scenario === 'cancel-batch') {
      await delay(50); assert.equal(f.sent.length, 0); assert.equal(f.copies.length, 0); assert.equal(f.system.getState().completion!.cancelled, true);
      continue;
    }
    await until(() => {
      const state = f.system.getState();
      assert.notEqual(state.continuation?.phase, 'paused', scenario + ': ' + JSON.stringify(state));
      return state.continuation?.phase === 'waiting_reply';
    });
    assert.equal(f.sent.length, 1, scenario);
    const result = JSON.parse(f.sent[0]!).tool_results[0];
    assert.equal(result.status, scenario === 'timeout' ? 'failed' : scenario === 'stop' ? 'cancelled' : 'permission_denied');
    if (scenario === 'denied') { assert.equal(result.started_at, undefined); assert.equal(result.data, undefined); assert.equal(f.copies.length, 0); }
    else { assert.equal(result.data.status, 'stopped'); assert.equal(result.data.cleanup_pending, false); assert.match(result.data.stdout, /before-stop/); assert.equal(f.copies.length, 1); assert.equal(f.sent[0], f.copies[0]); }
    for (let i = 0; i < 3; i++) await f.call(CHANNELS.getToolState);
    await delay(25); assert.equal(f.sent.length, 1, '重复状态不重发');
  }
});

it('真实文件修改、读取和搜索批次自动复制，失败回执保留，关闭开关与重复采集不复制', async t => {
  const f = await fixture(t);
  const text = (id: string, requests: unknown[]) => '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: id, requests }) + '\n```';
  const create = text('file-create', [{ id: 'create', tool: 'apply_changes', args: { changes: [{ path: 'note.txt', operation: 'create', content: 'original text' }] } }]);
  await f.system.accept(create, 'complete'); await until(() => !f.system.getState().busy);
  assert.equal(await fs.readFile(path.join(f.root, 'note.txt'), 'utf8'), 'original text');
  assert.equal(f.copies.length, 1);
  assert.deepEqual(JSON.parse(f.copies[0]!).tool_results, f.system.getState().results);
  const inspect = text('file-inspect', [
    { id: 'read', tool: 'read_file', args: { path: 'note.txt' } },
    { id: 'search', tool: 'search_text', args: { path: 'note.txt', query: 'original' } },
    { id: 'missing', tool: 'read_file', args: { path: 'missing.txt' } },
  ]);
  await f.system.accept(inspect, 'complete'); await until(() => !f.system.getState().busy);
  assert.equal(f.copies.length, 2);
  const output = JSON.parse(f.copies[1]!).tool_results;
  assert.deepEqual(output, f.system.getState().results);
  assert.equal(output.length, 3); assert.match(JSON.stringify(output[0].data), /original text/);
  assert.deepEqual(output.map((r: any) => r.status), ['done', 'done', 'failed']);
  assert.equal(f.system.getState().clipboard?.ok, true);
  await f.system.accept(inspect, 'complete'); await until(() => !f.system.getState().busy);
  await f.call(CHANNELS.getToolState); assert.equal(f.copies.length, 2);
  await f.call(CHANNELS.setToolConfig, { autoCopyResults: false });
  await f.system.accept(text('file-disabled', [{ id: 'read', tool: 'read_file', args: { path: 'note.txt' } }]), 'complete');
  await until(() => !f.system.getState().busy); assert.equal(f.copies.length, 2);
  await f.call(CHANNELS.setToolConfig, { autoCopyResults: true }); assert.equal(f.copies.length, 2);
  assert.equal(f.call(CHANNELS.copyToolResults).ok, true); assert.equal(f.copies.length, 3);
  assert.deepEqual(JSON.parse(f.copies[2]!).tool_results, f.system.getState().results);
});

it('真实命令结束一次复制完整失败输出，读取状态或重复采集不再复制，手动可重复制', async t => {
  const f = await fixture(t); assert.equal(f.copies.length, 0);
  const text = batch('failed', 'Write-Output actual; [Console]::Error.WriteLine("failure"); exit 7', 'printf actual; printf failure >&2; exit 7');
  await f.system.accept(text, 'complete'); await until(() => !f.system.getState().busy);
  assert.equal(f.copies.length, 1);
  const output = JSON.parse(f.copies[0]!).tool_results[0];
  assert.equal(output.status, 'failed'); assert.equal(output.data.exit_code, 7); assert.match(output.data.stderr, /failure/);
  assert.ok(output.data.duration_ms >= 0); assert.ok(output.finished_at >= output.started_at);
  assert.equal(f.system.getState().clipboard?.ok, true);
  for (let i = 0; i < 3; i++) await f.call(CHANNELS.getToolState);
  await f.system.accept(text, 'complete'); await until(() => !f.system.getState().busy);
  assert.equal(f.copies.length, 1);
  assert.equal(f.call(CHANNELS.copyToolResults).ok, true); assert.equal(f.copies.length, 2);
});

it('后台命令启动不复制，真实结束事件刷新本批输出并复制一次', async t => {
  const f = await fixture(t);
  await f.system.accept(batch('background', 'Write-Output started; Start-Sleep -Milliseconds 700; Write-Output finished', 'printf started; sleep .7; printf finished', true), 'complete');
  await until(() => !f.system.getState().busy);
  assert.equal(f.copies.length, 0); assert.equal(f.system.getState().hasRunningProcesses, true);
  await until(() => f.copies.length === 1);
  const output = JSON.parse(f.copies[0]!).tool_results[0]; assert.match(output.data.stdout, /finished/);
  assert.equal(output.data.status, 'done'); assert.equal(f.system.getState().hasRunningProcesses, false);
  assert.ok(output.data.duration_ms >= 700);
});

it('逐条中断前后台命令不取消同批其他进程或后续无依赖请求，IPC拒绝不属于当前批次的目标', async t => {
  const f = await fixture(t);
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
  const text = '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: 'separate', requests: [
    { id: 'background', tool: 'run_command', args: { command, shell, background: true, timeout_ms: 60000 } },
    { id: 'foreground', tool: 'run_command', args: { command, shell, timeout_ms: 60000 } },
    { id: 'after', tool: 'get_project_info', args: {} },
  ] }) + '\n```';
  await f.system.accept(text, 'complete');
  await until(() => f.system.getState().results.some(r => r.request_id === 'foreground' && (r.data as any)?.process_id));
  const foreground = (f.system.getState().results.find(r => r.request_id === 'foreground')?.data as any).process_id;
  const background = (f.system.getState().results.find(r => r.request_id === 'background')?.data as any).process_id;
  await assert.rejects(f.call(CHANNELS.stopToolCommand, { batch_id: 'wrong', request_id: 'foreground', process_id: foreground }), /不属于/);
  await assert.rejects(f.call(CHANNELS.stopToolCommand, { batch_id: 'separate', request_id: 'missing', process_id: foreground }), /不属于/);
  await assert.rejects(f.call(CHANNELS.stopToolCommand, { batch_id: 'separate', request_id: 'foreground', process_id: background }), /不属于/);
  await assert.rejects(f.call(CHANNELS.stopToolCommand, { batch_id: 'separate', request_id: 'foreground', process_id: foreground, extra: true }), /目标无效/);
  await f.call(CHANNELS.stopToolCommand, { batch_id: 'separate', request_id: 'foreground', process_id: foreground });
  await until(() => !f.system.getState().busy);
  const current = f.system.getState();
  assert.equal(current.results.find(r => r.request_id === 'foreground')?.status, 'cancelled');
  assert.equal((current.results.find(r => r.request_id === 'background')?.data as any).status, 'running');
  assert.equal(current.results.find(r => r.request_id === 'after')?.status, 'done');
  assert.equal(current.hasRunningProcesses, true);
  assert.equal(f.copies.length, 0);
  await f.call(CHANNELS.stopToolCommand, { batch_id: 'separate', request_id: 'background', process_id: background });
  assert.equal(f.system.getState().hasRunningProcesses, false);
  assert.equal((f.system.getState().results.find(r => r.request_id === 'background')?.data as any).status, 'stopped');
  assert.equal(f.copies.length, 1, '本批全部进程清理结束后复制停止事实与部分输出');
});

it('含多个请求但校验不通过时统一返回批次错误，不执行合法的前一条也不伪造失败工具身份', async t => {
  const f = await fixture(t);
  const text = '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: 'invalid-many', requests: [
    { id: 'valid', tool: 'get_project_info', args: {} },
    { id: 'invalid', tool: 'read_file', args: {} },
  ] }) + '\n```';
  await f.system.accept(text, 'complete');
  assert.deepEqual(f.system.getState().results, []);
  assert.equal(f.copies.length, 0);
  assert.equal(f.call(CHANNELS.copyToolResults).ok, true);
  const reply = JSON.parse(f.copies[0]!);
  assert.deepEqual(reply.tool_results, []);
  assert.deepEqual(Object.keys(reply.batch_error).sort(), ['error', 'status']);
  assert.match(reply.batch_error.error, /invalid/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'state.json'), 'utf8')).ledger.length, 0);
});

it('强制中断真实命令并保留停止事实，取消与切换会话均不自动复制迟到输出', async t => {
  const f = await fixture(t);
  await f.system.accept(batch('long', 'Write-Output started; Start-Sleep -Seconds 30; Write-Output unexpected', 'printf started; sleep 30; printf unexpected'), 'complete');
  await until(() => f.system.getState().results.some(r => r.started_at !== undefined)); await delay(300);
  const stopped = await f.call(CHANNELS.cancelTools); await until(() => !f.system.getState().busy);
  assert.equal(stopped.hasRunningProcesses, false);
  assert.equal(f.system.getState().results[0]?.status, 'cancelled');
  assert.doesNotMatch(JSON.stringify(f.system.getState().results[0]?.data), /unexpected/);
  assert.equal(f.copies.length, 0);
  await f.system.accept(batch('other', 'Start-Sleep -Milliseconds 300; Write-Output late', 'sleep .3; printf late'), 'complete');
  await until(() => f.system.getState().results.some(r => r.started_at !== undefined));
  f.switchSession(); await until(() => !f.system.getState().busy);
  assert.deepEqual(f.system.getState().results, []); assert.equal(f.copies.length, 0);
});
