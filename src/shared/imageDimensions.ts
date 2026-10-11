/** 只检查受支持图片的尺寸头，不解压图片或扫描 JPEG 熵编码数据。 */
export function imageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | null {
  const length = bytes.length;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function ascii(offset: number, text: string): boolean {
    return offset + text.length <= length && Array.from(text).every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  }
  function le16(offset: number): number { return data.getUint16(offset, true); }
  function be16(offset: number): number { return data.getUint16(offset); }
  function le24(offset: number): number { return le16(offset) | data.getUint8(offset + 2) << 16; }
  function le32(offset: number): number { return data.getUint32(offset, true); }
  function be32(offset: number): number { return data.getUint32(offset); }
  function dimensions(width: number, height: number): { width: number; height: number } | null {
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (mimeType === 'image/png') {
    if (length < 33 || bytes[0] !== 137 || !ascii(1, 'PNG\r\n\u001a\n') || be32(8) !== 13 || !ascii(12, 'IHDR')) return null;
    return dimensions(be32(16), be32(20));
  }
  if (mimeType === 'image/gif') {
    if (length < 13 || !ascii(0, 'GIF87a') && !ascii(0, 'GIF89a')) return null;
    return dimensions(le16(6), le16(8));
  }
  if (mimeType === 'image/webp') {
    if (length < 20 || !ascii(0, 'RIFF') || !ascii(8, 'WEBP')) return null;
    const end = le32(4) + 8; const chunkSize = le32(16);
    if (end > length || end < 20 || chunkSize > end - 20) return null;
    if (ascii(12, 'VP8X')) {
      if (chunkSize !== 10) return null;
      return dimensions(le24(24) + 1, le24(27) + 1);
    }
    if (ascii(12, 'VP8L')) {
      if (chunkSize < 5 || bytes[20] !== 0x2f || data.getUint8(24) >> 5 !== 0) return null;
      return dimensions(1 + data.getUint8(21) + ((data.getUint8(22) & 0x3f) << 8), 1 + (data.getUint8(22) >> 6) + (data.getUint8(23) << 2) + ((data.getUint8(24) & 0x0f) << 10));
    }
    if (ascii(12, 'VP8 ')) {
      if (chunkSize < 10 || (data.getUint8(20) & 1) !== 0 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      return dimensions(le16(26) & 0x3fff, le16(28) & 0x3fff);
    }
    return null;
  }
  if (mimeType === 'image/jpeg') {
    if (length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;
    while (offset < length) {
      if (bytes[offset++] !== 0xff) return null;
      while (offset < length && bytes[offset] === 0xff) offset += 1;
      if (offset >= length) return null;
      const marker = data.getUint8(offset++);
      if (marker === 0xda || marker === 0xd9 || marker === 0x00) return null;
      if (marker === 0x01 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > length) return null;
      const segmentLength = be16(offset);
      if (segmentLength < 2 || segmentLength > length - offset) return null;
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        if (segmentLength < 8 || bytes[offset + 7] === 0 || segmentLength < 8 + data.getUint8(offset + 7) * 3) return null;
        return dimensions(be16(offset + 5), be16(offset + 3));
      }
      offset += segmentLength;
    }
  }
  return null;
}
