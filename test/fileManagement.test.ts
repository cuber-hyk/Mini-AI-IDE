import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';
import { FileService } from '../src/main/fileService';
import { FileManagementService, validateEntryName } from '../src/main/fileManagement';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-file-management-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new FileService(); files.setRoot(root);
  return { root, files, manager: new FileManagementService(files, async () => { throw new Error('回收站不可用'); }) };
}
it('新建与重命名改变真实文件；已有目标内容不能被覆盖', async (t) => {
  const f = await fixture(t); assert.equal((await f.manager.create('', 'sub', true)).ok, true);
  assert.equal((await f.manager.create('sub', 'a.txt', false)).ok, true);
  await fs.writeFile(path.join(f.root, 'sub/a.txt'), 'important');
  assert.equal((await f.manager.create('sub', 'a.txt', false)).ok, false);
  assert.equal(await fs.readFile(path.join(f.root, 'sub/a.txt'), 'utf8'), 'important');
  assert.equal((await f.manager.rename('sub/a.txt', 'b.txt')).ok, true);
  await fs.writeFile(path.join(f.root, 'sub/a.txt'), 'other');
  assert.equal((await f.manager.rename('sub/b.txt', 'a.txt')).ok, false);
  assert.equal(await fs.readFile(path.join(f.root, 'sub/a.txt'), 'utf8'), 'other');
  assert.equal(await fs.readFile(path.join(f.root, 'sub/b.txt'), 'utf8'), 'important');
});
it('文件夹改名后内容保留；仅大小写改名也能更新实际名称', async (t) => {
  const f = await fixture(t); await f.manager.create('', 'Folder', true); await f.manager.create('Folder', 'a.txt', false);
  assert.equal((await f.manager.rename('Folder', 'Renamed')).ok, true);
  assert.equal((await f.manager.rename('Renamed/a.txt', 'A.txt')).ok, true);
  assert.equal((await fs.readdir(path.join(f.root, 'Renamed'))).includes('A.txt'), true);
});
it('拒绝非法 Windows 名称、根目录操作和越界路径', async (t) => {
  const f = await fixture(t);
  for (const name of ['', '..', 'a/b', 'a\\b', 'CON.txt', 'LPT1', 'trailing.', 'space ', 'a:b', ' a']) assert.ok(validateEntryName(name), name);
  assert.equal(validateEntryName('中文笔记.md'), null);
  assert.equal((await f.manager.rename('.', 'new')).ok, false); assert.equal((await f.manager.trash('.')).ok, false);
  assert.equal((await f.manager.create('..', 'outside.txt', false)).ok, false);
});
it('回收站失败时文件仍存在，成功时只调用注入回收站接口', async (t) => {
  const f = await fixture(t); await f.manager.create('', 'keep.txt', false);
  assert.equal((await f.manager.trash('keep.txt')).ok, false); assert.equal((await fs.stat(path.join(f.root, 'keep.txt'))).isFile(), true);
  const called: string[] = []; const manager = new FileManagementService(f.files, async (absolute) => { called.push(absolute); });
  assert.equal((await manager.trash('keep.txt')).ok, true); assert.deepEqual(called, [path.join(f.root, 'keep.txt')]);
});
it('外部 junction 不允许读取、保存、新建、改名或删除；目录根本身链接可正常使用', async (t) => {
  const f = await fixture(t); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-external-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'a.txt'), 'outside');
  await fs.symlink(outside, path.join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.files.readFile('link/a.txt')).ok, false); assert.equal((await f.files.writeFile('link/a.txt', 'bad')).ok, false);
  assert.equal((await f.manager.create('link', 'new.txt', false)).ok, false); assert.equal((await f.manager.rename('link/a.txt', 'b.txt')).ok, false);
  assert.equal((await f.manager.trash('link')).ok, false); assert.equal(await fs.readFile(path.join(outside, 'a.txt'), 'utf8'), 'outside');
  f.files.setRoot(path.join(f.root, 'link')); assert.equal((await f.files.readFile('a.txt')).ok, true);
});
it('捕获旧根后发生切换时拒绝继续异步操作', async (t) => {
  const f = await fixture(t); await f.manager.create('', 'a.txt', false);
  const pending = f.files.readFile('a.txt'); f.files.clearRoot();
  assert.equal((await pending).ok, false);
});

it('永久删除真实文件和文件夹全部内容，保持回收站作为独立操作', async (t) => {
  const f = await fixture(t); await f.manager.create('', 'sub', true); await f.manager.create('sub', 'a.txt', false);
  assert.equal((await f.manager.delete('sub/a.txt')).ok, true); await assert.rejects(fs.stat(path.join(f.root, 'sub/a.txt')), { code: 'ENOENT' });
  await f.manager.create('sub', 'b.txt', false); assert.equal((await f.manager.delete('sub')).ok, true);
  await assert.rejects(fs.stat(path.join(f.root, 'sub')), { code: 'ENOENT' });
  await f.manager.create('', 'recycle.txt', false); assert.equal((await f.manager.trash('recycle.txt')).ok, false);
  assert.equal((await fs.stat(path.join(f.root, 'recycle.txt'))).isFile(), true);
});

it('永久删除拒绝根、越界、缺失目标、链接和链接祖先，检查路径可用于复制与定位', async (t) => {
  const f = await fixture(t); await f.manager.create('', 'real', true); await f.manager.create('real', 'a.txt', false);
  await fs.symlink(path.join(f.root, 'real'), path.join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const relative of ['', '.', '..', 'missing.txt', 'link', 'link/a.txt']) assert.equal((await f.manager.delete(relative)).ok, false, relative);
  assert.equal((await f.manager.inspect('link/a.txt')).ok, false);
  assert.equal((await f.manager.inspect('')).ok, true); const target = await f.manager.inspect('real/a.txt');
  assert.equal(target.ok, true); if (target.ok) assert.equal(target.absolute, path.join(f.root, 'real/a.txt'));
  assert.equal(await fs.readFile(path.join(f.root, 'real/a.txt'), 'utf8'), '');
});

it('确认目标身份过期或根发生切换时不删除新目标', async (t) => {
  const f = await fixture(t); await f.manager.create('', 'a.txt', false);
  const inspected = await f.manager.inspect('a.txt'); assert.equal(inspected.ok, true);
  if (inspected.ok) {
    const result = await f.manager.delete('a.txt', { ...inspected.identity, birthtimeMs: inspected.identity.birthtimeMs + 1 });
    assert.equal(result.ok, false); assert.equal((await fs.stat(path.join(f.root, 'a.txt'))).isFile(), true);
  }
  const pending = f.manager.delete('a.txt'); f.files.clearRoot(); assert.equal((await pending).ok, false);
});

it('删除普通文件夹内的 junction 仅移除链接，不递归删除外部内容', async (t) => {
  const f = await fixture(t); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-delete-external-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(f.root, 'sub')); await fs.writeFile(path.join(outside, 'keep.txt'), 'external');
  await fs.symlink(outside, path.join(f.root, 'sub', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.manager.delete('sub')).ok, true);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'external');
});
