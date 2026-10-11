import assert from 'node:assert/strict';
import { it } from 'node:test';
import { imageDimensions } from '../src/shared/imageDimensions';

it('PNG 和 GIF 在解码前给出真实尺寸，零尺寸与截断尺寸头拒绝', () => {
  const png = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(100000, 16); png.writeUInt32BE(90000, 20);
  assert.deepEqual(imageDimensions(png, 'image/png'), { width: 100000, height: 90000 });
  assert.equal(imageDimensions(png.subarray(0, 24), 'image/png'), null); png.writeUInt32BE(0, 16); assert.equal(imageDimensions(png, 'image/png'), null);
  const gif = Buffer.alloc(13); gif.write('GIF89a'); gif.writeUInt16LE(640, 6); gif.writeUInt16LE(480, 8);
  assert.deepEqual(imageDimensions(gif, 'image/gif'), { width: 640, height: 480 }); gif.write('GIF87a'); assert.equal(imageDimensions(gif, 'image/gif')?.width, 640);
  assert.equal(imageDimensions(gif.subarray(0, 9), 'image/gif'), null);
});

function webp(type: string, payload: number[]): Buffer {
  const bytes = Buffer.alloc(20 + payload.length); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WEBP', 8); bytes.write(type, 12); bytes.writeUInt32LE(payload.length, 16); Buffer.from(payload).copy(bytes, 20); return bytes;
}
it('WebP 有损、无损和扩展画布都按格式尺寸位读取，不把压缩帧当尺寸', () => {
  const lossy = webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0xc2, 0xe0, 0x81]);
  assert.deepEqual(imageDimensions(lossy, 'image/webp'), { width: 640, height: 480 });
  const width = 640 - 1; const height = 480 - 1;
  const lossless = webp('VP8L', [0x2f, width & 0xff, width >> 8 | (height & 3) << 6, height >> 2 & 0xff, height >> 10]);
  assert.deepEqual(imageDimensions(lossless, 'image/webp'), { width: 640, height: 480 });
  const extended = webp('VP8X', [0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual(imageDimensions(extended, 'image/webp'), { width: 16777216, height: 16777216 });
  lossless[24] |= 0xe0; assert.equal(imageDimensions(lossless, 'image/webp'), null);
  assert.equal(imageDimensions(lossy.subarray(0, 25), 'image/webp'), null);
  extended.writeUInt32LE(0xffffffff, 16); assert.equal(imageDimensions(extended, 'image/webp'), null);
});

function jpeg(marker = 0xc0): Buffer { return Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 6, 1, 2, 3, 4, 0xff, marker, 0, 11, 8, 1, 0xe0, 2, 0x80, 1, 1, 0x11, 0]); }
it('JPEG 跳过有界元数据，基线和渐进帧均可定位尺寸', () => {
  assert.deepEqual(imageDimensions(jpeg(), 'image/jpeg'), { width: 640, height: 480 });
  assert.deepEqual(imageDimensions(jpeg(0xc2), 'image/jpeg'), { width: 640, height: 480 });
  const filled = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), jpeg().subarray(2)]);
  assert.deepEqual(imageDimensions(filled, 'image/jpeg'), { width: 640, height: 480 });
});
it('JPEG 损坏段长度、熵编码内伪 SOF 和不支持 MIME 不得产生可信尺寸', () => {
  const malformed = jpeg(); malformed.writeUInt16BE(65535, 4); assert.equal(imageDimensions(malformed, 'image/jpeg'), null);
  malformed.writeUInt16BE(0, 4); assert.equal(imageDimensions(malformed, 'image/jpeg'), null);
  assert.equal(imageDimensions(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), jpeg().subarray(10)]), 'image/jpeg'), null);
  assert.equal(imageDimensions(jpeg().subarray(0, 17), 'image/jpeg'), null);
  assert.equal(imageDimensions(jpeg(), 'image/svg+xml'), null); assert.equal(imageDimensions(new Uint8Array(), 'image/png'), null);
});
