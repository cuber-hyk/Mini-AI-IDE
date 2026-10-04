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
  /**
   * 片段替换的行区间（1 起、闭区间）；null 表示"整文件替换"。
   * 来源是围栏上方的 `### 范围：80-92` 指令（也接受 `### 行：80-92`）。
   */
  range: LineRange | null;
  /** 被剥离的路径注释行原文（用于回溯） */
  strippedPathLine: string | null;
  /** 在原文中的起止偏移（含围栏），便于回显 */
  start: number;
  end: number;
}

export interface LineRange {
  start: number;
  end: number;
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

/**
 * 找出所有代码围栏（支持 ~~~ ；不支持嵌套围栏，与 Markdown 一致）。
 *
 * **容忍未闭合围栏**（实测必需）：目标站点把开头的 ``` 渲染成文本，但结尾围栏是
 * 装饰元素、不出现在 `innerText` 里。若坚持"围栏必须成对"，采到的整段回复会被判定为
 * "没有围栏"，表现为**采集成功但解析出 0 个代码块**（用户实测反馈）。
 * 因此未闭合的围栏视为**延续到文本结尾**。
 */
export function splitFences(text: string): RawFence[] {
  const found: RawFence[] = [];

  // 1) 成对围栏
  const closed = /^[ \t]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;
  for (const m of text.matchAll(closed)) {
    const start = m.index ?? 0;
    const full = m[0];
    const firstLineEnd = full.indexOf('\n');
    const bodyStart = start + (firstLineEnd >= 0 ? firstLineEnd + 1 : full.length);
    found.push({
      start,
      end: start + full.length,
      info: (m[2] ?? '').trim(),
      body: m[3] ?? '',
      bodyStart,
    });
  }

  // 2) 未闭合围栏：从某个 ``` 行起一直到文本结尾（排除落在已闭合块内的）
  for (const m of text.matchAll(/^[ \t]*(`{3,})[^\n]*(?:\n|$)/gm)) {
    const start = m.index ?? 0;
    if (found.some((f) => start >= f.start && start < f.end)) continue;
    const full = m[0];
    const newlineIdx = full.indexOf('\n');
    const openingLine = newlineIdx >= 0 ? full.slice(0, newlineIdx) : full;
    const info = openingLine.replace(/^[ \t]*`+/, '').replace(/`+[ \t]*$/, '').trim();
    const bodyStart = newlineIdx >= 0 ? start + newlineIdx + 1 : text.length;
    found.push({ start, end: text.length, info, body: text.slice(bodyStart), bodyStart });
  }

  found.sort((a, b) => a.start - b.start);
  return found;
}

/* ------------------------------------------------------------------ *
 * 路径线索：围栏内首行注释
 * ------------------------------------------------------------------ */

/**
 * 路径捕获组：允许**空格与中文**文件名（2026-10-04 用户实测）。
 * 旧版 `(\S+\.(?:ext))` 不允许空格 —— 真实文件名「BLIP 阅读笔记.md」在
 * "BLIP" 后的空格处断掉，整条匹配失败。现改为排除式字符类（排除反引号、
 * 引号、换行）+ 非贪婪扩展，配合各条自己的行尾结构锚定，停在第一个「.扩展名」。
 */
const PATH_CAPTURE = String.raw`([^\\\`"\n]+?\.(?:[A-Za-z0-9]+))`;

const PATH_COMMENT_PATTERNS: RegExp[] = [
  // // path/to/x.ts   或   // file: path/to/x.ts
  new RegExp(`^[ \\t]*\\/\\/[ \\t]*(?:file|filename|path|文件|路径)?[ \\t]*[:：]?[ \\t]*${PATH_CAPTURE}[ \\t]*$`, 'i'),
  // # path/to/x.py （Python/Ruby/shell/配置）
  new RegExp(`^[ \\t]*#[ \\t]*(?:file|filename|path|文件|路径)?[ \\t]*[:：]?[ \\t]*${PATH_CAPTURE}[ \\t]*$`, 'i'),
  // <!-- path/to/x.html -->
  new RegExp(`^[ \\t]*<!--[ \\t]*(?:file|filename|path|文件|路径)?[ \\t]*[:：]?[ \\t]*${PATH_CAPTURE}[ \\t]*-->[ \\t]*$`, 'i'),
  // -- path/to/x.sql
  new RegExp(`^[ \\t]*--[ \\t]*(?:file|filename|path|文件|路径)?[ \\t]*[:：]?[ \\t]*${PATH_CAPTURE}[ \\t]*$`, 'i'),
  // /* path/to/x.css */
  new RegExp(`^[ \\t]*\\/\\*[ \\t]*(?:file|filename|path|文件|路径)?[ \\t]*[:：]?[ \\t]*${PATH_CAPTURE}[ \\t]*\\*\\/[ \\t]*$`, 'i'),
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
  if (mentions.length === 0) {
    /*
     * 回退（2026-10-04 用户实测）：带「文件：」标签的行，模型给出的路径可能是
     * 「BLIP 阅读笔记.md」这种"英文+空格+中文"文件名 —— extractPathMentions 的
     * 保守字符类（无空格、\w 不含中文）完全认不出来，整条 (b) 线索失灵，
     * 块的 filePath 落为 null（用户看到"未确定目标文件"）。
     * 这里对**带标签**的情形退一步：candidate 不含句子标点、以已知扩展名结尾、
     * 长度合理 → 整体当作路径。模型显式写了「文件：」时其意图就是给路径；
     * 即便给错，预览面板的「改路径」仍可人工纠正（宁可带核对提示，也不丢线索）。
     * 不带标签的行**不适用**本回退 —— 那类情形维持原判（交给唯一候选线索）。
     */
    const candidateIsPathLike =
      labeled &&
      labeled[1] &&
      unwrapped.length <= 200 &&
      !/[，。；：！？、""''（）<>]/.test(unwrapped) &&
      new RegExp(String.raw`\.(?:${EXT_ALTERNATION})$`, 'i').test(unwrapped);
    if (!candidateIsPathLike) return null;
    return unwrapped;
  }
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

/* ------------------------------------------------------------------ *
 * 行区间指令：### 范围：80-92
 *
 * 为什么需要它：片段替换比"整文件替换"省 token，但**行号必须可靠**。
 * 因此约定：
 *  - 用户复制片段时带上**文件真实行号**（见 formatNumberedSnippet）；
 *  - 模型回显 `### 范围：N-M`；
 *  - 应用前由 FileService 做**三向校验**（区间有效 / 原内容匹配 / 上下文匹配），
 *    任何一项不符即拒绝，绝不按可能已失效的行号写入（见 computeApply 的说明）。
 * ------------------------------------------------------------------ */

/** 匹配 `### 范围：80-92`、`### 行：80-92`、`### lines: 80-92`、`### 位置：替换第 80-92 行` 等形态 */
const RANGE_DIRECTIVE_RE =
  /^\s*(?:#{1,6}\s*)?(?:范围|行|行号|位置|lines?|range|position)\s*[:：]\s*(?:替换第\s*)?(\d{1,7})\s*(?:[-–—~至到]\s*(\d{1,7}))?\s*行?\s*$/i;

/** 从一行文本解析行区间；单数字（`### 范围：80`）视为 80-80 */
export function matchRangeDirective(line: string): LineRange | null {
  const m = RANGE_DIRECTIVE_RE.exec(line);
  if (!m || !m[1]) return null;
  const start = Number.parseInt(m[1], 10);
  const end = m[2] ? Number.parseInt(m[2], 10) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < 1) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/** 在围栏上方的标题区里找行区间指令（与路径线索同一段文本） */
function findPrecedingRange(text: string, fenceStart: number): LineRange | null {
  const before = text.slice(0, fenceStart);
  const lines = before.split(/\r\n|\r|\n/);
  let i = lines.length - 1;
  while (i >= 0 && (lines[i] ?? '').trim().length === 0) i -= 1;

  const block: string[] = [];
  while (i >= 0) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) break;
    block.unshift(line);
    i -= 1;
  }
  // 从近到远找第一条可解析的区间指令
  for (let k = block.length - 1; k >= 0; k -= 1) {
    const r = matchRangeDirective(block[k] as string);
    if (r) return r;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 带行号的片段格式化（"复制选中片段"用）
 * ------------------------------------------------------------------ */

/**
 * 把一段文本格式化为"带文件真实行号"的片段，供用户粘贴进提示词。
 * 行号格式为 `  80| ` （右对齐、竖线分隔），便于模型原样回显。
 */
export function formatNumberedSnippet(text: string, startLine: number): string {
  const lines = text.length === 0 ? [] : text.split(/\r\n|\r|\n/);
  const width = Math.max(3, String(startLine + lines.length - 1).length);
  return lines
    .map((line, idx) => `${String(startLine + idx).padStart(width, ' ')}| ${line}`)
    .join('\n');
}

/** 从"带行号片段"里还原纯文本（去掉 `NNN| ` 前缀），用于生成提示词里的干净片段 */
export function stripNumberedPrefix(numbered: string): { text: string; startLine: number | null } {
  const lines = numbered.split(/\r\n|\r|\n/);
  let startLine: number | null = null;
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*(\d{1,7})\|\s?(.*)$/.exec(line);
    if (m && m[1]) {
      const n = Number.parseInt(m[1], 10);
      if (startLine === null) startLine = n;
      out.push(m[2] ?? '');
    } else {
      out.push(line);
    }
  }
  return { text: out.join('\n'), startLine };
}

function findPrecedingHeadingPath(text: string, fenceStart: number): string | null {  const before = text.slice(0, fenceStart);
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

    // 行区间指令：存在即表示"这是片段替换"，否则视为"整文件替换"
    const range = findPrecedingRange(text, f.start);

    // 若片段里行号被原样带进来（` 80| code`），剥掉前缀让代码保持干净
    if (range) {
      const stripped = stripNumberedPrefix(code);
      if (stripped.startLine !== null) code = stripped.text;
    }

    // 注意：不再用"当前打开的文件"兜底 —— 编辑器里打开的文件与待改文件未必相关，
    // 猜错会把代码写进错误的文件。宁可 null（交预览让用户指定）。

    return {
      code: code.replace(/\s+$/, ''),
      language: normalizeLanguage(f.info),
      filePath,
      pathSource,
      range,
      strippedPathLine,
      start: f.start,
      end: f.end,
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
  const snippets = blocks.filter((b) => b.range !== null);
  if (snippets.length > 0) {
    notes.push(
      `${snippets.length} 个代码块是**片段替换**（带行区间）：应用前会做三向校验（区间有效 / 原内容匹配 / 上下文匹配），不一致即拒绝`
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
  | { kind: 'replace-whole-file' }
  /**
   * 片段替换（按文件真实行号）。
   * **必须带 expectedOriginal**：这是"三向校验"里的第二项 —— 只有当前 1-based
   * 闭区间 [start,end] 的内容与 expectedOriginal 完全一致时才允许替换。
   * 缺了它，行号一旦漂移就会静默改错地方，因此本模式拒绝无校验的应用。
   *
   * `contextPrev` / `contextNext`（可选）：复制片段时记录的区间前后各一行，
   * 用于第三项"上下文校验"。不提供则跳过该项。
   */
  | {
      kind: 'replace-lines';
      start: number;
      end: number;
      expectedOriginal: string;
      contextPrev?: string | null;
      contextNext?: string | null;
    };

export interface ApplyResult {
  /** 应用后的文件内容 */
  text: string;
  /** 实际采用的模式（便于 UI 告知用户） */
  mode: ApplyMode['kind'];
  /** 被替换掉的原文（用于撤销与 diff） */
  replaced: string;
}

export type ApplyOutcome =
  | ({ ok: true } & ApplyResult)
  | { ok: false; reason: 'range-invalid' | 'content-mismatch' | 'context-mismatch'; detail: string };

/** 按 1-based 闭区间取行（用于片段校验） */
export function getLineRange(text: string, start: number, end: number): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (start < 1 || end < start) return [];
  return lines.slice(start - 1, end);
}

/**
 * 计算"把某个代码块应用到某文件后"的文本。
 *
 * ⚠️ 重要：本函数**不改动任何文件**，只做纯计算。落盘由 FileService 在用户确认后执行
 * （ADR-0004 方案 A）。
 *
 * 片段替换（`replace-lines`）做**三向校验**：
 *   ① 区间有效：1 ≤ start ≤ end ≤ 文件总行数；
 *   ② 原内容匹配：当前 [start,end] 行必须等于 `expectedOriginal`（用户复制片段时的原文）；
 *   ③ 上下文匹配：区间外紧邻的上一行/下一行（若存在）必须仍然存在且相同。
 * 任一项不符即返回 `ok: false`，**绝不按可能已失效的行号写入**。
 *
 * 插入规则（`insert-at-cursor`，确定性、便于测试）：
 *   在光标位置插入；若左侧不是行首/换行则补前导换行，右侧有内容且非换行则补尾随换行。
 */
export function computeApply(
  originalText: string,
  block: ParsedCodeBlock,
  mode: ApplyMode
): ApplyOutcome {
  switch (mode.kind) {
    case 'insert-at-cursor': {
      const at = Math.max(0, Math.min(mode.cursorOffset, originalText.length));
      const before = originalText.slice(0, at);
      const after = originalText.slice(at);
      const needsLeading = before.length > 0 && !before.endsWith('\n');
      const needsTrailing = after.length > 0 && !after.startsWith('\n');
      const inserted = `${needsLeading ? '\n' : ''}${block.code}${needsTrailing ? '\n' : ''}`;
      return { ok: true, text: `${before}${inserted}${after}`, mode: mode.kind, replaced: '' };
    }
    case 'replace-fence-region': {
      const start = Math.max(0, Math.min(mode.start, originalText.length));
      const end = Math.max(start, Math.min(mode.end, originalText.length));
      const replaced = originalText.slice(start, end);
      return {
        ok: true,
        text: `${originalText.slice(0, start)}${block.code}${originalText.slice(end)}`,
        mode: mode.kind,
        replaced,
      };
    }
    case 'replace-whole-file': {
      return { ok: true, text: block.code, mode: mode.kind, replaced: originalText };
    }
    case 'replace-lines': {
      const allLines = originalText.split(/\r\n|\r|\n/);
      const total = allLines.length;
      if (mode.start < 1 || mode.end < mode.start || mode.end > total) {
        return {
          ok: false,
          reason: 'range-invalid',
          detail: `行区间 ${mode.start}-${mode.end} 超出文件范围（文件共 ${total} 行）`,
        };
      }

      const currentSlice = allLines.slice(mode.start - 1, mode.end).join('\n');
      const expected = mode.expectedOriginal.replace(/\s+$/, '');
      if (currentSlice.replace(/\s+$/, '') !== expected) {
        return {
          ok: false,
          reason: 'content-mismatch',
          detail: `第 ${mode.start}-${mode.end} 行的当前内容与复制时的原文不一致（文件可能已被改动），已拒绝写入`,
        };
      }

      // 上下文校验：前后各取一行（若存在）
      const prevIdx = mode.start - 2;
      const nextIdx = mode.end;
      const currentPrev = prevIdx >= 0 ? allLines[prevIdx] : null;
      const currentNext = nextIdx < total ? allLines[nextIdx] : null;
      if (mode.contextPrev !== undefined && mode.contextPrev !== null && currentPrev !== mode.contextPrev) {
        return {
          ok: false,
          reason: 'context-mismatch',
          detail: `第 ${mode.start - 1} 行（区间上一行）与复制时不一致，行号可能已漂移，已拒绝写入`,
        };
      }
      if (mode.contextNext !== undefined && mode.contextNext !== null && currentNext !== mode.contextNext) {
        return {
          ok: false,
          reason: 'context-mismatch',
          detail: `第 ${mode.end + 1} 行（区间下一行）与复制时不一致，行号可能已漂移，已拒绝写入`,
        };
      }

      const replaced = currentSlice;
      const blockLines = block.code.split(/\r\n|\r|\n/);

      // 范围只指向原文；新内容行数不限制，区间外内容完整保留。
      const newLines = [
        ...allLines.slice(0, mode.start - 1),
        ...blockLines,
        ...allLines.slice(mode.end),
      ];
      return {
        ok: true,
        text: newLines.join('\n'),
        mode: mode.kind,
        replaced,
      };
    }
    default: {
      const exhaustive: never = mode;
      throw new Error(`未知应用模式：${String(exhaustive)}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 选区记忆兜底：把"复制片段那一刻"的区间回填给无区间的代码块
 * ------------------------------------------------------------------ */

/** 「复制选中片段」时的选区记忆（主进程在 copyNumberedSnippet 成功后记录） */
export interface SnippetRangeMemory {
  /** 片段所属文件（相对根目录，正斜杠） */
  relPath: string;
  /** 片段起始行（1 起） */
  startLine: number;
  /** 片段结束行（含） */
  endLine: number;
}

/**
 * 选区兜底：模型没回显（或采集策略没采到）`### 范围：N-M` 时，
 * 用「复制片段那一刻」的选区回填 —— **否则无区间的块会被当成整文件替换**。
 * 实测踩坑：用户选中 2-10 行复制片段让模型改，模型也只回了针对 2-10 的内容，
 * 但解析出的块没有行区间，应用时整个文件被模型内容覆盖，区间外的行全部丢失。
 *
 * 两个保守条件，避免把记忆套到不相关的块上：
 *  1. 批次内**恰好一个**「无区间且路径与片段一致」的块 —— 多个时无法判断各自区间，
 *     宁可维持 null（预览里人工确认），也不猜；
 *  2. 路径比较大小写不敏感（Windows 文件名语义）。
 *
 * 模型自己回显的区间指令优先级更高：已解析出 range 的块不做任何改动。
 *
 * @returns 回填说明（供解析备注展示）；未回填返回 null。
 *          **原地修改**传入的 blocks（collectReply 缓存与预览共用同一批对象）。
 */
export function applySnippetRangeFallback(
  blocks: ParsedCodeBlock[],
  snippet: SnippetRangeMemory | null
): string | null {
  if (!snippet) return null;
  const target = snippet.relPath.toLowerCase();
  const candidates = blocks.filter(
    (b) => b.range === null && b.filePath !== null && b.filePath.toLowerCase() === target
  );
  const block = candidates[0];
  if (candidates.length !== 1 || !block) return null;
  block.range = { start: snippet.startLine, end: snippet.endLine };
  return (
    `代码块未携带行区间指令，已按「复制片段时的选区」回填为 ${snippet.startLine}-${snippet.endLine}` +
    `（应用时仅替换该区间，不再整文件覆盖）`
  );
}
