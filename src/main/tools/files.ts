import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { decodeTextFile } from '../../shared/encoding';
import { isInsideRoot } from '../../shared/pathGuard';
import { validateToolArgs, type ToolName } from '../../shared/toolProtocol';

const OUTPUT_LIMIT = 50_000;
const FILE_BYTE_LIMIT = 16 * 1024 * 1024;
const WALK_LIMIT = 10_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release']);

/** 授权由 harness 完成；此处只返回真实目标，不能把 cwd 当成沙箱。 */
export async function resolveToolPath(root: string, input?: string): Promise<string> {
  if (!root || (input !== undefined && (typeof input !== 'string' || input.includes('\0')))) throw new Error('路径无效');
  const requested = path.resolve(root, input || '.');
  let ancestor = requested;
  const missing: string[] = [];
  for (;;) {
    try {
      const stat = await fs.lstat(ancestor);
      const real = await fs.realpath(ancestor); // 悬空链接必须报错，不能当成待创建路径。
      if (missing.length && !(stat.isDirectory() || (stat.isSymbolicLink() && (await fs.stat(real)).isDirectory()))) throw new Error('路径的父级不是目录');
      return path.join(real, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // lstat 能找到的悬空链接不能向上回退。
      try { await fs.lstat(ancestor); throw new Error('路径包含悬空链接'); }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ENOENT') throw check; }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(path.basename(ancestor)); ancestor = parent;
    }
  }
}

interface Entry { path: string; type: 'directory' | 'file' | 'link' | 'other'; depth: number }
interface WalkResult { entries: Entry[]; truncated: boolean; skipped: { path: string; reason: string }[] }

async function walk(root: string, depth: number, limit: number, includeDirectories: boolean): Promise<WalkResult> {
  const entries: Entry[] = []; const skipped: WalkResult['skipped'] = [];
  let visited = 0; let truncated = false;
  async function visit(directory: string, level: number): Promise<void> {
    const children = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      visited += 1;
      if (visited > WALK_LIMIT || entries.length >= limit) { truncated = true; return; }
      const absolute = path.join(directory, child.name); const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (child.isDirectory() && SKIP_DIRS.has(child.name.toLowerCase())) { if (skipped.length < 100) skipped.push({ path: relative, reason: '默认排除目录' }); continue; }
      // 不通过任何链接读取外部内容；指定链接目标的单独请求会重新授权。
      const type = child.isSymbolicLink() ? 'link' : child.isDirectory() ? 'directory' : child.isFile() ? 'file' : 'other';
      if (includeDirectories || type === 'file') entries.push({ path: relative, type, depth: level });
      if (type === 'link' && skipped.length < 100) skipped.push({ path: relative, reason: '不递归或读取链接' });
      if (type === 'directory' && level < depth) await visit(absolute, level + 1);
      if (truncated) return;
    }
  }
  await visit(root, 0);
  return { entries, truncated, skipped };
}

function glob(pattern: string): { test: (value: string) => boolean } {
  if (pattern.length > 1000) throw new Error('glob 超过 1000 字符上限');
  const normalized = pattern.replace(/\\/g, '/'); const tokens: string[] = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (char === '*' && normalized[i + 1] === '*') {
      i += 1;
      if (normalized[i + 1] === '/') { tokens.push('**/'); i += 1; }
      else tokens.push('**');
    } else tokens.push(char);
  }
  // 动态规划避免任意 glob 在正则回溯中阻塞主进程。
  return { test(input: string) {
    const value = process.platform === 'win32' ? input.toLowerCase() : input;
    let next = new Uint8Array(value.length + 1); next[value.length] = 1;
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      const token = process.platform === 'win32' ? tokens[i]!.toLowerCase() : tokens[i]!;
      const row = new Uint8Array(value.length + 1); let directorySuffix = false;
      for (let j = value.length; j >= 0; j -= 1) {
        if (token === '**/') {
          if (value[j] === '/' && next[j + 1]) directorySuffix = true;
          row[j] = next[j] || directorySuffix ? 1 : 0;
        } else if (token === '**' || token === '*') row[j] = next[j] || (j < value.length && (token === '**' || value[j] !== '/') && row[j + 1]) ? 1 : 0;
        else if (j < value.length && (token === '?' ? value[j] !== '/' : token === value[j]) && next[j + 1]) row[j] = 1;
      }
      next = row;
    }
    return next[0] === 1;
  } };
}

async function readText(absolute: string) {
  const before = await fs.lstat(absolute);
  if (!before.isFile()) throw new Error('目标不是普通文件，不能通过链接读取');
  const handle = await fs.open(absolute, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('目标不是普通文件');
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('读取时文件对象发生改变，请重新查询');
    if (stat.size > FILE_BYTE_LIMIT) throw new Error(`文件超过读取上限 ${FILE_BYTE_LIMIT} 字节，请使用命令查询`);
    // 增长中的文件同样只读有限字节。
    const buffer = Buffer.alloc(Math.min(stat.size + 1, FILE_BYTE_LIMIT + 1));
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > FILE_BYTE_LIMIT) throw new Error(`文件超过读取上限 ${FILE_BYTE_LIMIT} 字节，请使用命令查询`);
    if (size > stat.size) throw new Error('文件读取时发生增长，请重新查询');
    const decoded = decodeTextFile(buffer.subarray(0, size));
    if (!decoded.ok) throw new Error(`拒绝二进制文件：${decoded.detail}`);
    if (decoded.text.includes('\0')) throw new Error('拒绝二进制文件：文本包含 NUL 字符');
    return decoded;
  } finally { await handle.close(); }
}

export class ToolFiles {
  async execute(root: string, tool: ToolName, args: Record<string, unknown>): Promise<unknown> {
    const invalid = validateToolArgs(tool, args); if (invalid) throw new Error(invalid);
    const target = await resolveToolPath(root, args.path as string | undefined);
    if (tool === 'read_file') {
      const decoded = await readText(target); const lines = decoded.text.split(/\r\n|\n|\r/);
      const start = (args.start_line as number | undefined) ?? 1;
      const end = Math.min((args.end_line as number | undefined) ?? lines.length, lines.length);
      let content = ''; let last = start - 1; let truncated = false; let partialLine = false;
      for (let i = start; i <= end; i += 1) {
        const rendered = `${i}: ${lines[i - 1]!}\n`;
        if (content.length + rendered.length > OUTPUT_LIMIT) {
          if (!content) { content = rendered.slice(0, OUTPUT_LIMIT); last = i; partialLine = true; }
          truncated = true; break;
        }
        content += rendered; last = i;
      }
      return { path: target, encoding: decoded.encoding, total_lines: lines.length, start_line: start, end_line: last, content, truncated,
        next_start_line: truncated ? (partialLine ? last : last + 1) : null,
        note: partialLine ? '单行超过字符上限，该行只返回前段；可使用命令查询剩余字符' : truncated ? '达到字符上限，请从 next_start_line 继续读取' : '' };
    }
    const stat = await fs.stat(target);
    if (tool === 'search_text' && stat.isFile()) return this.searchText(target, [{ path: path.basename(target), type: 'file', depth: 0 }], args, false, []);
    if (!stat.isDirectory()) throw new Error('目标不是目录');
    if (tool === 'get_project_info') {
      const tree = await walk(target, 0, 100, true);
      return { root: target, name: path.basename(target), platform: process.platform, entries: tree.entries, truncated: tree.truncated, skipped: tree.skipped };
    }
    if (tool === 'list_directory') return { path: target, ...await walk(target, (args.depth as number | undefined) ?? 1, (args.limit as number | undefined) ?? 500, true) };
    const tree = await walk(target, 10, WALK_LIMIT, false);
    if (tool === 'search_files') {
      const match = glob(args.pattern as string); const limit = (args.limit as number | undefined) ?? 500;
      const matches = tree.entries.filter(e => match.test(e.path) || (!(args.pattern as string).replace(/\\/g, '/').includes('/') && match.test(path.posix.basename(e.path))));
      return { path: target, files: matches.slice(0, limit).map(e => e.path), truncated: tree.truncated || matches.length > limit, skipped: tree.skipped };
    }
    if (tool === 'search_text') return this.searchText(target, tree.entries, args, tree.truncated, tree.skipped);
    throw new Error(`文件工具不支持 ${tool}`);
  }

  private async searchText(target: string, entries: Entry[], args: Record<string, unknown>, truncated: boolean, skipped: WalkResult['skipped']) {
    const query = args.query as string; const limit = (args.limit as number | undefined) ?? 100; const context = (args.context as number | undefined) ?? 2;
    const matches: { path: string; line: number; content: string; context: { line: number; content: string }[] }[] = [];
    const single = (await fs.stat(target)).isFile(); let budget = OUTPUT_LIMIT;
    for (const entry of entries) {
      const absolute = single ? target : path.join(target, entry.path);
      let text: string;
      try {
        if (!single && !isInsideRoot(target, await fs.realpath(absolute))) throw new Error('真实路径已越出查询目录，跳过');
        text = (await readText(absolute)).text;
      }
      catch (error) { if (skipped.length < 100) skipped.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) }); continue; }
      const lines = text.split(/\r\n|\n|\r/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i]!.includes(query)) continue;
        const surrounding: { line: number; content: string }[] = [];
        const content = lines[i]!;
        let size = content.length + entry.path.length + 30;
        for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j += 1) {
          if (i !== j) { surrounding.push({ line: j + 1, content: lines[j]! }); size += lines[j]!.length + 30; }
        }
        if (matches.length >= limit || size > budget) { truncated = true; return { path: target, query, matches, truncated, skipped, note: '达到结果或字符上限，请缩小 path 或使用命令查询' }; }
        budget -= size; matches.push({ path: entry.path, line: i + 1, content, context: surrounding });
      }
    }
    return { path: target, query, matches, truncated, skipped };
  }
}
