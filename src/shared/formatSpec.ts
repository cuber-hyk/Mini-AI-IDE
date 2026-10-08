/** 唯一工具输出协议的模板源；设置面板默认资源由构建生成。 */
import { buildSnippetText, buildWholeFileText, fenceFor } from './snippet';
import { TOOL_PROTOCOL_PROMPT, type ToolRequest } from './toolProtocol';

interface SpecExample { title: string; note: string; input: string; output: string; inShort: boolean }
function request(id: string, tool: ToolRequest['tool'], args: ToolRequest['args'], depends_on?: string[]): ToolRequest {
  return { id, tool, args, ...(depends_on ? { depends_on } : {}) };
}
function batch(id: string, requests: ToolRequest[]): string {
  return ['```mini-ai-tools', JSON.stringify({ protocol_version: 1, batch_id: id, requests }), '```'].join('\n');
}
function replace(path: string, old_string: string, new_string: string): ToolRequest {
  return request('edit', 'apply_changes', { changes: [{ path, operation: 'replace', edits: [{ old_string, new_string }] }] });
}
function context(path: string, body: string, whole = false): string {
  return whole ? buildWholeFileText(path, body).text : buildSnippetText({ relPath: path, text: body, startLine: 1 }).text;
}
const examples: SpecExample[] = [
  { title: '按名称加载技能', note: '只读取目录中真实可用技能的完整说明，不自动执行技能脚本。', inShort: false,
    input: '技能目录有 review，用它审阅当前项目。',
    output: batch('example-skill', [request('skill', 'load_skill', { name: 'review' })]) },
  { title: '局部替换', note: '原文逐字匹配；输出实际修改请求。', inShort: true,
    input: context('src/counter.ts', 'let n = 0;'),
    output: batch('example-replace', [replace('src/counter.ts', 'let n = 0;', 'let n = 1;')]) },
  { title: '新建文件', note: '目标不存在，content 为完整文本。', inShort: true,
    input: '新建 src/util/format.ts，导出日期格式化函数。',
    output: batch('example-create', [request('create', 'apply_changes', { changes: [{ path: 'src/util/format.ts', operation: 'create', content: 'export function formatDate(d: Date): string {\n  return d.toISOString().slice(0, 10);\n}' }] })]) },
  { title: '覆盖全文', note: '用户已明确要求整体修改；覆盖存在的文件。', inShort: true,
    input: '增加 C，整体替换该文件。\n' + context('src/config.ts', 'export const A = 1;\nexport const B = 2;', true),
    output: batch('example-overwrite', [request('write', 'apply_changes', { changes: [{ path: 'src/config.ts', operation: 'overwrite', content: 'export const A = 1;\nexport const B = 2;\nexport const C = 3;' }] })]) },
  { title: '查询项目和目录', note: '不知道项目结构时先查询，拿到结果再决定修改。', inShort: true,
    input: '了解项目根目录、src 结构和 TypeScript 文件。',
    output: batch('example-project', [request('info', 'get_project_info', {}), request('tree', 'list_directory', { path: 'src', depth: 2, limit: 100 }), request('find', 'search_files', { pattern: '**/*.ts', limit: 100 })]) },
  { title: '读取文件和搜索内容', note: '行范围只用于查询；search_text 是字面匹配。', inShort: true,
    input: '查看 README.md 前三行，找项目中的 TODO。',
    output: batch('example-read', [request('read', 'read_file', { path: 'README.md', start_line: 1, end_line: 3 }), request('search', 'search_text', { query: 'TODO', context: 1, limit: 20 })]) },
  { title: '普通讨论不调用工具', note: '解释和代码示例均不执行；示例不要标记为正式请求。', inShort: true,
    input: '演示如何复制数组再排序，给一个普通代码示例。',
    output: '先复制数组，再按数值排序，不改变原数组。以下代码仅用于解释：\n```javascript\nconst sorted = [...values].sort((a, b) => a - b);\n```' },
  { title: '插入与删除', note: '插入保留真实原文，删除使用空 new_string。', inShort: false,
    input: context('src/hello.ts', 'export const greeting = "hello";') + '\n\n' + context('src/debug.ts', 'console.log("debug");\n'),
    output: batch('example-insert-delete', [request('edit', 'apply_changes', { changes: [
      { path: 'src/hello.ts', operation: 'replace', edits: [{ old_string: 'export const greeting = "hello";', new_string: 'export const greeting = "hello";\nexport const language = "zh";' }] },
      { path: 'src/debug.ts', operation: 'replace', edits: [{ old_string: 'console.log("debug");\n', new_string: '' }] },
    ] })]) },
  { title: '同文件多处替换', note: '同文件集中一条请求，所有 old_string 基于同一原文且不重叠。', inShort: false,
    input: context('src/options.ts', 'const size = 1;\nconst enabled = false;'),
    output: batch('example-multiple', [request('edit', 'apply_changes', { changes: [{ path: 'src/options.ts', operation: 'replace', edits: [
      { old_string: 'const size = 1;', new_string: 'const size = 2;' }, { old_string: 'const enabled = false;', new_string: 'const enabled = true;' },
    ] }] })]) },
  { title: 'Markdown 内嵌围栏', note: '围栏只是 JSON 字符串内容，完整保留原文。', inShort: false,
    input: context('docs/fences.md', '````text\n原文\n````', true),
    output: batch('example-markdown', [request('write', 'apply_changes', { changes: [{ path: 'docs/fences.md', operation: 'overwrite', content: '# 说明\n\n````text\n新内容\n````' }] })]) },
  { title: '无扩展名与空文件', note: '每个目标明确路径；允许 content 为空。', inShort: false,
    input: context('.env', 'PORT=3000') + '\n\n' + context('LICENSE', '旧许可说明') + '\n请同时新建 empty.txt 空文件。',
    output: batch('example-empty', [request('edit', 'apply_changes', { changes: [
      { path: '.env', operation: 'replace', edits: [{ old_string: 'PORT=3000', new_string: 'PORT=4000' }] },
      { path: 'LICENSE', operation: 'overwrite', content: '新的许可说明' }, { path: 'empty.txt', operation: 'create', content: '' },
    ] })]) },
  { title: '前台与后台命令', note: '显式指定 shell 和超时；后台 process_id 由真实结果提供。', inShort: false,
    input: '先打印 ready，再后台每秒打印一次 tick。',
    output: batch('example-command', [request('ready', 'run_command', { command: 'Write-Output "ready"', shell: 'powershell', timeout_ms: 5000 }), request('watch', 'run_command', { command: 'while ($true) { Write-Output "tick"; Start-Sleep -Seconds 1 }', shell: 'powershell', background: true }, ['ready'])]) },
  { title: '修改成功后运行 Bash', note: '依赖只保证前置成功；失败时后续命令跳过。Bash 须在本机可用。', inShort: false,
    input: '新建 smoke.sh 打印 ok，然后使用 Bash 验证。',
    output: batch('example-dependency', [request('create', 'apply_changes', { changes: [{ path: 'smoke.sh', operation: 'create', content: 'printf "ok\\n"\n' }] }), request('check', 'run_command', { command: 'bash smoke.sh', shell: 'bash', timeout_ms: 5000 }, ['create'])]) },
  { title: '读取并停止已知进程', note: '只使用 IDE 上一轮返回的 process_id；cursor 也来自真实结果。', inShort: false,
    input: '上一轮工具结果：{"process_id":"process-123","cursor":0,"status":"running"}。读取输出后停止该进程。',
    output: batch('example-process', [request('output', 'get_process_output', { process_id: 'process-123', cursor: 0, limit: 1000 }), request('stop', 'stop_process', { process_id: 'process-123' }, ['output'])]) },
];
function displayed(text: string): string {
  const fence = '`'.repeat(Math.max(5, fenceFor(text).length));
  return [fence, text, fence].join('\n');
}
function renderExamples(short: boolean): string {
  return examples.filter(example => !short || example.inShort).map((example, index) => [
    '示例 ' + (index + 1) + '｜' + example.title, example.note,
    '【我给你的】', displayed(example.input), '【你该给我的】', displayed(example.output),
  ].join('\n')).join('\n\n');
}
export const FORMAT_SPEC_SHORT = [TOOL_PROTOCOL_PROMPT, '工具示例（输入 → 输出；外层围栏内是演示，不执行）', renderExamples(true)].join('\n\n');
export const FORMAT_SPEC_FULL = [TOOL_PROTOCOL_PROMPT, '工具示例（输入 → 输出；外层围栏内是演示，不执行）', renderExamples(false)].join('\n\n');

export type FormatSpecVariant = 'short' | 'full';

/** 版本判定：任何非 'full' 的值都归一为 'short'（IPC 入参不可信） */
export function normalizeVariant(v: unknown): FormatSpecVariant {
  return v === 'full' ? 'full' : 'short';
}

/**
 * 自定义格式要求的长度上限（字符）。
 * 8000 字足够写进整套约定与示例；再长会挤占 prompt 里"用户需求 + 目录结构"的注意力。
 * 超限时**截断而不是拒绝**：用户点保存时提示一次，内容仍保留（不让他白写一遍）。
 */
export const MAX_CUSTOM_FORMAT_SPEC_LENGTH = 8000;

/**
 * 分版本的自定义内容。
 *
 * 为什么**每个版本各存一份**而不是共用一个：用户在"简洁版"和"完整版"上想改的东西
 * 往往不同（简洁版可能只想留三条硬规则，完整版才有余地放长注解）。共用一个字段的结果是
 * "拨到另一版发现内容也变了"，很反直觉。
 */
export interface CustomFormatSpecs {
  short?: string | null;
  full?: string | null;
}

/**
 * 取最终使用的「输出格式要求」。
 *
 * 生效规则（**分版本、各自独立**）：
 *   当前版本的自定义非空 → 强制工具协议 + 该自定义原文；
 *   否则 → 回落该版本的内置默认。
 *
 * 自定义原文仍保留在尾部，作为表达风格补充；强制工具协议不能被自定义移除。
 *
 * 未设置或只写了空白时回落内置默认（见 settings.ts 的 load()：空串视同未设置）。
 *
 * @param customs 分版本自定义内容
 * @param variant 当前选择的版本
 */
export function resolveFormatSpec(customs: CustomFormatSpecs | null | undefined, variant: FormatSpecVariant = 'short'): string {
  const v = normalizeVariant(variant);
  const raw = customs ? (v === 'full' ? customs.full : customs.short) : null;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed.length > 0 ? withToolProtocol(raw as string) : getFormatSpec(v);
}

/** 所有格式复制和 prompt 组装共用同一执行约定，内置模板不重复包装。 */
function withToolProtocol(text: string): string {
  return text.startsWith(TOOL_PROTOCOL_PROMPT) ? text : TOOL_PROTOCOL_PROMPT + '\n\n' + text;
}

export function getFormatSpec(variant: FormatSpecVariant = 'short'): string {
  return normalizeVariant(variant) === 'full' ? FORMAT_SPEC_FULL : FORMAT_SPEC_SHORT;
}

/* ------------------------------------------------------------------ *
 * 完整 prompt 组装（由用户在本应用内点击"复制 prompt"触发）
 * ------------------------------------------------------------------ */

export interface PromptContext {
  /** 工作目录（绝对路径，按用户机器如实给出） */
  root: string | null;
  /** 目录摘要（相对路径列表，已截断并注明） */
  tree: string | null;
  /** 运行环境摘要，如 "Windows 10.0.26200；Node 24.21.0" */
  environment: string | null;
}

export interface BuildPromptInput {
  /** 用户在应用内输入框里写的需求（唯一由人写的部分） */
  requirement: string;
  context: PromptContext;
  /** 输出格式补充；强制工具协议始终附带 */
  formatSpec: string;
  /** 可选：要改的文件路径（用户手填），会单独成段 */
  targetFiles?: string[];
}

/**
 * 把"用户需求 + 环境上下文 + 输出格式要求"组装成完整 prompt。
 *
 * 说明：本函数只产出**文本**，由调用方写入系统剪贴板；
 * **绝不写入网页输入框** —— 最后那一下 Ctrl+V 必须由用户完成（ADR-0003）。
 */
export function buildPrompt(input: BuildPromptInput): string {
  const parts: string[] = [];

  if (input.requirement.trim().length > 0) {
    parts.push(`## 用户需求\n${input.requirement.trim()}`);
  }

  const envLines: string[] = [];
  if (input.context.environment) envLines.push(`- 运行环境: ${input.context.environment}`);
  if (input.context.root) envLines.push(`- 当前工作目录: ${input.context.root}`);
  if (envLines.length > 0) {
    parts.push(`## 工作环境\n${envLines.join('\n')}`);
  }

  if (input.context.tree) {
    parts.push(`## 目录结构（摘要）\n${input.context.tree}`);
  }

  if (input.targetFiles && input.targetFiles.length > 0) {
    parts.push(`## 要改的文件\n${input.targetFiles.map((f) => `- ${f}`).join('\n')}`);
  }

  parts.push(withToolProtocol(input.formatSpec));
  return parts.join('\n\n');
}

