/**
 * 回程解析（纯逻辑，可单测）。
 * 每个修改块只采用紧邻文件与明确操作标题，不从正文、其他块或选区猜测。
 * 缺失或冲突的信息保留为诊断，交由应用层阻塞；无文件修改元数据的围栏作为只读附属内容。
 */

/** 代码块 */
export interface ParsedCodeBlock {
  /** 围栏正文原文，只去除围栏的结构性换行 */
  code: string;
  /** 围栏语言标注（可为空字符串） */
  language: string;
  /** 推断出的目标文件（相对根目录，正斜杠）；null 表示未能确定 */
  filePath: string | null;
  /** 路径线索来源 */
  pathSource: 'fence-comment' | 'preceding-heading' | 'none';
  /**
   * 保留为 null；旧行号格式只触发迁移诊断，不再作为修改定位。
   */
  range: LineRange | null;
  /** 明确的修改操作，不从内容或磁盘存在状态推断 */
  operation?: EditOperation;
  /** 替换操作中的完整 SEARCH/REPLACE 对 */
  edits?: TextEdit[];
  /** 没有文件修改元数据的附属内容，只读展示；语言仅用于高亮 */
  kind?: 'other';
  /** 标题或路径注释相互冲突、格式无效时阻塞该块 */
  validationError?: string;
  /** 保留为 null；协议正文内的路径注释按字面保留 */
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

export interface RawFence {
  start: number;
  end: number;
  info: string;
  /** 完整正文；只移除围栏自己的结构性换行 */
  body: string;
  bodyStart: number;
  closed: boolean;
  fenceLength: number;
  marker: '`' | '~';
}

interface TextLine { text: string; start: number; end: number }
function textLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  const re = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  for (const match of text.matchAll(re)) {
    if (match[0].length === 0) break;
    const start = match.index ?? 0;
    lines.push({ text: match[1] ?? '', start, end: start + match[0].length });
  }
  return lines;
}

function withoutStructuralNewline(text: string): string {
  return text.replace(/(?:\r\n|\r|\n)$/, '');
}

/** Markdown 围栏逐行切分，记录闭合状态；缺失闭合不能成为可写正文。 */
export function splitFences(text: string): RawFence[] {
  const lines = textLines(text);
  const found: RawFence[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const opening = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)$/.exec(line.text);
    if (!opening) continue;
    const fence = opening[1]!;
    const marker = fence[0] as '`' | '~';
    const closing = new RegExp(`^[ \\t]*${marker === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
    let j = i + 1;
    while (j < lines.length && !closing.test(lines[j]!.text)) j += 1;
    const close = lines[j];
    const bodyStart = line.end;
    found.push({
      start: line.start, end: close ? close.end : text.length,
      info: (opening[2] ?? '').trim(),
      body: close ? withoutStructuralNewline(text.slice(bodyStart, close.start)) : text.slice(bodyStart),
      bodyStart, closed: Boolean(close), fenceLength: fence.length, marker,
    });
    i = close ? j : lines.length;
  }
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

export type EditOperation = 'replace' | 'create' | 'overwrite';
export interface TextEdit { oldText: string; newText: string }

interface BlockHeader {
  paths: string[];
  operations: EditOperation[];
  errors: string[];
  hasFileLabel: boolean;
  hasOperationLabel: boolean;
  hasRangeLabel: boolean;
  context: boolean;
  start: number;
}

const OPERATION_LABEL_RE = /^操作\s*[:：]\s*(.*)$/;
const CONTEXT_LABEL_RE = /^(?:上下文文件|上下文)\s*[:：]/;
const RANGE_LABEL_RE = /^(?:范围|行|行号|位置|lines?|range|position)\s*[:：]/i;
const OPERATIONS = new Map<string, EditOperation>([['替换', 'replace'], ['新建', 'create'], ['覆盖全文', 'overwrite']]);

/** 旧范围仅供识别与迁移诊断，绝不参与定位。 */
export function matchRangeDirective(line: string): LineRange | null {
  const match = /^(?:#{1,6}\s*)?(?:范围|行|行号|位置|lines?|range|position)\s*[:：]\s*(\d+)\s*[-–—~至到]\s*(\d+)\s*$/.exec(line.trim());
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2]);
  return start >= 1 && end >= start ? { start, end } : null;
}

function findBlockHeader(text: string, previousEnd: number, fenceStart: number): BlockHeader {
  const header: BlockHeader = {
    paths: [], operations: [], errors: [], hasFileLabel: false,
    hasOperationLabel: false, hasRangeLabel: false, context: false, start: fenceStart,
  };
  const lines = textLines(text.slice(previousEnd, fenceStart));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.text.trim() ?? '';
    if (!line) continue;
    const cleaned = cleanHeading(line);
    const fileLabel = FILE_LABEL_RE.test(cleaned);
    const operationLabel = OPERATION_LABEL_RE.exec(cleaned);
    const rangeLabel = RANGE_LABEL_RE.test(cleaned);
    const contextLabel = CONTEXT_LABEL_RE.test(cleaned);
    const path = matchHeadingLine(line);
    if (fileLabel) header.hasFileLabel = true;
    if (path) header.paths.unshift(path);
    else if (fileLabel) header.errors.unshift('文件路径格式无效或包含多个路径，请明确单个目标文件');
    if (operationLabel) {
      header.hasOperationLabel = true;
      const operation = OPERATIONS.get(operationLabel[1]?.trim() ?? '');
      if (operation) header.operations.unshift(operation);
      else header.errors.unshift('未知或缺失操作，请明确使用替换、新建或覆盖全文');
    }
    if (rangeLabel) {
      header.hasRangeLabel = true;
      header.errors.unshift('旧行号范围协议不可应用，请改用明确操作与 SEARCH/REPLACE 新格式');
    }
    if (contextLabel) header.context = true;
    if (!path && !fileLabel && !operationLabel && !rangeLabel && !contextLabel) break;
    header.start = previousEnd + lines[i]!.start;
  }
  return header;
}

/** 替换对只解释独立标记行；正文字符与真实首尾换行保持不变。 */
function parseTextEdits(code: string): { edits?: TextEdit[]; error?: string } {
  const lines = textLines(code);
  const edits: TextEdit[] = [];
  let state: 'outside' | 'search' | 'replace' = 'outside';
  let bodyStart = 0;
  let oldText = '';
  for (const line of lines) {
    const marker = line.text;
    if (marker === '<<<<<<< SEARCH') {
      if (state !== 'outside') return { error: 'SEARCH 标记冲突，请为该文件使用明确的覆盖全文' };
      state = 'search'; bodyStart = line.end;
    } else if (marker === '=======') {
      if (state !== 'search') return { error: '分隔标记冲突或替换对残缺，请检查 SEARCH/REPLACE 结构' };
      oldText = withoutStructuralNewline(code.slice(bodyStart, line.start));
      if (oldText.length === 0) return { error: 'SEARCH 原文不能为空；插入请提供真实原文上下文' };
      state = 'replace'; bodyStart = line.end;
    } else if (marker === '>>>>>>> REPLACE') {
      if (state !== 'replace') return { error: 'REPLACE 标记冲突或替换对残缺，请检查 SEARCH/REPLACE 结构' };
      edits.push({ oldText, newText: withoutStructuralNewline(code.slice(bodyStart, line.start)) });
      state = 'outside';
    } else if (state === 'outside' && marker !== '') {
      return { error: '替换正文包含结构外文本或非法标记，请提供完整 SEARCH/REPLACE 对' };
    }
  }
  if (state !== 'outside' || edits.length === 0) return { error: '缺失或残缺 SEARCH/REPLACE 对，请补充完整替换结构' };
  return { edits };
}

export function parseModelReply(replyText: string): ParseResult {
  const text = replyText ?? '';
  const notes: string[] = [];
  const fences = splitFences(text);
  const mentionedPaths = extractPathMentions(text);
  const orphaned: ParsedCodeBlock[] = [];
  const addMissingFence = (start: number, end: number) => {
    const content = text.slice(start, end);
    if (!textLines(content).some((line) => {
      const cleaned = cleanHeading(line.text);
      return FILE_LABEL_RE.test(cleaned) || OPERATION_LABEL_RE.test(cleaned) || RANGE_LABEL_RE.test(cleaned);
    })) return;
    orphaned.push({
      code: content, language: '', filePath: null, pathSource: 'none', range: null,
      strippedPathLine: null, start, end,
      validationError: '文件修改缺少完整代码围栏，不能把缺失正文当作空文件',
    });
  };
  const blocks: ParsedCodeBlock[] = fences.map((f, index) => {
    const previousEnd = fences[index - 1]?.end ?? 0;
    const header = findBlockHeader(text, previousEnd, f.start);
    addMissingFence(previousEnd, header.start);
    const paths = header.paths;
    const distinctPaths = new Set(paths.map((path) => path.toLowerCase()));
    const operations = new Set(header.operations);
    const firstLine = textLines(f.body)[0]?.text ?? '';
    const legacyComment = !header.hasOperationLabel && !header.context && paths.length === 0
      ? parsePathCommentLine(firstLine) : { path: null };
    const errors = [...header.errors, ...(legacyComment.error ? [legacyComment.error] : [])];
    if (distinctPaths.size > 1) errors.push('文件路径相互冲突，请明确单个目标文件');
    if (operations.size > 1) errors.push('操作相互冲突，请明确单个修改操作');
    const filePath = distinctPaths.size === 1 ? (paths[0] ?? null) : null;
    const operation = operations.size === 1 ? header.operations[0] : undefined;
    const searchMarker = textLines(f.body).some((line) => /^\s*(?:<{7,}\s*SEARCH|={7,}|>{7,}\s*REPLACE)\s*$/.test(line.text));
    const modification = paths.length > 0 || header.hasFileLabel || header.hasOperationLabel ||
      header.hasRangeLabel || Boolean(legacyComment.path) || errors.length > 0 || (!header.context && searchMarker);
    const contextOnly = header.context && !modification;
    if (header.context && modification) errors.push('上下文与修改操作不能混用，请分别声明');
    if (!f.closed) errors.push('代码围栏未闭合，请补充完整成对围栏');
    if (modification) {
      if (!filePath) errors.push('缺少明确文件路径，请补充本块文件标题');
      else if (!header.hasFileLabel) errors.push('修改块必须显式声明 ### 文件：相对路径');
      if (!operation) errors.push('缺少明确操作，请声明替换、新建或覆盖全文');
      if (f.marker !== '`' || f.fenceLength < 4) errors.push('修改块必须使用至少四个反引号的完整围栏');
    }
    let edits: TextEdit[] | undefined;
    if (operation === 'replace') {
      const parsed = parseTextEdits(f.body);
      edits = parsed.edits;
      if (parsed.error) errors.push(parsed.error);
    }
    const other = (contextOnly || !modification) && errors.length === 0;
    return {
      code: f.body, language: normalizeLanguage(f.info), filePath,
      pathSource: filePath ? 'preceding-heading' : 'none',
      range: null, strippedPathLine: null, start: f.start, end: f.end,
      ...(operation ? { operation } : {}), ...(edits ? { edits } : {}),
      ...(other ? { kind: 'other' as const } : {}),
      ...(errors.length ? { validationError: errors.join('；') } : {}),
    };
  });
  // 缺少实际代码框不能被解释为空的新建/覆盖正文；保留可见诊断。
  addMissingFence(fences.at(-1)?.end ?? 0, text.length);
  blocks.push(...orphaned);
  blocks.sort((a, b) => a.start - b.start);
  if (!fences.length && !blocks.length) notes.push('回复中未找到代码围栏，无可应用内容');
  const unresolved = blocks.filter((block) => block.kind !== 'other' && (!block.filePath || !block.operation || block.validationError));
  if (unresolved.length) notes.push(`${unresolved.length} 个修改块格式缺失或冲突，请补充新协议后重新采集`);
  const others = blocks.filter((block) => block.kind === 'other');
  if (others.length) notes.push(`${others.length} 段附属内容只读展示，无需补充修改信息`);
  return { blocks, mentionedPaths, hasUnresolved: unresolved.length > 0, notes };
}

function normalizeLanguage(info: string): string {
  return (info.split(/\s+/)[0] ?? '').replace(/[{}]/g, '').trim().toLowerCase();
}

export interface EditLocation {
  /** 原文字符半开区间；对应 computeApply 输入的原始换行偏移 */
  start: number;
  end: number;
  oldRange: LineRange | null;
  newRange: LineRange | null;
  /** 真实逻辑换行数增量，行内删除和末尾换行不能靠触及范围长度相减。 */
  lineDelta: number;
}
export interface ApplyResult {
  text: string;
  mode: EditOperation;
  replaced: string;
  locations: EditLocation[];
}
export type ApplyOutcome =
  | ({ ok: true } & ApplyResult)
  | { ok: false; reason: 'invalid-protocol' | 'empty-search' | 'search-not-found' | 'search-ambiguous' | 'overlap'; detail: string };

/** 只规范换行，并保留逻辑字符边界到原字符边界的映射。 */
function normalizedText(text: string): { text: string; offsets: number[] } {
  let normalized = '';
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      normalized += '\n';
    } else normalized += char;
    offsets.push(i + 1);
  }
  return { text: normalized, offsets };
}

/** 字符区间对应实际含内容的行；空区间没有新行。 */
function lineRange(text: string, start: number, end: number): LineRange | null {
  if (end <= start) return null;
  const lineAt = (offset: number) => {
    let line = 1;
    for (const match of text.matchAll(/\r\n|\r|\n/g)) {
      if ((match.index ?? 0) + match[0].length > offset) break;
      line += 1;
    }
    return line;
  };
  return { start: lineAt(start), end: lineAt(end - 1) };
}

export function getLineRange(text: string, start: number, end: number): string[] {
  if (start < 1 || end < start) return [];
  return text.split(/\r\n|\r|\n/).slice(start - 1, end);
}

/** 所有替换对在同一原文中定位、验证，然后一次计算；绝不把前一对结果作为后一对原文。 */
export function computeApply(originalText: string, block: ParsedCodeBlock): ApplyOutcome {
  const invalid = (detail: string): ApplyOutcome => ({ ok: false, reason: 'invalid-protocol', detail });
  if (block.kind === 'other' || block.validationError || !block.filePath || !block.operation || block.range !== null) {
    return invalid(block.validationError ?? '缺少明确文件或操作，或仍使用旧范围协议');
  }
  const operation = block.operation;
  if (!['replace', 'create', 'overwrite'].includes(operation)) return invalid('未知修改操作');
  const eol = originalText.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  if (operation === 'create' || operation === 'overwrite') {
    const text = operation === 'overwrite' ? normalizedText(block.code).text.replace(/\n/g, eol) : block.code;
    return {
      ok: true, text, mode: operation, replaced: originalText,
      locations: [{ start: 0, end: originalText.length, oldRange: lineRange(originalText, 0, originalText.length), newRange: lineRange(text, 0, text.length),
        lineDelta: normalizedText(text).text.split('\n').length - normalizedText(originalText).text.split('\n').length }],
    };
  }
  if (!block.edits?.length) return invalid('替换操作缺少完整 SEARCH/REPLACE 对');
  const original = normalizedText(originalText);
  const located: Array<{ index: number; start: number; end: number; replacement: string }> = [];
  for (const [index, edit] of block.edits.entries()) {
    const search = normalizedText(edit.oldText).text;
    if (!search.length) return { ok: false, reason: 'empty-search', detail: 'SEARCH 原文不能为空，请提供真实上下文' };
    const first = original.text.indexOf(search);
    if (first < 0) return { ok: false, reason: 'search-not-found', detail: `第 ${index + 1} 对 SEARCH 原文不匹配，请重新复制准确原文` };
    if (original.text.indexOf(search, first + 1) >= 0) {
      return { ok: false, reason: 'search-ambiguous', detail: `第 ${index + 1} 对 SEARCH 匹配多次，请补充唯一上下文` };
    }
    located.push({ index, start: original.offsets[first]!, end: original.offsets[first + search.length]!, replacement: normalizedText(edit.newText).text.replace(/\n/g, eol) });
  }
  const sorted = [...located].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.start < sorted[i - 1]!.end) return { ok: false, reason: 'overlap', detail: '多个 SEARCH 区间重叠，整块替换已拒绝' };
  }
  let text = '';
  let cursor = 0;
  const locations: EditLocation[] = [];
  for (const item of sorted) {
    text += originalText.slice(cursor, item.start);
    const newStart = text.length;
    text += item.replacement;
    locations[item.index] = { start: item.start, end: item.end, oldRange: lineRange(originalText, item.start, item.end), newRange: lineRange(text, newStart, text.length),
      lineDelta: normalizedText(item.replacement).text.split('\n').length - normalizedText(originalText.slice(item.start, item.end)).text.split('\n').length };
    cursor = item.end;
  }
  text += originalText.slice(cursor);
  return { ok: true, text, mode: operation, replaced: located.map((item) => originalText.slice(item.start, item.end)).join('\n'), locations };
}
