/** 明确操作输出协议的唯一模板源；设置面板默认资源由构建生成。 */
import { buildSnippetText, buildWholeFileText, fenceFor, languageHintFor } from './snippet';

interface SpecExample {
  title: string;
  note: string;
  input: string;
  output: string;
  inShort: boolean;
}
function operation(path: string, kind: '替换' | '新建' | '覆盖全文', body: string): string {
  const fence = fenceFor(body);
  return ['### 文件：' + path, '### 操作：' + kind, fence + languageHintFor(path), body, fence].join('\n');
}
function pair(oldText: string, newText: string): string {
  return ['<<<<<<< SEARCH', oldText, '=======', newText, '>>>>>>> REPLACE'].join('\n');
}
function context(path: string, body: string, whole = false): string {
  return whole ? buildWholeFileText(path, body).text : buildSnippetText({ relPath: path, text: body, startLine: 1 }).text;
}
const examples: SpecExample[] = [
  { title: '局部替换', note: 'SEARCH 必须逐字来自原文；新内容行数可增加，IDE 自行计算位置。', inShort: true,
    input: context('src/counter.ts', 'let n = 0;'),
    output: operation('src/counter.ts', '替换', pair('let n = 0;', 'let n = 0;\nexport function inc() {\n  return ++n;\n}')) },
  { title: '新建文件', note: '只创建不存在的路径；围栏中是完整新文件内容，不包 SEARCH。', inShort: true,
    input: '请新建 src/util/format.ts，导出日期格式化函数。',
    output: operation('src/util/format.ts', '新建', 'export function formatDate(d: Date): string {\n  return d.toISOString().slice(0, 10);\n}') },
  { title: '覆盖全文', note: '明确请求整体修改时输出全文；复制完整原文不自动意味着覆盖。', inShort: true,
    input: context('src/config.ts', 'export const A = 1;\nexport const B = 2;', true),
    output: operation('src/config.ts', '覆盖全文', 'export const A = 1;\nexport const B = 2;\nexport const C = 3;') },
  { title: 'Markdown 内嵌代码块', note: '内层围栏原样保留；外层围栏至少四个反引号。', inShort: true,
    input: context('docs/notes.md', '# 说明\n\n```python\ndef foo():\n    pass\n```'),
    output: operation('docs/notes.md', '替换', pair('def foo():\n    pass', 'def foo():\n    return 1')) },
  { title: '纯文本文件', note: '.txt 可不写语言标注，保留原文空白。', inShort: true,
    input: context('docs/summary.txt', '第一行纯文本。'),
    output: operation('docs/summary.txt', '替换', pair('第一行纯文本。', '第一行纯文本。\n第二行纯文本。')) },
  { title: '普通讨论不落文件', note: '没有修改需求时，不加文件、操作头；命令及示例是只读内容。', inShort: true,
    input: '冒泡排序的时间复杂度是多少？', output: '平均和最坏情况为 O(n²)，空间复杂度为 O(1)。' },
  { title: '插入内容', note: '用真实原文作为 SEARCH，在 REPLACE 保留原文并追加内容。', inShort: false,
    input: context('src/hello.ts', 'export const greeting = "hello";'),
    output: operation('src/hello.ts', '替换', pair('export const greeting = "hello";', 'export const greeting = "hello";\nexport const language = "zh";')) },
  { title: '删除内容', note: '空 REPLACE 表示删除；SEARCH 非空，不能用空 SEARCH 插入。', inShort: false,
    input: context('src/debug.ts', 'console.log("debug");\n'),
    output: operation('src/debug.ts', '替换', pair('console.log("debug");\n', '')) },
  { title: '同文件多处替换', note: '一个块内可放多个完整替换对；各 SEARCH 在同一原文中唯一且不重叠，一次应用。', inShort: false,
    input: context('src/options.ts', 'const size = 1;\nconst enabled = false;'),
    output: operation('src/options.ts', '替换', pair('const size = 1;', 'const size = 2;') + '\n' + pair('const enabled = false;', 'const enabled = true;')) },
  { title: '.env 与无扩展名文件', note: '每个文件重新声明文件与操作头；不从上一块继承路径或操作。', inShort: false,
    input: context('.env', 'PORT=3000') + '\n\n' + context('LICENSE', '旧许可说明'),
    output: operation('.env', '替换', pair('PORT=3000', 'PORT=4000')) + '\n\n' + operation('LICENSE', '覆盖全文', '新的许可说明') },
  { title: '内容包含更长围栏', note: '内容有四个连续反引号时外层加长，结尾与开头同长度。', inShort: false,
    input: context('docs/fences.md', '````text\n原文\n````', true),
    output: operation('docs/fences.md', '覆盖全文', '````text\n新内容\n````') },
  { title: '空文件与只读命令', note: '空新建或覆盖也须完整围栏；运行命令不附修改元数据。', inShort: false,
    input: '请新建 empty.txt 空文件，并说明查看目录的命令。',
    output: operation('empty.txt', '新建', '') + '\n\n仅供手动执行的命令：\n````powershell\nGet-ChildItem\n````' },
  { title: '错误示例：残缺替换对（不可应用）', note: '下面故意缺少 REPLACE 闭合标记，不能这样输出；请给完整替换对。', inShort: false,
    input: context('src/broken.ts', 'const a = 1;'),
    output: operation('src/broken.ts', '替换', '<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;') },
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
const core = [
  '【输入/输出格式要求】',
  '我提供的是只读原文上下文；你输出的是明确的修改操作。不要把上下文头照抄成修改指令。',
  '每个修改块必须紧邻声明 ### 文件：相对路径 和 ### 操作：替换／新建／覆盖全文（只能选其中一个）。',
  '然后用至少四个反引号围栏承载内容，成对闭合，开头与结尾同长度。内容中最长连续反引号超过围栏时，外层比它多一个。',
  '替换：围栏内依次写独立标记行 <<<<<<< SEARCH、原文、=======、新内容、>>>>>>> REPLACE。一个块可含多个完整替换对。',
  'SEARCH 必须逐字复制上下文中的真实原文，非空且在目标原文中唯一匹配。保留缩进、Tab、空格、首尾空行与末尾换行；不改写，不加行号，不用省略号。',
  '原文不存在匹配或出现多次时，请先请求补充上下文；不能猜测位置、模糊匹配或改掉所有匹配。',
  '新建：目标必须不存在，围栏内直接给完整文件文本；覆盖全文：目标必须存在，围栏内直接给修改后的全文。两者不包装 SEARCH／REPLACE，允许空文件，但不能缺失围栏。',
  '无需提供定位行号或范围，IDE 根据原文计算；旧行号协议不可应用。一次操作中的替换对不能重叠；同文件覆盖全文不能与其他操作混用，新建不能重复。',
  '文件与操作头必须在围栏外，且每个块重新声明。命令、流程图、普通示例与讨论不带修改元数据；不冒充文件变更。',
  '语言标注仅用于显示：.ts→typescript、.py→python、.json→json、.md→markdown；.txt／无扩展名可留空，.env→bash。正文里的路径注释属于内容，不能擅自剥除。',
  '输出完整内容；无法一次输出时请分多轮，每轮交付一个完整操作，不用省略号、不提交半段围栏或替换对。',
].join('\n');
const details = [
  '补充规则：插入使用一段真实 SEARCH，在 REPLACE 中保留它并追加；删除使用空 REPLACE。每个正文与后面的标记／闭合围栏间多一个结构性换行，正文自己的末尾换行仍须保留。',
  '多个文件各自给完整头部；同文件多个围栏是独立操作，全部 SEARCH 根据同一原文校验，不能搜索前一 REPLACE 刚生成的内容。',
  '若真实正文含独立的 SEARCH／分隔线／REPLACE 标记而产生歧义，请对该文件改用明确的覆盖全文，不猜测标记归属。新建／覆盖全文正文内的协议示例按字面保存。',
  '重复原文请补选更多上下文来获得唯一匹配；不足以判断时先提问。覆盖全文会完整显示 diff，请核对是否遗漏原有内容。',
  '格式错误示例（不可应用）：缺少操作头、操作名称未知、未闭合围栏、残缺替换对、空 SEARCH、混入旧范围头。不要使用这些格式；IDE 会显示诊断，不自动修正。',
].join('\n');
export const FORMAT_SPEC_SHORT = [core, '示例（输入 → 输出）', renderExamples(true)].join('\n\n');
export const FORMAT_SPEC_FULL = [core, details, '示例（输入 → 输出）', renderExamples(false)].join('\n\n');

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
 *   当前版本的自定义非空 → 用该自定义；
 *   否则 → 回落该版本的内置默认。
 *
 * 这就是"用户可以改系统 prompt"的全部机制：**只影响拼进 prompt 的格式段**，
 * 其余固定文案（## 用户需求 / ## 工作环境 …）仍由程序生成，保证提示词骨架始终可被解析。
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
  return trimmed.length > 0 ? (raw as string) : getFormatSpec(v);
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
  /** 输出格式要求；传入空字符串则不附 */
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

  if (input.formatSpec.trim().length > 0) {
    parts.push(input.formatSpec);
  }

  return parts.join('\n\n');
}

