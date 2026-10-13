import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isInsideRoot } from '../shared/pathGuard';
import { webPlatformOf } from '../shared/webConversation';
import { sessionKeyOf } from './consumptionStore';

const OWNER = '{"kind":"mini-ai-ide-composer-drafts","version":1}\n';
const IGNORE = '# Web composer drafts are retained until the user removes them.\n*\n!.gitignore\n';
const samePath = (left: string, right: string) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

/** Saves the authorized plain-text draft before its composer can be overwritten. */
export class ComposerDraftBackup {
  private pending: Promise<unknown> = Promise.resolve();

  save(root: string, session: string, text: string): Promise<string> {
    const result = this.pending.then(() => this.saveDraft(root, session, text));
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async directory(root: string, target: string): Promise<boolean> {
    if (!isInsideRoot(root, target)) throw new Error('网页草稿备份路径必须位于当前项目内');
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try { stat = await fs.lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('网页草稿备份路径不是普通目录或包含链接、目录联接');
    const real = await fs.realpath(target);
    if (!isInsideRoot(root, real) || !samePath(target, real)) throw new Error('网页草稿备份路径越界或包含路径别名');
    return true;
  }

  private async ensureDirectory(root: string, target: string): Promise<boolean> {
    if (await this.directory(root, target)) return false;
    let created = false;
    try { await fs.mkdir(target); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!await this.directory(root, target)) throw new Error('网页草稿备份目录创建失败');
    return created;
  }

  private async marker(root: string, directory: string, name: string, expected: string, mayCreate: boolean): Promise<void> {
    if (!await this.directory(root, directory)) throw new Error('网页草稿备份目录已失效');
    const target = path.join(directory, name);
    let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try { stat = await fs.lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!stat) {
      if (!mayCreate) throw new Error('已有网页草稿备份目录缺少归属标记，拒绝认领');
      try {
        const file = await fs.open(target, 'wx', 0o600);
        try { await file.writeFile(expected, 'utf8'); await file.sync(); }
        finally { await file.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      stat = await fs.lstat(target);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) throw new Error('网页草稿备份标记文件存在冲突');
    const real = await fs.realpath(target);
    if (!samePath(target, real) || !isInsideRoot(root, real)) throw new Error('网页草稿备份标记文件真实路径无效');
    if (await fs.readFile(target, 'utf8') !== expected) throw new Error('网页草稿备份标记内容冲突，拒绝覆盖');
  }

  private async saveDraft(root: string, session: string, text: string): Promise<string> {
    if (typeof root !== 'string' || !root.trim()) throw new Error('尚未打开项目，不能备份网页草稿');
    if (typeof session !== 'string' || webPlatformOf(session) !== 'chatgpt' || webPlatformOf(sessionKeyOf(session)) !== 'chatgpt') throw new Error('仅支持当前普通 ChatGPT 会话的网页草稿备份');
    if (typeof text !== 'string' || text.length === 0) throw new Error('网页草稿必须是非空纯文本');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > 1024 * 1024 || bytes.toString('utf8') !== text) throw new Error('网页草稿超过 1MiB 或无法无损保存为 UTF-8');
    const projectRoot = await fs.realpath(root);
    if (!await this.directory(projectRoot, projectRoot)) throw new Error('当前项目根目录不可用');
    const appDirectory = path.join(projectRoot, '.mini-ai-ide');
    const draftDirectory = path.join(appDirectory, 'composer-drafts');
    await this.ensureDirectory(projectRoot, appDirectory);
    const created = await this.ensureDirectory(projectRoot, draftDirectory);
    await this.marker(projectRoot, draftDirectory, '.owner.json', OWNER, created);
    await this.marker(projectRoot, draftDirectory, '.gitignore', IGNORE, true);
    const verifyDirectory = async () => {
      for (const directory of [projectRoot, appDirectory, draftDirectory]) {
        if (!await this.directory(projectRoot, directory)) throw new Error('网页草稿备份路径在保存期间变化');
      }
      await this.marker(projectRoot, draftDirectory, '.owner.json', OWNER, false);
      await this.marker(projectRoot, draftDirectory, '.gitignore', IGNORE, false);
    };
    await verifyDirectory();
    const sessionHash = createHash('sha256').update(sessionKeyOf(session)).digest('hex').slice(0, 16);
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sessionHash}-${randomUUID()}.txt`;
    const target = path.join(draftDirectory, name);
    const file = await fs.open(target, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await verifyDirectory();
    const stat = await fs.lstat(target);
    const actual = await fs.realpath(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length || !samePath(actual, target) || !isInsideRoot(projectRoot, actual)) throw new Error('网页草稿备份文件路径或大小在保存期间变化');
    if (!(await fs.readFile(actual)).equals(bytes)) throw new Error('网页草稿备份字节核验失败');
    await verifyDirectory();
    if (!samePath(await fs.realpath(target), actual)) throw new Error('网页草稿备份最终路径已变化');
    return actual;
  }
}
