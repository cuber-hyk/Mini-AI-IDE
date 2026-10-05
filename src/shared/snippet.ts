/** 无损复制原文上下文；行号只用于本地反馈，不参与 AI 修改定位。 */
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

/** 上下文头部：声明原文来自哪个文件，不代表修改操作。 */
export function pathHeader(relPath: string): string {
  return `### 上下文文件：${relPath}`;
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

/** 选区原文逐字保留，以只读上下文头部组装。 */
export function buildSnippetText(input: NumberedSnippetInput): SnippetParts {
  const relPath = input.relPath.trim();
  const body = input.text;
  const fence = fenceFor(body);
  const lang = languageHintFor(relPath);
  const lineCount = input.text.length === 0 ? 0 : input.text.split(/\r\n|\r|\n/).length;
  const startLine = Math.max(1, Math.round(input.startLine));
  const endLine = startLine + Math.max(0, lineCount - 1);

  const lines = [pathHeader(relPath), '### 上下文：原文片段', fence + lang, body, fence];
  return { text: lines.join('\n'), relPath, startLine, endLine, fence };
}

export interface WholeFileParts {
  /** 写入剪贴板的完整文本 */
  text: string;
  relPath: string;
  fence: string;
  lineCount: number;
  /** 本地反馈行范围，不进入复制文本 */
  startLine: number;
  endLine: number;
}

/** 全文作为只读上下文，不暗示覆盖全文；保留末尾换行与空白。 */
export function buildWholeFileText(relPath: string, content: string): WholeFileParts {
  const rel = relPath.trim();
  const cleaned = content;
  const fence = fenceFor(cleaned);
  const lang = languageHintFor(rel);
  const lineCount = cleaned.length === 0 ? 0 : cleaned.split(/\r\n|\r|\n/).length;
  const startLine = 1;
  const endLine = Math.max(1, lineCount);
  const lines = [pathHeader(rel), '### 上下文：完整原文', `${fence}${lang}`, cleaned, fence];
  return { text: lines.join('\n'), relPath: rel, fence, lineCount, startLine, endLine };
}
