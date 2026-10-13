import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { MAX_MANUAL_TOOL_JSON_LENGTH, type ManualToolJsonPreview, type ManualToolJsonExecution } from '../../shared/manualToolJson';
import { parseToolBatch, type ToolBatch } from '../../shared/toolProtocol';

interface Context { project: string | null; scope: string; error?: string }
type ManualWeb = Pick<WebContents, 'on' | 'removeListener'>;
interface Pending { token: string; project: string; scope: string; batch: ToolBatch; expires: number }

/** 用户粘贴的完整批次：只预览与单次确认，不采集网页或修复 JSON。 */
export class ManualToolJson {
  private pending: Pending | undefined;
  private web: ManualWeb;
  constructor(web: ManualWeb, private readonly context: () => Context, private readonly execute: (batch: ToolBatch) => Promise<void>) {
    this.web = web; this.listen();
  }
  private readonly navigating = (event: { isMainFrame: boolean }) => { if (event.isMainFrame) this.invalidate(); };
  private readonly inPage = (_event: unknown, _url: string, main: boolean) => { if (main) this.invalidate(); };
  private readonly destroyed = () => this.invalidate();
  private listen(): void { this.web.on('did-start-navigation', this.navigating); this.web.on('did-navigate-in-page', this.inPage); this.web.on('destroyed', this.destroyed); }
  private unlisten(): void { this.web.removeListener('did-start-navigation', this.navigating); this.web.removeListener('did-navigate-in-page', this.inPage); this.web.removeListener('destroyed', this.destroyed); }
  bindWeb(web: ManualWeb): void { this.invalidate(); this.unlisten(); this.web = web; this.listen(); }
  invalidate(): void { this.pending = undefined; }
  dispose(): void { this.invalidate(); this.unlisten(); }

  preview(raw: unknown): ManualToolJsonPreview {
    this.invalidate();
    const context = this.context();
    if (context.error) return { ok: false, error: context.error };
    if (!context.project) return { ok: false, error: '请先打开项目，再校验工具 JSON' };
    if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_MANUAL_TOOL_JSON_LENGTH || raw.includes('\0'))
      return { ok: false, error: '请输入完整工具 JSON，最多 200000 字符且不能包含空字符' };
    const text = raw.trim();
    let source: string;
    if (text.startsWith('{')) {
      let longest = 0; for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
      const fence = '`'.repeat(Math.max(4, longest + 1)); source = `${fence}mini-ai-tools\n${text}\n${fence}`;
    } else {
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const open = /^(`{3,}|~{3,})mini-ai-tools\s*$/.exec(lines[0]!);
      if (!open || lines.at(-1) !== open[1] || lines.slice(1, -1).some(line => line === open[1]))
        return { ok: false, error: '只接受完整原始 JSON 或单个 mini-ai-tools 正式围栏，不能混入说明或多个批次' };
      source = text;
    }
    const parsed = parseToolBatch(source);
    if (parsed.kind === 'error') return { ok: false, error: parsed.error };
    if (parsed.kind !== 'batch') return { ok: false, error: '只接受完整工具请求批次，不接受 repair_draft、结果回执或普通说明' };
    const token = randomUUID();
    this.pending = { token, project: context.project, scope: context.scope, batch: structuredClone(parsed.batch), expires: Date.now() + 300_000 };
    return { ok: true, token, batch_id: parsed.batch.batch_id, project: context.project, requests: structuredClone(parsed.batch.requests) };
  }

  async run(token: unknown): Promise<ManualToolJsonExecution> {
    const pending = this.pending; this.invalidate();
    if (!pending || typeof token !== 'string' || token !== pending.token || Date.now() > pending.expires)
      return { ok: false, error: '校验已失效或已执行，请重新校验工具 JSON' };
    const context = this.context();
    if (context.error) return { ok: false, error: context.error };
    if (context.project !== pending.project || context.scope !== pending.scope)
      return { ok: false, error: '项目、平台或会话已变化，请重新校验工具 JSON' };
    try { await this.execute(pending.batch); return { ok: true }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}
