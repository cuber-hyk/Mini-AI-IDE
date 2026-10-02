/**
 * 编码探测与解码（纯逻辑，可单测）
 *
 * 为什么需要它：Windows 上的源代码文件不全是 UTF-8，GBK 很常见。
 * 按 UTF-8 硬读会得到乱码，而乱码送去给模型等于喂垃圾。
 *
 * 策略（按优先级）：
 *   1. BOM：UTF-8 / UTF-16LE / UTF-16BE —— 有 BOM 就按 BOM 解，去掉 BOM；
 *   2. 严格 UTF-8 校验：合法则按 UTF-8 解；
 *   3. 回退 GBK/GB18030；
 *   4. 含 NUL 字节视为二进制并拒绝。
 *
 * 实现约束：不使用第三方依赖 —— Node 自带完整 ICU，`TextDecoder('gbk')` 可直接用。
 */

export type DetectedEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gbk';

export interface DecodeResult {
  /** 解码后的文本（BOM 已剥离） */
  text: string;
  /** 实际采用的编码 */
  encoding: DetectedEncoding;
  /** 是否经过回退（UTF-8 校验失败后走 GBK） */
  fellBack: boolean;
  /** 原始字节长度 */
  byteLength: number;
}

export type DecodeFailureReason = 'binary';

export interface DecodeFailure {
  ok: false;
  reason: DecodeFailureReason;
  detail: string;
}

export type DecodeOutcome = ({ ok: true } & DecodeResult) | DecodeFailure;

const BOM_UTF8 = [0xef, 0xbb, 0xbf];
const BOM_UTF16LE = [0xff, 0xfe];
const BOM_UTF16BE = [0xfe, 0xff];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * 严格 UTF-8 校验（RFC 3629）。
 * 拒绝：孤立续字节、截断序列、过长编码、代理区码点、超出 U+10FFFF。
 */
export function isValidUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] as number;
    if (b0 <= 0x7f) {
      i += 1;
      continue;
    }
    let needed: number;
    let min: number;
    let code: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      needed = 1;
      min = 0x80;
      code = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      needed = 2;
      min = 0x800;
      code = b0 & 0x0f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      needed = 3;
      min = 0x10000;
      code = b0 & 0x07;
    } else {
      return false; // 0x80-0xc1、0xf5-0xff 均非法
    }
    if (i + needed >= bytes.length) return false; // 截断：续字节不足
    for (let k = 1; k <= needed; k += 1) {
      const bk = bytes[i + k] as number;
      if (bk < 0x80 || bk > 0xbf) return false;
      code = (code << 6) | (bk & 0x3f);
    }
    if (code < min) return false; // 过长编码
    if (code >= 0xd800 && code <= 0xdfff) return false; // 代理区
    if (code > 0x10ffff) return false; // 超出范围
    i += needed + 1;
  }
  return true;
}

/** 二进制判定：出现 NUL 字节（UTF-16 已由 BOM 分支处理） */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0x00) return true;
  }
  return false;
}

export function decodeTextFile(input: Uint8Array): DecodeOutcome {
  const bytes = input;
  const byteLength = bytes.length;

  // 1) BOM
  if (startsWith(bytes, BOM_UTF8)) {
    const body = bytes.subarray(BOM_UTF8.length);
    return {
      ok: true,
      text: new TextDecoder('utf-8').decode(body),
      encoding: 'utf-8-bom',
      fellBack: false,
      byteLength,
    };
  }
  if (startsWith(bytes, BOM_UTF16LE)) {
    const body = bytes.subarray(BOM_UTF16LE.length);
    return {
      ok: true,
      text: new TextDecoder('utf-16le').decode(body),
      encoding: 'utf-16le',
      fellBack: false,
      byteLength,
    };
  }
  if (startsWith(bytes, BOM_UTF16BE)) {
    const body = bytes.subarray(BOM_UTF16BE.length);
    return {
      ok: true,
      text: new TextDecoder('utf-16be').decode(body),
      encoding: 'utf-16be',
      fellBack: false,
      byteLength,
    };
  }

  // 2) 二进制拒绝
  if (looksBinary(bytes)) {
    return { ok: false, reason: 'binary', detail: '检测到 NUL 字节，判定为二进制文件' };
  }

  // 3) 严格 UTF-8
  if (isValidUtf8(bytes)) {
    return {
      ok: true,
      text: new TextDecoder('utf-8').decode(bytes),
      encoding: 'utf-8',
      fellBack: false,
      byteLength,
    };
  }

  // 4) 回退 GBK/GB18030
  try {
    return {
      ok: true,
      text: new TextDecoder('gbk').decode(bytes),
      encoding: 'gbk',
      fellBack: true,
      byteLength,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'binary',
      detail: `UTF-8 校验失败且 GBK 解码不可用：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
