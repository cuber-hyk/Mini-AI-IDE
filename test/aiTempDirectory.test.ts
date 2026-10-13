import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AiTempDirectory } from '../src/main/tools/aiTempDirectory';

async function project(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-temp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('目录按需创建，同任务复用，原 cwd 和无关项目文件不变', async t => {
  const root = await project(t); const owner = new AiTempDirectory();
  const cwd = process.cwd();
  const unrelated = path.join(root, 'user.txt'); await fs.writeFile(unrelated, 'retain');
  assert.equal(await fs.stat(root).then(() => true), true);
  const first = await owner.ensure(root, 'json-debug-20261012');
  assert.equal(first.reused, false); assert.equal(first.task_id, 'json-debug-20261012');
  assert.equal(first.relative_path, '.mini-ai-ide/ai-temp/json-debug-20261012');
  assert.equal(first.path, await fs.realpath(first.path));
  assert.match(await fs.readFile(path.join(root, '.mini-ai-ide', 'ai-temp', '.gitignore'), 'utf8'), /\*\n!\.gitignore/);
  const script = path.join(first.path, 'scratch.ps1'); await fs.writeFile(script, 'Write-Output hello');
  const next = await owner.ensure(root, 'json-debug-20261012');
  assert.equal(next.reused, true); assert.equal(next.path, first.path);
  assert.equal(await fs.readFile(script, 'utf8'), 'Write-Output hello');
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'retain');
  assert.equal(process.cwd(), cwd);
});

test('任务标识及不同项目隔离，不能认领已有未知目录', async t => {
  const one = await project(t); const two = await project(t); const owner = new AiTempDirectory();
  await assert.rejects(owner.ensure(one, '../outside'), /task_id/);
  await assert.rejects(owner.ensure(one, 'ABC'), /task_id/);
  const a = await owner.ensure(one, 'task-001'); const b = await owner.ensure(two, 'task-001');
  assert.notEqual(a.path, b.path);
  await fs.mkdir(path.join(one, '.mini-ai-ide', 'ai-temp', 'unclaimed'));
  await assert.rejects(owner.ensure(one, 'unclaimed'), /归属标记/);
  assert.equal((await fs.stat(path.join(one, '.mini-ai-ide', 'ai-temp', 'unclaimed'))).isDirectory(), true);
});

test('归属标记冲突及目录创建失败时拒绝覆盖、删除或迁移', async t => {
  const root = await project(t); const owner = new AiTempDirectory();
  const first = await owner.ensure(root, 'task-001');
  await fs.writeFile(path.join(first.path, 'important.txt'), 'user data');
  await fs.writeFile(path.join(first.path, '.owner.json'), 'not ours');
  await assert.rejects(owner.ensure(root, 'task-001'), /标记内容冲突/);
  assert.equal(await fs.readFile(path.join(first.path, 'important.txt'), 'utf8'), 'user data');
  const another = await project(t); await fs.writeFile(path.join(another, '.mini-ai-ide'), 'blocked');
  await assert.rejects(owner.ensure(another, 'task-002'), /创建或复用失败/);
  assert.equal(await fs.readFile(path.join(another, '.mini-ai-ide'), 'utf8'), 'blocked');
});

test('拒绝 Windows junction 或符号链接，即使链接对象的归属名看似合法', async t => {
  const root = await project(t); const external = await project(t);
  const link = path.join(root, '.mini-ai-ide');
  try { await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('当前环境没有建立目录链接的权限'); return; }
    throw error;
  }
  await assert.rejects(new AiTempDirectory().ensure(root, 'task-001'), /链接|目录联接/);
  await assert.rejects(fs.access(path.join(external, 'ai-temp')));
});
