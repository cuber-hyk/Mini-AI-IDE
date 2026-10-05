/**
 * 生成打包用的应用图标 `build/icon.ico`。
 *
 * 为什么需要自写而不是引第三方库：仓库的 devDependencies 是刻意保持极简的
 * （只为了跑 Electron 而已），为一个图标引入 sharp / png-to-ico 得不偿失。
 * 这里直接用 Node 内置的 `zlib` 手写 PNG，再用 PNG-in-ICO 容器封装成 .ico，
 * 零新增依赖、零网络。
 *
 * 图案：与 IDE 布局同构的「左编辑器 / 右网页」双栏，取自 design-tokens.json 的配色。
 *
 * 用法：node tools/gen-icon.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const outDir = path.join(repoRoot, 'build');
const outFile = path.join(outDir, 'icon.ico');

/* 与 design-tokens.json 保持一致 */
const COLOR = {
  bg: [0x1e, 0x21, 0x28],
  bgDeep: [0x16, 0x18, 0x1d],
  border: [0x2b, 0x2f, 0x38],
  accent: [0x5b, 0x8d, 0xef],
  text: [0xd8, 0xdb, 0xe2],
  muted: [0x8b, 0x93, 0xa1],
};

/** .ico 内嵌的各档尺寸。Windows 会按场景挑最合适的一档。 */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/* ---------- 画布 ---------- */

function createCanvas(size) {
  return { size, data: new Uint8ClampedArray(size * size * 4) };
}

function put(canvas, x, y, rgb, alpha) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size || alpha <= 0) return;
  const i = (y * canvas.size + x) * 4;
  const a = alpha / 255;
  const dstA = canvas.data[i + 3] / 255;
  /* 以 source-over 合成，避免直接覆盖已有像素的边缘 */
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  for (let c = 0; c < 3; c += 1) {
    canvas.data[i + c] = Math.round((rgb[c] * a + canvas.data[i + c] * dstA * (1 - a)) / outA);
  }
  canvas.data[i + 3] = Math.round(outA * 255);
}

/** 抗锯齿填充一个轴对齐矩形：在边界 1px 内按覆盖率混合。 */
function fillRect(canvas, x0, y0, w, h, rgb, alpha = 255) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
      /* 覆盖率 = 与目标像素的重叠比例 */
      const cov = Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0)) *
        Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0));
      if (cov <= 0) continue;
      put(canvas, x, y, rgb, Math.round(alpha * cov));
    }
  }
}

/** 圆角矩形：四角用圆形遮罩裁切。 */
function fillRoundRect(canvas, x0, y0, w, h, radius, rgb, alpha = 255) {
  const r = Math.min(radius, w / 2, h / 2);
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      /* 到最近角心的距离 */
      const dx = Math.max(x0 + r - px, 0, px - (x0 + w - r));
      const dy = Math.max(y0 + r - py, 0, py - (y0 + h - r));
      const dist = Math.hypot(dx, dy);
      const cov = Math.max(0, Math.min(1, r + 0.5 - dist));
      if (cov <= 0) continue;
      put(canvas, x, y, rgb, Math.round(alpha * cov));
    }
  }
}

/* ---------- 图标造型 ---------- */

/**
 * 按比例绘制，尺寸无关（同一套代码覆盖 16 → 256）。
 * 布局对应 IDE 的「左编辑器 / 右网页」双栏。
 */
function drawIcon(size) {
  const c = createCanvas(size);
  const u = size / 32; /* 基准网格 32×32 */

  /* 底板：深色圆角方块 */
  fillRoundRect(c, 0, 0, size, size, 7 * u, COLOR.bg, 255);
  /* 顶部一条更深的标题栏，强化「应用窗口」语义 */
  fillRoundRect(c, 0, 0, size, 5.5 * u, 7 * u, COLOR.bgDeep, 255);
  fillRect(c, 0, 5.5 * u, size, 1.2 * u, COLOR.bgDeep, 255);

  /* 标题栏三个圆点 */
  for (let i = 0; i < 3; i += 1) {
    const cx = (4.5 + i * 3.4) * u;
    const cy = 2.9 * u;
    fillRoundRect(c, cx - 0.7 * u, cy - 0.7 * u, 1.4 * u, 1.4 * u, 0.7 * u,
      i === 0 ? COLOR.accent : COLOR.border, 255);
  }

  const bodyTop = 8.5 * u;
  const bodyH = size - bodyTop - 3.5 * u;

  /* 左：编辑器 —— 左侧一条 accent 色竖条表示当前行，其上三条不同长度的代码线 */
  fillRoundRect(c, 4.5 * u, bodyTop, 10.5 * u, bodyH, 1.2 * u, COLOR.bgDeep, 255);
  fillRect(c, 4.5 * u, bodyTop, 1.1 * u, bodyH, COLOR.accent, 255);
  const lineWidths = [6.4, 8.2, 4.6, 7.0];
  lineWidths.forEach((w, i) => {
    const y = bodyTop + 1.5 * u + i * 2.1 * u;
    fillRoundRect(c, 7.0 * u, y, w * u, 1.0 * u, 0.5 * u, COLOR.text, i === 0 ? 255 : 170);
  });

  /* 中缝：分栏线 */
  fillRect(c, 16.6 * u, bodyTop, 0.7 * u, bodyH, COLOR.border, 255);

  /* 右：网页 —— 顶部一条地址栏 + 下方两块内容，暗示「网页只读视图」 */
  fillRoundRect(c, 18.3 * u, bodyTop, 9.2 * u, bodyH, 1.2 * u, COLOR.bgDeep, 255);
  fillRoundRect(c, 19.3 * u, bodyTop + 1.2 * u, 7.2 * u, 1.7 * u, 0.85 * u, COLOR.border, 255);
  fillRoundRect(c, 19.3 * u, bodyTop + 4.0 * u, 7.2 * u, 2.0 * u, 0.9 * u, COLOR.muted, 130);
  fillRoundRect(c, 19.3 * u, bodyTop + 6.6 * u, 4.6 * u, 2.0 * u, 0.9 * u, COLOR.muted, 90);

  /* 外描边，收紧边缘避免深色背景上「糊掉」 */
  fillRoundRect(c, 0.35 * u, 0.35 * u, size - 0.7 * u, size - 0.7 * u, 6.6 * u, COLOR.border, 150);

  return c;
}

/* ---------- PNG 编码 ---------- */

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(canvas) {
  const { size, data } = canvas;
  /* 每行前置 filter 字节 0（None） */
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(data.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; /* bit depth */
  ihdr[9] = 6; /* color type: RGBA */
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- ICO 容器 ---------- */

/**
 * ICO 的 ICONDIR：6 字节头 + 每档 16 字节目录项，随后各档 PNG 负载。
 * 所有尺寸的图像都声明为 PNG（Vista+ 支持；Windows 10/11 是目标平台，稳妥）。
 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); /* reserved */
  header.writeUInt16LE(1, 2); /* type: icon */
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dirs = [];
  for (const { size, png } of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = size >= 256 ? 0 : size; /* 0 表示 256 */
    dir[1] = size >= 256 ? 0 : size;
    dir[2] = 0; /* 调色板 */
    dir[3] = 0; /* reserved */
    dir.writeUInt16LE(1, 4); /* color planes */
    dir.writeUInt16LE(32, 6); /* bits per pixel */
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += png.length;
    dirs.push(dir);
  }
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.png)]);
}

/* ---------- 主流程 ---------- */

fs.mkdirSync(outDir, { recursive: true });
const entries = SIZES.map((size) => ({ size, png: encodePng(drawIcon(size)) }));
fs.writeFileSync(outFile, buildIco(entries));
console.log(`[gen-icon] 完成：${path.relative(repoRoot, outFile)}（${SIZES.length} 档：${SIZES.join('/')}，${(fs.statSync(outFile).size / 1024).toFixed(1)} KB）`);

/* 顺带出一张 256 PNG，方便在 README / 商店素材里复用 */
const png256 = path.join(outDir, 'icon.png');
fs.writeFileSync(png256, entries.find((e) => e.size === 256).png);
console.log(`[gen-icon] 完成：${path.relative(repoRoot, png256)}`);
