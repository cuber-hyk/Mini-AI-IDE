import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { validateToolArgs, type ToolName } from '../../shared/toolProtocol';
import { resolveToolPath } from './files';

const OUTPUT_LIMIT = 1_000_000;
const PROCESS_LIMIT = 100;
interface Chunk { stream: 'stdout' | 'stderr'; text: string; start: number }
interface OwnedProcess {
  id: string; child: ChildProcessWithoutNullStreams; status: 'running' | 'done' | 'failed' | 'stopped';
  chunks: Chunk[]; chars: number; total: number; stdout: string; stderr: string; truncated: boolean;
  exitCode: number | null; signal: string | null; timedOut: boolean; error: string | null;
  startedAt: number; finishedAt: number | null;
  timer: ReturnType<typeof setTimeout>; completion: Promise<void>; finish: () => void; stopping: Promise<void> | null;
  timeoutFailure: Promise<void>; reportTimeoutFailure: () => void;
  remaining: Map<number, WindowsProcess>;
}

interface WindowsProcess { pid: number; parent: number; created: string }

/** taskkill 枚举后仍可能有子进程启动，保留身份快照再核对剩余后代。 */
async function windowsSnapshot(): Promise<WindowsProcess[]> {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString("o")} } | ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => {
    const query = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    query.stdout.on('data', b => { output += String(b); }); query.stderr.on('data', b => { error += String(b); });
    query.once('error', reject);
    query.once('close', code => {
      if (code !== 0) { reject(new Error(`无法核对 IDE 子进程树：${error}`)); return; }
      try { const parsed: unknown = JSON.parse(output); resolve((Array.isArray(parsed) ? parsed : [parsed]) as WindowsProcess[]); }
      catch (reason) { reject(reason); }
    });
  });
}

async function windowsKill(pid: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.once('error', reject); killer.once('close', resolve);
  });
}

export class ToolProcesses {
  private readonly processes = new Map<string, OwnedProcess>();
  private stopGeneration = 0;
  constructor(private readonly onChanged?: () => void) {}

  get hasRunning(): boolean {
    return [...this.processes.values()].some(p => p.status === 'running' || p.stopping !== null || p.remaining.size > 0);
  }

  snapshot(processId: string) {
    const owned = this.processes.get(processId);
    return owned ? this.summary(owned) : undefined;
  }

  async execute(root: string, tool: ToolName, args: Record<string, unknown>, onStarted?: (data: unknown) => void): Promise<unknown> {
    const invalid = validateToolArgs(tool, args); if (invalid) throw new Error(invalid);
    if (tool === 'run_command') return this.run(root, args, onStarted);
    const owned = this.processes.get(args.process_id as string);
    if (!owned) throw new Error('process_id 不属于此 IDE 会话，不能查询或停止任意系统进程');
    if (tool === 'stop_process') { await this.stop(owned); return this.summary(owned); }
    if (tool !== 'get_process_output') throw new Error(`进程工具不支持 ${tool}`);
    const cursor = (args.cursor as number | undefined) ?? 0; const limit = (args.limit as number | undefined) ?? 50_000;
    if (cursor > owned.chars) throw new Error('cursor 超过已保留输出范围');
    const end = Math.min(owned.chars, cursor + limit);
    const chunks = owned.chunks.filter(c => c.start + c.text.length > cursor && c.start < end)
      .map(c => ({ stream: c.stream, text: c.text.slice(Math.max(0, cursor - c.start), end - c.start) }));
    return { ...this.summary(owned, false), output: chunks.map(c => c.text).join(''), chunks, cursor, next_cursor: end, has_more: end < owned.chars,
      stdout: chunks.filter(c => c.stream === 'stdout').map(c => c.text).join(''), stderr: chunks.filter(c => c.stream === 'stderr').map(c => c.text).join('') };
  }

  private summary(p: OwnedProcess, includeOutput = true) {
    return { process_id: p.id, status: p.status, exit_code: p.exitCode, signal: p.signal, timed_out: p.timedOut,
      truncated: p.truncated, total_chars: p.total, retained_chars: p.chars, error: p.error,
      started_at: p.startedAt, finished_at: p.finishedAt, duration_ms: Math.max(0, (p.finishedAt ?? Date.now()) - p.startedAt),
      cleanup_pending: p.remaining.size > 0 || p.stopping !== null,
      ...(includeOutput ? { stdout: p.stdout, stderr: p.stderr } : {}) };
  }

  private append(p: OwnedProcess, stream: Chunk['stream'], text: string) {
    p.total += text.length;
    const canRecord = p.chunks.length < 65_536 || p.chunks[p.chunks.length - 1]?.stream === stream;
    const kept = canRecord ? text.slice(0, Math.max(0, OUTPUT_LIMIT - p.chars)) : '';
    if (kept) {
      const last = p.chunks[p.chunks.length - 1];
      // 合并同一流的相邻小片段，避免无界元数据增长。
      if (last?.stream === stream) last.text += kept;
      else p.chunks.push({ stream, text: kept, start: p.chars });
      p.chars += kept.length; p[stream] += kept;
    }
    if (kept.length < text.length) p.truncated = true;
  }

  private async run(root: string, args: Record<string, unknown>, onStarted?: (data: unknown) => void) {
    const generation = this.stopGeneration;
    for (const [id, p] of this.processes) { if (this.processes.size < PROCESS_LIMIT) break; if (p.status !== 'running' && !p.stopping && !p.remaining.size) this.processes.delete(id); }
    if (this.processes.size >= PROCESS_LIMIT) throw new Error('后台进程数量达到上限，请先停止已有进程');
    const cwd = await resolveToolPath(root, args.cwd as string | undefined);
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('命令工作目录不是目录');
    if (generation !== this.stopGeneration) throw new Error('命令已取消，未启动进程');
    const powershell = args.shell === 'powershell';
    const executable = powershell ? (process.platform === 'win32' ? 'powershell.exe' : 'pwsh') : 'bash';
    const shellArgs = powershell
      ? ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; ${args.command as string}`]
      : ['--noprofile', '--norc', '-c', args.command as string];
    const startedAt = Date.now();
    const child = spawn(executable, shellArgs, { cwd, windowsHide: true, shell: false, stdio: 'pipe', detached: process.platform !== 'win32' });
    let finish!: () => void; const completion = new Promise<void>(resolve => { finish = resolve; });
    let reportTimeoutFailure!: () => void; const timeoutFailure = new Promise<void>(resolve => { reportTimeoutFailure = resolve; });
    const id = `proc-${randomUUID()}`;
    const p: OwnedProcess = { id, child, status: 'running', chunks: [], chars: 0, total: 0, stdout: '', stderr: '', truncated: false,
      exitCode: null, signal: null, timedOut: false, error: null, startedAt, finishedAt: null, timer: setTimeout(() => {}, 0), completion, finish, stopping: null,
      timeoutFailure, reportTimeoutFailure, remaining: new Map() };
    clearTimeout(p.timer);
    const timeout = (args.timeout_ms as number | undefined) ?? 120_000;
    p.timer = setTimeout(() => {
      p.timedOut = true;
      void this.stop(p).catch(error => {
        p.error = `命令超时，但停止失败，进程可能仍在运行：${String(error)}`;
        p.reportTimeoutFailure(); this.onChanged?.();
      });
    }, timeout);
    this.processes.set(id, p);
    const stdout = new StringDecoder('utf8'); const stderr = new StringDecoder('utf8');
    child.stdout.on('data', (buffer: Buffer) => this.append(p, 'stdout', stdout.write(buffer)));
    child.stderr.on('data', (buffer: Buffer) => this.append(p, 'stderr', stderr.write(buffer)));
    child.stdin.end();
    child.on('error', error => {
      p.error = `无法运行 ${powershell ? 'PowerShell' : 'Bash'} (${executable})：${error.message}`;
      p.status = 'failed'; p.finishedAt ??= Date.now(); clearTimeout(p.timer); p.finish();
      if (!p.stopping) this.onChanged?.();
    });
    child.on('close', (code, signal) => {
      this.append(p, 'stdout', stdout.end()); this.append(p, 'stderr', stderr.end());
      p.exitCode = code; p.signal = signal;
      if (p.status === 'running') p.status = code === 0 ? 'done' : 'failed';
      p.finishedAt ??= Date.now();
      clearTimeout(p.timer); p.finish();
      if (!p.stopping) this.onChanged?.();
    });
    // 等待 spawn/error，以免将不存在的 shell 报成成功的后台任务。
    const spawned = await new Promise<boolean>(resolve => { child.once('spawn', () => resolve(true)); child.once('error', () => resolve(false)); });
    if (spawned) onStarted?.(this.summary(p));
    if (args.background !== true || p.error) {
      await Promise.race([p.completion, p.timeoutFailure]);
      if (p.stopping) {
        try { await p.stopping; }
        // stop 已记录错误及残余身份，保留命令输出供查询和重试。
        catch { return this.summary(p); }
      }
    }
    return this.summary(p);
  }

  private async stop(p: OwnedProcess): Promise<void> {
    if (p.stopping) return p.stopping;
    if (p.status !== 'running' && p.remaining.size === 0) return;
    const stopping = (async () => {
      if (!p.child.pid) return;
      if (process.platform === 'win32') {
        const first = await windowsSnapshot();
        const root = first.find(item => item.pid === p.child.pid);
        const identities = new Map([...p.remaining].filter(([pid, identity]) => first.some(item => item.pid === pid && item.created === identity.created)));
        if (root && p.status === 'running') identities.set(root.pid, root);
        const collect = (snapshot: WindowsProcess[], cutoff?: number) => {
          let added: boolean;
          do {
            added = false;
            for (const item of snapshot) {
              const parent = identities.get(item.parent);
              if (!parent || identities.has(item.pid) || item.created < parent.created || (cutoff !== undefined && Date.parse(item.created) > cutoff)) continue;
              identities.set(item.pid, item); added = true;
            }
          } while (added);
        };
        collect(first);
        p.remaining = new Map(identities);
        if (root && p.status === 'running') {
          const code = await windowsKill(p.child.pid);
          if (code !== 0 && p.status === 'running') throw new Error(`无法停止进程树，taskkill 退出码 ${code}`);
        }
        const cutoff = Date.now();
        // 只处理由上述真实父子关系证明归属的剩余对象，创建时间避免 PID 复用。
        const after = await windowsSnapshot(); collect(after, cutoff);
        p.remaining = new Map(after.filter(item => identities.get(item.pid)?.created === item.created).map(item => [item.pid, item]));
        for (const item of [...after].reverse()) {
          if (item.pid === p.child.pid || identities.get(item.pid)?.created !== item.created) continue;
          const code = await windowsKill(item.pid);
          if (code !== 0 && (await windowsSnapshot()).some(current => current.pid === item.pid && current.created === item.created)) {
            throw new Error(`IDE 子进程树清理失败，taskkill 退出码 ${code}`);
          }
          p.remaining.delete(item.pid);
        }
      } else {
        try { process.kill(-p.child.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await p.completion;
      p.remaining.clear();
      // 树清理成功且实际退出后才标记 stopped；失败不能伪报停止成功。
      if (p.status !== 'done') p.status = 'stopped';
    })();
    p.stopping = stopping;
    try { await stopping; }
    catch (error) { p.error = `停止失败：${String(error)}`; throw error; }
    finally { p.stopping = null; this.onChanged?.(); }
  }

  async dispose(): Promise<void> {
    this.stopGeneration++;
    const results = await Promise.allSettled([...this.processes.values()].map(p => this.stop(p)));
    const failed = results.find(r => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
