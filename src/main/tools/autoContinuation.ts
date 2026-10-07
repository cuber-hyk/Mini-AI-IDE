/** 自动继续只消费真正结束的当前批次；不执行工具、不读网页输入、不重试发送。 */
import type { ToolContinuationState, ToolState } from '../../shared/toolProtocol';
import { formatToolResults } from './resultClipboard';

interface Context { root: string | null; session: string; state: ToolState }
interface Pending { scope: string; completionId: number; body: string; interval: number }
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
  private generation = 0;
  private disposed = false;
  private initialized = false;
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
  private blocked(state: ToolState): boolean {
    return !!state.batchError || !!state.completion?.cancelled || state.results.some(result => ['permission_denied', 'cancelled', 'unknown'].includes(result.status) || result.tool === 'run_command' && (result.data as { status?: string } | undefined)?.status === 'stopped');
  }
  observe({ root, session, state }: Context): void {
    if (this.disposed) return;
    if (!this.initialized) { this.initialized = true; this.observedCompletion = state.completion?.id ?? 0; }
    const scope = JSON.stringify([root, session]);
    if (scope !== this.scope) { this.cancel(); this.scope = scope; }
    if (!state.config.automatic || !root) {
      if (this.pending || this.value.phase !== 'off') this.cancel();
      this.observedCompletion = Math.max(this.observedCompletion, state.completion?.id ?? 0);
      this.change({ phase: state.config.automatic ? 'waiting_user' : 'off', message: state.config.automatic ? '请先打开目录并发送需求' : '自动继续已关闭，本轮工具可继续完成' });
      return;
    }
    if (state.batchError) { this.cancel(); this.change({ phase: 'paused', message: '回复格式错误，等待你处理' }); return; }
    if (this.blocked(state)) {
      if (this.pending) this.cancel();
      this.observedCompletion = Math.max(this.observedCompletion, state.completion?.id ?? 0);
      this.change({ phase: 'paused', message: '工具被拒绝、中断或状态未知，等待你处理' }); return;
    }
    if (this.pending && (!state.completion || state.completion.id !== this.pending.completionId || formatToolResults(state.results) !== this.pending.body)) this.cancel();
    if (state.busy || state.results.some(result => ['running', 'pending_permission'].includes(result.status) || result.tool === 'run_command' && ((result.data as { status?: string; cleanup_pending?: boolean } | undefined)?.status === 'running' || (result.data as { cleanup_pending?: boolean } | undefined)?.cleanup_pending))) {
      if (this.pending) this.cancel();
      this.change({ phase: 'waiting_tools', message: state.results.some(result => result.status === 'pending_permission') ? '等待工具授权' : '等待本批工具执行结束' }); return;
    }
    const completion = state.completion;
    if (!completion) { this.change({ phase: 'waiting_user', message: '等待你发送需求或回答 AI' }); return; }
    if (this.pending) {
      if (this.value.phase === 'countdown' && this.pending.interval !== state.config.sendIntervalSeconds) {
        this.pending.interval = state.config.sendIntervalSeconds; this.schedule(this.pending);
      }
      return;
    }
    if (completion.id <= this.observedCompletion) {
      if (this.value.phase === 'off') this.change({ phase: 'waiting_user', message: '自动继续已开启，等待新的工具结果' });
      return;
    }
    this.observedCompletion = completion.id;
    if (!state.results.some(result => result.started_at !== undefined && ['done', 'failed'].includes(result.status))) {
      this.change({ phase: 'waiting_user', message: '本批没有实际执行的工具，等待你处理' }); return;
    }
    const pending = { scope, completionId: completion.id, body: formatToolResults(state.results), interval: state.config.sendIntervalSeconds };
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
    if (!context.state.config.automatic || context.state.busy || this.blocked(context.state) || pending.scope !== JSON.stringify([context.root, context.session]) || context.state.completion?.id !== pending.completionId || formatToolResults(context.state.results) !== pending.body) {
      this.cancel(); this.change({ phase: 'paused', message: '当前项目、会话或结果已变化，自动发送取消' }); return;
    }
    this.change({ phase: 'sending', message: '正在发送工具结果…' });
    try {
      const result = await this.options.send(pending.body, context.session, () => !this.disposed && generation === this.generation && this.pending === pending);
      if (this.disposed || generation !== this.generation || this.pending !== pending) return;
      this.pending = undefined;
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
  reset(): void { this.cancel(); this.scope = ''; this.change({ phase: 'waiting_user', message: '项目或会话已变化，等待你发送需求' }); }
  dispose(): void { this.disposed = true; this.cancel(); }
}
