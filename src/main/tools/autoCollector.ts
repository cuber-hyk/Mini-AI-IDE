/** 调度只负责历史基线和执行；网页状态读取由 replyObservation 拥有。 */
export { COMPLETION_SCRIPT } from './replyObservation';

export interface AutoReply { url: string; text: string; completion: 'generating' | 'interrupted' | 'complete' | 'idle' | 'unknown' }
export class AutoCollector {
  private disposed = false; private enabled = false; private polling = false;
  private revision = 0; private pending = false;
  private userTurn = false;
  private waiting: 'unknown' | 'interrupted' | undefined;
  private scope = ''; private last = ''; private baseline = true; private observedGenerating = false;
  constructor(private readonly read: () => Promise<AutoReply>, private readonly collect: (text: string, current: () => boolean) => Promise<void>,
    private readonly report: (message: string) => void) {}
  setEnabled(value: boolean): void {
    if (this.enabled === value) return;
    this.enabled = value; this.reset();
  }
  reset(): void { this.revision++; this.pending = false; this.userTurn = false; this.waiting = undefined; this.baseline = true; this.observedGenerating = false; this.scope = ''; this.last = ''; }
  noteUserTurn(): void { this.userTurn = true; this.waiting = undefined; }
  /** 未确认的自动发送不能授权下一轮；保留已见正文基线，真人新动作可再关联。 */
  cancelTurn(): void { this.revision++; this.pending = false; this.userTurn = false; this.waiting = undefined; this.observedGenerating = false; }
  acknowledge(url: string, text: string): void { this.revision++; this.userTurn = false; this.waiting = undefined; this.scope = url; this.last = text; this.baseline = false; this.observedGenerating = false; }
  dispose(): void { this.disposed = true; this.pending = false; this.revision++; }
  async tick(): Promise<void> {
    if (!this.enabled || this.disposed) return;
    if (this.polling) { this.pending = true; return; }
    this.polling = true;
    const revision = this.revision;
    try {
      const reply = await this.read();
      if (!this.enabled || this.disposed || revision !== this.revision) return;
      if (this.scope !== reply.url) { if (this.scope) this.userTurn = false; this.scope = reply.url; this.baseline = true; this.observedGenerating = false; }
      if (this.baseline) {
        this.last = reply.text; this.baseline = false; this.observedGenerating = reply.completion === 'generating';
        this.report(reply.completion === 'interrupted' ? 'AI 回复已中断，等待继续生成；当前工具批次未执行' : this.observedGenerating ? 'AI 正在生成，自动采集等待回复结束' : '自动采集已就绪，等待新的 mini-ai-tools 工具回复；已有回复不执行');
        return;
      }
      // 页面导航后的历史内容可能异步挂载；只有用户实际发起的新轮可执行。
      if (!this.userTurn) { if (reply.completion === 'complete' || reply.completion === 'idle') this.last = reply.text; this.observedGenerating = false; return; }
      if (reply.completion === 'generating') { this.observedGenerating = true; this.waiting = undefined; return; }
      if (reply.completion === 'unknown' || reply.completion === 'interrupted') {
        if (this.waiting !== reply.completion) this.report(reply.completion === 'interrupted'
          ? 'AI 回复已中断，等待继续生成；当前工具批次未执行'
          : '自动采集等待确认回复结束；若完成后仍未采集，请使用“采集回复”');
        this.waiting = reply.completion; return;
      }
      this.waiting = undefined;
      if (!reply.text || reply.text === this.last) return;
      if (reply.completion !== 'complete' && !(reply.completion === 'idle' && this.observedGenerating)) {
        this.report('无法确认网页回复结束，请使用“采集回复”；网页结构可能已变化'); return;
      }
      this.last = reply.text; this.observedGenerating = false;
      this.userTurn = false;
      await this.collect(reply.text, () => this.enabled && !this.disposed && revision === this.revision);
    } catch (error) { if (this.enabled && !this.disposed && revision === this.revision) this.report('自动采集失败：' + (error instanceof Error ? error.message : String(error))); }
    finally { this.polling = false; if (this.pending) { this.pending = false; await this.tick(); } }
  }
}
