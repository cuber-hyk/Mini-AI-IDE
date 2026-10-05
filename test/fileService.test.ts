/**
 * FileService 集成测试（真实文件系统，临时目录）
 *
 * 覆盖：列目录 / UTF-8 读取 / GBK 回退 / 二进制拒绝 / 路径越界 / 写入 / 分片 / 上限。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { FileService } from '../src/main/fileService';

let root: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-ai-ide-fs-test-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'sub file\n', 'utf8');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('FileService', () => {
  it('未设置根目录时拒绝一切读取', async () => {
    const svc = new FileService();
    const r = await svc.readFile('a.ts');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /尚未打开任何目录/);
  });

  it('列目录返回条目并标记文本可能性', async () => {
    const svc = new FileService();
    svc.setRoot(root);
    const r = await svc.listDir('');
    assert.equal(r.ok, true);
    const names = r.entries.map((e) => e.name);
    assert.ok(names.includes('a.ts'));
    assert.ok(names.includes('sub'));
    const ts = r.entries.find((e) => e.name === 'a.ts');
    assert.equal(ts?.textLike, true);
    const bin = r.entries.find((e) => e.name === 'bin.dat');
    assert.equal(bin?.textLike, false);
    const sub = r.entries.find((e) => e.name === 'sub');
    assert.equal(sub?.textLike, null);
  });

  it('读取 UTF-8 文件并返回元信息', async () => {
    const svc = new FileService();
    svc.setRoot(root);
    const r = await svc.readFile('a.ts');
    assert.equal(r.ok, true);
    assert.equal(r.encoding, 'utf-8');
    assert.equal(r.fellBack, false);
    assert.equal(r.text, 'export const a = 1;\n');
    assert.equal(r.meta?.lineCount, 2);
  });

  it('GBK 文件回退解码成功', async () => {
    const svc = new FileService();
    svc.setRoot(root);
    const r = await svc.readFile('gbk.txt');
    assert.equal(r.ok, true);
    assert.equal(r.encoding, 'gbk');
    assert.equal(r.fellBack, true);
    assert.equal(r.text, '中文\n');
  });

  it('二进制文件被拒绝', async () => {
    const svc = new FileService();
    svc.setRoot(root);
    const r = await svc.readFile('bin.dat');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /二进制/);
  });

  it('路径越界被拒绝（.. 穿越）', async () => {
    const svc = new FileService();
    svc.setRoot(root);
    const r = await svc.readFile(path.join('..', '..', 'anything.txt'));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /不在已打开的根目录内/);
  });

  it('超出上限时只返回元信息', async () => {
    const svc = new FileService(10); // 上限 10 字符
    svc.setRoot(root);
    const r = await svc.readFile('a.ts');
    assert.equal(r.ok, true);
    assert.equal(r.tooLarge, true);
    assert.equal(r.text, '');
    assert.equal(r.limit, 10);
    assert.ok((r.meta?.charCount ?? 0) > 10);
  });

  it('写入后可读回同样内容', async () => {
    const svc = new FileService();
    svc.setRoot(root);
    const w = await svc.writeFile('a.ts', 'export const a = 2;\n');
    assert.equal(w.ok, true);
    assert.equal(w.byteLength, Buffer.byteLength('export const a = 2;\n', 'utf8'));
    const r = await svc.readFile('a.ts');
    assert.equal(r.text, 'export const a = 2;\n');
  });

  it('写入同样受路径白名单约束', async () => {
    const svc = new FileService();
    svc.setRoot(root);
    const w = await svc.writeFile(path.join('..', 'escape.txt'), 'x');
    assert.equal(w.ok, false);
  });

  it('分片读取返回正确区间', async () => {
    const svc = new FileService();
    svc.setRoot(root);
    const r = await svc.sliceFile('a.ts', 1, 1);
    assert.equal(r.ok, true);
    assert.equal(r.startLine, 1);
    assert.equal(r.endLine, 1);
    assert.equal(r.totalLines, 2);
    assert.equal(r.text, 'export const a = 2;');
  });

  it('可以读取子目录中的文件', async () => {
    const svc = new FileService();
    svc.setRoot(root);
    const r = await svc.readFile('sub/b.txt');
    assert.equal(r.ok, true);
    assert.equal(r.text, 'sub file\n');
  });
});

async function creationFixture(t: any, limit = 200_000) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mini-ai-create-file-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const files = new FileService(limit); files.setRoot(directory);
  return { root: directory, files };
}

describe('AI 新增文件及撤销', () => {
  it('多级缺失路径可预览为空原文，预览不创建目录或文件', async (t) => {
    const f = await creationFixture(t);
    const target = await f.files.resolveSafePath('app/backend/seed.ts', true);
    assert.equal(target.ok, true);
    const raw = await f.files.readRawText('app/backend/seed.ts', true);
    assert.equal(raw.ok, true);
    if (raw.ok) { assert.equal(raw.text, ''); assert.equal(raw.exists, false); assert.ok(f.files.isCurrentRoot(raw.rootRevision)); }
    assert.deepEqual(await fs.promises.readdir(f.root), []);
    assert.equal((await f.files.readRawText('app/backend/seed.ts')).ok, false);
    await fs.promises.writeFile(path.join(f.root, 'empty.txt'), '');
    const existing = await f.files.readRawText('empty.txt', true);
    assert.ok(existing.ok && existing.exists);
  });

  it('排他新增会创建缺失父级并记录本次目录，撤销还原原有目录结构', async (t) => {
    const f = await creationFixture(t); await fs.promises.mkdir(path.join(f.root, 'existing'));
    const result = await f.files.createFile('existing/app/backend/seed.ts', 'export const seed = 1;\n');
    assert.equal(result.ok, true); assert.deepEqual(result.createdDirectories?.map((directory) => directory.relative), ['existing/app', 'existing/app/backend']);
    for (const directory of result.createdDirectories!) {
      const stat = await fs.promises.lstat(path.join(f.root, directory.relative));
      assert.equal(directory.dev, stat.dev); assert.equal(directory.ino, stat.ino);
    }
    assert.equal(await fs.promises.readFile(path.join(f.root, 'existing/app/backend/seed.ts'), 'utf8'), 'export const seed = 1;\n');
    assert.equal((await f.files.removeCreatedFile('existing/app/backend/seed.ts', 'export const seed = 1;\n', result.createdDirectories!, result.createdFileIdentity!)).ok, true);
    assert.deepEqual(await fs.promises.readdir(path.join(f.root, 'existing')), []);
  });

  it('预览后外部创建的文件不能被新增操作覆盖，包括空文件', async (t) => {
    const f = await creationFixture(t);
    assert.ok((await f.files.readRawText('new.txt', true)).ok);
    await fs.promises.writeFile(path.join(f.root, 'new.txt'), '');
    assert.equal((await f.files.createFile('new.txt', 'AI output')).ok, false);
    assert.equal(await fs.promises.readFile(path.join(f.root, 'new.txt'), 'utf8'), '');
  });

  it('多个并行新增同一文件仅成功一次，失败者不覆盖成功内容', async (t) => {
    const f = await creationFixture(t);
    const results = await Promise.all([f.files.createFile('same/file.txt', 'one'), f.files.createFile('same/file.txt', 'two')]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(await fs.promises.readFile(path.join(f.root, 'same/file.txt'), 'utf8'), results[0].ok ? 'one' : 'two');
  });

  it('撤销拒绝删除被编辑过的新文件；删除成功后仅清理仍空的新目录', async (t) => {
    const f = await creationFixture(t); const created = await f.files.createFile('project/src/a.txt', 'AI');
    await fs.promises.writeFile(path.join(f.root, 'project/src/a.txt'), 'user draft');
    assert.equal((await f.files.removeCreatedFile('project/src/a.txt', 'AI', created.createdDirectories!, created.createdFileIdentity!)).ok, false);
    assert.equal(await fs.promises.readFile(path.join(f.root, 'project/src/a.txt'), 'utf8'), 'user draft');
    await fs.promises.writeFile(path.join(f.root, 'project/src/a.txt'), 'AI');
    await fs.promises.writeFile(path.join(f.root, 'project/src/other.txt'), 'keep');
    assert.equal((await f.files.removeCreatedFile('project/src/a.txt', 'AI', created.createdDirectories!, created.createdFileIdentity!)).ok, true);
    assert.equal(await fs.promises.readFile(path.join(f.root, 'project/src/other.txt'), 'utf8'), 'keep');
  });

  it('非法名称、越界及超限内容在任何落盘前被拒绝', async (t) => {
    const f = await creationFixture(t, 3);
    for (const rel of ['new/CON.txt', 'new/name.', 'new/a:b', '../outside.txt']) {
      assert.equal((await f.files.createFile(rel, 'ok')).ok, false, rel);
    }
    assert.equal((await f.files.createFile('new/file.txt', 'long')).ok, false);
    assert.equal((await f.files.createFile('.', 'ok')).ok, false);
    assert.deepEqual(await fs.promises.readdir(f.root), []);
  });

  it('允许缺失不会掩盖二进制、超限、目录及父级非目录错误', async (t) => {
    const f = await creationFixture(t, 3);
    await fs.promises.writeFile(path.join(f.root, 'binary.bin'), Buffer.from([0, 1, 2]));
    await fs.promises.writeFile(path.join(f.root, 'large.txt'), 'long');
    await fs.promises.writeFile(path.join(f.root, 'file.txt'), 'ok');
    assert.equal((await f.files.readRawText('binary.bin', true)).ok, false);
    assert.equal((await f.files.readRawText('large.txt', true)).ok, false);
    assert.equal((await f.files.readRawText('.', true)).ok, false);
    assert.equal((await f.files.readRawText('file.txt/child.txt', true)).ok, false);
    assert.equal((await f.files.createFile('file.txt/child.txt', 'ok')).ok, false);
  });

  it('外部 junction 和悬空祖先链接不可预览或新增，外部内容不变', async (t) => {
    const f = await creationFixture(t); const external = await creationFixture(t);
    await fs.promises.symlink(external.root, path.join(f.root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    const disappearing = path.join(external.root, 'disappearing'); await fs.promises.mkdir(disappearing);
    await fs.promises.symlink(disappearing, path.join(f.root, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.promises.rmdir(disappearing);
    for (const rel of ['external/missing/deep.txt', 'dangling/missing/deep.txt']) {
      assert.equal((await f.files.resolveSafePath(rel, true)).ok, false, rel);
      assert.equal((await f.files.readRawText(rel, true)).ok, false, rel);
      assert.equal((await f.files.createFile(rel, 'bad')).ok, false, rel);
    }
    assert.deepEqual(await fs.promises.readdir(external.root), []);
  });

  it('根目录切换后旧预览版本不能新增；进行中的读取和撤销也拒绝继续', async (t) => {
    const f = await creationFixture(t); const other = await creationFixture(t);
    const preview = await f.files.readRawText('new/file.txt', true); assert.ok(preview.ok);
    const created = await f.files.createFile('undo/file.txt', 'AI');
    const pending = f.files.removeCreatedFile('undo/file.txt', 'AI', created.createdDirectories!, created.createdFileIdentity!);
    f.files.setRoot(other.root);
    assert.equal((await pending).ok, false);
    assert.equal((await f.files.createFile('new/file.txt', 'AI', preview.rootRevision)).ok, false);
    assert.deepEqual(await fs.promises.readdir(other.root), []);
    assert.equal(await fs.promises.readFile(path.join(f.root, 'undo/file.txt'), 'utf8'), 'AI');
  });

  it('中途失败会回滚本次创建的仍空父级，已有目录保留', async (t) => {
    const f = await creationFixture(t); await fs.promises.mkdir(path.join(f.root, 'existing'));
    const resolve = f.files.resolveSafePath.bind(f.files); let calls = 0;
    f.files.resolveSafePath = async (rel, missing) => {
      const result = await resolve(rel, missing);
      if (++calls === 6) return { ok: false, error: '模拟父级检查失败' };
      return result;
    };
    const created = await f.files.createFile('existing/one/two/file.txt', 'AI');
    assert.equal(created.ok, false);
    assert.deepEqual(await fs.promises.readdir(path.join(f.root, 'existing')), []);
  });

  it('目录清理失败仍报告文件撤销成功并返回可见警告', async (t) => {
    const f = await creationFixture(t); const result = await f.files.createFile('new/file.txt', 'AI');
    const original = fs.promises.rmdir;
    fs.promises.rmdir = async () => { throw Object.assign(new Error('模拟目录清理权限失败'), { code: 'EACCES' }); };
    try {
      const removed = await f.files.removeCreatedFile('new/file.txt', 'AI', result.createdDirectories!, result.createdFileIdentity!);
      assert.equal(removed.ok, true); assert.match(removed.error ?? '', /文件已删除.*清理/);
      assert.equal(fs.existsSync(path.join(f.root, 'new/file.txt')), false);
    } finally { fs.promises.rmdir = original; }
  });

  it('伪造撤销目录记录不能删除无关目录或根目录', async (t) => {
    const f = await creationFixture(t); const created = await f.files.createFile('new/file.txt', 'AI');
    await fs.promises.mkdir(path.join(f.root, 'unrelated'));
    for (const relative of ['unrelated', '.', '../outside']) assert.equal((await f.files.removeCreatedFile('new/file.txt', 'AI', [{ relative, dev: 0, ino: 0 }], created.createdFileIdentity!)).ok, false);
    assert.equal(await fs.promises.readFile(path.join(f.root, 'new/file.txt'), 'utf8'), 'AI');
    assert.equal((await fs.promises.stat(path.join(f.root, 'unrelated'))).isDirectory(), true);
  });

  it('缺失读取仍报告权限失败，不把权限错误当作待创建文件', async (t) => {
    const f = await creationFixture(t); await fs.promises.writeFile(path.join(f.root, 'existing.txt'), 'keep');
    const original = fs.promises.readFile;
    fs.promises.readFile = async () => { throw Object.assign(new Error('模拟文件读取权限失败'), { code: 'EACCES' }); };
    try {
      const result = await f.files.readRawText('existing.txt', true);
      assert.equal(result.ok, false); if (!result.ok) assert.match(result.error, /权限失败/);
    } finally { fs.promises.readFile = original; }
  });

  it('新增文件父级被替换为根内链接时撤销拒绝，链接指向内容不受影响', async (t) => {
    const f = await creationFixture(t); const result = await f.files.createFile('new/file.txt', 'AI');
    await fs.promises.rename(path.join(f.root, 'new'), path.join(f.root, 'moved'));
    await fs.promises.symlink(path.join(f.root, 'moved'), path.join(f.root, 'new'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await f.files.removeCreatedFile('new/file.txt', 'AI', result.createdDirectories!, result.createdFileIdentity!)).ok, false);
    assert.equal(await fs.promises.readFile(path.join(f.root, 'moved/file.txt'), 'utf8'), 'AI');
  });

  it('根内链接允许读取已有文件，但新增预览和创建统一拒绝链接父级', async (t) => {
    const f = await creationFixture(t); await fs.promises.mkdir(path.join(f.root, 'inside'));
    await fs.promises.writeFile(path.join(f.root, 'inside/existing.txt'), 'keep');
    await fs.promises.symlink(path.join(f.root, 'inside'), path.join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const existing = await f.files.readRawText('link/existing.txt', true);
    assert.ok(existing.ok && existing.exists && existing.text === 'keep');
    for (const rel of ['link/new.txt', 'link/missing/deep.txt']) {
      const preview = await f.files.readRawText(rel, true);
      assert.equal(preview.ok, false); if (!preview.ok) assert.match(preview.error, /链接目录/);
      assert.equal((await f.files.createFile(rel, 'AI')).ok, false);
    }
    assert.deepEqual(await fs.promises.readdir(path.join(f.root, 'inside')), ['existing.txt']);
    // 用户明确打开的根目录本身可为链接，根下普通新路径仍允许创建与撤销。
    f.files.setRoot(path.join(f.root, 'link'));
    const preview = await f.files.readRawText('new/file.txt', true); assert.ok(preview.ok && !preview.exists);
    const result = await f.files.createFile('new/file.txt', 'AI'); assert.equal(result.ok, true);
    assert.equal((await f.files.removeCreatedFile('new/file.txt', 'AI', result.createdDirectories!, result.createdFileIdentity!)).ok, true);
    assert.deepEqual(await fs.promises.readdir(path.join(f.root, 'inside')), ['existing.txt']);
  });

  it('创建父级期间切换根目录会回滚旧根空目录，两个根都没有新文件', async (t) => {
    const f = await creationFixture(t); const other = await creationFixture(t);
    const resolve = f.files.resolveSafePath.bind(f.files); let calls = 0;
    f.files.resolveSafePath = async (rel, missing) => {
      const result = await resolve(rel, missing);
      if (++calls === 3) f.files.setRoot(other.root);
      return result;
    };
    assert.equal((await f.files.createFile('new/file.txt', 'AI')).ok, false);
    assert.deepEqual(await fs.promises.readdir(f.root), []);
    assert.deepEqual(await fs.promises.readdir(other.root), []);
  });

  it('用户重建同名目录后移回新增文件，撤销保留用户的新目录', async (t) => {
    const f = await creationFixture(t); const created = await f.files.createFile('new/file.txt', 'AI');
    await fs.promises.rename(path.join(f.root, 'new'), path.join(f.root, 'moved'));
    await fs.promises.mkdir(path.join(f.root, 'new'));
    const rebuilt = await fs.promises.lstat(path.join(f.root, 'new'));
    assert.notEqual(rebuilt.ino, created.createdDirectories![0]!.ino);
    await fs.promises.rename(path.join(f.root, 'moved/file.txt'), path.join(f.root, 'new/file.txt'));
    const result = await f.files.removeCreatedFile('new/file.txt', 'AI', created.createdDirectories!, created.createdFileIdentity!);
    assert.equal(result.ok, true); assert.match(result.error ?? '', /new 已改变，保留目录/);
    assert.equal(fs.existsSync(path.join(f.root, 'new/file.txt')), false);
    assert.equal((await fs.promises.lstat(path.join(f.root, 'new'))).ino, rebuilt.ino);
    assert.equal((await fs.promises.stat(path.join(f.root, 'moved'))).isDirectory(), true);
  });
});

it('新增撤销保留外部创建的同名同内容文件，移回原对象后才可撤销', async (t) => {
  const f = await creationFixture(t); const created = await f.files.createFile('new/file.txt', 'AI');
  assert.equal(created.ok, true);
  await fs.promises.rename(path.join(f.root, 'new/file.txt'), path.join(f.root, 'original.txt'));
  await fs.promises.writeFile(path.join(f.root, 'new/file.txt'), 'AI');
  const result = await f.files.removeCreatedFile('new/file.txt', 'AI', created.createdDirectories!, created.createdFileIdentity!);
  assert.equal(result.ok, false); assert.match(result.error ?? '', /同名文件替换/);
  assert.equal(await fs.promises.readFile(path.join(f.root, 'new/file.txt'), 'utf8'), 'AI');
  await fs.promises.unlink(path.join(f.root, 'new/file.txt'));
  await fs.promises.rename(path.join(f.root, 'original.txt'), path.join(f.root, 'new/file.txt'));
  assert.equal((await f.files.removeCreatedFile('new/file.txt', 'AI', created.createdDirectories!, created.createdFileIdentity!)).ok, true);
  assert.equal(fs.existsSync(path.join(f.root, 'new')), false);
});
