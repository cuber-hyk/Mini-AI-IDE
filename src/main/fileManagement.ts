/** 根目录内条目的创建、改名及删除操作；不拥有目录切换或 UI。 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileService } from './fileService';
import type { FileOperationResult } from '../shared/contract';
import { validateEntryName } from '../shared/pathGuard';
export { validateEntryName } from '../shared/pathGuard';

export class FileManagementService {
  constructor(private readonly files: FileService, private readonly trashItem: (absolute: string) => Promise<void>) {}

  /** 返回已验证目标；拒绝根下链接及链接祖先，根目录自身允许是用户选择的链接。 */
  async inspect(relPath: string) {
    const source = await this.files.resolveSafePath(relPath);
    if (!source.ok) return source;
    try {
      let current = this.files.getRoot()!;
      for (const part of source.relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if ((await fs.lstat(current)).isSymbolicLink()) return { ok: false as const, error: '请在系统资源管理器中管理链接' };
      }
      const stat = await fs.lstat(source.absolute);
      if (!this.files.isCurrentRoot(source.rootRevision)) return { ok: false as const, error: '目录已切换，请重新操作' };
      return { ...source, isDirectory: stat.isDirectory(), identity: { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs } };
    } catch (error) { return { ok: false as const, error: `无法访问目标：${error instanceof Error ? error.message : String(error)}` }; }
  }

  async delete(relPath: string, expected?: { dev: number; ino: number; birthtimeMs: number }): Promise<FileOperationResult> {
    try {
      const source = await this.inspect(relPath);
      if (!source.ok) return source;
      if (!source.relative) return { ok: false, error: '不能永久删除已打开的根目录' };
      if (expected && (source.identity.dev !== expected.dev || source.identity.ino !== expected.ino || source.identity.birthtimeMs !== expected.birthtimeMs)) return { ok: false, error: '目标在确认期间已被替换，请重新操作' };
      if (!this.files.isCurrentRoot(source.rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };
      await fs.rm(source.absolute, { recursive: source.isDirectory, force: false });
      return { ok: true, oldRelPath: source.relative.split(path.sep).join('/'), isDirectory: source.isDirectory };
    } catch (error) { return this.failure(error); }
  }

  async create(parent: string, name: string, isDirectory: boolean): Promise<FileOperationResult> {
    const invalid = validateEntryName(name);
    if (invalid) return { ok: false, error: invalid };
    try {
      const dir = await this.files.resolveSafePath(parent);
      if (!dir.ok) return dir;
      if (!(await fs.stat(dir.absolute)).isDirectory()) return { ok: false, error: '创建位置不是文件夹' };
      const target = await this.files.resolveSafePath(path.join(dir.relative, name), true);
      if (!target.ok) return target;
      if (!this.files.isCurrentRoot(dir.rootRevision)) return { ok: false, error: '目录已切换' };
      if (isDirectory) await fs.mkdir(target.absolute);
      else await fs.writeFile(target.absolute, '', { encoding: 'utf8', flag: 'wx' });
      return { ok: true, relPath: target.relative.split(path.sep).join('/'), isDirectory };
    } catch (error) { return this.failure(error); }
  }

  async rename(relPath: string, name: string): Promise<FileOperationResult> {
    const invalid = validateEntryName(name);
    if (invalid) return { ok: false, error: invalid };
    try {
      const source = await this.files.resolveSafePath(relPath);
      if (!source.ok) return source;
      if (!source.relative) return { ok: false, error: '不能重命名已打开的根目录' };
      const stat = await fs.lstat(source.absolute);
      if (stat.isSymbolicLink()) return { ok: false, error: '请在系统资源管理器中管理链接' };
      const target = await this.files.resolveSafePath(path.join(path.dirname(source.relative), name), true);
      if (!target.ok) return target;
      if (target.absolute === source.absolute) return { ok: true, oldRelPath: source.relative.split(path.sep).join('/'), relPath: target.relative.split(path.sep).join('/'), isDirectory: stat.isDirectory() };
      const caseOnly = process.platform === 'win32' && source.absolute.toLowerCase() === target.absolute.toLowerCase();
      if (!caseOnly) {
        try { await fs.lstat(target.absolute); return { ok: false, error: '目标名称已存在，不能覆盖' }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!this.files.isCurrentRoot(source.rootRevision)) return { ok: false, error: '目录已切换' };
      // 文件用排他 hard link 创建目标，避免 rename 的覆盖语义；case-only 经唯一中间名。
      if (caseOnly) {
        const temporary = path.join(path.dirname(source.absolute), `.mini-ai-rename-${randomUUID()}`);
        await fs.rename(source.absolute, temporary);
        try { await fs.rename(temporary, target.absolute); }
        catch (error) { await fs.rename(temporary, source.absolute); throw error; }
      } else if (!stat.isDirectory()) {
        await fs.link(source.absolute, target.absolute);
        try { await fs.unlink(source.absolute); }
        catch (error) { await fs.unlink(target.absolute); throw error; }
      } else await fs.rename(source.absolute, target.absolute);
      return { ok: true, oldRelPath: source.relative.split(path.sep).join('/'), relPath: target.relative.split(path.sep).join('/'), isDirectory: stat.isDirectory() };
    } catch (error) { return this.failure(error); }
  }

  async trash(relPath: string): Promise<FileOperationResult> {
    try {
      const source = await this.files.resolveSafePath(relPath);
      if (!source.ok) return source;
      if (!source.relative) return { ok: false, error: '不能删除已打开的根目录' };
      const stat = await fs.lstat(source.absolute);
      if (stat.isSymbolicLink()) return { ok: false, error: '请在系统资源管理器中管理链接' };
      if (!this.files.isCurrentRoot(source.rootRevision)) return { ok: false, error: '目录已切换' };
      await this.trashItem(source.absolute);
      return { ok: true, oldRelPath: source.relative.split(path.sep).join('/'), isDirectory: stat.isDirectory() };
    } catch (error) { return this.failure(error); }
  }

  private failure(error: unknown): FileOperationResult {
    return { ok: false, error: `操作失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
