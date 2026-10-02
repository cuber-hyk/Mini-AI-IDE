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
