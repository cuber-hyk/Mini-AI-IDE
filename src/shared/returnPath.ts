/**
 * 回程解析（纯逻辑，可单测）
 *
 * 职责：把模型的自由文本回复解析成"待应用变更"列表。
 *
 * 设计原则（见 docs/capabilities/return-path-and-format-contract.md）：
 *  1. **不"理解"模型**：只用确定性文本规则（围栏 + 路径线索 + 相邻标题）；
 *  2. **高容忍**：模型不按约定回复是常态，必须尽量识别，识别不了就降级为"无路径建议"；
 *  3. **不猜测**：无法确定目标文件时**绝不猜**，交给用户在预览里指定；
 *  4. **不丢内容**：解析结果保留原文与偏移量，便于 UI 回显与人工兜底。
 *
 * 识别顺序（按可信度从高到低）：
 *  a) 围栏内首行的路径注释（`// path/to/a.ts`、`# a.py`、`<!-- a.html -->`）
 *  b) 围栏**上方**最近的标题式路径行（`### src/a.ts`、`**src/a.ts**`、`文件名：src/a.ts`）
 *  c) 全文中出现的、看起来像路径的 token（`` `src/a.ts` ``、裸 `src/a.ts`）→ 整篇唯一时才采用
 *  d) 都不满足 → path 为 null（UI 需用户指定或改为"插入光标处"）
 *
 * **不用「当前打开的文件」兜底**：编辑器里打开的文件与待改文件未必相关，
 * 猜错会把代码写进错误的文件。宁可留空交预览，也不猜（用户明确要求）。
 */

/** 代码块 */
export interface ParsedCodeBlock {
  /** 块内代码（已去除路径注释行） */
  code: string;
  /** 围栏语言标注（可为空字符串） */
  language: string;
  /** 推断出的目标文件（相对根目录，正斜杠）；null 表示未能确定 */
  filePath: string | null;
  /** 路径线索来源 */
  pathSource: 'fence-comment' | 'preceding-heading' | 'unique-mention' | 'none';
  /** 在原文中的起止偏移（含围栏），便于回显 */
  start: number;
  end: number;
  /** 被剥离的路径注释行原文（用于回溯） */
  strippedPathLine: string | null;
}

export interface ParseOptions {
  /** 仅当整篇只提到一个候选路径时才采用 (c) 线索（默认 true） */
  allowUniqueMention?: boolean;
}

export interface ParseResult {
  blocks: ParsedCodeBlock[];
  /** 全文出现的路径候选（去重后，按出现顺序） */
  mentionedPaths: string[];
  /** 是否存在无法确定目标文件的代码块 */
  hasUnresolved: boolean;
  /** 解析备注（供 UI 展示，例如"未找到路径线索，已降级"） */
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * 路径识别
 * ------------------------------------------------------------------ */

/** 看起来像源码/文本文件的扩展名（用于从自由文本里挑出路径 token） */
const FILE_EXTENSIONS = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'jsx', 'json', 'jsonc',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
  'swift', 'scala', 'lua', 'pl', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg',
  'vue', 'svelte', 'astro', 'tex', 'bib', 'csv', 'tsv', 'log', 'diff', 'patch',
  'md', 'markdown', 'txt', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
];

const EXT_ALTERNATION = FILE_EXTENSIONS.join('|');

/**
 * 一个"像路径"的 token：
 *  - 允许目录分隔符 / 与 \
 *  - 允许字母数字 _ - . 空格（路径里偶有空格，但为避免误吞，保守地不含空格）
 *  - 必须以已知扩展名结尾
 */
const PATH_TOKEN_RE = new RegExp(
  String.raw`(?:[A-Za-z]:[\\/])?(?:[\w.@+-]+[\\/])*[\w.@+-]+\.(?:${EXT_ALTERNATION})\b`,
  'gi'
);

/** 从任意文本里抽取路径候选（保持出现顺序，去重） */
export function extractPathMentions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    const raw = m[0];
    if (!raw) continue;
    const normalized = normalizeRelPath(raw);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/** 归一化为"相对路径 + 正斜杠"；剔除开头的 ./，拒绝绝对路径与上跳 */
export function normalizeRelPath(raw: string): string | null {
  let p = raw.trim().replace(/\\/g, '/');
  p = p.replace(/^\.\//, '');
  if (p.length === 0) return null;
  // 绝对路径（含盘符）不作为相对目标使用：交由白名单/用户确认
  if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) return p;
  // 含上跳的路径保留原样交给白名单校验拒绝，但这里先不接受为"建议路径"
  if (p.split('/').includes('..')) return null;
  return p;
}

/* ------------------------------------------------------------------ *
 * 围栏切分
 * ------------------------------------------------------------------ */

interface RawFence {
  start: number;
  end: number;
  info: string;
  body: string;
  /** body 在原文中的起始偏移（用于精确定位注释行） */
  bodyStart: number;
}

/** 找出所有 ``` 围栏（支持 ~~~ ；不支持嵌套围栏，与 Markdown 一致） */
export function splitFences(text: string): RawFence[] {
  const fences: RawFence[] = [];
  const re = /^([ \t]*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\2[ \t]*$/gm;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const full = m[0];
    const info = (m[3] ?? '').trim();
    const body = m[4] ?? '';
    // body 起始位置 = 围栏起始 + 首行长度
    const firstLineEnd = full.indexOf('\n');
    const bodyStart = start + (firstLineEnd >= 0 ? firstLineEnd + 1 : full.length);
    fences.push({ start, end: start + full.length, info, body, bodyStart });
  }
  return fences;
}

/* ------------------------------------------------------------------ *
 * 路径线索：围栏内首行注释
 * ------------------------------------------------------------------ */

const PATH_COMMENT_PATTERNS: RegExp[] = [
  // // path/to/x.ts   或   // file: path/to/x.ts
  /^[ \t]*\/\/[ \t]*(?:file|filename|path|文件|路径)?[ \t]*[:：]?[ \t]*(\S+\.(?:[A-Za-z0-9]+))[ \t]*$/i,
  // # path/to/x.py （Python/Ruby/shell/配置）
  /^[ \t]*#[ \t]*(?:file|filename|path|文件|路径)?[ \t]*[:：]?[ \t]*(\S+\.(?:[A-Za-z0-9]+))[ \t]*$/i,
  // <!-- path/to/x.html -->
  /^[ \t]*<!--[ \t]*(?:file|filename|path|文件|路径)?[ \t]*[:：]?[ \t]*(\S+\.(?:[A-Za-z0-9]+))[ \t]*-->[ \t]*$/i,
  // -- path/to/x.sql
  /^[ \t]*--[ \t]*(?:file|filename|path|文件|路径)?[ \t]*[:：]?[ \t]*(\S+\.(?:[A-Za-z0-9]+))[ \t]*$/i,
  // /* path/to/x.css */
  /^[ \t]*\/\*[ \t]*(?:file|filename|path|文件|路径)?[ \t]*[:：]?[ \t]*(\S+\.(?:[A-Za-z0-9]+))[ \t]*\*\/[ \t]*$/i,
];

/** 判断首行是否是"路径注释"；是则返回路径与消费掉的字符数 */
export function matchPathCommentLine(line: string): string | null {
  for (const re of PATH_COMMENT_PATTERNS) {
    const m = re.exec(line);
    if (m && m[1]) {
      const normalized = normalizeRelPath(m[1]);
      if (normalized) return normalized;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 路径线索：围栏上方的标题式行
 * ------------------------------------------------------------------ */

/** 从"标题式行"里抽路径：### src/a.ts / **src/a.ts** / 文件名：src/a.ts / 1. `src/a.ts` */
export function matchHeadingLine(line: string): string | null {
  const stripped = line.replace(/^\s*#{1,6}\s*/, '').trim();
  const isMarkdownHeading = stripped !== line.trim() || /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line);

  const cleaned = stripped
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .trim();
  if (cleaned.length === 0) return null;

  // 整行被强调符包裹（`**path**` / `` `path` ``）也视为标题形态
  const isWrappedEmphasis = /^(\*\*|__)(.+)(\*\*|__)$/.test(cleaned) || /^`(.+)`$/.test(cleaned);

  // 形如 (文件名|文件|file|filename|path|路径) ：xxx
  const labeled = /(?:文件名|文件|路径|file|filename|path)\s*[:：]\s*(.+)$/i.exec(cleaned);
  const hasLabel = Boolean(labeled && labeled[1]);
  const candidate = labeled && labeled[1] ? labeled[1] : cleaned;

  // 去掉包裹用的强调符号；**注意不要动下划线**（它是合法文件名字符，如 train_caption.py）
  const unwrapped = candidate.replace(/[*`]/g, ' ').trim();

  // 整行必须"基本就是"一个路径（避免把整句中文当路径）
  const mentions = extractPathMentions(unwrapped);
  if (mentions.length === 0) return null;
  const only = mentions[0] as string;
  const residue = unwrapped.replace(only, '').replace(/[\s:：,，。;；\-–—()（）[\]*`]/g, '');
  if (residue.length > 4) return null;

  // 额外约束：只有当这一行**看起来就是标题**（Markdown 标题/列表项/带标签/整行强调）时才接受；
  // 否则一段普通文本里恰好提到一个路径（例如"请把 `src/c.ts` 改成："）不应被当作标题，
  // 那类情形应交给"全文唯一候选"线索处理。
  if (!isMarkdownHeading && !hasLabel && !isWrappedEmphasis) return null;

  return only;
}

/** 该行是否具有"标题形态"（用于在一个连续行块里判断是否还有标题行） */
function looksLikeHeadingLine(line: string): boolean {
  return (
    /^\s*#{1,6}\s+\S/.test(line) ||
    /^\s*[-*+]\s+\S/.test(line) ||
    /^\s*\d+[.)]\s+\S/.test(line) ||
    /^(?:文件名|文件|路径|file|filename|path)\s*[:：]/i.test(line.trim())
  );
}

function findPrecedingHeadingPath(text: string, fenceStart: number): string | null {
  const before = text.slice(0, fenceStart);
  const lines = before.split(/\r\n|\r|\n/);

  // 关键：**只有当紧邻围栏的上方是一个"连续的非空行块"时**，才把它当作标题区。
  // 若该块之前是空行（即它自己是一段独立文本），则它大概率是正文句子——
  // 例如"请把 `src/c.ts` 改成："后面直接跟代码块。这种情形应交给 (c) 唯一候选线索处理，
  // 否则会把任意提到路径的句子误判为"标题式路径行"。
  // 注意：`"a\n\n".split("\n")` 会得到 ["a","",""] —— 换行结尾会产生**两个**空串。
  // 因此必须跳过**所有**尾随空行，而不是只跳一个（早期只跳一个，导致标题块被判为空）。
  let i = lines.length - 1;
  while (i >= 0 && (lines[i] ?? '').trim().length === 0) i -= 1;

  const block: string[] = [];
  while (i >= 0) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) break;
    block.unshift(line);
    i -= 1;
  }
  if (block.length === 0) return null;
  // 该行块必须与更早的内容之间有空行（即它自成一段），才视为标题区。
  // 例外：块本身只有一行且**具备标题形态**（如文档开头的 `### src/b.ts`）——
  // 此时它前面没有内容也没有空行，仍应被接受。
  const separated = i < 0 || (lines[i] ?? '').trim().length === 0;
  if (!separated && !(block.length === 1 && looksLikeHeadingLine(block[0] as string))) return null;

  // 在标题区内自上而下寻找第一条可识别的路径行
  for (const line of block) {
    if (line.length > 200) continue;
    const p = matchHeadingLine(line);
    if (p) return p;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

export function parseModelReply(replyText: string, options: ParseOptions = {}): ParseResult {
  const text = replyText ?? '';
  const notes: string[] = [];
  const fences = splitFences(text);
  const mentionedPaths = extractPathMentions(text);
  const allowUnique = options.allowUniqueMention !== false;
  const uniqueMention = allowUnique && mentionedPaths.length === 1 ? (mentionedPaths[0] as string) : null;

  if (fences.length === 0) {
    notes.push('回复中未找到代码围栏，无可应用内容');
    return { blocks: [], mentionedPaths, hasUnresolved: false, notes };
  }
  if (mentionedPaths.length === 0) {
    notes.push('回复中未发现路径线索');
  } else if (mentionedPaths.length > 1) {
    notes.push(`发现 ${mentionedPaths.length} 个路径候选，将按围栏就近匹配`);
  }

  const blocks: ParsedCodeBlock[] = fences.map((f) => {
    let code = f.body;
    let strippedPathLine: string | null = null;
    let filePath: string | null = null;
    let pathSource: ParsedCodeBlock['pathSource'] = 'none';

    // (a) 围栏内首行路径注释 —— 最可信（就在代码里）
    const firstNewline = code.indexOf('\n');
    const firstLine = firstNewline >= 0 ? code.slice(0, firstNewline) : code;
    const fromComment = matchPathCommentLine(firstLine);
    if (fromComment) {
      filePath = fromComment;
      pathSource = 'fence-comment';
      strippedPathLine = firstLine;
      code = firstNewline >= 0 ? code.slice(firstNewline + 1) : '';
    }

    // (b) 围栏上方标题式路径行 —— 明确指定了"这段代码属于哪个文件"，优先于全局唯一候选
    if (!filePath) {
      const fromHeading = findPrecedingHeadingPath(text, f.start);
      if (fromHeading) {
        filePath = fromHeading;
        pathSource = 'preceding-heading';
      }
    }

    // (c) 全文唯一候选 —— 最后的自动线索，**可靠性最低**，必须提示用户核对
    if (!filePath && uniqueMention) {
      filePath = uniqueMention;
      pathSource = 'unique-mention';
    }

    // 注意：不再用"当前打开的文件"兜底 —— 编辑器里打开的文件与待改文件未必相关，
    // 猜错会把代码写进错误的文件。宁可 null（交预览让用户指定）。

    return {
      code: code.replace(/\s+$/, ''),
      language: normalizeLanguage(f.info),
      filePath,
      pathSource,
      start: f.start,
      end: f.end,
      strippedPathLine,
    };
  });

  const unresolved = blocks.filter((b) => !b.filePath);
  if (unresolved.length > 0) {
    notes.push(`${unresolved.length} 个代码块无法确定目标文件，需在预览中指定`);
  }
  const weak = blocks.filter((b) => b.pathSource === 'unique-mention');
  if (weak.length > 0) {
    notes.push(
      `${weak.length} 个代码块的目标文件来自"全文唯一候选"推断（可靠性最低）—— 请务必核对：回复正文里出现的示例路径可能导致误匹配`
    );
  }

  return { blocks, mentionedPaths, hasUnresolved: unresolved.length > 0, notes };
}

/** 语言标注归一化（仅用于高亮；不参与路径判断） */
function normalizeLanguage(info: string): string {
  if (!info) return '';
  const first = info.split(/\s+/)[0] ?? '';
  return first.replace(/[{}]/g, '').trim().toLowerCase();
}

/* ------------------------------------------------------------------ *
 * 文本安全应用：不做覆盖式落盘，只计算"应用后文本"
 * ------------------------------------------------------------------ */

export type ApplyMode =
  | { kind: 'insert-at-cursor'; cursorOffset: number }
  | { kind: 'replace-fence-region'; start: number; end: number }
  | { kind: 'replace-whole-file' };

export interface ApplyResult {
  /** 应用后的文件内容 */
  text: string;
  /** 实际采用的模式（便于 UI 告知用户） */
  mode: ApplyMode['kind'];
  /** 被替换掉的原文（用于撤销与 diff） */
  replaced: string;
}

/**
 * 计算"把某个代码块应用到某文件后"的文本。
 *
 * 注意：本函数**不改动任何文件**，只做纯计算，写入由 FileService 在执行阶段完成，
 * 并且必须先经用户确认（ADR-0004 方案 A）。
 *
 * 插入规则（确定性，便于测试与解释）：
 *  在光标位置插入代码块；若光标左侧**不是行首或换行**，则先补一个换行，
 *  使插入的代码从新的一行开始；若光标右侧还有内容且不是换行，则在代码块后补一个换行。
 *  实际效果会在 diff 预览中原样呈现，用户确认前不会落盘。
 */
export function computeApply(
  originalText: string,
  block: ParsedCodeBlock,
  mode: ApplyMode
): ApplyResult {
  switch (mode.kind) {
    case 'insert-at-cursor': {
      const at = Math.max(0, Math.min(mode.cursorOffset, originalText.length));
      const before = originalText.slice(0, at);
      const after = originalText.slice(at);
      const needsLeading = before.length > 0 && !before.endsWith('\n');
      const needsTrailing = after.length > 0 && !after.startsWith('\n');
      const inserted = `${needsLeading ? '\n' : ''}${block.code}${needsTrailing ? '\n' : ''}`;
      return { text: `${before}${inserted}${after}`, mode: mode.kind, replaced: '' };
    }
    case 'replace-fence-region': {
      const start = Math.max(0, Math.min(mode.start, originalText.length));
      const end = Math.max(start, Math.min(mode.end, originalText.length));
      const replaced = originalText.slice(start, end);
      return { text: `${originalText.slice(0, start)}${block.code}${originalText.slice(end)}`, mode: mode.kind, replaced };
    }
    case 'replace-whole-file': {
      return { text: block.code, mode: mode.kind, replaced: originalText };
    }
    default: {
      const exhaustive: never = mode;
      throw new Error(`未知应用模式：${String(exhaustive)}`);
    }
  }
}
