/** 本地解析诊断；不修复原文，不保留完整回复。 */
export function formatToolJsonDiagnostic(source: string, error: unknown): string {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'JSON 解析失败（未提供详细原因）';
  const parts = ['工具 JSON 无效，本批工具未执行。', reason.slice(0, 600)];
  const match = /\bat position\s+(\d+)(?:\s+\(line\s+\d+\s+column\s+\d+\))?$/i.exec(reason);
  const position = match ? Number(match[1]) : NaN;
  if (Number.isSafeInteger(position) && position >= 0 && position <= source.length) {
    const before = source.slice(0, position);
    const breaks = [...before.matchAll(/\r\n|\r|\n/g)];
    const lastBreak = breaks.at(-1);
    const lineStart = lastBreak ? lastBreak.index! + lastBreak[0].length : 0;
    const nextBreak = /\r|\n/.exec(source.slice(position));
    const lineEnd = nextBreak ? position + nextBreak.index : source.length;
    let start = Math.max(lineStart, position - 45);
    let end = Math.min(lineEnd, position + 45);
    // 不在 UTF-16 代理对之间截断；坐标仍使用解析器的 UTF-16 偏移。
    if (start > lineStart && /[\uDC00-\uDFFF]/.test(source[start]!)) start--;
    if (end < lineEnd && /[\uDC00-\uDFFF]/.test(source[end]!)) end++;
    const visible = (value: string) => value.replace(/[\u0000-\u001F\u007F]/g, char => char === '\t' ? '\\t' : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const prefix = start > lineStart ? '…' : '';
    const snippet = prefix + visible(source.slice(start, end)) + (end < lineEnd ? '…' : '');
    const caret = ' '.repeat(Array.from(prefix + visible(source.slice(start, position))).length) + '^';
    parts.push(`位置：JSON 正文第 ${breaks.length + 1} 行，第 ${position - lineStart + 1} 列；偏移 ${position}（从 0 开始，UTF-16）。`, snippet, caret);
  }
  parts.push('请修正以上错误，并重新输出一个完整、合法的 mini-ai-tools JSON 围栏；不要只返回补丁或残片。');
  return parts.join('\n');
}
