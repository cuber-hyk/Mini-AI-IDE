import { MAX_MANUAL_TOOL_JSON_LENGTH, type ManualToolJsonExecution } from '../../shared/manualToolJson';
import { parseToolBatch, type ToolBatch } from '../../shared/toolProtocol';
import { TOOL_JSON_RESEND_INSTRUCTION } from '../../shared/toolJsonDiagnostic';

interface Context { project: string | null; error?: string }

/** 用户粘贴只补上采集；校验、权限和执行继续由工具层负责。 */
export class ManualToolJson {
  constructor(private readonly context: () => Context, private readonly execute: (batch: ToolBatch) => Promise<void>,
    private readonly diagnose: (sourceText: string, error: string) => void) {}

  async run(raw: unknown): Promise<ManualToolJsonExecution> {
    const context = this.context();
    if (context.error) return { ok: false, error: context.error };
    if (!context.project) return { ok: false, error: '请先打开项目，再执行工具 JSON' };
    if (typeof raw !== 'string' || raw.length > MAX_MANUAL_TOOL_JSON_LENGTH || raw.includes('\0'))
      return { ok: false, error: '请输入完整工具 JSON，最多 200000 字符且不能包含空字符' };
    const invalid = (error: string): ManualToolJsonExecution => {
      this.diagnose(raw, error);
      return { ok: true };
    };
    if (!raw.trim()) return invalid('请输入完整工具 JSON');
    const text = raw.trim();
    let source: string;
    if (text.startsWith('{')) {
      let longest = 0; for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
      const fence = '`'.repeat(Math.max(4, longest + 1)); source = `${fence}mini-ai-tools\n${text}\n${fence}`;
    } else {
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const open = /^(`{3,}|~{3,})mini-ai-tools\s*$/.exec(lines[0]!);
      if (!open || lines.at(-1) !== open[1] || lines.slice(1, -1).some(line => line === open[1]))
        return invalid('只接受完整原始 JSON 或单个 mini-ai-tools 正式围栏，不能混入说明或多个批次');
      source = text;
    }
    const parsed = parseToolBatch(source);
    if (parsed.kind === 'error') return invalid(`${parsed.error}\n${TOOL_JSON_RESEND_INSTRUCTION}`);
    if (parsed.kind !== 'batch') return invalid('只接受完整工具请求批次，不接受 repair_draft、结果回执或普通说明');
    try { await this.execute(parsed.batch); return { ok: true }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}
