/**
 * 逐行差异（纯逻辑，可单测）
 *
 * 为什么需要：回程预览原先只显示"改哪个文件、改多少行"，用户看不到**具体增删了哪些行**，
 * 无法在落盘前判断对错（实测反馈："我以为会像主流编辑器一样显示 diff"）。
 *
 * 算法：标准 LCS（最长公共子序列）**逐行**比较，然后归并成带上下文的 hunk。
 * 刻意不引第三方 diff 库：逻辑简单、可单测、无依赖。
 */

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  /** 该行在**原文**中的行号（1 起）；新增行为 null */
  oldLine: number | null;
  /** 该行在**新文**中的行号（1 起）；删除行为 null */
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  /** 原文中的起始行（1 起） */
  oldStart: number;
  /** 新文中的起始行（1 起） */
  newStart: number;
  lines: DiffLine[];
  added: number;
  removed: number;
}

export interface DiffResult {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** 两侧行数（用于界面显示 "22 行"） */
  oldLineCount: number;
  newLineCount: number;
  /** 是否完全相同 */
  identical: boolean;
}

/** 按行切分（兼容 CRLF / CR / LF；忽略末尾换行带来的空尾行） */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS 动态规划表（行级）。行数过大时退化为"整体替换"，避免 O(n²) 卡死。 */
const MAX_LCS_LINES = 4000;

function lcsTable(a: string[], b: string[]): Uint32Array[] | null {
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) return null;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: Uint32Array[] = [];
  for (let i = 0; i < rows; i += 1) table.push(new Uint32Array(cols));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = table[i] as Uint32Array;
    const next = table[i + 1] as Uint32Array;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  return table;
}

/** 计算逐行差异（返回按原文顺序排列的 DiffLine 序列） */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const table = lcsTable(a, b);

  if (!table) {
    // 行数过多：退化为"全删 + 全增"，诚实且不卡死
    const out: DiffLine[] = [];
    a.forEach((text, i) => out.push({ kind: 'del', oldLine: i + 1, newLine: null, text }));
    b.forEach((text, j) => out.push({ kind: 'add', oldLine: null, newLine: j + 1, text }));
    return out;
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', oldLine: i + 1, newLine: j + 1, text: a[i] as string });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] as number) >= (table[i]?.[j + 1] as number)) {
      out.push({ kind: 'del', oldLine: i + 1, newLine: null, text: a[i] as string });
      i += 1;
    } else {
      out.push({ kind: 'add', oldLine: null, newLine: j + 1, text: b[j] as string });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ kind: 'del', oldLine: i + 1, newLine: null, text: a[i] as string });
    i += 1;
  }
  while (j < b.length) {
    out.push({ kind: 'add', oldLine: null, newLine: j + 1, text: b[j] as string });
    j += 1;
  }
  return out;
}

/**
 * 把逐行差异归并成 hunk（改动处 + 前后各 `context` 行上下文，相邻改动合并）。
 * 与主流编辑器一致：只展示改动附近，跳过未改动的大段。
 */
export function toHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const changedIdx: number[] = [];
  lines.forEach((l, idx) => {
    if (l.kind !== 'context') changedIdx.push(idx);
  });

  if (changedIdx.length === 0) return [];

  // 把改动索引按间距归并为区间
  const ranges: Array<[number, number]> = [];
  let startIdx = Math.max(0, (changedIdx[0] as number) - context);
  let endIdx = Math.min(lines.length - 1, (changedIdx[0] as number) + context);
  for (let k = 1; k < changedIdx.length; k += 1) {
    const idx = changedIdx[k] as number;
    if (idx - context <= endIdx + 1) {
      endIdx = Math.min(lines.length - 1, idx + context);
    } else {
      ranges.push([startIdx, endIdx]);
      startIdx = Math.max(0, idx - context);
      endIdx = Math.min(lines.length - 1, idx + context);
    }
  }
  ranges.push([startIdx, endIdx]);

  return ranges.map(([from, to]) => {
    const slice = lines.slice(from, to + 1);
    const firstOld = slice.find((l) => l.oldLine !== null)?.oldLine ?? 1;
    const firstNew = slice.find((l) => l.newLine !== null)?.newLine ?? 1;
    return {
      oldStart: firstOld,
      newStart: firstNew,
      lines: slice,
      added: slice.filter((l) => l.kind === 'add').length,
      removed: slice.filter((l) => l.kind === 'del').length,
    };
  });
}

/** 一次性得到可直接渲染的结果 */
export function diffTexts(oldText: string, newText: string, context = 3): DiffResult {
  const lines = diffLines(oldText, newText);
  const added = lines.filter((l) => l.kind === 'add').length;
  const removed = lines.filter((l) => l.kind === 'del').length;
  return {
    hunks: toHunks(lines, context),
    added,
    removed,
    oldLineCount: splitLines(oldText).length,
    newLineCount: splitLines(newText).length,
    identical: added === 0 && removed === 0,
  };
}
