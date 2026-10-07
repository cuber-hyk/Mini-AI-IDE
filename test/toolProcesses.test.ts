import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { ToolProcesses } from '../src/main/tools/processes';

const shell = process.platform === 'win32' ? 'powershell' : 'bash';
function nodeCommand(scriptPath: string) {
  const quote = (s: string) => `'${s.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''")}'`;
  return process.platform === 'win32' ? `& ${quote(process.execPath)} ${quote(scriptPath)}; exit $LASTEXITCODE` : `${quote(process.execPath)} ${quote(scriptPath)}`;
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }, script: string, onChanged?: () => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-command-')); const processes = new ToolProcesses(onChanged);
  t.after(async () => { await processes.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, 'command.cjs'); await fs.writeFile(file, script);
  return { root, processes, command: nodeCommand(file) };
}
async function waitFor(processes: ToolProcesses, root: string, id: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const output = await processes.execute(root, 'get_process_output', { process_id: id }) as any;
    if (output.status !== 'running') return output;
    assert.ok(Date.now() < deadline, '后台进程必须在测试时限内结束'); await delay(50);
  }
}

test('真实命令返回独立标准输出、错误输出、当前目录和非零退出码', async t => {
  const { root, processes, command } = await fixture(t, "console.log('中文 '+process.cwd()); console.error('actual stderr'); process.exitCode=7;");
  const result = await processes.execute(root, 'run_command', { command, shell }) as any;
  assert.equal(result.status, 'failed'); assert.equal(result.exit_code, 7);
  assert.ok(result.stdout.includes('中文')); assert.ok(result.stdout.toLowerCase().includes(root.toLowerCase()));
  assert.match(result.stderr, /actual stderr/); assert.equal(result.timed_out, false);
});

test('后台任务先返回 ID，字符游标分页不会重复或漏掉输出', async t => {
  const { root, processes, command } = await fixture(t, "setTimeout(()=>{ process.stdout.write('abcdefgh'); process.stderr.write('ERROR'); },100);");
  const started = await processes.execute(root, 'run_command', { command, shell, background: true }) as any;
  assert.equal(started.status, 'running'); const final = await waitFor(processes, root, started.process_id);
  assert.equal(final.exit_code, 0);
  const first = await processes.execute(root, 'get_process_output', { process_id: started.process_id, limit: 3 }) as any;
  const second = await processes.execute(root, 'get_process_output', { process_id: started.process_id, cursor: first.next_cursor }) as any;
  assert.equal(first.output.length, 3); assert.equal(first.output + second.output, final.output);
  assert.equal(first.stdout + second.stdout, 'abcdefgh'); assert.equal(first.stderr + second.stderr, 'ERROR');
  await assert.rejects(processes.execute(root, 'get_process_output', { process_id: started.process_id, cursor: 999 }), /cursor/);
});

test('超时终止真正子进程，并标记超时事实', async t => {
  const { root, processes, command } = await fixture(t, 'setInterval(()=>{},1000);');
  const start = Date.now();
  const result = await processes.execute(root, 'run_command', { command, shell, timeout_ms: 500 }) as any;
  assert.equal(result.timed_out, true); assert.equal(result.status, 'stopped'); assert.ok(Date.now() - start < 10_000);
  assert.equal(processes.hasRunning, false, '前台超时返回前必须等待停止清理完成');
  assert.equal(result.duration_ms, result.finished_at - result.started_at);
});

test('显式停止只接受 IDE 进程 ID，dispose 停止其余后台任务', async t => {
  const { root, processes, command } = await fixture(t, 'setInterval(()=>{},1000);');
  await assert.rejects(processes.execute(root, 'stop_process', { process_id: 'proc-external' }), /不属于/);
  const started = await processes.execute(root, 'run_command', { command, shell, background: true }) as any;
  await delay(150);
  const stopped = await processes.execute(root, 'stop_process', { process_id: started.process_id }) as any;
  assert.notEqual(stopped.status, 'running'); assert.equal(stopped.timed_out, false);
  const second = await processes.execute(root, 'run_command', { command, shell, background: true }) as any;
  assert.equal(second.status, 'running'); await processes.dispose();
  const disposed = await processes.execute(root, 'get_process_output', { process_id: second.process_id }) as any;
  assert.notEqual(disposed.status, 'running');
  const again = await processes.execute(root, 'run_command', { command: process.platform === 'win32' ? 'Write-Output resumed' : 'printf resumed', shell }) as any;
  assert.equal(again.status, 'done'); assert.match(again.stdout, /resumed/);
});

test('长输出明确截断而保留真实字符总量', async t => {
  const { root, processes, command } = await fixture(t, "process.stdout.write('x'.repeat(1_010_000));");
  const result = await processes.execute(root, 'run_command', { command, shell }) as any;
  assert.equal(result.exit_code, 0); assert.equal(result.stdout.length, 1_000_000);
  assert.equal(result.retained_chars, 1_000_000); assert.equal(result.total_chars, 1_010_000); assert.equal(result.truncated, true);
});

test('错误 cwd 和不存在的 shell 明确失败，不替换为另一种 shell', async t => {
  const { root, processes } = await fixture(t, '');
  await assert.rejects(processes.execute(root, 'run_command', { command: 'echo unexpected', shell, cwd: 'command.cjs' }), /不是目录/);
  // 使用临时 PATH，保证 Bash 不存在；若静默改用 PowerShell 会输出 unexpected。
  const original = process.env.PATH; process.env.PATH = root;
  try {
    let announced = false;
    const result = await processes.execute(root, 'run_command', { command: 'echo unexpected', shell: 'bash', background: true }, () => { announced = true; }) as any;
    assert.equal(result.status, 'failed'); assert.match(result.error, /ENOENT/); assert.equal(result.stdout, '');
    assert.equal(announced, false, '没有真正 spawn 的 shell 不能发布运行进程');
    assert.equal(processes.hasRunning, false); assert.ok(Number.isInteger(result.finished_at));
    assert.equal(result.duration_ms, result.finished_at - result.started_at);
  } finally { process.env.PATH = original; }
});

test('前台计时从实际启动到退出，查询和快照保持同一冻结时长', async t => {
  const { root, processes, command } = await fixture(t, 'setTimeout(()=>console.log("finished"),120);');
  const before = Date.now(); const result = await processes.execute(root, 'run_command', { command, shell }) as any;
  assert.ok(result.started_at >= before); assert.ok(result.finished_at <= Date.now());
  assert.ok(result.duration_ms >= 120); assert.equal(result.duration_ms, result.finished_at - result.started_at);
  assert.equal(processes.hasRunning, false); await delay(80);
  const queried = await processes.execute(root, 'get_process_output', { process_id: result.process_id }) as any;
  assert.equal(queried.duration_ms, result.duration_ms); assert.equal(queried.finished_at, result.finished_at);
  assert.deepEqual(processes.snapshot(result.process_id), result);
  assert.equal(processes.snapshot('proc-external'), undefined);
});

test('前台真实启动即发布进程 ID，独立停止不能影响另一条后台命令', async t => {
  const { root, processes, command } = await fixture(t, 'setInterval(()=>{},1000);');
  const background = await processes.execute(root, 'run_command', { command, shell, background: true }) as any;
  let announce!: (data: unknown) => void; const started = new Promise<unknown>(resolve => { announce = resolve; });
  let completed = false;
  const foreground = processes.execute(root, 'run_command', { command, shell }, announce).then(data => { completed = true; return data as any; });
  const running = await started as any;
  assert.equal(running.status, 'running'); assert.match(running.process_id, /^proc-/); assert.equal(running.finished_at, null);
  assert.equal(completed, false, '前台完成前必须拿到可单独控制的 ID');
  const stopped = await processes.execute(root, 'stop_process', { process_id: running.process_id }) as any;
  assert.equal(stopped.status, 'stopped'); assert.equal((await foreground).process_id, running.process_id);
  assert.equal(processes.snapshot(background.process_id)!.status, 'running'); assert.equal(processes.hasRunning, true);
});

test('后台计时实时增长，完成通知包含最终输出与真实结束时间', async t => {
  let processes!: ToolProcesses; let id = ''; const notifications: any[] = [];
  const fixtureResult = await fixture(t, 'setTimeout(()=>console.log("background complete"),500);', () => {
    notifications.push({ running: processes.hasRunning, snapshot: processes.snapshot(id) });
  });
  processes = fixtureResult.processes;
  const result = await processes.execute(fixtureResult.root, 'run_command', { command: fixtureResult.command, shell, background: true }) as any;
  id = result.process_id; assert.equal(processes.hasRunning, true); assert.equal(result.finished_at, null);
  await delay(80); const ongoing = processes.snapshot(id)!;
  assert.equal(ongoing.status, 'running'); assert.equal(ongoing.finished_at, null); assert.ok(ongoing.duration_ms > result.duration_ms);
  assert.equal(result.finished_at, null, '旧结果快照不会被后续状态原地修改');
  await waitFor(processes, fixtureResult.root, id);
  assert.equal(processes.hasRunning, false); assert.ok(notifications.length > 0);
  const last = notifications.at(-1); assert.equal(last.running, false); assert.equal(last.snapshot.status, 'done');
  assert.match(last.snapshot.stdout, /background complete/); assert.ok(Number.isInteger(last.snapshot.finished_at));
});

test('停止通知等进程树清理完成才发出，实际退出后计时冻结', async t => {
  let processes!: ToolProcesses; let id = ''; const notifications: any[] = [];
  const fixtureResult = await fixture(t, 'setInterval(()=>{},1000);', () => {
    notifications.push({ running: processes.hasRunning, snapshot: processes.snapshot(id) });
  });
  processes = fixtureResult.processes;
  const result = await processes.execute(fixtureResult.root, 'run_command', { command: fixtureResult.command, shell, background: true }) as any;
  id = result.process_id;
  const stopping = processes.execute(fixtureResult.root, 'stop_process', { process_id: id });
  assert.equal(processes.hasRunning, true);
  const stopped = await stopping as any;
  assert.equal(stopped.status, 'stopped'); assert.equal(processes.hasRunning, false);
  assert.equal(notifications.length, 1, '停止中 close 不能提前通知，再在完成时重复通知');
  assert.equal(notifications[0].running, false); assert.equal(notifications[0].snapshot.status, 'stopped');
  assert.equal(stopped.duration_ms, stopped.finished_at - stopped.started_at);
  await delay(80); assert.equal(processes.snapshot(id)!.duration_ms, stopped.duration_ms);
});

test('停止失败保留运行状态与实时计时，恢复后可以再次停止', async t => {
  const { root, processes, command } = await fixture(t, 'setInterval(()=>{},1000);');
  const started = await processes.execute(root, 'run_command', { command, shell, background: true }) as any;
  const originalPath = process.env.PATH; const originalKill = process.kill;
  try {
    if (process.platform === 'win32') process.env.PATH = root;
    else process.kill = (() => { throw Object.assign(new Error('stop denied'), { code: 'EPERM' }); }) as typeof process.kill;
    await assert.rejects(processes.execute(root, 'stop_process', { process_id: started.process_id }), /ENOENT|stop denied/);
    const failed = processes.snapshot(started.process_id)!;
    assert.equal(failed.status, 'running'); assert.equal(failed.finished_at, null); assert.equal(processes.hasRunning, true);
    await delay(60); assert.ok(processes.snapshot(started.process_id)!.duration_ms > failed.duration_ms);
  } finally { process.env.PATH = originalPath; process.kill = originalKill; }
  const stopped = await processes.execute(root, 'stop_process', { process_id: started.process_id }) as any;
  assert.equal(stopped.status, 'stopped'); assert.equal(processes.hasRunning, false);
});

test('前台超时停止失败可返回错误事实，但不能伪造已退出或结束时间', async t => {
  const { root, processes, command } = await fixture(t, 'setInterval(()=>{},1000);');
  const originalPath = process.env.PATH; const originalKill = process.kill;
  let result: any;
  try {
    const pending = processes.execute(root, 'run_command', { command, shell, timeout_ms: 500 });
    const deadline = Date.now() + 5_000;
    while (!processes.hasRunning) { assert.ok(Date.now() < deadline, '命令必须在时限内启动'); await delay(5); }
    if (process.platform === 'win32') process.env.PATH = root;
    else process.kill = (() => { throw Object.assign(new Error('timeout stop denied'), { code: 'EPERM' }); }) as typeof process.kill;
    result = await pending;
    assert.equal(result.timed_out, true); assert.equal(result.status, 'running'); assert.equal(result.finished_at, null);
    assert.match(result.error, /停止失败，进程可能仍在运行/); assert.equal(processes.hasRunning, true);
    await delay(60); assert.ok(processes.snapshot(result.process_id)!.duration_ms > result.duration_ms);
  } finally { process.env.PATH = originalPath; process.kill = originalKill; }
  const stopped = await processes.execute(root, 'stop_process', { process_id: result.process_id }) as any;
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.timed_out, true); assert.equal(processes.hasRunning, false);
  assert.ok(Number.isInteger(stopped.finished_at)); assert.equal(stopped.duration_ms, stopped.finished_at - stopped.started_at);
});

test('路径校验尚未完成时停止，命令不会迟到启动且后续新命令仍可运行', async t => {
  const { root, processes, command } = await fixture(t, 'require("node:fs").writeFileSync("unexpected.txt","late spawn");');
  const pending = processes.execute(root, 'run_command', { command, shell, background: true });
  const rejection = assert.rejects(pending, /命令已取消，未启动进程/);
  await processes.dispose(); await rejection;
  await assert.rejects(fs.stat(path.join(root, 'unexpected.txt')), { code: 'ENOENT' });
  assert.equal(processes.hasRunning, false);
  const fresh = await processes.execute(root, 'run_command', { command, shell }) as any;
  assert.equal(fresh.status, 'done'); assert.equal(await fs.readFile(path.join(root, 'unexpected.txt'), 'utf8'), 'late spawn');
});

test('Windows 残余后代停止失败保留归属供重试，PID 复用不能误杀', async t => {
  const { root, processes } = await fixture(t, '');
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
  let owned!: EventEmitter; let queryCount = 0; let retry = false; let replaced = false;
  const killed: number[] = [];
  const ancestor = { pid: 50101, parent: 1, created: '2026-01-01T00:00:00.000Z' };
  const descendant = { pid: 50102, parent: ancestor.pid, created: '2026-01-01T00:00:01.000Z' };
  const unrelated = { pid: 50103, parent: 1, created: '2026-01-01T00:00:01.000Z' };
  const spawn = t.mock.method(childProcess, 'spawn', ((executable: string, args: string[]) => {
    const fake = Object.assign(new EventEmitter(), { pid: ancestor.pid, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    setImmediate(() => {
      if (executable === 'taskkill.exe') {
        const pid = Number(args[1]); killed.push(pid);
        if (pid === ancestor.pid) { owned.emit('close', 1, null); fake.emit('close', 0); }
        else fake.emit('close', retry ? 0 : 1);
      } else if (args.some(arg => arg.startsWith('Get-CimInstance Win32_Process'))) {
        const items = queryCount++ === 0 ? [ancestor, descendant, unrelated]
          : [replaced ? { ...descendant, created: '2026-01-01T00:00:02.000Z' } : descendant, unrelated];
        fake.stdout.write(JSON.stringify(items)); fake.emit('close', 0);
      } else { owned = fake; fake.stdout.write('fixture stdout'); fake.emit('spawn'); }
    });
    return fake;
  }) as typeof childProcess.spawn);
  try {
    const started = await processes.execute(root, 'run_command', { command: 'fixture', shell: 'powershell', background: true }) as any;
    await assert.rejects(processes.execute(root, 'stop_process', { process_id: started.process_id }), /子进程树清理失败/);
    const failed = processes.snapshot(started.process_id)!;
    assert.equal(failed.status, 'failed'); assert.match(failed.error!, /停止失败/); assert.ok(Number.isInteger(failed.finished_at));
    assert.equal(processes.hasRunning, true, '主进程已退出，但已证明归属的残余后代仍可重试');
    retry = true;
    const stopped = await processes.execute(root, 'stop_process', { process_id: started.process_id }) as any;
    assert.equal(stopped.status, 'stopped'); assert.equal(processes.hasRunning, false);
    assert.deepEqual(killed, [ancestor.pid, descendant.pid, descendant.pid]);

    queryCount = 0; retry = false; killed.length = 0;
    const next = await processes.execute(root, 'run_command', { command: 'fixture', shell: 'powershell', background: true }) as any;
    await assert.rejects(processes.execute(root, 'stop_process', { process_id: next.process_id }), /子进程树清理失败/);
    replaced = true; retry = true;
    await processes.execute(root, 'stop_process', { process_id: next.process_id });
    assert.deepEqual(killed, [ancestor.pid, descendant.pid], '同 PID 的新对象和无关进程不能被重试终止');
    assert.equal(processes.hasRunning, false);

    queryCount = 0; retry = false; replaced = false;
    const foreground = processes.execute(root, 'run_command', { command: 'fixture', shell: 'powershell' })
      .then(value => ({ value: value as any }), error => ({ error }));
    const deadline = Date.now() + 5_000;
    while (!processes.hasRunning) { assert.ok(Date.now() < deadline); await delay(5); }
    await assert.rejects(processes.dispose(), /子进程树清理失败/);
    const outcome = await foreground; const stillOwned = processes.hasRunning;
    retry = true; await processes.dispose();
    assert.ok('value' in outcome, '前台停止失败必须保留实际 summary，不能只抛通用错误');
    assert.match(outcome.value.process_id, /^proc-/); assert.equal(outcome.value.stdout, 'fixture stdout');
    assert.match(outcome.value.error, /停止失败/); assert.equal(outcome.value.status, 'failed');
    assert.equal(outcome.value.cleanup_pending, true); assert.equal(stillOwned, true);
  } finally {
    // 断言失败时也必须在 fake helper 有效期间清理，不能将测试 PID 交给真实 taskkill。
    retry = true; replaced = false; queryCount = 0;
    try { await processes.dispose(); }
    finally { spawn.mock.restore(); Object.defineProperty(process, 'platform', originalPlatform); }
  }
});
