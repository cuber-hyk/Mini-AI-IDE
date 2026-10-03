/**
 * 提示词片段组装（纯逻辑，可单测）
 *
 * 目标：用户在编辑器里"选中一段代码"或"打开一个文件"时，程序生成**可直接粘贴给模型**的
 * 文本片段 —— 包含文件路径（模型据此知道写回哪里）、行范围与内容本身。
 *
 * 关键设计：
 *
 *  1. **输入与输出结构完全对称**（用户确定）。程序发出去的片段与提示词里要求模型
 *     输出的形态**逐字一致**，两者共用同一条骨架：
 *
 *       ### 文件：<相对路径>
 *       ### 范围：<起始行>-<结束行>
 *       ````<语言标注>
 *       <内容，不含行号>
 *       ````
 *
 *     好处：模型只需学一套规则（"照抄骨架、只改内容"），且解析器对输入与输出
 *     走的是同一条路径线索（`### 文件` 命中标题式路径行、`### 范围` 命中行区间指令）。
 *
 *  2. **行号只出现在 `### 范围` 行里，围栏内容里绝不含行号**。
 *     早期版本在围栏内写了 ` 80| code` 前缀。它对"人定位"与"机器写回"都是冗余
 *     （范围行已经说清楚替换哪几行），却带来一个真实风险：对 .md/.txt 这类纯文本，
 *     行号在视觉上与正文无异，模型漏写 `### 范围` 时（此时解析器不会剥前缀，
 *     见 returnPath.ts 只在 range 存在时调 stripNumberedPrefix）
 *     带行号的内容会被**原样写进文件**。单一真相源（范围行）比双份（行号 + 范围行）稳。
 *
 *  3. **围栏最少四个反引号**（不是固定四个）。内容里若出现四个及以上连续反引号，
 *     外层必须比它更长，否则会被提前闭合、内容被截断。规则：**比内容中最长的
 *     连续反引号多 1，最少 4**（与输出侧提示词「至少四个」一致，也与采集侧
 *     replyCollector 的 fenceFor 同规则）。
 */
import type { NumberedSnippetInput } from './contract';

/** 围栏下限：与提示词要求模型的「用四个反引号」对齐 */
export const MIN_FENCE_LENGTH = 4;

/** 计算安全围栏：比内容中最长连续反引号多 1，最少 MIN_FENCE_LENGTH 个 */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) {
    const len = (m[0] ?? '').length;
    if (len > longest) longest = len;
  }
  return '`'.repeat(Math.max(MIN_FENCE_LENGTH, longest + 1));
}

/** 由文件相对路径推断围栏语言标注（仅用于让模型正确识别语法，不参与路径判断） */
export function languageHintFor(relPath: string): string {
  const ext = (relPath.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    json: 'json', jsonc: 'jsonc',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
    c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
    swift: 'swift', scala: 'scala', lua: 'lua', pl: 'perl',
    sh: 'bash', bash: 'bash', zsh: 'zsh', ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html', xml: 'xml', svg: 'xml', vue: 'vue', svelte: 'svelte', astro: 'astro',
    md: 'markdown', markdown: 'markdown', txt: '', tex: 'latex',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'bash',
    csv: 'csv', tsv: 'tsv', diff: 'diff', patch: 'diff',
  };
  return map[ext] ?? '';
}

/** 片段头部：单独一行声明文件路径（模型据此确定写回目标） */
export function pathHeader(relPath: string): string {
  return `### 文件：${relPath}`;
}

/** 片段头部：单独一行声明行范围（替换哪几行的唯一依据） */
export function rangeHeader(startLine: number, endLine: number): string {
  return `### 范围：${startLine}-${endLine}`;
}

export interface SnippetParts {
  /** 写入剪贴板的完整文本 */
  text: string;
  /** 路径（相对根目录） */
  relPath: string;
  /** 片段起始行（1 起） */
  startLine: number;
  /** 片段结束行（含） */
  endLine: number;
  /** 使用的围栏 */
  fence: string;
}

/**
 * 组装"局部修改"片段：`### 文件` + `### 范围` + 围栏 + 内容（**不含行号**）。
 *
 * 行范围由 `### 范围：N-M` 承载（这是替换哪几行的**唯一依据**）；
 * 围栏内只放原文，不带 `N| ` 前缀 —— 理由见文件头注释第 2 条。
 */
export function buildSnippetText(input: NumberedSnippetInput): SnippetParts {
  const relPath = input.relPath.trim();
  const body = stripTrailingBlank(input.text);
  const fence = fenceFor(body);
  const lang = languageHintFor(relPath);
  const lineCount = input.text.length === 0 ? 0 : input.text.split(/\r\n|\r|\n/).length;
  const startLine = Math.max(1, Math.round(input.startLine));
  const endLine = startLine + Math.max(0, lineCount - 1);

  const lines = [pathHeader(relPath), rangeHeader(startLine, endLine), fence + lang, body, fence];
  return { text: lines.join('\n'), relPath, startLine, endLine, fence };
}

export interface WholeFileParts {
  /** 写入剪贴板的完整文本 */
  text: string;
  relPath: string;
  fence: string;
  lineCount: number;
  /** 片段声明的行范围（整文件 = 1..lineCount），与局部片段同构 */
  startLine: number;
  endLine: number;
}

/**
 * 组装"整个文件"片段（**上下文**用途）：`### 文件` + `### 范围：1-N` + 围栏 + 全文。
 *
 * 与"局部修改"片段**同一骨架**（用户要求输入输出完全对称）——
 * 早期版本这里写的是「这个文件是 <路径>」且不带范围行，与提示词要求的锚点形式不一致，
 * 模型需要在两套头部格式间切换。现在两种片段只差"范围是几行"。
 *
 * 整体输出的语义因此是「替换 1..N 行」（会走三向校验），而不是"无条件整文件覆盖"。
 */
export function buildWholeFileText(relPath: string, content: string): WholeFileParts {
  const rel = relPath.trim();
  // 结尾多余空行会让围栏被空行推远，去掉以求紧凑
  const cleaned = stripTrailingBlank(content);
  const fence = fenceFor(cleaned);
  const lang = languageHintFor(rel);
  const lineCount = cleaned.length === 0 ? 0 : cleaned.split(/\r\n|\r|\n/).length;
  const startLine = 1;
  const endLine = Math.max(1, lineCount);
  const lines = [pathHeader(rel), rangeHeader(startLine, endLine), `${fence}${lang}`, cleaned, fence];
  return { text: lines.join('\n'), relPath: rel, fence, lineCount, startLine, endLine };
}

/** 去掉尾部空白（含结尾多余空行），避免围栏被空行推远 */
function stripTrailingBlank(text: string): string {
  return text.replace(/\s+$/, '');
}
