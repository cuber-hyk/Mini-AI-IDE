/** 当前工具批次或解析诊断的一次发送资格；历史与未知运输不重试。 */
import type { ToolResultReturnState, ToolState } from '../../shared/toolProtocol';
import { isBatchValidationFailure, isCompletedStoppedCommand, isPermissionDenialReceipt } from '../../shared/toolProtocol';
import type { PromptAttachmentData } from '../../shared/localPrompt';
import type { ToolDiagnostic, ToolSelection } from './harness';
import type { WebSendResult } from '../webComposerSender';
import { formatToolResults } from './resultClipboard';

export type ToolReturnSource = { kind: 'batch'; selection: ToolSelection } | { kind: 'diagnostic'; diagnostic: ToolDiagnostic };
interface Context { root: string | null; session: string; state: ToolState; diagnostic?: ToolDiagnostic | null }
interface Options {
  current: () => Context;
  verify: (text: string, session: string, current: () => boolean, source: ToolReturnSource) => Promise<WebSendResult>;
  attachments: (state: ToolState) => Promise<PromptAttachmentData[]>;
  send: (text: string, session: string, current: () => boolean, attachments: readonly PromptAttachmentData[]) => Promise<WebSendResult>;
  changed: () => void;
}

export class ToolResultReturn {
  private source: ToolReturnSource | null = null;
  private generation = 0;
  private attempted = false;
  private phase: ToolResultReturnState['phase'] = 'ready';
  private message = '';
  constructor(private readonly options: Options) {}

  begin(source: ToolReturnSource | null): void {
    this.generation++; this.source = source; this.attempted = false; this.phase = 'ready'; this.message = '';
  }

  invalidate(): void {
    this.generation++; this.attempted = true; this.phase = 'invalidated'; this.message = '已发起新一轮，旧批结果与附件不再发送';
    this.options.changed();
  }

  private eligible(context: Context): boolean {
    const { state, root, session } = context;
    const source = this.source;
    if (!source || !root || state.busy) return false;
    const scope = source.kind === 'batch' ? source.selection : source.diagnostic;
    if (root !== scope.root || session !== scope.session) return false;
    if (source.kind === 'diagnostic') {
      const diagnostic = context.diagnostic;
      return !!diagnostic && !diagnostic.cancelled && diagnostic.id === source.diagnostic.id &&
        diagnostic.root === root && diagnostic.session === session && diagnostic.sourceText === source.diagnostic.sourceText &&
        !state.completion && state.results.length === 0 && !!state.batchError &&
        state.batchError.status === diagnostic.error.status && state.batchError.error === diagnostic.error.error;
    }
    return !state.batchError && !!state.completion && !state.completion.cancelled &&
      state.completion.batch_id === source.selection.batch.batch_id && state.results.length === source.selection.batch.requests.length &&
      state.results.every(result => result.batch_id === state.completion!.batch_id &&
        (['done', 'failed', 'permission_denied', 'skipped_dependency'].includes(result.status) || isCompletedStoppedCommand(result)) &&
        !(result.tool === 'run_command' && ((result.data as { status?: string; cleanup_pending?: boolean } | undefined)?.cleanup_pending ||
          (['running', 'stopped'].includes((result.data as { status?: string } | undefined)?.status ?? '') && !isCompletedStoppedCommand(result))))) &&
      (isBatchValidationFailure(state) || isPermissionDenialReceipt(state) || state.results.some(result =>
        ['done', 'failed'].includes(result.status) && result.started_at !== undefined || isCompletedStoppedCommand(result)));
  }

  getState(context: Context): ToolResultReturnState {
    const attachmentCount = context.state.results.filter(result => result.tool === 'attach_file' && result.status === 'done').length;
    return { phase: this.phase, attachmentCount, canSend: attachmentCount > 0 && !context.state.config.automatic && !this.attempted && this.eligible(context),
      message: this.message || (attachmentCount ? '附件已暂存，等待本批结果发送' : '') };
  }

  async send(mode: 'automatic' | 'manual', authorized: () => boolean = () => true): Promise<WebSendResult> {
    const context = this.options.current(); const generation = this.generation; const source = this.source;
    const automatic = mode === 'automatic';
    if (!source || this.attempted || !authorized() || !this.eligible(context) || context.state.config.automatic !== automatic ||
      (!automatic && (source.kind === 'diagnostic' || !this.getState(context).attachmentCount))) return { ok: false, error: '当前回执不可发送或已经尝试发送，请查看状态' };
    const text = formatToolResults(context.state.results, context.state.batchError); const completionId = context.state.completion?.id;
    const current = () => {
      const latest = this.options.current();
      return generation === this.generation && authorized() && this.eligible(latest) && latest.state.config.automatic === automatic &&
        latest.state.completion?.id === completionId && latest.root === context.root && latest.session === context.session && formatToolResults(latest.state.results, latest.state.batchError) === text;
    };
    this.attempted = true; this.phase = 'sending'; this.message = '正在发送本批结果与附件'; this.options.changed();
    let result: WebSendResult;
    try {
      result = await this.options.verify(text, context.session, current, source);
      if (result.ok && !current()) result = { ok: false, error: '项目、会话、批次或发送选项已变化，未发送' };
      if (result.ok) {
        const attachments = source.kind === 'diagnostic' || isBatchValidationFailure(context.state) || isPermissionDenialReceipt(context.state) ? [] : await this.options.attachments(context.state);
        result = current() ? await this.options.send(text, context.session, current, attachments) : { ok: false, error: '项目、会话、批次或发送选项已变化，未发送' };
      }
    } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    if (generation === this.generation) {
      this.phase = result.ok ? 'sent' : 'paused';
      this.message = result.ok ? '本批结果与附件已发送' : `${result.error ?? '发送失败'}；本批不重复上传，请在官网处理或发起新批次`;
      this.options.changed();
    }
    return result;
  }
}
