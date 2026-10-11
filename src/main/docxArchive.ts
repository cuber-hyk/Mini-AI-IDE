/** 仅验证 DOCX 容器，不解包到磁盘；按实际解压量约束资源占用。 */
import { inflateRawSync } from 'node:zlib';
import { DOCX_ENTRY_LIMIT, DOCX_EXPANDED_BYTE_LIMIT } from '../shared/filePreview';

export function validateDocxArchive(bytes: Buffer): string | null {
  const invalid = 'Word 文件容器损坏或格式不受支持';
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) return invalid;
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count) return invalid;
  if (count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) return '暂不支持 ZIP64 Word 文件';
  if (count > DOCX_ENTRY_LIMIT) return 'Word 文件条目超过 5000 项，无法预览';
  if (directoryStart + directorySize !== end) return invalid;
  let cursor = directoryStart;
  let expanded = 0;
  const names = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) return invalid;
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const expandedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || bytes.readUInt16LE(cursor + 34)) return invalid;
    if (flags & 1) return '暂不支持加密的 Word 文件';
    if ([compressedSize, expandedSize, localOffset].includes(0xffffffff)) return '暂不支持 ZIP64 Word 文件';
    if (method !== 0 && method !== 8) return invalid;
    if (expandedSize > DOCX_EXPANDED_BYTE_LIMIT - expanded) return 'Word 文件展开后超过 100 MiB，无法预览';
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (!name || names.has(name)) return invalid;
    names.add(name);
    if (localOffset + 30 > directoryStart || bytes.readUInt32LE(localOffset) !== 0x04034b50) return invalid;
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > directoryStart || bytes.readUInt16LE(localOffset + 6) !== flags
      || bytes.readUInt16LE(localOffset + 8) !== method
      || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(bytes.subarray(cursor + 46, cursor + 46 + nameLength))) return invalid;
    try {
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
      const content = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, DOCX_EXPANDED_BYTE_LIMIT - expanded) });
      if (content.length !== expandedSize) return invalid;
      if (name === 'word/document.xml' && content.length === 0) return invalid;
      expanded += content.length;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? 'Word 文件展开后超过 100 MiB，无法预览' : invalid;
    }
    cursor = next;
  }
  return cursor === end && names.has('[Content_Types].xml') && names.has('word/document.xml') ? null : invalid;
}
