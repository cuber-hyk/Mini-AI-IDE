import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ComposerDraftBackup } from '../src/main/composerDraftBackup';

const SESSION = 'https://chatgpt.com/c/private-session-001';
const directoryOf = (root: string) => path.join(root, '.mini-ai-ide', 'composer-drafts');
async function project(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mini-composer-draft-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('草稿先安全留底：UTF-8逐字保存空白和换行，多份文件不覆盖且不保存会话ID', async t => {
  const root = await project(t); const backup = new ComposerDraftBackup();
  const text = '  中文草稿\t\r\n\n末行  \n';
  await fs.writeFile(path.join(root, '.gitignore'), 'user-rule\n');
  const [first, second] = await Promise.all([backup.save(root, SESSION, text), backup.save(root, SESSION, ' next ')]);
  assert.notEqual(first, second);
  assert.equal(first, await fs.realpath(first));
  assert.equal(path.dirname(first), directoryOf(root));
  assert.deepEqual(await fs.readFile(first), Buffer.from(text, 'utf8'));
  assert.equal(await fs.readFile(second, 'utf8'), ' next ');
  assert.match(path.basename(first), /^\d{4}-\d{2}-\d{2}T.*Z-[a-f0-9]{16}-[a-f0-9-]{36}\.txt$/);
  assert.equal(path.basename(first).includes('private-session-001'), false);
  assert.equal(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), 'user-rule\n');
  assert.match(await fs.readFile(path.join(directoryOf(root), '.gitignore'), 'utf8'), /\*\n!\.gitignore/);
  const again = await new ComposerDraftBackup().save(root, SESSION, 'third');
  assert.equal(path.dirname(again), directoryOf(root));
  assert.equal(await fs.readFile(first, 'utf8'), text);
});

test('不同项目独立留底，拒绝无项目、不支持会话、空文本、超限和有损UTF-8且不创建目录', async t => {
  const one = await project(t); const two = await project(t); const backup = new ComposerDraftBackup();
  await assert.rejects(backup.save('', SESSION, 'draft'), /尚未打开项目/);
  await assert.rejects(backup.save(one, 'https://chat.deepseek.com/', 'draft'), /普通 ChatGPT/);
  await assert.rejects(backup.save(one, 'https://chatgpt.com/g/special', 'draft'), /普通 ChatGPT/);
  await assert.rejects(backup.save(one, 'https://user:pass@chatgpt.com/c/id', 'draft'), /普通 ChatGPT/);
  await assert.rejects(backup.save(one, SESSION, ''), /非空纯文本/);
  await assert.rejects(backup.save(one, SESSION, '中'.repeat(350000)), /1MiB/);
  await assert.rejects(backup.save(one, SESSION, '\ud800'), /无损/);
  await assert.rejects(fs.access(path.join(one, '.mini-ai-ide')));
  const a = await backup.save(one, SESSION, 'a'); const b = await backup.save(two, SESSION, 'b');
  assert.notEqual(path.dirname(a), path.dirname(b));
  assert.equal(await fs.readFile(a, 'utf8'), 'a'); assert.equal(await fs.readFile(b, 'utf8'), 'b');
});

test('拒绝认领未知目录、归属标记和忽略文件冲突，保留全部原文件', async t => {
  const root = await project(t); const dir = directoryOf(root); const backup = new ComposerDraftBackup();
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'keep.txt'), 'user data');
  await assert.rejects(backup.save(root, SESSION, 'new'), /缺少归属标记/);
  await fs.writeFile(path.join(dir, '.owner.json'), 'not ours');
  await assert.rejects(backup.save(root, SESSION, 'new'), /标记内容冲突/);
  assert.equal(await fs.readFile(path.join(dir, 'keep.txt'), 'utf8'), 'user data');
  assert.equal(await fs.readFile(path.join(dir, '.owner.json'), 'utf8'), 'not ours');
  const another = await project(t); const first = await backup.save(another, SESSION, 'original');
  await fs.writeFile(path.join(directoryOf(another), '.gitignore'), 'user override');
  await assert.rejects(backup.save(another, SESSION, 'new'), /标记内容冲突/);
  assert.equal(await fs.readFile(first, 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(directoryOf(another), '.gitignore'), 'utf8'), 'user override');
});

test('根目录不是目录或隐藏父路径是文件时拒绝，不覆盖冲突文件', async t => {
  const root = await project(t); const backup = new ComposerDraftBackup();
  const file = path.join(root, 'file'); await fs.writeFile(file, 'retain');
  await assert.rejects(backup.save(file, SESSION, 'draft'), /普通目录/);
  await fs.writeFile(path.join(root, '.mini-ai-ide'), 'retain app file');
  await assert.rejects(backup.save(root, SESSION, 'draft'), /普通目录/);
  assert.equal(await fs.readFile(path.join(root, '.mini-ai-ide'), 'utf8'), 'retain app file');
});

test('拒绝隐藏父目录或专用目录的junction/链接，不向链接目标写入', async t => {
  const backup = new ComposerDraftBackup();
  for (const level of ['parent', 'draft']) {
    const root = await project(t); const external = await project(t);
    if (level === 'draft') await fs.mkdir(path.join(root, '.mini-ai-ide'));
    const link = level === 'parent' ? path.join(root, '.mini-ai-ide') : directoryOf(root);
    await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(backup.save(root, SESSION, 'draft'), /链接|目录联接/);
    assert.deepEqual(await fs.readdir(external), []);
  }
});

test('已有标记目录或硬链接均拒绝，不修改外部标记', async t => {
  const backup = new ComposerDraftBackup();
  const root = await project(t); await backup.save(root, SESSION, 'first');
  const owner = path.join(directoryOf(root), '.owner.json'); const bytes = await fs.readFile(owner);
  await fs.unlink(owner); await fs.mkdir(owner);
  await assert.rejects(backup.save(root, SESSION, 'second'), /标记文件存在冲突/);
  await fs.rmdir(owner);
  const outside = path.join(root, 'external-marker'); await fs.writeFile(outside, bytes);
  await fs.link(outside, owner);
  await assert.rejects(backup.save(root, SESSION, 'second'), /标记文件存在冲突/);
  assert.deepEqual(await fs.readFile(outside), bytes);
});
