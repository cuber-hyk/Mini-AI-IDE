/** 自动继续消费当前完成批次或校验诊断；不执行工具、不读网页输入、不重试发送。 */
import type { ToolContinuationState, ToolState } from '../../shared/toolProtocol';
import { isBatchValidationFailure, isCompletedStoppedCommand, isPermissionDenialReceipt } from '../../shared/toolProtocol';
import type { ToolDiagnostic } from './harness';
import { formatToolResults } from './resultClipboard';

interface Context { root: string | null; session: string; state: ToolState; diagnostic?: ToolDiagnostic | null }
interface Pending { scope: string; event: { kind: 'completion' | 'diagnostic'; id: number }; corrective: boolean; body: string; interval: number }
interface Options {
  current: () => Context;
  send: (text: string, session: string, current: () => boolean) => Promise<{ ok: boolean; error?: string; uncertain?: boolean }>;
  cancelSend: () => Promise<void>;
  changed: (state: ToolContinuationState) => void;
}
export class AutoContinuation {
  private value: ToolContinuationState = { phase: 'off', message: '自动继续已关闭' };
  private pending: Pending | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scope = '';
  private observedCompletion = 0;
  private observedDiagnostic = 0;
  private generation = 0;
  private disposed = false;
  private initialized = false;
  // 解析与执行前整批校验错误共用额度；正常执行结果发送成功或切换 scope 时归零。
  private consecutiveBatchErrors = 0;
  private static readonly MAX_CONSECUTIVE_BATCH_ERRORS = 5;
  constructor(private readonly options: Options) {}
  getState(): ToolContinuationState { return { ...this.value }; }
  private change(value: ToolContinuationState): void {
    if (JSON.stringify(value) === JSON.stringify(this.value)) return;
    this.value = value; this.options.changed(this.getState());
  }
  private cancel(): void {
    this.generation++; this.pending = undefined;
    const generation = this.generation;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    void this.options.cancelSend().catch(error => {
      if (!this.disposed && generation === this.generation) this.change({ phase: 'paused', message: '自动发送清理失败：' + (error instanceof Error ? error.message : String(error)) });
    });
  }
  // 只拦执行层结果；解析层 batchError 由连续计数与上限单独处理。
  private blocked(state: ToolState): boolean {
    return !!state.completion?.cancelled || state.results.some(result => result.status === 'unknown' ||
      result.status === 'cancelled' && !isCompletedStoppedCommand(result) ||
      result.tool === 'run_command' && (result.data as { status?: string } | undefined)?.status === 'stopped' && !isCompletedStoppedCommand(result));
  }
  private bodyOf(state: ToolState): string {
    return formatToolResults(state.results, state.batchError);
  }
  private eventOf({ root, session, state, diagnostic }: Context): Pending['event'] | undefined {
    if (state.batchError) {
      return diagnostic && !diagnostic.cancelled && diagnostic.root === root && diagnostic.session === session &&
        !state.completion && !state.results.length && diagnostic.error.error === state.batchError.error && diagnostic.error.status === state.batchError.status
        ? { kind: 'diagnostic', id: diagnostic.id } : undefined;
    }
    return state.completion ? { kind: 'completion', id: state.completion.id } : undefined;
  }
  observe(context: Context): void {
    const { root, session, state, diagnostic } = context;
    if (this.disposed) return;
    if (!this.initialized) {
      this.initialized = true; this.observedCompletion = state.completion?.id ?? 0; this.observedDiagnostic = diagnostic?.id ?? 0;
    }
    const scope = JSON.stringify([root, session]);
    if (scope !== this.scope) { this.cancel(); this.scope = scope; this.consecutiveBatchErrors = 0; }
    if (!state.config.automatic || !root) {
      if (this.pending || this.value.phase !== 'off') this.cancel();
      this.observedCompletion = Math.max(this.observedCompletion, state.completion?.id ?? 0);
      this.observedDiagnostic = Math.max(this.observedDiagnostic, diagnostic?.id ?? 0);
      this.change({ phase: state.config.automatic ? 'waiting_user' : 'off', message: state.config.automatic ? '请先打开目录并发送需求' : '自动继续已关闭，本轮工具可继续完成' });
      return;
    }
    if (this.blocked(state) || diagnostic?.cancelled) {
      if (this.pending) this.cancel();
      this.observedCompletion = Math.max(this.observedCompletion, state.completion?.id ?? 0);
      this.observedDiagnostic = Math.max(this.observedDiagnostic, diagnostic?.id ?? 0);
      this.change({ phase: 'paused', message: '工具被拒绝、中断或状态未知，等待你处理' }); return;
    }
    const event = this.eventOf(context);
    if (this.pending && (event?.kind !== this.pending.event.kind || event.id !== this.pending.event.id || this.bodyOf(state) !== this.pending.body)) this.cancel();
    if (state.busy || state.results.some(result => ['running', 'pending_permission'].includes(result.status) || result.tool === 'run_command' && ((result.data as { status?: string; cleanup_pending?: boolean } | undefined)?.status === 'running' || (result.data as { cleanup_pending?: boolean } | undefined)?.cleanup_pending))) {
      if (this.pending) this.cancel();
      this.change({ phase: 'waiting_tools', message: state.results.some(result => result.status === 'pending_permission') ? '等待工具授权' : '等待本批工具执行结束' }); return;
    }
    if (!event) { this.change({ phase: 'waiting_user', message: '等待你发送需求或回答 AI' }); return; }
    if (this.pending) {
      if (this.value.phase === 'countdown' && this.pending.interval !== state.config.sendIntervalSeconds) {
        this.pending.interval = state.config.sendIntervalSeconds; this.schedule(this.pending);
      }
      return;
    }
    if (event.id <= (event.kind === 'diagnostic' ? this.observedDiagnostic : this.observedCompletion)) {
      if (this.value.phase === 'off') this.change({ phase: 'waiting_user', message: '自动继续已开启，等待新的工具结果' });
      return;
    }
    if (event.kind === 'diagnostic') this.observedDiagnostic = event.id; else this.observedCompletion = event.id;
    const corrective = event.kind === 'diagnostic' || isBatchValidationFailure(state);
    const hasExecuted = state.results.some(result => result.started_at !== undefined && ['done', 'failed'].includes(result.status) || isCompletedStoppedCommand(result));
    if (!hasExecuted && !corrective && !isPermissionDenialReceipt(state)) {
      this.change({ phase: 'waiting_user', message: '本批没有实际执行的工具，等待你处理' }); return;
    }
    if (corrective) {
      if (this.consecutiveBatchErrors >= AutoContinuation.MAX_CONSECUTIVE_BATCH_ERRORS) {
        this.change({ phase: 'paused', message: '连续 5 次批次校验失败，已停止自动发送，等待你处理' }); return;
      }
    }
    const pending = { scope, event, corrective, body: this.bodyOf(state), interval: state.config.sendIntervalSeconds };
    this.pending = pending; this.schedule(pending);
  }
  private schedule(pending: Pending): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const generation = this.generation;
    this.change({ phase: 'countdown', message: '工具结果就绪，等待自动发送', dueAt: Date.now() + pending.interval * 1000 });
    this.timer = setTimeout(() => { this.timer = undefined; void this.send(pending, generation); }, pending.interval * 1000);
  }
  private async send(pending: Pending, generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation || this.pending !== pending) return;
    const context = this.options.current();
    const event = this.eventOf(context);
    if (!context.state.config.automatic || context.state.busy || this.blocked(context.state) || pending.scope !== JSON.stringify([context.root, context.session]) || event?.kind !== pending.event.kind || event.id !== pending.event.id || pending.corrective !== (event.kind === 'diagnostic' || isBatchValidationFailure(context.state)) || this.bodyOf(context.state) !== pending.body) {
      this.cancel(); this.change({ phase: 'paused', message: '当前项目、会话或结果已变化，自动发送取消' }); return;
    }
    this.change({ phase: 'sending', message: '正在发送工具结果…' });
    if (pending.corrective) this.consecutiveBatchErrors++;
    try {
      const result = await this.options.send(pending.body, context.session, () => !this.disposed && generation === this.generation && this.pending === pending);
      if (this.disposed || generation !== this.generation || this.pending !== pending) return;
      this.pending = undefined;
      if (result.ok && !pending.corrective) this.consecutiveBatchErrors = 0;
      this.change(result.ok ? { phase: 'waiting_reply', message: '结果已发送，等待 AI 回复' } : { phase: 'paused', message: (result.uncertain ? '发送结果无法确认，不会重复发送：' : '自动发送暂停：') + (result.error || '请检查网页') });
    } catch (error) {
      if (this.disposed || generation !== this.generation || this.pending !== pending) return;
      this.pending = undefined;
      this.change({ phase: 'paused', message: '自动发送失败，不会重试：' + (error instanceof Error ? error.message : String(error)) });
    }
  }
  userTurn(): void {
    if (this.pending) { this.cancel(); this.change({ phase: 'waiting_reply', message: '你已发起新一轮，旧结果不再自动发送' }); }
  }
  reset(context: Pick<Context, 'root' | 'session'>): void {
    this.cancel();
    const scope = JSON.stringify([context.root, context.session]);
    if (scope !== this.scope) { this.scope = scope; this.consecutiveBatchErrors = 0; }
    if (this.value.phase !== 'off') this.change({ phase: 'waiting_user', message: '当前回执已变化，等待新的工具结果' });
  }
  dispose(): void { this.disposed = true; this.cancel(); }
}
