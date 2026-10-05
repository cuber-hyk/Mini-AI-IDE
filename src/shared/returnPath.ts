/**
 * 回程解析（纯逻辑，可单测）。
 * 每个代码块只采用自身首行路径注释与紧邻的文件/范围标题，不从正文、其他块或选区猜测。
 * 缺失或冲突的信息保留为诊断，交由应用层阻塞；无文件修改元数据的围栏作为只读附属内容。
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
  pathSource: 'fence-comment' | 'preceding-heading' | 'none';
  /**
   * 已有文件待替换的原行区间（1 起、闭区间）；null 表示未提供范围。
   * 来源是围栏上方的 `### 范围：80-92` 指令（也接受 `### 行：80-92`）。
   */
  range: LineRange | null;
  /** 没有文件修改元数据的附属内容，只读展示；语言仅用于高亮 */
  kind?: 'other';
  /** 标题或路径注释相互冲突、格式无效时阻塞该块 */
  validationError?: string;
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

export interface ParseResult {
  blocks: ParsedCodeBlock[];
  /** 全文出现的路径候选（去重后，按出现顺序） */
  mentionedPaths: string[];
  /** 是否存在缺少目标路径或元数据冲突的待修改块；只读附属内容不计入 */
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
  'prisma', 'md', 'markdown', 'txt', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
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
  const closed = /^[ \t]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\1[ \t]*\r?$/gm;
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

interface PathComment {
  path: string | null;
  error?: string;
}

/** 路径注释与显式文件标签统一校验，歧义不能变成带空格的合法文件名。 */
function parsePathCommentLine(line: string): PathComment {
  const comment = /^\s*(?:\/\/|#|--|<!--|\/\*)\s*(.*?)\s*(?:-->|\*\/)?\s*$/.exec(line);
  const explicitLabel = comment ? FILE_LABEL_RE.exec(comment[1] ?? '') : null;
  let candidate: string | null = explicitLabel?.[1]?.trim() ?? null;
  if (!explicitLabel) {
    for (const re of PATH_COMMENT_PATTERNS) {
      const matched = re.exec(line);
      if (matched?.[1]) { candidate = matched[1].trim(); break; }
    }
  }
  if (candidate === null) return { path: null };
  const mentions = extractPathMentions(candidate);
  if (mentions.length > 1) return { path: null, error: '路径注释包含多个目标文件，请 AI 明确单个文件路径' };
  const path = normalizeRelPath(candidate);
  if (!path || /[，。；：！？、<>"`*]/.test(candidate.replace(/^[A-Za-z]:/, ''))) {
    return { path: null, error: '路径注释的文件路径格式无效，请 AI 补充有效的单个文件路径' };
  }
  return { path };
}

/** 判断首行是否明确指定单个路径；无效或歧义路径返回 null。 */
export function matchPathCommentLine(line: string): string | null {
  return parsePathCommentLine(line).path;
}

/* ------------------------------------------------------------------ *
 * 路径线索：围栏上方的标题式行
 * ------------------------------------------------------------------ */

/** 文件标签必须独占标题，正文中的示例不作为目标文件。 */
const FILE_LABEL_RE = /^(?:文件名|文件|路径|file|filename|path)\s*[:：]\s*(.*)$/i;

function cleanHeading(line: string): string {
  return line.trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)$/, '$1')
    .trim();
}

/** 显式标签允许中文、空格、点文件及自定义扩展名；具体磁盘合法性由白名单校验。 */
export function matchHeadingLine(line: string): string | null {
  const cleaned = cleanHeading(line);
  const labeled = FILE_LABEL_RE.exec(cleaned);
  const candidate = (labeled?.[1] ?? cleaned)
    .replace(/^(?:\*\*|__|`)(.*?)(?:\*\*|__|`)$/, '$1').trim();
  const heading = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(line);
  const wrapped = /^(?:\*\*|__|`)/.test(line.trim());
  if (!labeled && !heading && !wrapped) return null;
  if (!candidate || candidate.length > 200 || /[，。；：！？、<>"`*]/.test(candidate.replace(/^[A-Za-z]:/, ''))) return null;
  if (labeled) {
    // 多条路径在同一标题中仍属歧义，不能把分隔符当成文件名的一部分。
    if (extractPathMentions(candidate).length > 1) return null;
    return normalizeRelPath(candidate);
  }
  if (!new RegExp(String.raw`\.(?:${EXT_ALTERNATION})$`, 'i').test(candidate)) return null;
  const mentions = extractPathMentions(candidate);
  const normalized = normalizeRelPath(candidate);
  if (mentions.length !== 1 || mentions[0] !== normalized) return null;
  return normalized;
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

interface BlockHeader {
  paths: string[];
  ranges: LineRange[];
  errors: string[];
  hasFileLabel: boolean;
}

/** 只扫描上一围栏之后、当前围栏之前的相邻标题；空行可跨越，正文或章节标题形成边界。 */
function findBlockHeader(text: string, previousEnd: number, fenceStart: number): BlockHeader {
  const header: BlockHeader = { paths: [], ranges: [], errors: [], hasFileLabel: false };
  const lines = text.slice(previousEnd, fenceStart).split(/\r\n|\r|\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? '';
    if (!line) continue;
    const fileLabel = FILE_LABEL_RE.test(cleanHeading(line));
    const rangeLabel = /^(?:范围|行|行号|位置|lines?|range|position)\s*[:：]/i.test(cleanHeading(line));
    const path = matchHeadingLine(line);
    const range = matchRangeDirective(line);
    if (fileLabel) header.hasFileLabel = true;
    if (path) header.paths.unshift(path);
    else if (fileLabel) header.errors.unshift('文件路径格式无效或同一标题包含多个路径，请 AI 明确单个文件路径');
    if (range) header.ranges.unshift(range);
    else if (rangeLabel) header.errors.unshift('范围格式无效，请 AI 补充有效的原行区间');
    if (!path && !range && !fileLabel && !rangeLabel) break;
  }
  return header;
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

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

export function parseModelReply(replyText: string): ParseResult {
  const text = replyText ?? '';
  const notes: string[] = [];
  const fences = splitFences(text);
  const mentionedPaths = extractPathMentions(text);
  if (fences.length === 0) {
    notes.push('回复中未找到代码围栏，无可应用内容');
    return { blocks: [], mentionedPaths, hasUnresolved: false, notes };
  }

  const blocks: ParsedCodeBlock[] = fences.map((f, index) => {
    const header = findBlockHeader(text, fences[index - 1]?.end ?? 0, f.start);
    let code = f.body;
    let strippedPathLine: string | null = null;
    const firstNewline = code.indexOf('\n');
    const firstLine = firstNewline >= 0 ? code.slice(0, firstNewline) : code;
    const comment = parsePathCommentLine(firstLine);
    const fromComment = comment.path;
    if (fromComment) {
      strippedPathLine = firstLine;
      code = firstNewline >= 0 ? code.slice(firstNewline + 1) : '';
    }
    const paths = [...header.paths, ...(fromComment ? [fromComment] : [])];
    const distinctPaths = new Set(paths.map((path) => path.toLowerCase()));
    const errors = [...header.errors, ...(comment.error ? [comment.error] : [])];
    if (distinctPaths.size > 1) errors.push('文件路径相互冲突，请 AI 为该代码块明确单个目标文件');
    const distinctRanges = new Set(header.ranges.map((range) => `${range.start}-${range.end}`));
    if (distinctRanges.size > 1) errors.push('原行区间相互冲突，请 AI 为该代码块明确单个范围');
    const filePath = distinctPaths.size === 1 ? (fromComment ?? header.paths[0] ?? null) : null;
    const range = distinctRanges.size === 1 ? (header.ranges[0] ?? null) : null;
    if (range) {
      const stripped = stripNumberedPrefix(code);
      if (stripped.startLine !== null) code = stripped.text;
    }
    const language = normalizeLanguage(f.info);
    const other = !filePath && paths.length === 0 && !header.hasFileLabel &&
      header.ranges.length === 0 && errors.length === 0;
    return {
      code: code.replace(/\s+$/, ''),
      language,
      filePath,
      pathSource: filePath ? (fromComment ? 'fence-comment' : 'preceding-heading') : 'none',
      range,
      strippedPathLine,
      start: f.start,
      end: f.end,
      ...(other ? { kind: 'other' as const } : {}),
      ...(errors.length ? { validationError: errors.join('；') } : {}),
    };
  });

  const unresolved = blocks.filter((block) => block.kind !== 'other' && (!block.filePath || block.validationError));
  if (unresolved.length) notes.push(`${unresolved.length} 个代码块缺少明确路径或存在冲突，请 AI 补充后重新采集`);
  const snippets = blocks.filter((block) => block.range && block.kind !== 'other');
  if (snippets.length) notes.push(`${snippets.length} 个代码块携带原行区间；已有文件应用前做三向校验，新建文件完整写入代码`);
  const others = blocks.filter((block) => block.kind === 'other');
  if (others.length) notes.push(`${others.length} 段附属内容只读展示，无需补充文件路径，IDE 不会执行或写入文件`);
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
