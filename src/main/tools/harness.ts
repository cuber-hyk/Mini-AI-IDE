import { parseToolBatch, ToolBatch, ToolBatchError, ToolRequest, ToolResult, ToolState } from '../../shared/toolProtocol';
import { LedgerEntry, ToolStore } from './store';

interface HarnessOptions {
  store: ToolStore;
  root: () => string | null;
  session: () => string;
  execute: (root: string, request: ToolRequest, started: (data: unknown) => void, selection: ToolSelection) => Promise<unknown>;
  selected?: (selection: ToolSelection | null) => void;
  diagnosed?: (diagnostic: ToolDiagnostic) => void;
  stopped?: (selection: ToolSelection, error: string) => void;
  authorize: (root: string, request: ToolRequest) => Promise<'once' | 'remember' | 'deny'>;
  describe: (root: string, request: ToolRequest) => Promise<{ external: boolean; fingerprint: string }>;
  /** 只做静态全批冲突校验，不读取未经授权的目标。 */
  prepare?: (root: string, batch: ToolBatch) => Promise<void>;
  changed: (state: ToolState) => void;
  snapshotProcess?: (id: string) => unknown;
}
export interface ToolSelection {
  root: string;
  session: string;
  batch: ToolBatch;
}
/** 仅主进程持有的本次解析事实；不是工具执行 completion，不进入复制正文。 */
export interface ToolDiagnostic {
  id: number;
  root: string | null;
  session: string;
  sourceText: string;
  error: ToolBatchError;
  cancelled?: boolean;
}
interface BatchSelection extends ToolSelection {
  executed?: boolean;
  notified?: boolean;
  cancelled?: boolean;
}
// 结果归属本次采集对象，避免较早排队批次的迟到输出进入最近一轮。
interface SelectedEntry extends LedgerEntry { selection: BatchSelection }
const PROJECT_READ = new Set(['get_project_info', 'list_directory', 'search_files', 'read_file', 'search_text', 'load_skill']);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const failedData = (request: ToolRequest, data: unknown) => {
  // 查询和停止工具返回的是被管理进程的状态；非零退出属于资料，不代表工具调用失败。
  if (request.tool === 'get_process_output' || request.tool === 'stop_process') return false;
  if (!data || typeof data !== 'object') return false;
  const result = data as Record<string, unknown>;
  return result.ok === false || result.status === 'failed' || result.timed_out === true || (typeof result.exit_code === 'number' && result.exit_code !== 0);
};

/** 一个确定的工具批次入口。执行、审批和去重都由 IDE 负责。 */
export class ToolHarness {
  private queue: Promise<void> = Promise.resolve();
  private waiting = 0;
  private generation = 0;
  private results: Array<{ key: string; result: ToolResult }> = [];
  private message = '';
  private selection: BatchSelection | null = null;
  private completion: ToolState['completion'];
  private completionId = 0;
  private diagnostic: ToolDiagnostic | null = null;
  private diagnosticId = 0;

  constructor(private readonly options: HarnessOptions) {}

  getState(): ToolState {
    const results = this.getCopyResults();
    return { config: this.options.store.getConfig(), results, message: this.message, busy: this.waiting > 0, ...(this.diagnostic ? { batchError: { ...this.diagnostic.error } } : {}), ...(this.completion ? { completion: { ...this.completion } } : {}) };
  }
  get state(): ToolState { return this.getState(); }
  getDiagnostic(): ToolDiagnostic | null {
    this.getCopyResults();
    return this.diagnostic ? { ...this.diagnostic, error: { ...this.diagnostic.error } } : null;
  }
  matchesBatch(batch: ToolBatch): boolean {
    this.getCopyResults();
    return !!this.selection && JSON.stringify(this.selection.batch) === JSON.stringify(batch);
  }
  getCopyResults(): ToolResult[] {
    const selection = this.selection;
    if (selection && (this.options.root() !== selection.root || this.options.session() !== selection.session)) this.clearResults();
    if (this.diagnostic && (this.options.root() !== this.diagnostic.root || this.options.session() !== this.diagnostic.session)) this.clearResults();
    return structuredClone(this.results.map(result => result.result));
  }

  getRunningCommand(batchId: string, requestId: string): string | undefined {
    const results = this.getCopyResults();
    if (this.selection?.batch.batch_id !== batchId) return undefined;
    const result = results.find(item => item.batch_id === batchId && item.request_id === requestId && item.tool === 'run_command');
    const data = result?.data as { process_id?: unknown; status?: unknown; cleanup_pending?: unknown } | undefined;
    if (!data || (data.status !== 'running' && data.cleanup_pending !== true) || typeof data.process_id !== 'string' || !data.process_id) return undefined;
    return data.process_id;
  }

  async configure(patch: unknown): Promise<ToolState> {
    await this.options.store.configure(patch);
    this.report('工具设置已保存');
    return this.getState();
  }

  async clearRules(): Promise<void> {
    const root = this.options.root();
    if (!root) throw new Error('尚未打开项目，无法清除本项目规则');
    await this.options.store.clearRules(root);
    this.report('已清除本项目保存的工具权限规则');
  }

  report(message: string): void { this.message = message; this.publish(); }

  cancel(): void {
    this.generation++;
    if (this.selection) this.selection.cancelled = true;
    if (this.completion) this.completion.cancelled = true;
    if (this.diagnostic) this.diagnostic.cancelled = true;
    this.report('已停止尚未执行的请求；已启动工具的实际结果仍会保留');
  }

  collect(text: string): Promise<void> {
    const parsed = parseToolBatch(text);
    if (parsed.kind !== 'batch') {
      this.getCopyResults();
      if (parsed.kind === 'error' && this.diagnostic?.sourceText === text) {
        this.report('工具批次校验失败，未执行'); return Promise.resolve();
      }
      this.clearResults();
      if (parsed.kind === 'error') {
        this.diagnostic = { id: ++this.diagnosticId, root: this.options.root(), session: this.options.session(), sourceText: text,
          error: { status: 'failed', error: parsed.error } };
        this.options.diagnosed?.(this.getDiagnostic()!);
        this.report('工具批次校验失败，未执行');
      }
      else this.report('已采集回复，但没有 mini-ai-tools 工具请求，未执行。普通讨论和代码示例仅作为资料；实际操作必须使用工具请求。');
      return Promise.resolve();
    }
    const root = this.options.root();
    if (!root) { this.clearResults(); this.report('尚未打开项目，工具批次未执行'); return Promise.resolve(); }
    const session = this.options.session();
    this.getCopyResults();
    if (!this.selection || this.selection.root !== root || this.selection.session !== session || JSON.stringify(this.selection.batch) !== JSON.stringify(parsed.batch)) {
      this.clearResults();
      this.selection = { root, session, batch: parsed.batch };
      this.options.selected?.(this.selection);
    }
    const selection = this.selection;
    const generation = this.generation;
    this.waiting++;
    this.publish();
    const run = this.queue.then(() => this.runBatch(root, session, generation, parsed.batch, selection));
    const finish = run.catch(error => { this.options.stopped?.(selection, errorText(error)); this.report(`工具批次停止：${errorText(error)}；未确认状态不会自动重试`); }).finally(() => {
      this.waiting--;
      this.getCopyResults();
      if (this.selection === selection) this.finishSelection();
      this.publish();
    });
    this.queue = finish;
    return finish;
  }

  private async runBatch(root: string, session: string, generation: number, batch: ToolBatch, selection: BatchSelection): Promise<void> {
    await this.options.store.ready();
    if (!this.current(root, session, generation)) { this.options.stopped?.(selection, '项目、会话已变化或批次已停止；未执行'); this.report('项目、会话已变化或批次已停止；未执行'); return; }
    // 在任何副作用及权限对话框之前落盘；落盘失败则整个批次不执行。
    const reservation = await this.options.store.reserve(root, session, batch);
    if (reservation.kind === 'conflict') {
      const message = `批次 ${batch.batch_id} 的 ID 被不同内容复用；未执行`;
      this.options.stopped?.(selection, message); this.report(message); return;
    }
    const entry: SelectedEntry = { ...reservation.entry, selection };
    if (reservation.kind === 'duplicate') {
      this.restore(entry);
      this.report(`批次 ${batch.batch_id} 已采集，未重复执行；unknown 表示重启后无法确认的状态`);
      return;
    }
    selection.executed = true;
    if (this.options.prepare) {
      try { await this.options.prepare(root, batch); }
      catch (error) {
        for (const request of batch.requests) await this.record(entry, request, { status: 'failed', error: `全批次校验失败：${errorText(error)}` });
        this.report('工具批次校验失败，所有请求均未执行');
        return;
      }
    }
    const completed = new Map<string, ToolResult['status']>();
    for (const request of batch.requests) {
      if (!this.current(root, session, generation)) {
        await this.record(entry, request, { status: 'cancelled', error: '项目、会话已变化或用户停止；未执行' });
        completed.set(request.id, 'cancelled');
        continue;
      }
      if (request.depends_on?.some(id => completed.get(id) !== 'done')) {
        await this.record(entry, request, { status: 'skipped_dependency', error: '前置请求未成功；未执行' });
        completed.set(request.id, 'skipped_dependency');
        continue;
      }
      let status: ToolResult['status'];
      try { status = await this.runRequest(root, session, generation, entry, request); }
      catch (error) {
        // 若执行状态不能落盘，不能继续后续副作用；UI保留不确定状态。
        this.show(entry, request, { status: 'unknown', error: `执行记录无法保存：${errorText(error)}` });
        for (const remaining of batch.requests.slice(batch.requests.indexOf(request) + 1)) {
          this.show(entry, remaining, { status: 'cancelled', error: '批次因执行记录保存失败停止；此请求未执行，状态未能持久保存' });
        }
        throw error;
      }
      completed.set(request.id, status);
    }
    this.report(`批次 ${batch.batch_id} 已处理；请复制工具结果发给 AI`);
  }

  private async runRequest(root: string, session: string, generation: number, entry: SelectedEntry, request: ToolRequest): Promise<ToolResult['status']> {
    let authorized: { external: boolean; fingerprint: string } | null = null;
    const hasApproval = (description: { external: boolean; fingerprint: string }) => authorized?.fingerprint === description.fingerprint && authorized.external === description.external;
    let granted = false;
    // 最终启动前复核权限、脚本和路径；频繁变化时停止，不能沿用过期授权。
    for (let attempt = 0; attempt < 3; attempt++) {
      let description: { external: boolean; fingerprint: string };
      try { description = await this.options.describe(root, request); }
      catch (error) { await this.record(entry, request, { status: 'failed', error: errorText(error) }); return 'failed'; }
      const decision = this.permission(root, request, description);
      if (decision === 'deny') {
        await this.record(entry, request, { status: 'permission_denied', error: '权限拒绝；工具未执行' });
        return 'permission_denied';
      }
      if (decision === 'ask' && !hasApproval(description)) {
        await this.record(entry, request, { status: 'pending_permission' });
        this.report(`等待批准：${request.tool} (${request.id})`);
        let authorization: 'once' | 'remember' | 'deny';
        try { authorization = await this.options.authorize(root, request); }
        catch (error) { await this.record(entry, request, { status: 'failed', error: `权限请求失败：${errorText(error)}` }); return 'failed'; }
        if (!this.current(root, session, generation)) return this.cancelRequest(entry, request);
        if (authorization === 'deny') {
          await this.record(entry, request, { status: 'permission_denied', error: '权限拒绝；工具未执行' });
          return 'permission_denied';
        }
        let approvedDescription: typeof description;
        try { approvedDescription = await this.options.describe(root, request); }
        catch (error) { await this.record(entry, request, { status: 'failed', error: errorText(error) }); return 'failed'; }
        if (approvedDescription.external !== description.external || approvedDescription.fingerprint !== description.fingerprint) {
          await this.record(entry, request, { status: 'permission_denied', error: '审批期间目标或脚本已变化，请由 AI 重新请求' });
          return 'permission_denied';
        }
        if (this.permission(root, request, approvedDescription) === 'deny') {
          await this.record(entry, request, { status: 'permission_denied', error: '审批期间权限规则已拒绝；工具未执行' });
          return 'permission_denied';
        }
        authorized = { ...description };
        if (authorization === 'remember') await this.options.store.addRule(root, description.fingerprint, 'allow');
      }
      if (!this.current(root, session, generation)) return this.cancelRequest(entry, request);
      await this.record(entry, request, { status: 'running' });
      if (!this.current(root, session, generation)) return this.cancelRequest(entry, request);
      let finalDescription: typeof description;
      try { finalDescription = await this.options.describe(root, request); }
      catch (error) { await this.record(entry, request, { status: 'failed', error: errorText(error) }); return 'failed'; }
      const finalDecision = this.permission(root, request, finalDescription);
      if (!this.current(root, session, generation)) return this.cancelRequest(entry, request);
      if (finalDecision === 'deny') {
        await this.record(entry, request, { status: 'permission_denied', error: '启动前权限规则已拒绝；工具未执行' });
        return 'permission_denied';
      }
      if (finalDecision === 'allow' || hasApproval(finalDescription)) { granted = true; break; }
    }
    if (!granted) {
      await this.record(entry, request, { status: 'permission_denied', error: '目标或权限持续变化；工具未执行，请重新请求' });
      return 'permission_denied';
    }
    this.report(`正在执行：${request.tool} (${request.id})`);
    if (!this.current(root, session, generation)) return this.cancelRequest(entry, request);
    this.show(entry, request, { status: 'running', started_at: Date.now() });
    let data: unknown;
    try { data = await this.options.execute(root, request, started => this.show(entry, request, { status: 'running', data: started }), entry.selection); }
    catch (error) { await this.record(entry, request, { status: 'failed', error: errorText(error) }); return 'failed'; }
    const process = data as { status?: string; timed_out?: boolean } | null;
    const status = request.tool === 'run_command' && process?.status === 'stopped' && !process.timed_out ? 'cancelled' : failedData(request, data) ? 'failed' : 'done';
    await this.record(entry, request, { status, data });
    return status;
  }

  private permission(root: string, request: ToolRequest, description: { external: boolean; fingerprint: string }): 'allow' | 'ask' | 'deny' {
    const mode = this.options.store.getConfig().permission;
    if (mode === 'full') return 'allow';
    if (mode === 'ask') return PROJECT_READ.has(request.tool) && !description.external ? 'allow' : 'ask';
    const rules = this.options.store.getRules(root).filter(r => r.fingerprint === description.fingerprint);
    if (rules.some(r => r.action === 'deny')) return 'deny';
    if (rules.some(r => r.action === 'ask')) return 'ask';
    return rules.some(r => r.action === 'allow') ? 'allow' : 'ask';
  }

  private current(root: string, session: string, generation: number): boolean {
    return this.generation === generation && this.options.root() === root && this.options.session() === session;
  }
  private async cancelRequest(entry: SelectedEntry, request: ToolRequest): Promise<'cancelled'> {
    await this.record(entry, request, { status: 'cancelled', error: '审批或启动期间项目、会话已变化或用户停止；未执行' });
    return 'cancelled';
  }
  private async record(entry: SelectedEntry, request: ToolRequest, value: Pick<ToolResult, 'status'> & Partial<Pick<ToolResult, 'data' | 'error'>>): Promise<void> {
    try { await this.options.store.updateResult(entry.scope, entry.batch_id, request.id, value.status); }
    catch (error) {
      this.show(entry, request, { ...value, status: 'unknown', error: `状态未能持久保存：${errorText(error)}` });
      throw error;
    }
    this.show(entry, request, value);
  }
  private show(entry: SelectedEntry, request: ToolRequest, value: Pick<ToolResult, 'status'> & Partial<Pick<ToolResult, 'data' | 'error' | 'started_at'>>): void {
    this.getCopyResults();
    if (this.selection !== entry.selection) return;
    const key = `${entry.scope}\0${entry.batch_id}\0${request.id}`;
    const result: ToolResult = { batch_id: entry.batch_id, request_id: request.id, tool: request.tool, ...value };
    const existing = this.results.find(r => r.key === key);
    if (existing) existing.result = { ...existing.result, ...result };
    else this.results.push({ key, result });
    const visible = existing?.result ?? this.results[this.results.length - 1]!.result;
    this.refreshProcess(visible);
    if (visible.started_at !== undefined && !['running', 'pending_permission'].includes(visible.status) && visible.finished_at === undefined) visible.finished_at = Date.now();
    this.publish();
  }
  private restore(entry: SelectedEntry): void {
    this.getCopyResults();
    if (this.selection !== entry.selection) return;
    for (const r of entry.requests) {
      const key = `${entry.scope}\0${entry.batch_id}\0${r.request_id}`;
      if (!this.results.some(result => result.key === key)) this.results.push({ key, result: { ...r, batch_id: entry.batch_id } });
    }
  }
  private clearResults(): void {
    // 只释放展示与复制正文，ToolStore 的防重放状态继续保留。
    this.selection = null;
    this.results = [];
    this.completion = undefined;
    this.diagnostic = null;
    this.message = '';
    this.options.selected?.(null);
  }
  /** 更新已启动后台命令的真实回执；不会执行工具或重新生成完成事件。 */
  refreshProcesses(): void {
    this.getCopyResults();
    for (const item of this.results) this.refreshProcess(item.result);
    this.finishSelection();
    this.publish();
  }
  private refreshProcess(result: ToolResult): void {
    const data = result.data as { process_id?: string } | undefined;
    if (result.tool !== 'run_command' || !data?.process_id || !this.options.snapshotProcess) return;
    const actual = this.options.snapshotProcess(data.process_id);
    if (actual) result.data = actual;
  }
  private finishSelection(): void {
    const selection = this.selection;
    if (!selection?.executed || selection.notified || this.waiting > 0 || this.results.some(item => item.result.tool === 'run_command' &&
      ((item.result.data as { status?: string; cleanup_pending?: boolean } | undefined)?.status === 'running' || (item.result.data as { cleanup_pending?: boolean } | undefined)?.cleanup_pending))) return;
    selection.notified = true;
    const success = !selection.cancelled && this.results.length === selection.batch.requests.length && this.results.every(item => item.result.status === 'done' &&
      !(item.result.tool === 'run_command' && failedData(selection.batch.requests.find(r => r.id === item.result.request_id)!, item.result.data)));
    this.completion = { id: ++this.completionId, batch_id: selection.batch.batch_id, outcome: success ? 'success' : 'error', ...(selection.cancelled ? { cancelled: true } : {}) };
  }
  private publish(): void { this.options.changed(this.getState()); }
}
