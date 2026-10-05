/**
 * 文件读取服务（主进程专用）
 *
 * ADR-0002：文件系统访问**只在主进程**；渲染进程通过 IPC 请求纯文本结果。
 * 所有路径请求都先过 `resolveWithinRoot`，越界直接拒绝。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { decodeTextFile } from '../shared/encoding';
import { checkSize, isProbablyTextFile, sliceLines, type TextMeta } from '../shared/limits';
import { DEFAULT_LIST_POLICY, filterAndSortEntries, isInsideRoot, resolveWithinRoot, validateEntryName, type DirEntryLike } from '../shared/pathGuard';
import type { DirEntry, ListDirResult, ReadFileResult, SliceFileResult, WriteFileResult } from '../shared/contract';

/** 单次返回内容上限（字符数）。超限只返回元信息，要求用户显式确认后分片读取。 */
export const DEFAULT_CHAR_LIMIT = 200_000;

export type SafeFilePath =
  | { ok: true; absolute: string; relative: string; rootRevision: number }
  | { ok: false; error: string };

/** 撤销只清理由本次新增记录的真实目录对象，不能仅凭名称删除重建目录。 */
export interface CreatedDirectory { relative: string; dev: number; ino: number }
/** 创建时取得的文件对象身份，避免撤销删除外部同名重建文件。 */
export interface CreatedFileIdentity { dev: number; ino: number; birthtimeMs: number }
export type CreateFileResult =
  | { ok: true; relPath: string; byteLength: number; createdDirectories: CreatedDirectory[]; createdFileIdentity: CreatedFileIdentity }
  | { ok: false; error: string; createdDirectories?: never; createdFileIdentity?: never };

export class FileService {
  private root: string | null = null;
  private rootRevision = 0;

  constructor(private readonly charLimit: number = DEFAULT_CHAR_LIMIT) {}

  get characterLimit(): number { return this.charLimit; }

  getRoot(): string | null {
    return this.root;
  }

  /** 由主进程在用户通过系统对话框选择目录后调用 */
  setRoot(absoluteRoot: string): string {
    this.root = path.resolve(absoluteRoot);
    this.rootRevision += 1;
    return this.root;
  }

  clearRoot(): void {
    this.root = null;
    this.rootRevision += 1;
  }

  isCurrentRoot(revision: number): boolean {
    return revision === this.rootRevision;
  }

  /** 同时检查词法路径和真实路径；异步调用只能继续使用此次捕获的根目录。 */
  async resolveSafePath(relPath: string, allowMissing = false): Promise<SafeFilePath> {
    const r = this.requireRoot();
    if (!r.ok) return r;
    const rootRevision = this.rootRevision;
    const verdict = resolveWithinRoot(r.root, relPath === '' ? '.' : relPath);
    if (!verdict.ok) return { ok: false, error: verdict.detail };
    try {
      const realRoot = await fs.realpath(r.root);
      const parts = verdict.relative ? verdict.relative.split(path.sep) : [];
      if (allowMissing) {
        for (const part of parts) {
          const invalid = validateEntryName(part);
          if (invalid) return { ok: false, error: invalid };
        }
      }
      let current = r.root;
      for (let index = 0; index < parts.length; index += 1) {
        current = path.join(current, parts[index]!);
        let stat;
        try { stat = await fs.lstat(current); }
        catch (err) {
          if (!allowMissing || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          // 已逐级核对最近存在的祖先；后续路径尚未存在，预览不创建任何条目。
          break;
        }
        const realTarget = await fs.realpath(current); // 悬空链接在此报错，不视作缺失文件。
        if (!isInsideRoot(realRoot, realTarget)) return { ok: false, error: '目标真实路径不在已打开的根目录内' };
        if (index < parts.length - 1 && !(stat.isDirectory() || (stat.isSymbolicLink() && (await fs.stat(current)).isDirectory()))) {
          return { ok: false, error: '路径的父级不是文件夹（ENOTDIR）' };
        }
      }
      if (!this.isCurrentRoot(rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };
      return { ok: true, absolute: verdict.absolute, relative: verdict.relative, rootRevision };
    } catch (err) {
      return { ok: false, error: `无法访问路径：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private requireRoot(): { ok: true; root: string } | { ok: false; error: string } {
    if (!this.root) return { ok: false, error: '尚未打开任何目录' };
    return { ok: true, root: this.root };
  }

  /** 新增路径不得穿过根下链接目录，以保证撤销时能确认新增目录归属。 */
  private async validateCreationParents(target: Extract<SafeFilePath, { ok: true }>): Promise<{ ok: true } | { ok: false; error: string }> {
    const root = this.requireRoot();
    if (!root.ok) return root;
    if (!this.isCurrentRoot(target.rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };
    try {
      let ancestor = root.root;
      for (const part of target.relative.split(path.sep).slice(0, -1)) {
        ancestor = path.join(ancestor, part);
        let stat;
        try { stat = await fs.lstat(ancestor); }
        catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') break; throw err; }
        if (stat.isSymbolicLink()) return { ok: false, error: '不能通过链接目录创建新文件' };
        if (!stat.isDirectory()) return { ok: false, error: '路径的父级不是文件夹（ENOTDIR）' };
      }
      return this.isCurrentRoot(target.rootRevision) ? { ok: true } : { ok: false, error: '目录已切换，请重新操作' };
    } catch (err) { return { ok: false, error: `无法检查新增父路径：${err instanceof Error ? err.message : String(err)}` }; }
  }

  async listDir(relPath: string): Promise<ListDirResult> {
    const r = this.requireRoot();
    if (!r.ok) return { ok: false, entries: [], truncated: false, error: r.error };

    const verdict = await this.resolveSafePath(relPath);
    if (!verdict.ok) return { ok: false, entries: [], truncated: false, error: verdict.error };

    let dirents;
    try {
      dirents = await fs.readdir(verdict.absolute, { withFileTypes: true });
    } catch (err) {
      return { ok: false, entries: [], truncated: false, error: `无法读取目录：${err instanceof Error ? err.message : String(err)}` };
    }

    const like: DirEntryLike[] = dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
    const { shown, truncated } = filterAndSortEntries(like, DEFAULT_LIST_POLICY);

    const entries: DirEntry[] = [];
    for (const e of shown) {
      const childAbs = path.join(verdict.absolute, e.name);
      const childVerdict = await this.resolveSafePath(childAbs);
      if (!childVerdict.ok) continue;
      if (childVerdict.rootRevision !== verdict.rootRevision) return { ok: false, entries: [], truncated: false, error: '目录已切换，请重新操作' };
      entries.push({
        name: e.name,
        relPath: childVerdict.relative.split(path.sep).join('/'),
        isDirectory: e.isDirectory,
        textLike: e.isDirectory ? null : isProbablyTextFile(e.name),
      });
    }

    if (!this.isCurrentRoot(verdict.rootRevision)) return { ok: false, entries: [], truncated: false, error: '目录已切换，请重新操作' };

    return { ok: true, entries, truncated };
  }

  async readFile(relPath: string): Promise<ReadFileResult> {
    const r = this.requireRoot();
    if (!r.ok) return { ok: false, error: r.error };

    const verdict = await this.resolveSafePath(relPath);
    if (!verdict.ok) return { ok: false, error: verdict.error };

    let buf: Buffer;
    try {
      buf = await fs.readFile(verdict.absolute);
    } catch (err) {
      return { ok: false, error: `无法读取文件：${err instanceof Error ? err.message : String(err)}` };
    }

    if (!this.isCurrentRoot(verdict.rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };

    const decoded = decodeTextFile(new Uint8Array(buf));
    if (!decoded.ok) {
      return { ok: false, relPath: verdict.relative, error: decoded.detail };
    }

    const sized = checkSize(decoded.text, decoded.byteLength, this.charLimit);
    if (sized.status === 'too-large') {
      return {
        ok: true,
        relPath: verdict.relative,
        encoding: decoded.encoding,
        fellBack: decoded.fellBack,
        meta: sized.meta,
        tooLarge: true,
        limit: sized.limit,
        text: '',
      };
    }

    return {
      ok: true,
      relPath: verdict.relative,
      text: decoded.text,
      encoding: decoded.encoding,
      fellBack: decoded.fellBack,
      meta: sized.meta,
    };
  }

  /**
   * 读取文件**原文**（不做"超限只返回元信息"的降级）。
   * 用途：回程应用前的 diff 预览与撤销快照 —— 必须拿到完整原文才能正确计算差异；
   * 若超限则返回错误，由调用方提示用户（避免在超大文件上生成不可读的 diff）。
   */
  async readRawText(relPath: string, allowMissing = false): Promise<{ ok: true; text: string; relPath: string; exists: boolean; rootRevision: number } | { ok: false; error: string }> {
    const r = this.requireRoot();
    if (!r.ok) return { ok: false, error: r.error };

    const verdict = await this.resolveSafePath(relPath, allowMissing);
    if (!verdict.ok) return { ok: false, error: verdict.error };

    let buf: Buffer;
    try {
      buf = await fs.readFile(verdict.absolute);
    } catch (err) {
      if (allowMissing && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        const checked = await this.resolveSafePath(relPath, true);
        if (!checked.ok) return checked;
        if (checked.rootRevision !== verdict.rootRevision || !this.isCurrentRoot(verdict.rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };
        const parents = await this.validateCreationParents(checked);
        if (!parents.ok) return parents;
        return { ok: true, text: '', relPath: verdict.relative, exists: false, rootRevision: verdict.rootRevision };
      }
      return { ok: false, error: `无法读取文件：${err instanceof Error ? err.message : String(err)}` };
    }
    if (!this.isCurrentRoot(verdict.rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };
    const decoded = decodeTextFile(new Uint8Array(buf));
    if (!decoded.ok) return { ok: false, error: decoded.detail };
    if (decoded.text.length > this.charLimit) {
      return {
        ok: false,
        error: `文件过大（${decoded.text.length} 字符 > 上限 ${this.charLimit}），暂不支持在预览中应用`,
      };
    }
    return { ok: true, text: decoded.text, relPath: verdict.relative, exists: true, rootRevision: verdict.rootRevision };
  }

  /**
   * 写回文件。
   *
   * 边界说明（ADR-0004）：这是**用户在编辑器里明确编辑后保存**的通道，不是"程序自动落盘"。
   * 因此：只接受字符串内容；路径仍过白名单；大小上限与读取一致。
   * 回程的预览后应用传入预期原文，在打开的文件上再次核对后写入。
   */
  async writeFile(relPath: string, text: string, expectedText?: string): Promise<WriteFileResult> {
    const r = this.requireRoot();
    if (!r.ok) return { ok: false, error: r.error };
    if (typeof text !== 'string') return { ok: false, error: '内容必须是字符串' };

    const verdict = await this.resolveSafePath(relPath, expectedText === undefined);
    if (!verdict.ok) return { ok: false, error: verdict.error };

    if (text.length > this.charLimit) {
      return { ok: false, error: `内容超出上限（${text.length} > ${this.charLimit} 字符）` };
    }

    try {
      if (!this.isCurrentRoot(verdict.rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };
      if (expectedText !== undefined) {
        // r+ 要求文件存在，不能在检查后目标消失时静默重建。
        const handle = await fs.open(verdict.absolute, 'r+');
        try {
          const current = decodeTextFile(await handle.readFile());
          const opened = await handle.stat();
          const named = await fs.stat(verdict.absolute);
          if (!current.ok || current.text !== expectedText || opened.dev !== named.dev || opened.ino !== named.ino ||
              !this.isCurrentRoot(verdict.rootRevision)) return { ok: false, error: '文件已在预览后变化，已拒绝写入' };
          const buffer = Buffer.from(text, 'utf8');
          let written = 0;
          while (written < buffer.length) {
            const result = await handle.write(buffer, written, buffer.length - written, written);
            if (!result.bytesWritten) throw new Error('文件写入未完成');
            written += result.bytesWritten;
          }
          await handle.truncate(buffer.length);
        } finally { await handle.close(); }
      } else await fs.writeFile(verdict.absolute, text, 'utf8');
    } catch (err) {
      return { ok: false, error: `写入失败：${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, relPath: verdict.relative, byteLength: Buffer.byteLength(text, 'utf8') };
  }

  /** AI 整文件新增：只在应用时创建目录，排他创建文件，绝不覆盖已有目标。 */
  async createFile(relPath: string, text: string, expectedRevision?: number): Promise<CreateFileResult> {
    if (typeof text !== 'string') return { ok: false, error: '内容必须是字符串' };
    if (text.length > this.charLimit) return { ok: false, error: `内容超出上限（${text.length} > ${this.charLimit} 字符）` };
    const target = await this.resolveSafePath(relPath, true);
    if (!target.ok) return target;
    if (!target.relative) return { ok: false, error: '不能创建已打开的根目录' };
    if (!this.isCurrentRoot(target.rootRevision) || (expectedRevision !== undefined && expectedRevision !== target.rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };
    const parentsChecked = await this.validateCreationParents(target);
    if (!parentsChecked.ok) return parentsChecked;
    if (!this.isCurrentRoot(target.rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };
    const root = this.root!;
    const createdDirectories: CreatedDirectory[] = [];
    let realRoot: string;
    try { realRoot = await fs.realpath(root); }
    catch (err) { return { ok: false, error: `无法访问根目录：${err instanceof Error ? err.message : String(err)}` }; }
    let handle: fs.FileHandle | null = null;
    let createdFile: CreatedFileIdentity | null = null;
    try {
      const parents = target.relative.split(path.sep).slice(0, -1);
      for (let index = 0; index < parents.length; index += 1) {
        const relative = parents.slice(0, index + 1).join(path.sep);
        const directory = await this.resolveSafePath(relative, true);
        if (!directory.ok) throw new Error(directory.error);
        if (directory.rootRevision !== target.rootRevision || !this.isCurrentRoot(target.rootRevision)) throw new Error('目录已切换，请重新操作');
        try {
          await fs.mkdir(directory.absolute);
          const created = await fs.lstat(directory.absolute);
          if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('新增目录已被其他操作替换');
          createdDirectories.push({ relative: relative.split(path.sep).join('/'), dev: created.dev, ino: created.ino });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
        const checked = await this.resolveSafePath(relative);
        if (!checked.ok) throw new Error(checked.error);
        const stat = await fs.lstat(checked.absolute);
        if (stat.isSymbolicLink()) throw new Error('不能通过链接目录创建新文件');
        if (checked.rootRevision !== target.rootRevision || !stat.isDirectory()) throw new Error('目录已切换或父级不是文件夹');
      }
      const checked = await this.resolveSafePath(target.relative, true);
      if (!checked.ok) throw new Error(checked.error);
      const parentsVerdict = await this.validateCreationParents(checked);
      if (!parentsVerdict.ok) throw new Error(parentsVerdict.error);
      if (checked.rootRevision !== target.rootRevision || !this.isCurrentRoot(target.rootRevision)) throw new Error('目录已切换，请重新操作');
      handle = await fs.open(target.absolute, 'wx');
      createdFile = await handle.stat();
      if (!this.isCurrentRoot(target.rootRevision)) throw new Error('目录已切换，请重新操作');
      await handle.writeFile(text, 'utf8');
      if (!this.isCurrentRoot(target.rootRevision)) throw new Error('目录已切换，请重新操作');
      await handle.close(); handle = null;
      return { ok: true, relPath: target.relative, byteLength: Buffer.byteLength(text, 'utf8'), createdDirectories, createdFileIdentity: { dev: createdFile.dev, ino: createdFile.ino, birthtimeMs: createdFile.birthtimeMs } };
    } catch (err) {
      const warnings: string[] = [];
      if (handle) { try { await handle.close(); } catch (closeErr) { warnings.push(String(closeErr)); } }
      if (createdFile) {
        try {
          const stat = await fs.lstat(target.absolute);
          if (!stat.isSymbolicLink() && stat.dev === createdFile.dev && stat.ino === createdFile.ino && isInsideRoot(realRoot, await fs.realpath(target.absolute))) await fs.unlink(target.absolute);
        } catch (cleanupErr) { if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(String(cleanupErr)); }
      }
      warnings.push(...await this.cleanCreatedDirectories(root, realRoot, createdDirectories));
      return { ok: false, error: `创建失败：${err instanceof Error ? err.message : String(err)}${warnings.length ? `；清理失败：${warnings.join('；')}` : ''}` };
    }
  }

  /** 撤销新增只删除内容仍等于应用结果的文件及本次创建的空目录。 */
  async removeCreatedFile(relPath: string, expectedText: string, createdDirectories: CreatedDirectory[], expectedIdentity: CreatedFileIdentity): Promise<{ ok: boolean; error?: string }> {
    const target = await this.resolveSafePath(relPath);
    if (!target.ok) return target;
    if (!target.relative) return { ok: false, error: '不能删除已打开的根目录' };
    if (!this.isCurrentRoot(target.rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };
    const root = this.root!;
    try {
      const directories: CreatedDirectory[] = [];
      for (const directory of createdDirectories) {
        const verdict = resolveWithinRoot(root, directory.relative);
        if (!verdict.ok || !verdict.relative || !isInsideRoot(verdict.absolute, path.dirname(target.absolute))) return { ok: false, error: '新增目录记录与目标文件不匹配' };
        if (!Number.isFinite(directory.dev) || !Number.isFinite(directory.ino)) return { ok: false, error: '新增目录记录缺少真实身份' };
        const relative = verdict.relative.split(path.sep).join('/');
        directories.push({ relative, dev: directory.dev, ino: directory.ino });
      }
      const stat = await fs.lstat(target.absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, error: '目标已变为链接或其他类型，不能撤销新增' };
      if (!expectedIdentity || stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino || stat.birthtimeMs !== expectedIdentity.birthtimeMs) return { ok: false, error: '目标已被同名文件替换，不能撤销其他操作创建的文件' };
      let ancestor = root;
      for (const part of target.relative.split(path.sep).slice(0, -1)) {
        ancestor = path.join(ancestor, part);
        if ((await fs.lstat(ancestor)).isSymbolicLink()) return { ok: false, error: '目标父目录已变为链接，不能撤销新增' };
      }
      const current = await this.readRawText(target.relative);
      if (!current.ok) return current;
      if (current.text !== expectedText) return { ok: false, error: '新增文件已被修改，不能直接删除' };
      const checked = await this.resolveSafePath(target.relative);
      if (!checked.ok) return checked;
      const latest = await fs.lstat(checked.absolute);
      const realRoot = await fs.realpath(root);
      if (latest.isSymbolicLink() || latest.dev !== stat.dev || latest.ino !== stat.ino || latest.size !== stat.size || latest.mtimeMs !== stat.mtimeMs || latest.ctimeMs !== stat.ctimeMs) return { ok: false, error: '目标文件已改变，不能撤销新增' };
      if (checked.rootRevision !== target.rootRevision || current.rootRevision !== target.rootRevision || !this.isCurrentRoot(target.rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };
      await fs.unlink(target.absolute);
      const warnings = await this.cleanCreatedDirectories(root, realRoot, directories.sort((a, b) => a.relative.split('/').length - b.relative.split('/').length));
      // 文件已成功撤销，清理目录的错误单独提示，不能让调用方重复撤销文件。
      return warnings.length ? { ok: true, error: `文件已删除，但部分新增空目录未能清理：${warnings.join('；')}` } : { ok: true };
    } catch (err) { return { ok: false, error: `撤销新增失败：${err instanceof Error ? err.message : String(err)}` }; }
  }

  private async cleanCreatedDirectories(root: string, realRoot: string, directories: readonly CreatedDirectory[]): Promise<string[]> {
    const warnings: string[] = [];
    for (const directory of [...directories].reverse()) {
      const relative = directory.relative;
      const absolute = path.join(root, relative);
      try {
        let ancestor = root;
        let linkedAncestor = false;
        for (const part of relative.split('/').slice(0, -1)) {
          ancestor = path.join(ancestor, part);
          if ((await fs.lstat(ancestor)).isSymbolicLink()) { linkedAncestor = true; break; }
        }
        if (linkedAncestor) { warnings.push(`${relative} 父级已变为链接，保留目录`); continue; }
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== directory.dev || stat.ino !== directory.ino || !isInsideRoot(realRoot, await fs.realpath(absolute))) { warnings.push(`${relative} 已改变，保留目录`); continue; }
        await fs.rmdir(absolute);
      } catch (err) {
        if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((err as NodeJS.ErrnoException).code ?? '')) warnings.push(`${relative}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return warnings;
  }

  /** 分片读取：仅接受行号，路径仍需过白名单 */
  async sliceFile(relPath: string, startLine: number, endLine: number): Promise<SliceFileResult> {
    const r = this.requireRoot();
    if (!r.ok) return { ok: false, error: r.error };

    const verdict = await this.resolveSafePath(relPath);
    if (!verdict.ok) return { ok: false, error: verdict.error };

    let buf: Buffer;
    try {
      buf = await fs.readFile(verdict.absolute);
    } catch (err) {
      return { ok: false, error: `无法读取文件：${err instanceof Error ? err.message : String(err)}` };
    }
    if (!this.isCurrentRoot(verdict.rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };
    const decoded = decodeTextFile(new Uint8Array(buf));
    if (!decoded.ok) return { ok: false, error: decoded.detail };

    const s = sliceLines(decoded.text, startLine, endLine);
    return { ok: true, text: s.text, startLine: s.startLine, endLine: s.endLine, totalLines: s.totalLines };
  }
}

export type { TextMeta };
