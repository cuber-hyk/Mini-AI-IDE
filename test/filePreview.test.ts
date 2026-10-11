import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { readFilePreview } from '../src/main/filePreview';
import { FileService } from '../src/main/fileService';
import { filePreviewKind, FILE_PREVIEW_BYTE_LIMIT, DOCX_EXPANDED_BYTE_LIMIT } from '../src/shared/filePreview';

async function fixture(t: any, files = new FileService()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-file-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  files.setRoot(root);
  return { root, files, read: (relative: string) => readFilePreview(files, relative, root) };
}

function zip(entries: Array<{ name: string; text?: string; bytes?: Buffer; expandedSize?: number; encrypted?: boolean }>): Buffer {
  const local: Buffer[] = []; const directory: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = entry.bytes ?? Buffer.from(entry.text ?? 'content');
    const compressed = deflateRawSync(content);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(entry.encrypted ? 1 : 0, 6);
    header.writeUInt16LE(8, 8); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(entry.expandedSize ?? content.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(entry.encrypted ? 1 : 0, 8);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.expandedSize ?? content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); directory.push(central, name);
    offset += header.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

const docxEntries = [{ name: '[Content_Types].xml', text: '<Types/>' }, { name: 'word/document.xml', text: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>' }];

it('只对已约定扩展名分流附件，大小写和 Windows 路径一致', () => {
  for (const name of ['a.PNG', 'a.jpg', 'a.jpeg', 'a.gif', 'folder\\a.WeBP']) assert.equal(filePreviewKind(name), 'image');
  assert.equal(filePreviewKind('a.PDF'), 'pdf'); assert.equal(filePreviewKind('a.DOCX'), 'docx'); assert.equal(filePreviewKind('a.doc'), 'unsupported');
  for (const name of ['a.txt', 'README', 'png', 'pdf', 'docx', 'folder.pdf/a.txt', 'a.svg']) assert.equal(filePreviewKind(name), null);
});

it('读取原始附件字节且不改变真实文件；PDF 不通过文本编码转换', async t => {
  const f = await fixture(t); const bytes = Buffer.from('%PDF-1.7\n\u0000binary');
  await fs.mkdir(path.join(f.root, 'docs')); await fs.writeFile(path.join(f.root, 'docs/a.PDF'), bytes);
  const result = await f.read('docs/a.PDF'); assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.kind, 'pdf'); assert.equal(result.mimeType, 'application/pdf'); assert.equal(result.relPath, 'docs/a.PDF'); assert.deepEqual(Buffer.from(result.bytes), bytes); }
  assert.deepEqual(await fs.readFile(path.join(f.root, 'docs/a.PDF')), bytes);
});

it('允许 PNG、JPEG、GIF、WebP 签名并拒绝扩展名伪装', async t => {
  const f = await fixture(t);
  const png = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0]);
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16);
  const samples = [{ name: 'a.png', bytes: png, mime: 'image/png' }, { name: 'a.jpg', bytes: jpeg, mime: 'image/jpeg' },
    { name: 'a.gif', bytes: Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000'), mime: 'image/gif' }, { name: 'a.webp', bytes: webp, mime: 'image/webp' }];
  for (const sample of samples) {
    await fs.writeFile(path.join(f.root, sample.name), sample.bytes); const result = await f.read(sample.name);
    assert.equal(result.ok, true, sample.name); if (result.ok) assert.equal(result.mimeType, sample.mime);
    await fs.writeFile(path.join(f.root, sample.name), 'plain text'); assert.equal((await f.read(sample.name)).ok, false);
  }
});

it('图片在交给解码器之前拒绝超大或无效尺寸，不能只凭签名放行', async t => {
  const f = await fixture(t);
  const png = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12);
  png.writeUInt32BE(10000, 16); png.writeUInt32BE(10000, 20); await fs.writeFile(path.join(f.root, 'huge.png'), png);
  const huge = await f.read('huge.png'); assert.equal(huge.ok, false); if (!huge.ok) assert.match(huge.error, /4000 万像素/);
  png.writeUInt32BE(0, 16); await fs.writeFile(path.join(f.root, 'invalid.png'), png);
  assert.equal((await f.read('invalid.png')).ok, false);
});

it('预览拒绝根不匹配、越界、目录、缺失文件和未支持类型', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'folder.pdf'));
  await fs.writeFile(path.join(f.root, 'a.txt'), 'text'); await fs.writeFile(path.join(f.root, 'a.doc'), 'legacy');
  for (const relative of ['../outside.pdf', 'folder.pdf', 'missing.pdf', 'a.txt', 'a.doc']) assert.equal((await f.read(relative)).ok, false, relative);
  assert.equal((await readFilePreview(f.files, 'missing.pdf', `${f.root}-old`)).ok, false);
});

it('外部 junction 不会返回项目外二进制；项目内链接保持可用', async t => {
  const f = await fixture(t); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-preview-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'a.pdf'), '%PDF-1.7 outside');
  await fs.symlink(outside, path.join(f.root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.read('outside/a.pdf')).ok, false);
  await fs.mkdir(path.join(f.root, 'inside')); await fs.writeFile(path.join(f.root, 'inside/a.pdf'), '%PDF-1.7 inside');
  await fs.symlink(path.join(f.root, 'inside'), path.join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.read('link/a.pdf')).ok, true);
});

it('单附件超过 32 MiB 时拒绝而不截断返回', async t => {
  const f = await fixture(t); const handle = await fs.open(path.join(f.root, 'huge.pdf'), 'w');
  await handle.truncate(FILE_PREVIEW_BYTE_LIMIT + 1); await handle.close();
  const result = await f.read('huge.pdf'); assert.equal(result.ok, false); if (!result.ok) assert.match(result.error, /32 MiB/);
});

it('切根和切根后返回原目录都撤销正在进行的旧预览读取', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.pdf'), '%PDF-1.7');
  const first = f.read('a.pdf'); f.files.clearRoot(); assert.equal((await first).ok, false);
  f.files.setRoot(f.root); const second = f.read('a.pdf'); f.files.setRoot(f.root); assert.equal((await second).ok, false);
});

it('读取期间文件被替换时不返回过期文件内容', async t => {
  class ReplacingFiles extends FileService {
    calls = 0;
    override async resolveSafePath(relative: string, allowMissing = false) {
      this.calls += 1;
      if (this.calls === 2) {
        await fs.rename(path.join(this.getRoot()!, relative), path.join(this.getRoot()!, 'old.pdf'));
        await fs.writeFile(path.join(this.getRoot()!, relative), '%PDF-1.7 new');
      }
      return super.resolveSafePath(relative, allowMissing);
    }
  }
  const f = await fixture(t, new ReplacingFiles()); await fs.writeFile(path.join(f.root, 'a.pdf'), '%PDF-1.7 old');
  assert.equal((await f.read('a.pdf')).ok, false);
});

it('DOCX 必须具有有效 ZIP 目录、内容类型和 Word 正文条目', async t => {
  const f = await fixture(t); const target = path.join(f.root, 'a.docx');
  await fs.writeFile(target, zip(docxEntries)); const valid = await f.read('a.docx'); assert.equal(valid.ok, true);
  if (valid.ok) { assert.equal(valid.kind, 'docx'); assert.equal(valid.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); }
  for (const bytes of [zip([{ name: 'other.xml' }]), zip([{ name: '[Content_Types].xml' }]), zip([...docxEntries, docxEntries[1]!]), zip(docxEntries).subarray(0, -1)]) {
    await fs.writeFile(target, bytes); assert.equal((await f.read('a.docx')).ok, false);
  }
});

it('DOCX 拒绝加密、ZIP64 和超过 5000 项的容器', async t => {
  const f = await fixture(t); const target = path.join(f.root, 'a.docx');
  await fs.writeFile(target, zip(docxEntries.map(entry => ({ ...entry, encrypted: true })))); assert.equal((await f.read('a.docx')).ok, false);
  const zip64 = zip(docxEntries); zip64.writeUInt16LE(0xffff, zip64.length - 14); zip64.writeUInt16LE(0xffff, zip64.length - 12);
  await fs.writeFile(target, zip64); assert.equal((await f.read('a.docx')).ok, false);
  await fs.writeFile(target, zip(Array.from({ length: 5001 }, (_, index) => ({ name: `${index}.xml` }))));
  const result = await f.read('a.docx'); assert.equal(result.ok, false); if (!result.ok) assert.match(result.error, /5000/);
});

it('DOCX 声明展开量超限直接拒绝，伪报小尺寸也不能绕过实际解压上限', async t => {
  const f = await fixture(t); const target = path.join(f.root, 'a.docx');
  await fs.writeFile(target, zip([...docxEntries, { name: 'word/media/bomb', expandedSize: DOCX_EXPANDED_BYTE_LIMIT + 1 }]));
  const declared = await f.read('a.docx'); assert.equal(declared.ok, false); if (!declared.ok) assert.match(declared.error, /100 MiB/);
  await fs.writeFile(target, zip([...docxEntries, { name: 'word/media/bomb', bytes: Buffer.alloc(DOCX_EXPANDED_BYTE_LIMIT + 1), expandedSize: 1 }]));
  const actual = await f.read('a.docx'); assert.equal(actual.ok, false); if (!actual.ok) assert.match(actual.error, /100 MiB/);
});
