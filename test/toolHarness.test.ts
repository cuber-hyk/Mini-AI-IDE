import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolHarness } from '../src/main/tools/harness';
import { ToolStore } from '../src/main/tools/store';
import { ToolRequest, ToolState } from '../src/shared/toolProtocol';
import { ResultClipboard } from '../src/main/tools/resultClipboard';

const read: ToolRequest = { id: 'read', tool: 'read_file', args: { path: 'README.md' } };
const run: ToolRequest = { id: 'run', tool: 'run_command', args: { command: 'echo hi', shell: 'powershell' } };
const text = (requests: ToolRequest[], batchId = 'batch-1') => `\`\`\`mini-ai-tools\n${JSON.stringify({ protocol_version: 1, batch_id: batchId, requests })}\n\`\`\``;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-harness-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'tools.json');
  const store = new ToolStore(filePath);
  await store.ready();
  let root: string | null = directory;
  let session = 'chat';
  let fingerprint = 'same-script';
  let external = false;
  let describe = async () => ({ external, fingerprint });
  let authorize: (root: string, request: ToolRequest) => Promise<'once' | 'remember' | 'deny'> = async () => 'deny';
  let execute: (root: string, request: ToolRequest, started: (data: unknown) => void) => Promise<unknown> = async () => ({ exit_code: 0 });
  let prepare: (root: string) => Promise<void> = async () => undefined;
  let onChange: (state: ToolState) => void = () => undefined;
  let snapshot: (id: string) => unknown = () => undefined;
  const executed: string[] = [];
  const asked: string[] = [];
  const makeHarness = (selectedStore = store) => new ToolHarness({
    store: selectedStore, root: () => root, session: () => session,
    describe: () => describe(),
    execute: async (r, request, started) => { executed.push(request.id); return execute(r, request, started); },
    authorize: async (r, request) => { asked.push(request.id); return authorize(r, request); },
    prepare: r => prepare(r), changed: s => onChange(s), snapshotProcess: id => snapshot(id),
  });
  const harness = makeHarness();
  return { directory, filePath, store, harness, executed, asked, makeHarness,
    setRoot: (r: string | null) => { root = r; }, setSession: (s: string) => { session = s; },
    setFingerprint: (f: string) => { fingerprint = f; }, setExternal: (e: boolean) => { external = e; },
    setDescribe: (fn: typeof describe) => { describe = fn; },
    setAuthorize: (fn: typeof authorize) => { authorize = fn; }, setExecute: (fn: typeof execute) => { execute = fn; },
    setPrepare: (fn: typeof prepare) => { prepare = fn; }, setOnChange: (fn: typeof onChange) => { onChange = fn; },
    setSnapshot: (fn: typeof snapshot) => { snapshot = fn; },
  };
}

test('诊断来源只在新采集内容时创建，重复采集和取消保留标识，切 scope 清除', async t => {
  const f = await fixture(t); const bad = '```mini-ai-tools\n{}\n```';
  await f.harness.collect(bad);
  const first = f.harness.getDiagnostic()!;
  assert.ok(first.id > 0); assert.equal(first.root, f.directory); assert.equal(first.session, 'chat'); assert.equal(first.sourceText, bad);
  assert.deepEqual(first.error, f.harness.state.batchError); assert.equal(f.harness.state.completion, undefined); assert.deepEqual(f.executed, []);
  first.error.error = 'mutated copy'; assert.notEqual(f.harness.state.batchError!.error, first.error.error);
  await f.harness.collect(bad); assert.equal(f.harness.getDiagnostic()!.id, first.id);
  f.harness.cancel(); await f.harness.collect(bad);
  assert.equal(f.harness.getDiagnostic()!.id, first.id); assert.equal(f.harness.getDiagnostic()!.cancelled, true);
  await f.harness.collect('new reply\n' + bad);
  assert.ok(f.harness.getDiagnostic()!.id > first.id); assert.equal(f.harness.getDiagnostic()!.cancelled, undefined);
  const error = f.harness.state.batchError;
  f.setSession('other'); assert.equal(f.harness.getDiagnostic(), null); assert.equal(f.harness.state.batchError, undefined);
  await f.harness.collect(bad); assert.deepEqual(f.harness.state.batchError, error); assert.equal(f.harness.getDiagnostic()!.session, 'other');
  f.setRoot(null); assert.equal(f.harness.getDiagnostic(), null);
});

test('ask mode automatically reads only project data; commands and external files require IDE approval', async t => {
  const f = await fixture(t);
  await f.harness.collect(text([read, run]));
  assert.deepEqual(f.executed, ['read']);
  assert.deepEqual(f.asked, ['run']);
  assert.equal(f.harness.state.results[1]?.status, 'permission_denied');
  f.setExternal(true);
  await f.harness.collect(text([read], 'external'));
  assert.deepEqual(f.executed, ['read']);
  assert.deepEqual(f.asked, ['run', 'read']);
});

test('后台close早于启动回执落盘时，发布前复核实际快照，不永久等待或丢失最终输出', async t => {
  const f = await fixture(t); await f.harness.configure({ permission: 'full' });
  const gate = deferred<void>(); const saving = deferred<void>();
  let snapshot: unknown = { process_id: 'proc-owned', status: 'running' };
  f.setSnapshot(() => snapshot); f.setExecute(async () => ({ process_id: 'proc-owned', status: 'running' }));
  const update = f.store.updateResult.bind(f.store);
  f.store.updateResult = async (...args) => { if (args[3] === 'done') { saving.resolve(); await gate.promise; } await update(...args); };
  const collecting = f.harness.collect(text([{ ...run, args: { ...run.args, background: true } }], 'raced'));
  await saving.promise;
  snapshot = { process_id: 'proc-owned', status: 'done', stdout: 'completed during save', exit_code: 0 };
  f.harness.refreshProcesses(); gate.resolve(); await collecting;
  assert.equal((f.harness.state.results[0]!.data as any).status, 'done');
  assert.equal((f.harness.state.results[0]!.data as any).stdout, 'completed during save');
  assert.equal(f.harness.state.completion?.outcome, 'success');
});

test('后台启动不宣告本批就绪；用户取消后即使进程自然成功也不能自动复制', async t => {
  const f = await fixture(t); await f.harness.configure({ permission: 'full' });
  let copies = 0; const clipboard = new ResultClipboard(() => copies++);
  f.setOnChange(state => clipboard.complete(state));
  let snapshot: unknown = { process_id: 'proc-owned', status: 'running' };
  f.setSnapshot(() => snapshot); f.setExecute(async () => structuredClone(snapshot));
  await f.harness.collect(text([run], 'cancel-background'));
  assert.equal(f.harness.state.completion, undefined); assert.equal(copies, 0);
  f.harness.cancel(); snapshot = { process_id: 'proc-owned', status: 'done', exit_code: 0 };
  f.harness.refreshProcesses();
  assert.equal(f.harness.state.completion?.cancelled, true); assert.equal(copies, 0);
});

test('树清理失败后的非running快照仍能复核，重试清理完成后解除等待并反馈一次', async t => {
  const f = await fixture(t); await f.harness.configure({ permission: 'full' });
  let snapshot: unknown = { process_id: 'proc-owned', status: 'running' };
  f.setSnapshot(() => snapshot); f.setExecute(async () => structuredClone(snapshot));
  await f.harness.collect(text([run], 'cleanup')); f.harness.cancel();
  snapshot = { process_id: 'proc-owned', status: 'failed', cleanup_pending: true, error: 'cleanup failed' };
  f.harness.refreshProcesses(); assert.equal(f.harness.state.completion, undefined);
  snapshot = { process_id: 'proc-owned', status: 'stopped', cleanup_pending: false };
  f.harness.refreshProcesses();
  assert.equal((f.harness.state.results[0]!.data as any).cleanup_pending, false);
  assert.equal(f.harness.state.completion?.outcome, 'error');
  const id = f.harness.state.completion?.id; f.harness.refreshProcesses(); assert.equal(f.harness.state.completion?.id, id);
});

test('denial produces factual permission_denied and skips only explicit dependencies', async t => {
  const f = await fixture(t);
  await f.harness.collect(text([run, { ...read, depends_on: ['run'] }, { ...read, id: 'independent' }]));
  assert.deepEqual(f.executed, ['independent']);
  assert.deepEqual(f.harness.state.results.map(r => r.status), ['permission_denied', 'skipped_dependency', 'done']);
});

test('full mode executes in order without approvals while nonzero exits and timeouts remain failures', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  f.setExternal(true);
  f.setExecute(async (_root, request) => request.id === 'run' ? { exit_code: 2, stderr: 'failed' } : { status: 'running', process_id: 'owned-1' });
  await f.harness.collect(text([run, { ...read, depends_on: ['run'] }, { ...run, id: 'background', args: { ...run.args, background: true } }]));
  assert.deepEqual(f.executed, ['run', 'background']);
  assert.deepEqual(f.asked, []);
  assert.deepEqual(f.harness.state.results.map(r => r.status), ['failed', 'skipped_dependency', 'done']);
  f.setExecute(async () => ({ timed_out: true, exit_code: null }));
  await f.harness.collect(text([run], 'timeout'));
  assert.equal(f.harness.state.results.at(-1)?.status, 'failed');
});

test('reading a failed process output succeeds and its explicit dependents can inspect the error', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  const query: ToolRequest = { id: 'output', tool: 'get_process_output', args: { process_id: 'owned-1' } };
  const processData = { status: 'failed', exit_code: 2, timed_out: true, stdout: '', stderr: 'build failed' };
  f.setExecute(async (_root, request) => request.id === 'output' ? processData : { content: 'project information' });
  await f.harness.collect(text([query, { ...read, depends_on: ['output'] }]));
  assert.deepEqual(f.executed, ['output', 'read']);
  assert.deepEqual(f.harness.state.results.map(r => r.status), ['done', 'done']);
  assert.deepEqual(f.harness.state.results[0]?.data, processData);
});

test('successfully stopping a process preserves its terminated state without reporting tool failure', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  const stop: ToolRequest = { id: 'stop', tool: 'stop_process', args: { process_id: 'owned-1' } };
  const processData = { status: 'failed', exit_code: 1, terminated: true, stderr: 'interrupted' };
  f.setExecute(async () => processData);
  await f.harness.collect(text([stop]));
  assert.equal(f.harness.state.results[0]?.status, 'done');
  assert.deepEqual(f.harness.state.results[0]?.data, processData);
});

test('real process-query or stop errors still fail the tool and skip its dependents', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  const output: ToolRequest = { id: 'output', tool: 'get_process_output', args: { process_id: 'missing-1' } };
  const stop: ToolRequest = { id: 'stop', tool: 'stop_process', args: { process_id: 'missing-1' } };
  f.setExecute(async () => { throw new Error('没有该 IDE 进程'); });
  await f.harness.collect(text([output, stop, { ...read, depends_on: ['output', 'stop'] }]));
  assert.deepEqual(f.harness.state.results.map(r => r.status), ['failed', 'failed', 'skipped_dependency']);
  assert.deepEqual(f.executed, ['output', 'stop']);
});

test('saved rules apply only to the exact fingerprint and deny takes priority over execution', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'rules' });
  await f.store.addRule(f.directory, 'same-script', 'allow');
  await f.harness.collect(text([run]));
  assert.deepEqual(f.executed, ['run']);
  f.setFingerprint('modified-script');
  await f.harness.collect(text([run], 'changed'));
  assert.deepEqual(f.asked, ['run']);
  await f.store.addRule(f.directory, 'modified-script', 'deny');
  await f.harness.collect(text([run], 'denied'));
  assert.equal(f.harness.state.results.at(-1)?.status, 'permission_denied');
  assert.deepEqual(f.executed, ['run']);
});

test('remember stores only exact project approval and clearing rules asks again', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'rules' });
  f.setAuthorize(async () => 'remember');
  await f.harness.collect(text([run]));
  await f.harness.collect(text([run], 'second'));
  assert.equal(f.asked.length, 1);
  await f.harness.clearRules();
  f.setAuthorize(async () => 'deny');
  await f.harness.collect(text([run], 'third'));
  assert.equal(f.asked.length, 2);
});

test('IDE clear rules targets the opened project and refuses when there is no project', async t => {
  const f = await fixture(t);
  const other = path.join(f.directory, 'other');
  await f.store.addRule(f.directory, 'this-project', 'allow');
  await f.store.addRule(other, 'other-project', 'deny');
  await f.harness.clearRules();
  assert.deepEqual(f.store.getRules(f.directory), []);
  assert.deepEqual(f.store.getRules(other), [{ fingerprint: 'other-project', action: 'deny' }]);
  f.setRoot(null);
  await assert.rejects(f.harness.clearRules(), /尚未打开项目/);
  assert.deepEqual(f.store.getRules(other), [{ fingerprint: 'other-project', action: 'deny' }]);
});

test('recollecting a completed batch during the same run preserves actual output for copying', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  const actual = { exit_code: 0, stdout: 'real command output', stderr: '', nested: { count: 2 } };
  f.setExecute(async () => actual);
  await f.harness.collect(text([run]));
  const before = f.harness.state.results;
  await f.harness.collect(text([run]));
  assert.deepEqual(f.harness.state.results, before);
  assert.deepEqual(f.harness.state.results[0]?.data, actual);
  assert.deepEqual(f.harness.getCopyResults(), before);
  assert.deepEqual(f.executed, ['run']);
});

test('copying results returns only the latest collected batch and cannot leak another project or session history', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  assert.deepEqual(f.harness.getCopyResults(), []);
  f.setExecute(async (_root, request) => ({ stdout: `actual ${request.id}`, exit_code: 0 }));
  await f.harness.collect(text([run], 'older'));
  await f.harness.collect(text([read], 'latest'));
  assert.equal(f.harness.state.results.length, 1);
  assert.deepEqual(f.harness.state.results, f.harness.getCopyResults());
  const latest = f.harness.getCopyResults()[0]!;
  assert.deepEqual({ ...latest, started_at: undefined, finished_at: undefined }, { batch_id: 'latest', request_id: 'read', tool: 'read_file', status: 'done', data: { stdout: 'actual read', exit_code: 0 }, started_at: undefined, finished_at: undefined });
  assert.ok(latest.finished_at! >= latest.started_at!, '真实执行时长随当前批次结果复制');
  f.setRoot(path.join(f.directory, 'other'));
  assert.deepEqual(f.harness.state.results, []);
  assert.deepEqual(f.harness.getCopyResults(), []);
  await f.harness.collect(text([run], 'latest'));
  assert.equal(f.harness.getCopyResults().length, 1);
  assert.equal(f.harness.getCopyResults()[0]?.request_id, 'run');
  f.setRoot(f.directory);
  assert.deepEqual(f.harness.state.results, []);
  assert.deepEqual(f.harness.getCopyResults(), []);
  f.setSession('new-chat');
  assert.deepEqual(f.harness.getCopyResults(), []);
  await f.harness.collect(text([read], 'latest'));
  assert.equal(f.harness.getCopyResults().length, 1);
  f.setSession('chat');
  assert.deepEqual(f.harness.getCopyResults(), []);
});

test('copying after reopening the IDE is empty until a current batch is actually collected', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  await f.harness.collect(text([run]));
  const reopened = new ToolStore(f.filePath);
  await reopened.ready();
  const next = f.makeHarness(reopened);
  assert.deepEqual(next.state.results, []);
  assert.deepEqual(next.getCopyResults(), []);
  await next.collect(text([run]));
  assert.equal(next.getCopyResults().length, 1);
  assert.equal(next.state.completion, undefined, '历史去重状态恢复不能当作新一轮完成提示');
  assert.equal(next.state.results[0]?.data, undefined, '正文未落盘，重新采集只恢复去重元数据');
  assert.equal(next.state.results[0]?.status, 'done');
  assert.deepEqual(f.executed, ['run']);
});

test('invalid replies, reused IDs and reservation failures cannot expose the previous round output', async t => {
  for (const failure of ['invalid', 'conflict', 'disk'] as const) {
    const f = await fixture(t);
    await f.harness.configure({ permission: 'full' });
    f.setExecute(async () => ({ stdout: 'private previous output', exit_code: 0 }));
    await f.harness.collect(text([run]));
    assert.equal(f.harness.getCopyResults().length, 1);
    let reply = text([read], 'next');
    if (failure === 'invalid') reply = '```mini-ai-tools\n{}\n```';
    if (failure === 'conflict') reply = text([{ ...run, args: { command: 'different', shell: 'powershell' } }]);
    if (failure === 'disk') f.store.reserve = async () => { throw new Error('disk unavailable'); };
    const pending = f.harness.collect(reply);
    assert.deepEqual(f.harness.getCopyResults(), [], `${failure}: 清空不能等到执行后`);
    await pending;
    assert.deepEqual(f.harness.state.results, []);
    assert.deepEqual(f.harness.getCopyResults(), []);
    assert.deepEqual(f.executed, ['run']);
    assert.equal(f.store.getEntries().length, 1);
  }
});

test('late completion from an older running batch does not append output to the latest queued batch', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  const started = deferred<void>();
  const oldOutput = deferred<unknown>();
  const latestStarted = deferred<void>();
  const latestOutput = deferred<unknown>();
  f.setExecute(async (_root, request) => {
    if (request.id === 'run') { started.resolve(); return oldOutput.promise; }
    latestStarted.resolve(); return latestOutput.promise;
  });
  const first = f.harness.collect(text([run], 'older'));
  await started.promise;
  const next = f.harness.collect(text([read], 'latest'));
  assert.deepEqual(f.harness.state.results, []);
  oldOutput.resolve({ stdout: 'old result', exit_code: 0 });
  await latestStarted.promise;
  assert.equal(f.harness.state.completion, undefined, '上一批晚到结果不能触发当前批提示');
  assert.ok(f.harness.state.results.every(r => r.batch_id === 'latest'));
  assert.ok(f.harness.getCopyResults().every(r => r.batch_id === 'latest'));
  latestOutput.resolve({ stdout: 'new result', exit_code: 0 });
  await Promise.all([first, next]);
  assert.deepEqual(f.harness.state.results, f.harness.getCopyResults());
  assert.equal(f.harness.state.results[0]?.batch_id, 'latest');
  assert.deepEqual(f.harness.state.completion, { id: 1, batch_id: 'latest', outcome: 'success' });
  assert.equal(f.store.getEntries().length, 2);
  await f.harness.collect(text([run], 'older'));
  assert.equal(f.harness.state.completion, undefined, '重新查看历史批次不能播放完成提示');
  assert.equal(f.harness.state.results[0]?.data, undefined, '旧批正文已释放，只有去重状态可恢复');
  assert.deepEqual(f.executed, ['run', 'read']);
});

test('malformed, repeated IDs and alternative batches reject the entire reply before any permission or side effect', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  await f.harness.collect(text([read, read]));
  await f.harness.collect(`${text([run])}\n${text([read], 'two')}`);
  await f.harness.collect('```mini-ai-tools\n{}');
  await f.harness.collect(text([run, { ...read, args: { path: 42 } }]));
  assert.deepEqual(f.executed, []);
  assert.deepEqual(f.asked, []);
  assert.deepEqual(f.store.getHistory(), []);
});

test('ordinary replies remain inert and old file operations are rejected without a second execution path', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  for (const [reply, expected] of [['普通讨论', /已采集回复.*没有 mini-ai-tools/], ['### 文件：example.ts\n### 操作：新建\n```typescript\nconsole.log("example");\n```', /不再支持文件操作块/]] as const) {
    await f.harness.collect(reply);
    assert.match(f.harness.state.batchError?.error ?? f.harness.state.message, expected);
    assert.deepEqual(f.executed, []); assert.deepEqual(f.asked, []);
    assert.deepEqual(f.store.getHistory(), []);
  }
});

test('whole-batch modification conflicts fail every request before even an earlier command runs', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  f.setPrepare(async () => { throw new Error('同文件覆盖冲突'); });
  await f.harness.collect(text([run, read]));
  assert.deepEqual(f.executed, []);
  assert.deepEqual(f.harness.state.results.map(r => r.status), ['failed', 'failed']);
});

test('concurrent collection and recollection after restart cannot replay reserved batches', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  await Promise.all([f.harness.collect(text([run])), f.harness.collect(text([run]))]);
  assert.deepEqual(f.executed, ['run']);
  const reopened = new ToolStore(f.filePath);
  await reopened.ready();
  const next = f.makeHarness(reopened);
  await next.collect(text([run]));
  assert.deepEqual(f.executed, ['run']);
  assert.equal(next.state.results.length, 1);
  await next.collect(text([{ ...run, args: { ...run.args, command: 'different' } }]));
  assert.match(next.state.message, /不同内容复用/);
  assert.deepEqual(f.executed, ['run']);
});

test('interrupted state is unknown on restart and never automatically re-executed', async t => {
  const f = await fixture(t);
  const batch = { protocol_version: 1 as const, batch_id: 'batch-1', requests: [run] };
  const reserved = await f.store.reserve(f.directory, 'chat', batch);
  assert.ok(reserved.kind === 'new');
  await f.store.updateResult(reserved.entry.scope, batch.batch_id, 'run', 'running');
  const reopened = new ToolStore(f.filePath);
  await reopened.ready();
  const next = f.makeHarness(reopened);
  await next.collect(text([run]));
  assert.equal(next.state.results[0]?.status, 'unknown');
  assert.equal(next.state.completion, undefined, '恢复不确定执行记录不能发出新的完成事件');
  assert.deepEqual(f.executed, []);
});

test('permission and script changes during approval cannot authorize a different request', async t => {
  const f = await fixture(t);
  f.setAuthorize(async () => { f.setFingerprint('changed-during-dialog'); return 'once'; });
  await f.harness.collect(text([run]));
  assert.equal(f.harness.state.results[0]?.status, 'permission_denied');
  assert.deepEqual(f.executed, []);
  await f.harness.configure({ permission: 'rules' });
  f.setAuthorize(async () => { await f.store.addRule(f.directory, 'changed-during-dialog', 'deny'); return 'remember'; });
  await f.harness.collect(text([run], 'denied-during-dialog'));
  assert.equal(f.harness.state.results.at(-1)?.status, 'permission_denied');
  assert.deepEqual(f.executed, []);
});

test('selected permission is re-read for each request rather than granting the whole batch', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  f.setExecute(async () => { await f.harness.configure({ permission: 'ask' }); return { exit_code: 0 }; });
  await f.harness.collect(text([run, { ...run, id: 'next' }]));
  assert.deepEqual(f.executed, ['run']);
  assert.deepEqual(f.asked, ['next']);
  assert.equal(f.harness.state.results.at(-1)?.status, 'permission_denied');
});

test('full access revoked during durable start waits for approval instead of using the old grant', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  let calls = 0;
  f.setDescribe(async () => {
    calls++;
    if (calls === 2) await f.harness.configure({ permission: 'ask' });
    return { external: false, fingerprint: 'same-script' };
  });
  await f.harness.collect(text([run]));
  assert.deepEqual(f.executed, []);
  assert.deepEqual(f.asked, ['run']);
  assert.equal(f.harness.state.results[0]?.status, 'permission_denied');
});

test('a rule allowing an earlier script fingerprint cannot authorize a script changed just before start', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'rules' });
  await f.store.addRule(f.directory, 'old-script', 'allow');
  let calls = 0;
  f.setDescribe(async () => ({ external: false, fingerprint: ++calls === 1 ? 'old-script' : 'new-script' }));
  await f.harness.collect(text([run]));
  assert.deepEqual(f.executed, []);
  assert.deepEqual(f.asked, ['run']);
  assert.equal(f.harness.state.results[0]?.status, 'permission_denied');
});

test('workspace or browser navigation hides old results while cancelled metadata still prevents replay', async t => {
  const f = await fixture(t);
  f.setAuthorize(async () => { f.setRoot(path.join(f.directory, 'different')); return 'once'; });
  await f.harness.collect(text([run, read]));
  assert.deepEqual(f.harness.state.results, []);
  assert.deepEqual(f.store.getHistory().map(r => r.status), ['cancelled', 'cancelled']);
  assert.deepEqual(f.executed, []);
  f.setRoot(f.directory);
  f.setAuthorize(async () => { f.setSession('different-chat'); return 'once'; });
  await f.harness.collect(text([run], 'navigation'));
  assert.deepEqual(f.harness.state.results, []);
  assert.equal(f.store.getHistory().at(-1)?.status, 'cancelled');
});

test('cancel retains the already-started result and later batches replace output without deleting ledger entries', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  f.setExecute(async () => { f.harness.cancel(); return { exit_code: 0, stdout: 'actual side effect happened' }; });
  await f.harness.collect(text([run, read]));
  assert.deepEqual(f.harness.state.results.map(r => r.status), ['done', 'cancelled']);
  assert.deepEqual(f.executed, ['run']);
  f.setExecute(async () => ({ exit_code: 0 }));
  for (let index = 0; index < 5; index++) {
    await f.harness.collect(text(Array.from({ length: 50 }, (_, id) => ({ ...read, id: `read-${id}` })), `bulk-${index}`));
  }
  assert.equal(f.harness.state.results.length, 50);
  assert.ok(f.harness.state.results.every(r => r.batch_id === 'bulk-4'));
  assert.equal(f.store.getEntries().length, 6);
});

test('batches are serial and pending/running state is observable during approval/execution', async t => {
  const f = await fixture(t);
  const prompt = deferred<'once'>();
  const started = deferred<void>();
  const output = deferred<unknown>();
  const states: string[] = [];
  f.setOnChange(s => { for (const r of s.results) states.push(r.status); });
  f.setAuthorize(async () => { started.resolve(); return prompt.promise; });
  f.setExecute(async () => output.promise);
  const first = f.harness.collect(text([run]));
  await started.promise;
  assert.equal(f.harness.state.busy, true);
  assert.ok(states.includes('pending_permission'));
  prompt.resolve('once');
  // Observe execution directly without time-based polling.
  const executing = deferred<void>();
  f.setExecute(async () => { executing.resolve(); return output.promise; });
  await executing.promise;
  assert.deepEqual(f.executed, ['run']);
  assert.ok(states.includes('running'));
  const second = f.harness.collect(text([run], 'second'));
  assert.deepEqual(f.harness.state.results, [], '新一轮等待时不能继续显示或复制上一轮正文');
  output.resolve({ exit_code: 0 });
  await Promise.all([first, second]);
  assert.deepEqual(f.executed, ['run', 'run']);
  assert.equal(f.harness.state.busy, false);
});

test('cannot reserve on disk means no execution or approval, with an explicit failure message', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.filePath);
  await f.harness.collect(text([run]));
  assert.deepEqual(f.executed, []);
  assert.deepEqual(f.asked, []);
  assert.match(f.harness.state.message, /停止/);
  assert.equal(f.harness.state.busy, false);
});

test('failure to persist completion preserves actual output, stops later side effects and remains unknown after restart', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  const original = f.store.updateResult.bind(f.store);
  f.store.updateResult = async (scope, batch, request, status) => {
    if (status === 'done') throw new Error('disk unavailable');
    await original(scope, batch, request, status);
  };
  f.setExecute(async () => ({ exit_code: 0, stdout: 'command finished before disk failure' }));
  await f.harness.collect(text([run, read]));
  assert.deepEqual(f.executed, ['run']);
  assert.deepEqual(f.harness.state.results.map(r => r.status), ['unknown', 'cancelled']);
  assert.equal(f.harness.state.completion?.outcome, 'error', '落盘失败的不确定结果必须提示异常');
  assert.deepEqual(f.harness.state.results[0]?.data, { exit_code: 0, stdout: 'command finished before disk failure' });
  const reopened = new ToolStore(f.filePath);
  await reopened.ready();
  const next = f.makeHarness(reopened);
  await next.collect(text([run, read]));
  assert.deepEqual(f.executed, ['run']);
  assert.equal(next.state.results[0]?.status, 'unknown');
});

test('a completion event becomes ready only after the entire new batch finishes and remains stable on refresh or duplicate collection', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  const lastStarted = deferred<void>();
  const lastOutput = deferred<unknown>();
  f.setExecute(async (_root, request) => {
    if (request.id === 'run') return { exit_code: 0 };
    lastStarted.resolve();
    return lastOutput.promise;
  });
  const pending = f.harness.collect(text([run, read]));
  await lastStarted.promise;
  assert.equal(f.harness.state.results[0]?.status, 'done');
  assert.equal(f.harness.state.completion, undefined, '单个工具结束不应提前提示整批结果就绪');
  lastOutput.resolve({ content: 'complete output' });
  await pending;
  const completion = { id: 1, batch_id: 'batch-1', outcome: 'success' };
  assert.deepEqual(f.harness.state.completion, completion);
  assert.deepEqual(f.harness.getState().completion, completion);
  await f.harness.configure({ completionSound: true });
  f.harness.report('网页状态更新');
  await f.harness.collect(text([run, read]));
  assert.deepEqual(f.harness.state.completion, completion, '设置、状态刷新和同批去重不能产生新的提示 ID');
  assert.deepEqual(f.executed, ['run', 'read']);
});

test('failed, permission-denied and cancelled new batches finish with an error event', async t => {
  for (const failure of ['execution', 'permission', 'cancel'] as const) {
    const f = await fixture(t);
    if (failure !== 'permission') await f.harness.configure({ permission: 'full' });
    f.setExecute(async () => {
      if (failure === 'execution') throw new Error('command failed');
      f.harness.cancel();
      return { exit_code: 0 };
    });
    await f.harness.collect(text([run, read], failure));
    assert.deepEqual(f.harness.state.completion, { id: 1, batch_id: failure, outcome: 'error', ...(failure !== 'execution' ? { cancelled: true } : {}) });
    assert.ok(f.harness.state.results.some(result => result.status !== 'done'));
  }
});

test('JSON错误可复制准确诊断且不预约，切换项目/会话不保留错误正文', async t => {
  const f = await fixture(t);
  await f.harness.collect('```mini-ai-tools\n{"secret":"private", "requests":[1 2]}\n```');
  assert.equal(f.harness.state.batchError?.status, 'failed');
  assert.match(f.harness.state.batchError!.error, /SyntaxError/);
  assert.match(f.harness.state.batchError!.error, /第 1 行/);
  assert.equal(f.harness.state.message, '工具批次校验失败，未执行');
  assert.deepEqual(f.store.getEntries(), []); assert.deepEqual(f.executed, []);
  f.setSession('different'); assert.equal(f.harness.state.batchError, undefined);
  assert.doesNotMatch(f.harness.state.message, /private/);
});

test('前台启动回执立即展示，独立中断 lookup 只接受当前 scope 当前批次命令', async t => {
  const f = await fixture(t); await f.harness.configure({ permission: 'full' });
  const announced = deferred<void>(); const finish = deferred<unknown>();
  let lateStart: ((data: unknown) => void) | undefined;
  f.setExecute(async (_root, request, started) => {
    if (request.tool !== 'run_command') return { process_id: 'proc-not-a-command', status: 'running' };
    lateStart = started;
    started({ process_id: 'proc-foreground', status: 'running' }); announced.resolve();
    return finish.promise;
  });
  const collecting = f.harness.collect(text([read, run], 'foreground'));
  await announced.promise;
  const running = f.harness.state.results.find(item => item.request_id === 'run')!;
  assert.equal(running.status, 'running'); assert.equal((running.data as any).process_id, 'proc-foreground');
  assert.equal(f.harness.state.busy, true);
  assert.equal(f.harness.getRunningCommand('foreground', 'run'), 'proc-foreground');
  assert.equal(f.harness.getRunningCommand('foreground', 'read'), undefined);
  assert.equal(f.harness.getRunningCommand('old-batch', 'run'), undefined);
  assert.equal(f.harness.getRunningCommand('foreground', 'unknown'), undefined);
  f.setSession('different'); assert.equal(f.harness.getRunningCommand('foreground', 'run'), undefined);
  lateStart?.({ process_id: 'proc-late', status: 'running' }); assert.deepEqual(f.harness.state.results, []);
  finish.resolve({ process_id: 'proc-foreground', status: 'stopped' }); await collecting;
  assert.deepEqual(f.harness.state.results, [], '旧会话的结束不能恢复旧命令控制入口');
});

test('单命令中断只跳过其显式依赖，无关后续请求仍执行', async t => {
  const f = await fixture(t); await f.harness.configure({ permission: 'full' });
  const announced = deferred<void>(); const finish = deferred<unknown>();
  f.setExecute(async (_root, request, started) => {
    if (request.tool !== 'run_command') return { content: 'unrelated request completed' };
    started({ process_id: 'proc-single', status: 'running' }); announced.resolve();
    return finish.promise;
  });
  const collecting = f.harness.collect(text([run, { ...read, id: 'dependent', depends_on: ['run'] }, { ...read, id: 'independent' }], 'single-stop'));
  await announced.promise;
  assert.equal(f.harness.getRunningCommand('single-stop', 'run'), 'proc-single');
  finish.resolve({ process_id: 'proc-single', status: 'stopped', timed_out: false }); await collecting;
  assert.deepEqual(f.executed, ['run', 'independent']);
  assert.deepEqual(f.harness.state.results.map(item => item.status), ['cancelled', 'skipped_dependency', 'done']);
  assert.equal(f.harness.getRunningCommand('single-stop', 'run'), undefined);
});

test('后台残余树允许单独重试，已结束/切换批次/切换项目不能命中旧进程', async t => {
  const f = await fixture(t); await f.harness.configure({ permission: 'full' });
  let snapshot: unknown = { process_id: 'proc-owned', status: 'failed', cleanup_pending: true };
  f.setSnapshot(() => snapshot); f.setExecute(async () => snapshot);
  await f.harness.collect(text([run], 'cleanup'));
  assert.equal(f.harness.getRunningCommand('cleanup', 'run'), 'proc-owned');
  snapshot = { process_id: 'proc-owned', status: 'done', cleanup_pending: false }; f.harness.refreshProcesses();
  assert.equal(f.harness.getRunningCommand('cleanup', 'run'), undefined);
  snapshot = { process_id: 'proc-next', status: 'running' };
  await f.harness.collect(text([run], 'next'));
  assert.equal(f.harness.getRunningCommand('cleanup', 'run'), undefined);
  assert.equal(f.harness.getRunningCommand('next', 'run'), 'proc-next');
  f.setRoot(path.join(f.directory, 'another-project'));
  assert.equal(f.harness.getRunningCommand('next', 'run'), undefined);
});

test('changing session clears completion and old running work cannot notify or contaminate the new round', async t => {
  const f = await fixture(t);
  await f.harness.configure({ permission: 'full' });
  await f.harness.collect(text([read], 'first'));
  assert.equal(f.harness.state.completion?.id, 1);
  const oldStarted = deferred<void>();
  const oldOutput = deferred<unknown>();
  const newStarted = deferred<void>();
  const newOutput = deferred<unknown>();
  f.setExecute(async (_root, request) => {
    if (request.id === 'run') { oldStarted.resolve(); return oldOutput.promise; }
    newStarted.resolve(); return newOutput.promise;
  });
  const old = f.harness.collect(text([run], 'old-session'));
  await oldStarted.promise;
  f.setSession('new-chat');
  assert.equal(f.harness.state.completion, undefined);
  const current = f.harness.collect(text([read], 'new-session'));
  oldOutput.resolve({ exit_code: 0, stdout: 'old output' });
  await newStarted.promise;
  assert.equal(f.harness.state.completion, undefined, '旧会话结束不能打断当前批状态');
  assert.ok(f.harness.state.results.every(result => result.batch_id === 'new-session'));
  newOutput.resolve({ content: 'new output' });
  await Promise.all([old, current]);
  assert.deepEqual(f.harness.state.completion, { id: 2, batch_id: 'new-session', outcome: 'success' });
  assert.deepEqual(f.harness.state.results.map(result => result.data), [{ content: 'new output' }]);
  f.setSession('chat');
  assert.equal(f.harness.state.completion, undefined);
});
