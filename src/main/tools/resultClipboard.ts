import type { ToolBatchError, ToolResult, ToolState } from '../../shared/toolProtocol';
import type { ToolDiagnostic } from './harness';
import { isCompletedStoppedCommand } from '../../shared/toolProtocol';

/** 手动和自动复制使用同一回执；校验失败没有可信请求 ID，也没有执行结果。 */
export function formatToolResults(results: ToolResult[], batchError?: ToolBatchError): string {
  return JSON.stringify({ protocol_version: 1, tool_results: results, ...(batchError ? { batch_error: batchError } : {}) }, null, 2);
}

/** 主进程批次完成事件拥有自动复制；查询状态、UI 重绘与历史恢复不写剪贴板。 */
export class ResultClipboard {
  private attempted = 0;
  private attemptedDiagnostic = 0;
  private diagnosticNotice: { diagnostic: ToolDiagnostic; notice: NonNullable<ToolState['clipboard']> } | undefined;
  private notice: ToolState['clipboard'];

  constructor(private readonly copy: (text: string) => void) {}

  complete(state: ToolState): void {
    const completion = state.completion;
    if (!completion) { this.notice = undefined; if (!state.batchError) this.diagnosticNotice = undefined; return; }
    this.diagnosticNotice = undefined;
    if (completion.id <= this.attempted || state.busy) return;
    if (!state.config.autoCopyResults || completion.cancelled) { this.attempted = completion.id; return; }
    // 后台命令的启动回执不是执行结束；等当前批次的全部命令结束再复制。
    if (state.results.some(r => r.status === 'running' || r.status === 'pending_permission' ||
      r.tool === 'run_command' && (r.data as { status?: string } | undefined)?.status === 'running')) return;
    this.attempted = completion.id;
    const manualReceipt = state.source === 'manual' && state.results.length > 0 &&
      state.results.every(r => ['done', 'failed', 'permission_denied', 'skipped_dependency'].includes(r.status) || isCompletedStoppedCommand(r));
    if (state.results.some(r => r.status === 'unknown' || r.status === 'cancelled' && !isCompletedStoppedCommand(r) ||
      r.tool === 'run_command' && (r.data as { status?: string } | undefined)?.status === 'stopped' && !isCompletedStoppedCommand(r)) ||
      !manualReceipt &&
      !state.results.some(r => r.started_at !== undefined && ['done', 'failed'].includes(r.status) || isCompletedStoppedCommand(r))) return;
    try {
      this.copy(formatToolResults(state.results));
      this.notice = { id: completion.id, ok: true };
    } catch (error) {
      this.notice = { id: completion.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 只由本次手动解析事实触发，不把诊断伪装为执行完成。 */
  diagnose(state: ToolState, diagnostic: ToolDiagnostic): void {
    if (diagnostic.source !== 'manual' || diagnostic.id <= this.attemptedDiagnostic) return;
    this.attemptedDiagnostic = diagnostic.id;
    this.diagnosticNotice = undefined;
    if (!state.config.autoCopyResults || diagnostic.cancelled || state.busy || state.completion || state.results.length ||
      state.source !== 'manual' || state.batchError?.error !== diagnostic.error.error || state.batchError.status !== diagnostic.error.status) return;
    let notice: NonNullable<ToolState['clipboard']>;
    try { this.copy(formatToolResults([], diagnostic.error)); notice = { id: diagnostic.id, ok: true }; }
    catch (error) { notice = { id: diagnostic.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
    this.diagnosticNotice = { diagnostic, notice };
  }

  notification(state: ToolState, diagnostic?: ToolDiagnostic | null): ToolState['clipboard'] {
    const current = this.diagnosticNotice;
    if (current && diagnostic?.source === 'manual' && !diagnostic.cancelled && diagnostic.id === current.diagnostic.id &&
      diagnostic.root === current.diagnostic.root && diagnostic.session === current.diagnostic.session && diagnostic.sourceText === current.diagnostic.sourceText &&
      state.source === 'manual' && !state.completion && !state.results.length && state.batchError?.error === current.diagnostic.error.error &&
      state.batchError.status === current.diagnostic.error.status) return current.notice;
    return this.notice?.id === state.completion?.id ? this.notice : undefined;
  }
}
