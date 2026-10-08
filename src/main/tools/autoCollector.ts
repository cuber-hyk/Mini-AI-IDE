/** 调度只负责历史基线和执行；网页状态读取由 replyObservation 拥有。 */
export { COMPLETION_SCRIPT } from './replyObservation';
import { traceCollection, traceScope, traceText } from './collectionTrace';

export interface AutoReply { url: string; text: string; completion: 'generating' | 'interrupted' | 'complete' | 'idle' | 'unknown' }
export class AutoCollector {
  private disposed = false; private enabled = false; private polling = false;
  private revision = 0; private pending = false;
  private awaitingHistory = false;
  private waiting: 'unknown' | 'interrupted' | undefined;
  private scope = ''; private last = ''; private baseline = true; private observedGenerating = false;
  constructor(private readonly read: () => Promise<AutoReply>, private readonly collect: (text: string, current: () => boolean) => Promise<void>,
    private readonly report: (message: string) => void) {}
  private state(): Record<string, unknown> {
    return { enabled: this.enabled, disposed: this.disposed, revision: this.revision, polling: this.polling, pending: this.pending,
      awaitingHistory: this.awaitingHistory, waiting: this.waiting ?? null, scope: this.scope ? traceScope(this.scope) : null,
      baseline: this.baseline, observedGenerating: this.observedGenerating, last: traceText(this.last) };
  }
  private trace(event: string, data: Record<string, unknown> = {}): void { traceCollection(`auto.${event}`, { ...this.state(), ...data }); }
  setEnabled(value: boolean): void {
    if (this.enabled === value) return;
    this.enabled = value; this.reset();
    this.trace('enabled', { value });
  }
  reset(awaitHistory = false): void { this.revision++; this.pending = false; this.awaitingHistory = awaitHistory; this.waiting = undefined; this.baseline = true; this.observedGenerating = false; this.scope = ''; this.last = ''; this.trace('reset', { awaitHistory }); }
  /** 已确认首页首轮地址交接，结束遗留历史等待；保留正文去重和真实生成证据。 */
  continueAt(url: string): void { this.revision++; this.scope = url; this.baseline = false; this.awaitingHistory = false; this.waiting = undefined; this.trace('continue', { url: traceScope(url) }); }
  /** 只读监听已见真实生成，完整快照可能晚于生成结束；不能吞掉首轮。 */
  observeGeneration(url: string): void { this.revision++; this.scope = url; this.baseline = false; this.awaitingHistory = false; this.waiting = undefined; this.observedGenerating = true; this.trace('observe-generation', { url: traceScope(url) }); }
  acknowledge(url: string, text: string): void { this.revision++; this.waiting = undefined; this.scope = url; this.last = text; this.baseline = false; this.awaitingHistory = false; this.observedGenerating = false; this.trace('acknowledge', { url: traceScope(url), text: traceText(text) }); }
  dispose(): void { this.disposed = true; this.pending = false; this.revision++; this.trace('dispose'); }
  async tick(): Promise<void> {
    if (!this.enabled || this.disposed) { this.trace('tick-skip', { reason: this.disposed ? 'disposed' : 'disabled' }); return; }
    if (this.polling) { this.pending = true; this.trace('tick-skip', { reason: 'polling' }); return; }
    this.polling = true;
    const revision = this.revision;
    this.trace('tick-start', { tickRevision: revision });
    try {
      const reply = await this.read();
      this.trace('read', { tickRevision: revision, reply: { ...traceScope(reply.url), ...traceText(reply.text), completion: reply.completion } });
      if (!this.enabled || this.disposed || revision !== this.revision) { this.trace('decision', { decision: 'stale-after-read', tickRevision: revision }); return; }
      if (this.scope !== reply.url) { this.awaitingHistory ||= !!this.scope; this.scope = reply.url; this.baseline = true; this.observedGenerating = false; this.trace('scope-change', { reply: traceScope(reply.url) }); }
      if (this.baseline) {
        // 切换后的空加载帧不结束历史基线；观察到实际生成则等待本次新回复。
        this.last = reply.text; this.baseline = this.awaitingHistory && !reply.text && reply.completion !== 'generating'; this.awaitingHistory = this.baseline; this.observedGenerating = reply.completion === 'generating';
        this.trace('decision', { decision: 'baseline', reply: { ...traceText(reply.text), completion: reply.completion } });
        this.report(reply.completion === 'interrupted' ? 'AI 回复已中断，等待继续生成；当前工具批次未执行' : this.observedGenerating ? 'AI 正在生成，自动采集等待回复结束' : '自动采集已就绪，等待新的 mini-ai-tools 工具回复；已有回复不执行');
        return;
      }
      if (reply.completion === 'generating') { this.observedGenerating = true; this.waiting = undefined; this.trace('decision', { decision: 'generating' }); return; }
      if (reply.completion === 'unknown' || reply.completion === 'interrupted') {
        if (reply.text === this.last && !this.observedGenerating) { this.trace('decision', { decision: 'same-text-unknown', completion: reply.completion }); return; }
        if (this.waiting !== reply.completion) this.report(reply.completion === 'interrupted'
          ? 'AI 回复已中断，等待继续生成；当前工具批次未执行'
          : '自动采集等待确认回复结束；若完成后仍未采集，请使用“采集回复”');
        this.waiting = reply.completion; this.trace('decision', { decision: 'wait-uncertain', completion: reply.completion }); return;
      }
      this.waiting = undefined;
      if (!reply.text || reply.text === this.last) { this.trace('decision', { decision: !reply.text ? 'empty' : 'same-text-complete' }); return; }
      if (reply.completion !== 'complete' && !(reply.completion === 'idle' && this.observedGenerating)) {
        this.trace('decision', { decision: 'invalid-completion', completion: reply.completion });
        this.report('无法确认网页回复结束，请使用“采集回复”；网页结构可能已变化'); return;
      }
      this.last = reply.text; this.observedGenerating = false;
      this.trace('collect-start', { text: traceText(reply.text), completion: reply.completion, tickRevision: revision });
      await this.collect(reply.text, () => this.enabled && !this.disposed && revision === this.revision);
      this.trace('collect-done', { tickRevision: revision });
    } catch (error) { this.trace('error', { tickRevision: revision, error: error instanceof Error ? error.message : String(error) }); if (this.enabled && !this.disposed && revision === this.revision) this.report('自动采集失败：' + (error instanceof Error ? error.message : String(error))); }
    finally { this.polling = false; if (this.pending) { this.pending = false; await this.tick(); } }
  }
}
