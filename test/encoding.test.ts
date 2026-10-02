/**
 * 编码探测与解码的单元测试
 *
 * 重点覆盖 Windows 上的真实情况：UTF-8（含/不含 BOM）、GBK 回退、二进制拒绝。
 * 用 Node 内置测试运行器，不引第三方测试框架。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeTextFile, isValidUtf8 } from '../src/shared/encoding';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('isValidUtf8', () => {
  it('接受纯 ASCII', () => {
    assert.equal(isValidUtf8(utf8('hello world')), true);
  });

  it('接受合法中文 UTF-8', () => {
    assert.equal(isValidUtf8(utf8('你好，世界')), true);
  });

  it('拒绝孤立续字节', () => {
    assert.equal(isValidUtf8(new Uint8Array([0x41, 0x80, 0x42])), false);
  });

  it('拒绝截断的三字节序列', () => {
    assert.equal(isValidUtf8(new Uint8Array([0xe4, 0xbd])), false);
  });

  it('拒绝过长编码（0xc0 0x80）', () => {
    assert.equal(isValidUtf8(new Uint8Array([0xc0, 0x80])), false);
  });

  it('拒绝 0xf5 起始（超出 U+10FFFF）', () => {
    assert.equal(isValidUtf8(new Uint8Array([0xf5, 0x80, 0x80, 0x80])), false);
  });

  it('拒绝 UTF-8 编码的代理区码点（U+D800 -> ED A0 80）', () => {
    assert.equal(isValidUtf8(new Uint8Array([0xed, 0xa0, 0x80])), false);
  });
});

describe('decodeTextFile', () => {
  it('无 BOM 的 UTF-8 直接解码', () => {
    const out = decodeTextFile(utf8('const a = 1;\n'));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.encoding, 'utf-8');
    assert.equal(out.fellBack, false);
    assert.equal(out.text, 'const a = 1;\n');
  });

  it('识别并剥离 UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('hi')]);
    const out = decodeTextFile(bytes);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.encoding, 'utf-8-bom');
    assert.equal(out.text, 'hi');
  });

  it('识别 UTF-16LE BOM', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
    const out = decodeTextFile(bytes);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.encoding, 'utf-16le');
    assert.equal(out.text, 'AB');
  });

  it('GBK 字节回退解码为正确中文', () => {
    // "中文编码测试\n" 的 GBK 字节
    const gbk = new Uint8Array([
      0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xe0, 0xc2, 0xeb, 0xb2, 0xe2, 0xca, 0xd4, 0x0a,
    ]);
    const out = decodeTextFile(gbk);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.encoding, 'gbk');
    assert.equal(out.fellBack, true);
    assert.equal(out.text, '中文编码测试\n');
  });

  it('含 NUL 字节判定为二进制并拒绝', () => {
    const out = decodeTextFile(new Uint8Array([0x50, 0x4b, 0x00, 0x01, 0x02]));
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, 'binary');
  });

  it('空文件按 UTF-8 处理且文本为空', () => {
    const out = decodeTextFile(new Uint8Array([]));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.text, '');
    assert.equal(out.byteLength, 0);
  });
});
