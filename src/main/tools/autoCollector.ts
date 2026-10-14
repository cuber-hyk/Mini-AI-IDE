/** 调度只负责历史基线和执行；网页状态读取由 replyObservation 拥有。 */
export { COMPLETION_SCRIPT } from './replyObservation';
import { traceCollection, traceScope, traceText } from './collectionTrace';
import { createHash } from 'node:crypto';
import type { ReplySource } from './replySource';
import type { ToolCollectionState } from '../../shared/toolProtocol';

export interface AutoReply { url: string; text: string; completion: 'generating' | 'interrupted' | 'complete' | 'idle' | 'unknown'; source?: ReplySource; sourceKey?: string }
export class AutoCollector {
  private disposed = false; private enabled = false; private polling = false;
  private revision = 0; private pending = false;
  private awaitingHistory = false;
  private waiting: 'unknown' | 'interrupted' | undefined;
  private scope = ''; private last = ''; private baseline = true; private observedGenerating = false;
  private readonly seen = new Set<string>();
  private health: ToolCollectionState = { phase: 'off', message: '自动采集已关闭' };
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readFailures = 0;
  private remember(text: string): void { if (text) this.seen.add(createHash('sha256').update(text).digest('hex')); }
  private hasSeen(text: string): boolean { return this.seen.has(createHash('sha256').update(text).digest('hex')); }
  constructor(private readonly read: () => Promise<AutoReply>, private readonly collect: (text: string, current: () => boolean, sourceKey?: string, session?: string) => Promise<void>,
    private readonly report: (message: string) => void, private readonly changed?: (state: ToolCollectionState) => void) {}
  private status(value: ToolCollectionState): void {
    if (JSON.stringify(value) === JSON.stringify(this.health)) return;
    this.health = value; this.changed?.({ ...value });
  }
  private cancelReadRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined; this.readFailures = 0;
  }
  sourceChanged(): void {
    const message = '采集快照与当前回复来源不一致，工具未执行；请使用“采集回复”';
    this.status({ phase: 'paused', reason: 'source_changed', message }); this.report(message);
  }
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
  reset(awaitHistory = false): void { this.cancelReadRetry(); this.revision++; this.pending = false; this.awaitingHistory = awaitHistory; this.waiting = undefined; this.baseline = true; this.observedGenerating = false; this.scope = ''; this.last = ''; this.seen.clear(); this.status({ phase: this.enabled ? 'watching' : 'off', reason: 'baseline', message: this.enabled ? '自动采集等待新回复' : '自动采集已关闭' }); this.trace('reset', { awaitHistory }); }
  /** 已确认首页首轮地址交接，结束遗留历史等待；保留正文去重和真实生成证据。 */
  continueAt(url: string): void { this.cancelReadRetry(); this.revision++; this.scope = url; this.baseline = false; this.awaitingHistory = false; this.waiting = undefined; this.trace('continue', { url: traceScope(url) }); }
  /** 只读监听已见真实生成，完整快照可能晚于生成结束；不能吞掉首轮。 */
  observeGeneration(url: string): void { this.cancelReadRetry(); this.revision++; this.scope = url; this.baseline = false; this.awaitingHistory = false; this.waiting = undefined; this.observedGenerating = true; this.trace('observe-generation', { url: traceScope(url) }); }
  acknowledge(url: string, text: string): void { this.cancelReadRetry(); this.revision++; this.waiting = undefined; this.scope = url; this.last = text; this.remember(text); this.baseline = false; this.awaitingHistory = false; this.observedGenerating = false; this.status({ phase: this.enabled ? 'watching' : 'off', message: this.enabled ? '已手动采集，等待新回复' : '自动采集已关闭' }); this.trace('acknowledge', { url: traceScope(url), text: traceText(text) }); }
  dispose(): void { this.cancelReadRetry(); this.disposed = true; this.pending = false; this.revision++; this.trace('dispose'); }
  async tick(): Promise<void> {
    if (!this.enabled || this.disposed) { this.trace('tick-skip', { reason: this.disposed ? 'disposed' : 'disabled' }); return; }
    if (this.polling) { this.pending = true; this.trace('tick-skip', { reason: 'polling' }); return; }
    if (this.retryTimer !== undefined) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    this.polling = true;
    const revision = this.revision;
    let reading = true;
    this.trace('tick-start', { tickRevision: revision });
    try {
      const reply = await this.read();
      reading = false;
      this.trace('read', { tickRevision: revision, reply: { ...traceScope(reply.url), ...traceText(reply.text), completion: reply.completion } });
      if (!this.enabled || this.disposed || revision !== this.revision) { this.trace('decision', { decision: 'stale-after-read', tickRevision: revision }); return; }
      this.readFailures = 0;
      if (this.health.reason === 'read_failed') this.status({ phase: 'watching', message: '网页回复读取已恢复' });
      if (this.scope !== reply.url) { this.awaitingHistory ||= !!this.scope; this.scope = reply.url; this.seen.clear(); this.baseline = true; this.observedGenerating = false; this.trace('scope-change', { reply: traceScope(reply.url) }); }
      if (this.baseline) {
        // 切换后的空加载帧不结束历史基线；观察到实际生成则等待本次新回复。
        this.last = reply.text; this.baseline = this.awaitingHistory && !reply.text && reply.completion !== 'generating'; this.awaitingHistory = this.baseline; this.observedGenerating = reply.completion === 'generating';
        if (reply.completion !== 'generating' && reply.completion !== 'interrupted') this.remember(reply.text);
        this.trace('decision', { decision: 'baseline', reply: { ...traceText(reply.text), completion: reply.completion } });
        this.report(reply.completion === 'interrupted' ? 'AI 回复已中断，等待继续生成；当前工具批次未执行' : this.observedGenerating ? 'AI 正在生成，自动采集等待回复结束' : '自动采集已就绪，等待新的 mini-ai-tools 工具回复；已有回复不执行');
        return;
      }
      if (reply.completion === 'generating') { this.observedGenerating = true; this.waiting = undefined; this.status({ phase: 'watching', message: 'AI 正在生成，等待回复结束' }); this.trace('decision', { decision: 'generating' }); return; }
      if (reply.completion === 'unknown' || reply.completion === 'interrupted') {
        if (reply.text === this.last && !this.observedGenerating) { this.trace('decision', { decision: 'same-text-unknown', completion: reply.completion }); return; }
        if (this.waiting !== reply.completion) this.report(reply.completion === 'interrupted'
          ? 'AI 回复已中断，等待继续生成；当前工具批次未执行'
          : '自动采集等待确认回复结束；若完成后仍未采集，请使用“采集回复”');
        this.status({ phase: 'paused', reason: reply.completion === 'interrupted' ? 'reply_interrupted' : 'completion_unknown',
          message: reply.completion === 'interrupted' ? 'AI 回复已中断，等待继续生成；当前工具批次未执行' : '自动采集等待确认回复结束；若完成后仍未采集，请使用“采集回复”' });
        this.waiting = reply.completion; this.trace('decision', { decision: 'wait-uncertain', completion: reply.completion }); return;
      }
      this.waiting = undefined;
      if (reply.source && reply.source !== 'new') {
        this.trace('decision', { decision: 'historical-source', source: reply.source });
        if (reply.source === 'unknown') {
          const message = '无法确认回复是新增输出，自动采集暂停；请使用“采集回复”';
          this.status({ phase: 'paused', reason: 'source_unknown', message }); this.report(message);
        }
        return;
      }
      if (!reply.text || reply.text === this.last) { this.trace('decision', { decision: !reply.text ? 'empty' : 'same-text-complete' }); return; }
      if (this.hasSeen(reply.text) || this.seen.size >= 10_000) { this.trace('decision', { decision: 'seen-reply' }); return; }
      if (reply.completion !== 'complete' && !(reply.completion === 'idle' && this.observedGenerating)) {
        this.trace('decision', { decision: 'invalid-completion', completion: reply.completion });
        const message = '无法确认网页回复结束，请使用“采集回复”；网页结构可能已变化';
        this.status({ phase: 'paused', reason: 'completion_unknown', message }); this.report(message); return;
      }
      this.status({ phase: 'watching', message: '已确认新回复，正在采集' });
      this.last = reply.text; this.observedGenerating = false;
      this.remember(reply.text);
      this.trace('collect-start', { text: traceText(reply.text), completion: reply.completion, tickRevision: revision });
      await this.collect(reply.text, () => this.enabled && !this.disposed && revision === this.revision, reply.sourceKey, reply.url);
      this.trace('collect-done', { tickRevision: revision });
    } catch (error) {
      this.trace('error', { tickRevision: revision, error: error instanceof Error ? error.message : String(error) });
      if (this.enabled && !this.disposed && revision === this.revision) {
        const delays = [250, 1000, 3000];
        const delay = reading ? delays[this.readFailures++] : undefined;
        const message = '自动采集失败：' + (error instanceof Error ? error.message : String(error));
        this.status(delay !== undefined ? { phase: 'recovering', reason: 'read_failed', message: '网页回复读取失败，正在重新读取', attempt: this.readFailures }
          : { phase: 'paused', reason: reading ? 'read_failed' : 'collection_failed', message });
        this.report(message);
        if (delay !== undefined) this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          if (this.enabled && !this.disposed && revision === this.revision) void this.tick();
        }, delay);
      }
    }
    finally { this.polling = false; if (this.pending) { this.pending = false; await this.tick(); } }
  }
}
