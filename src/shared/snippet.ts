/**
 * 提示词片段组装（纯逻辑，可单测）
 *
 * 目标：用户在编辑器里"选中一段代码"或"打开一个文件"时，程序生成**可直接粘贴给模型**的
 * 文本片段 —— 包含文件路径（模型据此知道写回哪里）与内容本身。
 *
 * 关键设计（用户确认）：
 *  1. **必须加围栏**。否则文件内容里的注释、`#` 标题、行内代码会与提示词散文混在一起，
 *     模型分不清"哪些是我的指令、哪些是要改的代码"。
 *  2. **围栏长度必须按内容自适应**。若文件本身含 ```（例如 markdown 笔记里嵌代码块），
 *     固定三个反引号会被提前闭合，内容被截断。规则：比内容中最长的连续反引号多 1，最少 3。
 *  3. **路径是内容的附属品**，随内容一起给出（用户指出：不存在"只给路径不给内容"的用法）。
 */
import type { NumberedSnippetInput } from './contract';

/** 计算安全围栏：比内容中最长连续反引号多 1，最少 3 个 */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) {
    const len = (m[0] ?? '').length;
    if (len > longest) longest = len;
  }
  return '`'.repeat(Math.max(3, longest + 1));
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
 * 组装"局部修改"片段：路径 + 行区间 + 带行号的代码块。
 *
 * 行号放在围栏**内部**，是内容的一部分：模型可原样回显，解析器在写入前会剥掉前缀。
 */
export function buildSnippetText(input: NumberedSnippetInput): SnippetParts {
  const relPath = input.relPath.trim();
  const body = numberedBody(input.text, input.startLine);
  const fence = fenceFor(body);
  const lang = languageHintFor(relPath);
  const lineCount = input.text.length === 0 ? 0 : input.text.split(/\r\n|\r|\n/).length;
  const startLine = Math.max(1, Math.round(input.startLine));
  const endLine = startLine + Math.max(0, lineCount - 1);

  const lines = [pathHeader(relPath), `### 范围：${startLine}-${endLine}`, fence + lang, body, fence];
  return { text: lines.join('\n'), relPath, startLine, endLine, fence };
}

export interface WholeFileParts {
  /** 写入剪贴板的完整文本 */
  text: string;
  relPath: string;
  fence: string;
  lineCount: number;
}

/**
 * 组装"整个文件"片段（**上下文**用途）：路径 + 全文代码块。
 *
 * 与局部修改片段的区别：不带行区间（模型要给完整新内容），也不带行号前缀
 * （整文件不需要逐行引用，带行号反而增加噪声与 token）。
 */
export function buildWholeFileText(relPath: string, content: string): WholeFileParts {
  const rel = relPath.trim();
  // 结尾多余空行会让围栏被空行推远，去掉以求紧凑
  const cleaned = content.replace(/\s+$/, '');
  const fence = fenceFor(cleaned);
  const lang = languageHintFor(rel);
  const lineCount = cleaned.length === 0 ? 0 : cleaned.split(/\r\n|\r|\n/).length;
  const lines = [`这个文件是 ${rel}`, '', `${fence}${lang}`, cleaned, fence];
  return { text: lines.join('\n'), relPath: rel, fence, lineCount };
}

/** 给文本加行号前缀（右对齐 + 竖线），行号由调用方保证是文件真实行号 */
export function numberedBody(text: string, startLine: number): string {
  const lines = text.length === 0 ? [] : text.split(/\r\n|\r|\n/);
  const width = Math.max(3, String(startLine + Math.max(0, lines.length - 1)).length);
  return lines.map((line, i) => `${String(startLine + i).padStart(width, ' ')}| ${line}`).join('\n');
}
