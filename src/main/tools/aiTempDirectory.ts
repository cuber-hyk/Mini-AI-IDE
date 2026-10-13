import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isInsideRoot } from '../../shared/pathGuard';

const ROOT_OWNER = '{"kind":"mini-ai-ide-ai-temp-root","version":1}\n';
const IGNORE = '# AI task scratch files remain in this project and are not automatically deleted.\n*\n!.gitignore\n';
const taskOwner = (taskId: string) => JSON.stringify({ kind: 'mini-ai-ide-ai-temp-task', version: 1, task_id: taskId }) + '\n';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const samePath = (left: string, right: string) => {
  const a = path.resolve(left); const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

/** A dedicated, project-owned scratch directory. It never deletes or adopts unknown files. */
export class AiTempDirectory {
  private async directoryExists(projectRoot: string, target: string): Promise<boolean> {
    if (!isInsideRoot(projectRoot, target)) throw new Error('AI 临时目录必须位于当前项目内');
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try { stat = await fs.lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`AI 临时路径不是普通目录或包含链接、目录联接：${target}`);
    const real = await fs.realpath(target);
    if (!isInsideRoot(projectRoot, real) || !samePath(real, target)) throw new Error(`AI 临时目录真实路径越界或包含路径别名：${target}`);
    return true;
  }

  private async ensureDirectory(projectRoot: string, target: string): Promise<boolean> {
    const existed = await this.directoryExists(projectRoot, target);
    if (!existed) {
      try { await fs.mkdir(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (!await this.directoryExists(projectRoot, target)) throw new Error(`无法确认已创建的 AI 临时目录：${target}`);
    return existed;
  }

  private async ownedFile(projectRoot: string, directory: string, name: string, expected: string, mayCreate: boolean): Promise<void> {
    if (!await this.directoryExists(projectRoot, directory)) throw new Error('AI 临时目录已失效');
    const target = path.join(directory, name);
    let stat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try { stat = await fs.lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!stat) {
      if (!mayCreate) throw new Error(`已有临时目录缺少归属标记，拒绝认领：${directory}`);
      try { await fs.writeFile(target, expected, { flag: 'wx', encoding: 'utf8', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      stat = await fs.lstat(target);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error(`AI 临时目录标记文件存在冲突：${target}`);
    const real = await fs.realpath(target);
    if (!isInsideRoot(projectRoot, real) || !samePath(real, target)) throw new Error(`AI 临时目录标记文件真实路径无效：${target}`);
    if (await fs.readFile(target, 'utf8') !== expected) throw new Error(`AI 临时目录标记内容冲突，拒绝覆盖：${target}`);
  }

  async ensure(root: string, taskId: string): Promise<{ task_id: string; path: string; relative_path: string; reused: boolean }> {
    if (typeof taskId !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(taskId)) throw new Error('task_id 必须是 3–64 位、以小写字母开头的英小写字母、数字或连字符');
    if (!root) throw new Error('尚未打开项目，不能申请 AI 临时目录');
    const projectRoot = await fs.realpath(root);
    if (!await this.directoryExists(projectRoot, projectRoot)) throw new Error('当前项目根目录不可用');
    const appDirectory = path.join(projectRoot, '.mini-ai-ide');
    const tempRoot = path.join(appDirectory, 'ai-temp');
    const taskDirectory = path.join(tempRoot, taskId);
    try {
      await this.ensureDirectory(projectRoot, appDirectory);
      const rootExisted = await this.ensureDirectory(projectRoot, tempRoot);
      await this.ownedFile(projectRoot, tempRoot, '.owner.json', ROOT_OWNER, !rootExisted);
      await this.ownedFile(projectRoot, tempRoot, '.gitignore', IGNORE, true);
      const reused = await this.ensureDirectory(projectRoot, taskDirectory);
      await this.ownedFile(projectRoot, taskDirectory, '.owner.json', taskOwner(taskId), !reused);
      // Verify the entire ancestry again, including existing Windows junctions and links.
      for (const directory of [projectRoot, appDirectory, tempRoot, taskDirectory]) {
        if (!await this.directoryExists(projectRoot, directory)) throw new Error(`AI 临时路径在创建期间变化：${directory}`);
      }
      await this.ownedFile(projectRoot, tempRoot, '.owner.json', ROOT_OWNER, false);
      await this.ownedFile(projectRoot, tempRoot, '.gitignore', IGNORE, false);
      await this.ownedFile(projectRoot, taskDirectory, '.owner.json', taskOwner(taskId), false);
      const actual = await fs.realpath(taskDirectory);
      if (!samePath(actual, taskDirectory) || !isInsideRoot(projectRoot, actual)) throw new Error('AI 临时目录最终真实路径不在当前项目内');
      return { task_id: taskId, path: actual, relative_path: path.relative(projectRoot, actual).replace(/\\/g, '/'), reused };
    } catch (error) {
      throw new Error(`AI 临时目录创建或复用失败，未迁移、覆盖或清理已有文件：${errorText(error)}`);
    }
  }
}
