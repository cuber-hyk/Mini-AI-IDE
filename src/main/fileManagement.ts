/** 根目录内条目的创建、改名及回收站操作；不拥有目录切换或 UI。 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileService } from './fileService';
import type { FileOperationResult } from '../shared/contract';
import { validateEntryName } from '../shared/pathGuard';
export { validateEntryName } from '../shared/pathGuard';

export class FileManagementService {
  constructor(private readonly files: FileService, private readonly trashItem: (absolute: string) => Promise<void>) {}

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
