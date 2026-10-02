/**
 * 大小上限与元信息（纯逻辑，可单测）
 *
 * 规则（local-file-access 能力文档）：单次返回内容设上限；超限只返回元信息
 * （总字符数、行数）并要求用户显式确认后才分片读取。
 *
 * 注意：本项目**不再有"注入耗时"约束**（出程已整体移除，见 ADR-0003），
 * 上限的目的是保护编辑器与内存，而不是配合注入速度。
 */

export interface TextMeta {
  charCount: number;
  /** 不含换行符的行数（空文本为 0） */
  lineCount: number;
  byteLength: number;
}

export function computeTextMeta(text: string, byteLength: number): TextMeta {
  const charCount = text.length;
  const lineCount = charCount === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
  return { charCount, lineCount, byteLength };
}

export type SizeVerdict =
  | { status: 'ok'; meta: TextMeta }
  | { status: 'too-large'; meta: TextMeta; limit: number };

export function checkSize(text: string, byteLength: number, limit: number): SizeVerdict {
  const meta = computeTextMeta(text, byteLength);
  if (meta.charCount > limit) return { status: 'too-large', meta, limit };
  return { status: 'ok', meta };
}

/**
 * 分片读取：按行切片，返回指定区间的文本（含起止行）。
 * 行号从 1 开始，闭区间；越界自动收敛，不做报错（UI 侧应展示实际范围）。
 */
export interface SliceResult {
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}

export function sliceLines(text: string, startLine: number, endLine: number): SliceResult {
  const lines = text.length === 0 ? [] : text.split(/\r\n|\r|\n/);
  const totalLines = lines.length;
  if (totalLines === 0) {
    return { text: '', startLine: 0, endLine: 0, totalLines: 0 };
  }
  const s = Math.max(1, Math.min(startLine, totalLines));
  const e = Math.max(s, Math.min(endLine, totalLines));
  return { text: lines.slice(s - 1, e).join('\n'), startLine: s, endLine: e, totalLines };
}

/**
 * 可载入编辑器的扩展名白名单（不区分大小写）。
 * 不在列表内的**不作为错误**——只表示"需要用户显式确认"。
 */
export const TEXT_EXTENSIONS: readonly string[] = [
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php',
  '.swift', '.scala', '.lua', '.pl', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
  '.vue', '.svelte', '.astro', '.tex', '.bib', '.csv', '.tsv', '.log', '.diff', '.patch', '.gitignore',
];

export function isProbablyTextFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  const idx = lower.lastIndexOf('.');
  const ext = idx >= 0 ? lower.slice(idx) : '';
  if (TEXT_EXTENSIONS.includes(ext)) return true;
  // 无扩展名但常见文本文件名
  return ['license', 'readme', 'makefile', 'dockerfile', 'procfile'].includes(lower);
}
