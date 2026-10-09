/** 当前真实工具批次的一次发送资格；自动与手动共用，历史与未知运输不重试。 */
import type { ToolResultReturnState, ToolState } from '../../shared/toolProtocol';
import type { PromptAttachmentData } from '../../shared/localPrompt';
import type { ToolSelection } from './harness';
import type { WebSendResult } from '../webComposerSender';
import { formatToolResults } from './resultClipboard';

interface Context { root: string | null; session: string; state: ToolState }
interface Options {
  current: () => Context;
  verify: (text: string, session: string, current: () => boolean) => Promise<WebSendResult>;
  attachments: (state: ToolState) => Promise<PromptAttachmentData[]>;
  send: (text: string, session: string, current: () => boolean, attachments: readonly PromptAttachmentData[]) => Promise<WebSendResult>;
  changed: () => void;
}

export class ToolResultReturn {
  private selection: ToolSelection | null = null;
  private generation = 0;
  private attempted = false;
  private phase: ToolResultReturnState['phase'] = 'ready';
  private message = '';
  constructor(private readonly options: Options) {}

  begin(selection: ToolSelection | null): void {
    this.generation++; this.selection = selection; this.attempted = false; this.phase = 'ready'; this.message = '';
  }

  invalidate(): void {
    this.generation++; this.attempted = true; this.phase = 'paused'; this.message = '已发起新一轮，旧批结果与附件不再发送';
    this.options.changed();
  }

  private eligible(context: Context): boolean {
    const { state, root, session } = context;
    return !!this.selection && root === this.selection.root && session === this.selection.session &&
      !state.busy && !state.batchError && !!state.completion && !state.completion.cancelled &&
      state.completion.batch_id === this.selection.batch.batch_id && state.results.length === this.selection.batch.requests.length &&
      state.results.every(result => result.batch_id === state.completion!.batch_id && ['done', 'failed', 'skipped_dependency'].includes(result.status) &&
        !(result.tool === 'run_command' && ((result.data as { status?: string; cleanup_pending?: boolean } | undefined)?.cleanup_pending ||
          ['running', 'stopped'].includes((result.data as { status?: string } | undefined)?.status ?? '')))) &&
      state.results.some(result => ['done', 'failed'].includes(result.status) && result.started_at !== undefined);
  }

  getState(context: Context): ToolResultReturnState {
    const attachmentCount = context.state.results.filter(result => result.tool === 'attach_file' && result.status === 'done').length;
    return { phase: this.phase, attachmentCount, canSend: attachmentCount > 0 && !context.state.config.automatic && !this.attempted && this.eligible(context),
      message: this.message || (attachmentCount ? '附件已暂存，等待本批结果发送' : '') };
  }

  async send(mode: 'automatic' | 'manual', authorized: () => boolean = () => true): Promise<WebSendResult> {
    const context = this.options.current(); const generation = this.generation;
    const automatic = mode === 'automatic';
    if (this.attempted || !authorized() || !this.eligible(context) || context.state.config.automatic !== automatic ||
      (!automatic && !this.getState(context).attachmentCount)) return { ok: false, error: '当前批附件不可发送或已经尝试发送，请查看状态' };
    const text = formatToolResults(context.state.results); const completionId = context.state.completion!.id;
    const current = () => {
      const latest = this.options.current();
      return generation === this.generation && authorized() && this.eligible(latest) && latest.state.config.automatic === automatic &&
        latest.state.completion?.id === completionId && latest.root === context.root && latest.session === context.session && formatToolResults(latest.state.results) === text;
    };
    this.attempted = true; this.phase = 'sending'; this.message = '正在发送本批结果与附件'; this.options.changed();
    let result: WebSendResult;
    try {
      result = await this.options.verify(text, context.session, current);
      if (result.ok && !current()) result = { ok: false, error: '项目、会话、批次或发送选项已变化，未发送' };
      if (result.ok) {
        const attachments = await this.options.attachments(context.state);
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
