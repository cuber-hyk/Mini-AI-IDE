/** 编辑器本地预览的唯一二进制读取 owner；不提供 URL 或绝对路径给渲染进程。 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';
import { FILE_PREVIEW_BYTE_LIMIT, DOCUMENT_PREVIEW_BYTE_LIMIT, filePreviewKind, type FilePreviewResult } from '../shared/filePreview';
import { imageDimensions } from '../shared/imageDimensions';
import { validateDocxArchive } from './docxArchive';
import type { FileService } from './fileService';

const sameFile = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino
  && left.birthtimeMs === right.birthtimeMs && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

function mimeFor(bytes: Buffer, extension: string): string | null {
  if (extension === '.pdf') return bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')) ? 'application/pdf' : null;
  if (extension === '.docx') return bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : null;
  if (extension === '.png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR' ? 'image/png' : null;
  if (extension === '.jpg' || extension === '.jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null;
  if (extension === '.gif') return bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) ? 'image/gif' : null;
  if (extension === '.webp') return bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  return null;
}

export async function readFilePreview(files: FileService, relPath: string, expectedRoot: string): Promise<FilePreviewResult> {
  const fail = (error: string): FilePreviewResult => ({ ok: false, error });
  if (files.getRoot() !== expectedRoot) return fail('目录已切换，请重新打开预览');
  const kind = filePreviewKind(relPath);
  if (!kind || kind === 'unsupported') return fail('此文件类型暂不支持预览');
  const target = await files.resolveSafePath(relPath);
  if (!target.ok) return target;
  let handle: fs.FileHandle | undefined;
  try {
    const realPath = await fs.realpath(target.absolute);
    const before = await fs.stat(realPath);
    if (!before.isFile()) return fail('只能预览普通文件');
    const byteLimit = kind === 'image' ? FILE_PREVIEW_BYTE_LIMIT : DOCUMENT_PREVIEW_BYTE_LIMIT;
    if (before.size > byteLimit) return fail(`文件超过 ${byteLimit / (1024 * 1024)} MiB，无法预览`);
    handle = await fs.open(realPath, 'r');
    if (!sameFile(before, await handle.stat())) return fail('文件已变化，请重新打开预览');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) return fail('文件已变化，请重新打开预览');
      offset += read.bytesRead;
    }
    const checked = await files.resolveSafePath(relPath);
    if (!checked.ok) return checked;
    if (checked.rootRevision !== target.rootRevision || !files.isCurrentRoot(target.rootRevision) || files.getRoot() !== expectedRoot) return fail('目录已切换，请重新打开预览');
    if (await fs.realpath(checked.absolute) !== realPath || !sameFile(before, await handle.stat()) || !sameFile(before, await fs.stat(checked.absolute))) return fail('文件已变化，请重新打开预览');
    const mimeType = mimeFor(bytes, path.extname(relPath).toLowerCase());
    if (!mimeType) return fail('文件内容与扩展名不匹配，或文件已损坏');
    if (kind === 'image') {
      const size = imageDimensions(bytes, mimeType);
      if (!size) return fail('图片尺寸无效或文件已损坏');
      if (size.width * size.height > 40_000_000) return fail('图片超过 4000 万像素，无法预览');
    }
    if (kind === 'docx') {
      const error = validateDocxArchive(bytes);
      if (error) return fail(error);
    }
    if (!files.isCurrentRoot(target.rootRevision)) return fail('目录已切换，请重新打开预览');
    return { ok: true, kind, mimeType, bytes: new Uint8Array(bytes), relPath: target.relative.split(path.sep).join('/') };
  } catch (error) {
    return fail(`无法预览文件：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await handle?.close();
  }
}
