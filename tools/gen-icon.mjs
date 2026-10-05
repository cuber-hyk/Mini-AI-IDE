/**
 * 应用图标生成器：产出 `build/icon.ico`（多档）+ `build/icon.png` + `build/icon-preview.png`。
 *
 * ## 两种模式
 *
 * 1. **从设计源图转换**（默认）：读 `assets/icon-source.png`，自动抠底、修圆角、
 *    抗锯齿降采样后打包成 ICO。
 * 2. **程序化绘制**（`--variant=split|orbit|bracket`）：纯代码画出图标，无需素材。
 *    保留它是为了「没有设计稿时也能出图标」，同时作为回归基准。
 *
 * ## 为什么自写而不引第三方库
 *
 * 仓库的 devDependencies 刻意保持极简（只为跑 Electron 而已），为一个图标引入
 * sharp / png-to-ico 得不偿失 —— 那会拖进原生模块或十几层传递依赖。这里只用
 * Node 内置的 `zlib`：自己解码 PNG、自己编码 PNG、自己封装 ICO。
 * 代价是下面这几百行编解码代码，收益是零新增依赖、零网络、完全可审计。
 *
 * ## 源图为什么要「转换」而不是直接用
 *
 * AI 生成的设计稿通常是 **RGB 无 alpha**，把「透明」画成了棋盘格像素，还带
 * 平台水印与投影。直接转 ICO 的后果是任务栏里出现一块灰色格子。所以必须：
 *   ① 识别主体包围盒 → ② 按真实圆角重新生成 alpha（SDF 抗锯齿）
 *   → ③ 裁掉边界外的水印/投影 → ④ 用积分图做面积平均降采样。
 *
 * 用法：
 *   node tools/gen-icon.mjs                     # 默认：从 assets/icon-source.png 转换
 *   node tools/gen-icon.mjs --from=<png>        # 指定源图
 *   node tools/gen-icon.mjs --out=<目录>         # 指定产物目录（默认 ./build）
 *   node tools/gen-icon.mjs --variant=bracket   # 程序化绘制指定方案
 *   node tools/gen-icon.mjs --preview           # 只出预览图，不写 icon.ico
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/*
 * 路径基准取**当前工作目录**，而不是脚本所在目录。
 *
 * 为什么不取脚本位置：这个脚本会被复制到别的项目里当构建工具用，那时
 * `脚本位置/..` 会指向项目之外，产物落到莫名其妙的地方。cwd 在
 * 「npm script / spawnSync」两种调用方式下都是项目根（npm 会把 cwd 设为
 * package 根），语义稳定。
 */
const baseDir = process.cwd();
/* 允许 --out=<目录> 改产物位置，便于在别的项目里把它当通用工具用 */
const outArg = process.argv.slice(2).find((a) => a.startsWith('--out='));
const outDir = outArg ? path.resolve(baseDir, outArg.split('=')[1]) : path.join(baseDir, 'build');
const outFile = path.join(outDir, 'icon.ico');

/** .ico 内嵌的各档尺寸。Windows 按场景挑：16 任务栏、32 列表、48 桌面、256 大图标视图。 */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/* ================================================================
 * 一、PNG 解码
 * ================================================================ */

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG 为 RGBA8。
 *
 * 支持位深 8/16、颜色类型 0(灰度)/2(RGB)/3(调色板)/4(灰度+alpha)/6(RGBA)。
 * **不支持交错（Adam7）** —— 遇到时明确报错，而不是悄悄解出一张错图。这是刻意
 * 的取舍：交错 PNG 在 AI 生成的素材里极少见，而 Adam7 解交织会让代码量翻倍；
 * 真遇到时用图像工具另存一次即可。
 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件（缺签名）');

  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const data = buf.subarray(off + 8, off + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (interlace !== 0) throw new Error('不支持交错（Adam7）PNG，请用图像工具另存为无交错格式');
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`不支持的位深：${bitDepth}`);

  const ch = CHANNELS[colorType];
  if (!ch) throw new Error(`不支持的颜色类型：${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  /* 16 位每样本 2 字节；反滤波按字节走，所以 stride 用字节数 */
  const bytesPerSample = bitDepth / 8;
  const bpp = ch * bytesPerSample;
  const stride = width * bpp;

  const flat = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = flat.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? flat.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      if (filterType === 1) v += a;
      else if (filterType === 2) v += b;
      else if (filterType === 3) v += (a + b) >> 1;
      else if (filterType === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
  }

  /* 统一转 RGBA8。16 位样本取高字节 —— 图标用不到 16 位精度。 */
  const out = new Uint8ClampedArray(width * height * 4);
  const sample = (i) => (bitDepth === 16 ? flat[i * 2] : flat[i]);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const si = y * stride + x * bpp;
      const di = (y * width + x) * 4;
      if (colorType === 0) {
        const g = sample(si);
        out[di] = g; out[di + 1] = g; out[di + 2] = g; out[di + 3] = 255;
      } else if (colorType === 4) {
        const g = sample(si);
        out[di] = g; out[di + 1] = g; out[di + 2] = g;
        out[di + 3] = sample(si + bytesPerSample);
      } else if (colorType === 2) {
        out[di] = sample(si);
        out[di + 1] = sample(si + bytesPerSample);
        out[di + 2] = sample(si + bytesPerSample * 2);
        out[di + 3] = 255;
      } else if (colorType === 6) {
        out[di] = sample(si);
        out[di + 1] = sample(si + bytesPerSample);
        out[di + 2] = sample(si + bytesPerSample * 2);
        out[di + 3] = sample(si + bytesPerSample * 3);
      } else { /* colorType === 3，调色板 */
        const idx = sample(si);
        out[di] = palette[idx * 3];
        out[di + 1] = palette[idx * 3 + 1];
        out[di + 2] = palette[idx * 3 + 2];
        /* tRNS 是「每个调色板项的 alpha」，缺省全不透明 */
        out[di + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
      }
    }
  }

  return { w: width, h: height, data: out };
}

/* ================================================================
 * 二、PNG 编码
 * ================================================================ */

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

/** 编码为 RGBA8 PNG。每行前置 filter 字节 0（None）。 */
function encodePng(canvas) {
  const { w, h, data } = canvas;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ================================================================
 * 三、画布原语（程序化绘制用）
 * ================================================================ */

function createCanvas(w, h) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

/** source-over 合成。抗锯齿边缘必须正确叠加，不能直接覆盖。 */
function put(canvas, x, y, rgb, alpha) {
  if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h || alpha <= 0) return;
  const i = (y * canvas.w + x) * 4;
  const a = alpha / 255;
  const dstA = canvas.data[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  for (let c = 0; c < 3; c += 1) {
    canvas.data[i + c] = Math.round((rgb[c] * a + canvas.data[i + c] * dstA * (1 - a)) / outA);
  }
  canvas.data[i + 3] = Math.round(outA * 255);
}

/**
 * 圆角矩形填充。传 `gradient` 时按像素 y 在 [顶色, 底色] 间插值。
 *
 * 用**标准的圆角矩形有向距离场**：
 *   q = |p - center| - (halfSize - r)
 *   d = length(max(q, 0)) + min(max(q.x, q.y), 0) - r
 * 内部点的 d 是负数（越深越负），因此覆盖率 clamp(0.5 - d) 在内部自然取到 1。
 *
 * ⚠️ 曾经写成「只算到四角圆弧的距离」，那样内部点的 d 恒为 0，
 * 覆盖率被算成 0.5 —— 结果是**整个形状半透明**。在深色图标上不明显，
 * 但画预览图的深色底板时，本该近黑的底会显示成中灰，一眼就能看出不对。
 */
function fillRoundRect(canvas, x0, y0, w, h, radius, rgb, alpha = 255, gradient = null) {
  const r = Math.min(radius, w / 2, h / 2);
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const halfW = w / 2 - r;
  const halfH = h / 2 - r;

  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y += 1) {
    const t = gradient ? Math.max(0, Math.min(1, (y - y0) / h)) : 0;
    const color = gradient
      ? [0, 1, 2].map((c) => Math.round(gradient[0][c] + (gradient[1][c] - gradient[0][c]) * t))
      : rgb;
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x += 1) {
      const qx = Math.abs(x + 0.5 - cx) - halfW;
      const qy = Math.abs(y + 0.5 - cy) - halfH;
      const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const cov = Math.max(0, Math.min(1, 0.5 - dist));
      if (cov <= 0) continue;
      put(canvas, x, y, color, Math.round(alpha * cov));
    }
  }
}

function fillCircle(canvas, cx, cy, radius, rgb, alpha = 255) {
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y += 1) {
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x += 1) {
      const cov = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
      if (cov <= 0) continue;
      put(canvas, x, y, rgb, Math.round(alpha * cov));
    }
  }
}

/** 旋转椭圆描边。用于轨道环。 */
function strokeArc(canvas, cx, cy, radiusX, radiusY, rotation, thickness, rgb, alpha = 255) {
  const steps = Math.max(48, Math.ceil(radiusX * 3));
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  for (let i = 0; i <= steps; i += 1) {
    const t = (Math.PI * 2 * i) / steps;
    const ex = radiusX * Math.cos(t);
    const ey = radiusY * Math.sin(t);
    fillCircle(canvas, cx + ex * cos - ey * sin, cy + ex * sin + ey * cos, thickness / 2, rgb, alpha);
  }
}

function strokePolyline(canvas, points, thickness, rgb, alpha = 255) {
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      fillCircle(canvas, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thickness / 2, rgb, alpha);
    }
  }
}

/* ================================================================
 * 四、程序化方案（无素材时的备选）
 * ================================================================ */

const BASE = { top: [0x2b, 0x3d, 0x63], bottom: [0x10, 0x14, 0x20] };
const INK = { white: [0xf2, 0xf5, 0xfb], dim: [0xa8, 0xb2, 0xca], accent: [0x7d, 0xb2, 0xff] };

/**
 * 每个方案接收已画好底板的 canvas 与基准单位 `u`（= size/32）。
 * 坐标一律用「格」（0..32），画时乘 `u` —— 混用两种尺度会出现
 * 「元素跑到画布外」这种很难一眼看出的错。
 */
const VARIANTS = {
  split: (c, u) => {
    const x0 = 4.6;
    const rows = [
      { y: 10.6, w: 8.2, cur: true },
      { y: 14.6, w: 6.0, cur: false },
      { y: 18.6, w: 9.0, cur: false },
      { y: 22.6, w: 5.0, cur: false },
    ];
    for (const { y, w, cur } of rows) {
      if (cur) fillRoundRect(c, x0 * u, (y - 1.05) * u, 1.3 * u, 2.1 * u, 0.65 * u, INK.accent, 255);
      strokePolyline(c, [[(x0 + 2.2) * u, y * u], [(x0 + 2.2 + w) * u, y * u]], 2.0 * u,
        cur ? INK.white : INK.dim, cur ? 255 : 215);
    }
    fillRoundRect(c, 17.4 * u, 7.0 * u, 1.0 * u, 18.0 * u, 0.5 * u, INK.dim, 120);
    fillRoundRect(c, 19.8 * u, 8.8 * u, 9.0 * u, 10.8 * u, 2.6 * u, INK.accent, 255);
    fillCircle(c, 22.4 * u, 20.8 * u, 1.1 * u, INK.accent, 255);
    for (const [i, y] of [12.2, 15.0, 17.8].entries()) {
      strokePolyline(c, [[21.8 * u, y * u], [21.8 * u + (i === 2 ? 3.0 : 5.2) * u, y * u]], 1.5 * u,
        [0x14, 0x1d, 0x30], 235);
    }
  },
  orbit: (c, u) => {
    const cx = 16 * u, cy = 16 * u, r = 10.6 * u;
    for (const angle of [-Math.PI / 3, Math.PI / 3, 0]) {
      strokeArc(c, cx, cy, r, r * 0.42, angle, 2.1 * u, INK.white, 240);
      fillCircle(c, cx + r * Math.cos(angle), cy + r * Math.sin(angle), 1.9 * u, INK.accent, 255);
    }
    fillCircle(c, cx, cy, 3.4 * u, INK.accent, 255);
    fillCircle(c, cx, cy, 1.7 * u, [0xff, 0xff, 0xff], 255);
  },
  bracket: (c, u) => {
    const cy = 16 * u;
    strokePolyline(c, [[13.4 * u, 6.8 * u], [6.8 * u, cy], [13.4 * u, 25.2 * u]], 2.8 * u, INK.white, 248);
    strokePolyline(c, [[18.6 * u, 6.8 * u], [25.2 * u, cy], [18.6 * u, 25.2 * u]], 2.8 * u, INK.white, 248);
    fillRoundRect(c, 14.9 * u, 9.6 * u, 2.1 * u, 10.4 * u, 1.05 * u, INK.accent, 255);
    fillRoundRect(c, 12.4 * u, 21.8 * u, 7.2 * u, 2.0 * u, 1.0 * u, INK.accent, 255);
  },
};

function drawProgrammatic(size, variantName) {
  const c = createCanvas(size, size);
  const u = size / 32;
  fillRoundRect(c, 0, 0, size, size, 7.2 * u, null, 255, [BASE.top, BASE.bottom]);

  /* 顶部高光按行递减 alpha 渐隐 —— 用实心矩形压白会切出一道硬横线 */
  const glossH = Math.round(size * 0.5);
  for (let y = 0; y < glossH; y += 1) {
    const t = 1 - y / glossH;
    const a = Math.round(16 * t * t);
    if (a <= 0) continue;
    for (let x = 0; x < size; x += 1) put(c, x, y, [0xff, 0xff, 0xff], a);
  }

  VARIANTS[variantName](c, u);
  return c;
}

/* ================================================================
 * 五、从设计源图转换
 * ================================================================ */

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * 判定主体（图标本体）与背景（棋盘格 / 纯色底 / 投影）。
 *
 * 为什么不能简单用「与背景色距离」：设计稿的方块外侧通常有一圈柔和投影，
 * 它的颜色和背景差得不小，会把包围盒撑大一圈。这里用**亮度**判定 ——
 * 主体是深沉底色，投影和棋盘格都明显更亮，能干净分开。
 *
 * 背景偏亮（luma > 128）时判「比背景暗 60 以上」为主体；
 * 背景偏暗时退回「与背景色距离 > 60」，兼顾深色底的设计稿。
 */
function makeSubjectTest(rgba, w, h) {
  const probes = [
    [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
    [Math.floor(w / 2), 0], [Math.floor(w / 2), h - 1],
    [0, Math.floor(h / 2)], [w - 1, Math.floor(h / 2)],
  ];
  let sum = 0;
  for (const [x, y] of probes) {
    const i = (y * w + x) * 4;
    sum += luma(rgba[i], rgba[i + 1], rgba[i + 2]);
  }
  const bgLuma = sum / probes.length;
  if (bgLuma > 128) {
    return { bgLuma, isSubject: (r, g, b) => luma(r, g, b) < bgLuma - 60 };
  }
  const bg = [rgba[0], rgba[1], rgba[2]];
  return {
    bgLuma,
    isSubject: (r, g, b) => Math.hypot(r - bg[0], g - bg[1], b - bg[2]) > 60,
  };
}

/**
 * 扫描主体包围盒。
 *
 * 判据是**每行/每列的主体像素数占比**，而不是「有没有主体像素」。这一点很关键：
 * 设计稿常带水印、签名、小字标注，它们也是「非背景」像素，但只要按数量设阈值，
 * 就能把只有零星像素的水印挡在外面。之前用「连续 2 个像素」做判据，水印把包围盒
 * 撑大了 150px，导致裁切错位。
 */
function findSubjectBounds(rgba, w, h, isSubject) {
  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return isSubject(rgba[i], rgba[i + 1], rgba[i + 2]);
  };

  /* 一行里主体像素超过 15% 宽度才算「属于图标」的行 */
  const rowThreshold = Math.max(8, Math.round(w * 0.15));
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y += 1) {
    let count = 0;
    for (let x = 0; x < w; x += 1) if (at(x, y)) count += 1;
    if (count >= rowThreshold) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) throw new Error('在源图里找不到图标主体，请检查背景是否明显区别于图标');

  /* 再在 [top, bottom] 区间内按同样思路定左右边界 */
  const colThreshold = Math.max(8, Math.round((bottom - top + 1) * 0.15));
  let left = -1;
  let right = -1;
  for (let x = 0; x < w; x += 1) {
    let count = 0;
    for (let y = top; y <= bottom; y += 1) if (at(x, y)) count += 1;
    if (count >= colThreshold) {
      if (left < 0) left = x;
      right = x;
    }
  }
  if (left < 0) throw new Error('在源图里找不到图标主体的水平边界');

  return { left, top, right, bottom, w: right - left + 1, h: bottom - top + 1 };
}

/**
 * 由圆角弧上的采样点反解圆角半径。
 *
 * 原理：圆角矩形在距顶边 `dy` 处的左边界相对包围盒内缩
 *   d = r - √(r² - (r - dy)²)
 * 反解得 r = d + dy + √(2·d·dy)。对多个 dy 求解后取中位数，抗单点噪声。
 */
function detectCornerRadius(rgba, w, isSubject, bounds) {
  const estimates = [];
  for (const dy of [2, 4, 6, 10, 14, 18, 24]) {
    const y = bounds.top + dy;
    if (y > bounds.bottom) break;
    let xLeft = -1;
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      const i = (y * w + x) * 4;
      if (isSubject(rgba[i], rgba[i + 1], rgba[i + 2])) { xLeft = x; break; }
    }
    if (xLeft < 0) continue;
    const d = xLeft - bounds.left;
    if (d <= 0) continue;
    estimates.push(d + dy + Math.sqrt(2 * d * dy));
  }
  if (estimates.length === 0) return null;
  estimates.sort((a, b) => a - b);
  return estimates[Math.floor(estimates.length / 2)];
}

/**
 * 把源图转成「正方形 + 真 alpha」的画布。
 *
 * 步骤：定位主体 → 裁成正方形 → 按检测到的圆角生成 SDF alpha。
 * 圆角遮罩**略微内缩 1.5px**：源图边缘本身有抗锯齿（深蓝↔棋盘格的混合像素），
 * 若不内缩，这些半混合像素会被当作不透明内容保留，边缘泛灰。
 */
function convertSourceImage(rgba, w, h) {
  const { bgLuma, isSubject } = makeSubjectTest(rgba, w, h);
  const b = findSubjectBounds(rgba, w, h, isSubject);
  const detected = detectCornerRadius(rgba, w, isSubject, b);
  const side = Math.max(b.w, b.h);
  const inset = 1.5;
  const r = detected ?? Math.round(side * 0.232);

  console.log(`[gen-icon] 源图 ${w}×${h}，背景亮度 ${bgLuma.toFixed(0)}`);
  console.log(`[gen-icon] 主体包围盒 ${b.w}×${b.h} @ (${b.left},${b.top})，圆角半径 ${r.toFixed(0)}（占边长 ${(r / side * 100).toFixed(1)}%）`);

  /* 以主体中心为中心裁正方形 */
  const ox = Math.round(b.left + b.w / 2 - side / 2);
  const oy = Math.round(b.top + b.h / 2 - side / 2);

  const out = createCanvas(side, side);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const sx = ox + x;
      const sy = oy + y;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const si = (sy * w + sx) * 4;
      const di = (y * side + x) * 4;
      out.data[di] = rgba[si];
      out.data[di + 1] = rgba[si + 1];
      out.data[di + 2] = rgba[si + 2];
      out.data[di + 3] = 255;
    }
  }

  /* 圆角 SDF 遮罩（内缩 inset，抗锯齿覆盖率由距离场给出） */
  const rr = Math.max(1, r - inset);
  const bcx = side / 2;
  const bcy = side / 2;
  const halfW = side / 2 - inset - rr;
  const halfH = side / 2 - inset - rr;
  let cleared = 0;
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const qx = Math.abs(x + 0.5 - bcx) - halfW;
      const qy = Math.abs(y + 0.5 - bcy) - halfH;
      const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
      const cov = Math.max(0, Math.min(1, 0.5 - dist));
      if (cov >= 1) continue;
      const di = (y * side + x) * 4;
      if (cov <= 0) {
        out.data[di + 3] = 0;
        cleared += 1;
      } else {
        out.data[di + 3] = Math.round(out.data[di + 3] * cov);
      }
    }
  }
  console.log(`[gen-icon] 圆角遮罩：清除 ${cleared} 个方块外像素（约 ${(cleared / (side * side) * 100).toFixed(1)}%）`);

  return out;
}

/* ================================================================
 * 六、面积平均降采样
 * ================================================================ */

/**
 * 用积分图（summed-area table）做面积平均降采样。
 *
 * 为什么不逐像素 box filter：1536→16 时每个输出像素要平均约 9600 个源像素，
 * 7 档累计超过 10^8 次操作。积分图把任意矩形求和降到 O(1)。
 *
 * **预乘 alpha** 是关键：遮罩后边缘像素 alpha 是渐变的，若直接对 RGBA 各通道
 * 独立平均，透明区域的颜色会被算进 RGB，边缘出现灰边。正确做法是先乘 alpha
 * 再平均，最后由平均 alpha 还原。
 */
function buildIntegral(canvas) {
  const { w, h, data } = canvas;
  const si = w + 1;
  const r = new Float64Array(si * (h + 1));
  const g = new Float64Array(si * (h + 1));
  const b = new Float64Array(si * (h + 1));
  const a = new Float64Array(si * (h + 1));

  for (let y = 0; y < h; y += 1) {
    let rowR = 0, rowG = 0, rowB = 0, rowA = 0;
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const alpha = data[i + 3] / 255;
      rowR += data[i] * alpha;
      rowG += data[i + 1] * alpha;
      rowB += data[i + 2] * alpha;
      rowA += data[i + 3];
      const di = (y + 1) * si + (x + 1);
      r[di] = r[di - si] + rowR;
      g[di] = g[di - si] + rowG;
      b[di] = b[di - si] + rowB;
      a[di] = a[di - si] + rowA;
    }
  }
  return { r, g, b, a, si };
}

function resampleArea(src, dw, dh) {
  const { r, g, b, a, si } = buildIntegral(src);
  const out = createCanvas(dw, dh);
  const scaleX = src.w / dw;
  const scaleY = src.h / dh;

  /* 矩形求和：I[y1][x1] - I[y0][x1] - I[y1][x0] + I[y0][x0] */
  const rect = (plane, x0, y0, x1, y1) =>
    plane[y1 * si + x1] - plane[y0 * si + x1] - plane[y1 * si + x0] + plane[y0 * si + x0];

  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(src.h, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(src.w, Math.ceil((x + 1) * scaleX)));
      const sumA = rect(a, x0, y0, x1, y1);
      if (sumA <= 0) continue;
      const n = (x1 - x0) * (y1 - y0);
      const di = (y * dw + x) * 4;
      /*
       * 预乘还原。注意量纲：积分图里 RGB 存的是 `rgb × (a/255)`（a 归一化到 0..1），
       * 而 alpha 积分存的是 `a`（0..255）。所以
       *   颜色 = Σ(rgb·a/255) / Σ(a/255) = rect(rgb) × 255 / Σa
       * 直接写 `rect(rgb) / Σa` 会少乘 255，整张图变成近黑色 —— 这个错误在
       * 单色图标上看不出来（本来就是深色），只有细看色值才发现。
       */
      out.data[di] = Math.round((rect(r, x0, y0, x1, y1) * 255) / sumA);
      out.data[di + 1] = Math.round((rect(g, x0, y0, x1, y1) * 255) / sumA);
      out.data[di + 2] = Math.round((rect(b, x0, y0, x1, y1) * 255) / sumA);
      out.data[di + 3] = Math.round(sumA / n);
    }
  }
  return out;
}

/* ================================================================
 * 七、ICO 容器
 * ================================================================ */

/**
 * ICONDIR：6 字节头 + 每档 16 字节目录项 + 各档 PNG 负载。
 * 全部用 PNG 存储（Vista+ 支持；目标平台是 Windows 10/11）。
 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dirs = [];
  for (const { size, png } of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = size >= 256 ? 0 : size;
    dir[1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += png.length;
    dirs.push(dir);
  }
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.png)]);
}

/* ================================================================
 * 八、预览图
 * ================================================================ */

/** 把 canvas 缩放后贴到目标画布（走同一条预乘降采样链，避免边缘灰边）。 */
function blitScaled(dst, src, dx, dy, dw) {
  const scaled = dw === src.w ? src : resampleArea(src, dw, Math.max(1, Math.round((src.h / src.w) * dw)));
  for (let y = 0; y < scaled.h; y += 1) {
    for (let x = 0; x < scaled.w; x += 1) {
      const i = (y * scaled.w + x) * 4;
      if (scaled.data[i + 3] <= 0) continue;
      put(dst, dx + x, dy + y, [scaled.data[i], scaled.data[i + 1], scaled.data[i + 2]], scaled.data[i + 3]);
    }
  }
  return scaled;
}

/**
 * 生成对比预览：同一图标在**浅色与深色两种背景**下的 168 / 48 / 32 / 16 表现。
 * 深色那一行对应 Windows 深色任务栏 —— 图标在浅底上好看、在深底上糊掉，
 * 是图标最常见的翻车点，必须两种底都过一遍。
 */
function buildPreviewSheet(master) {
  const pad = 24;
  const bigSize = 168;
  const smalls = [48, 32, 16];
  const labelGap = 24;
  const rowGap = 24;

  const rowW = bigSize + 26 + smalls.reduce((s, v) => s + v + 14, 0);
  const w = pad * 2 + rowW;
  const h = pad * 2 + (bigSize + labelGap) * 2 + rowGap;
  const sheet = createCanvas(w, h);

  /* 上半浅色底、下半深色底（模拟任务栏） */
  fillRoundRect(sheet, 0, 0, w, Math.round(h / 2), 0, [0xf1, 0xf3, 0xf7], 255);
  fillRoundRect(sheet, 0, Math.round(h / 2), w, h - Math.round(h / 2), 0, [0x1b, 0x1d, 0x22], 255);

  for (const rowY of [pad + labelGap, Math.round(h / 2) + pad + labelGap]) {
    let x = pad;
    const scaled = blitScaled(sheet, master, x, rowY, bigSize);
    x += bigSize + 26;
    for (const s of smalls) {
      /* 小尺寸与大图垂直居中对齐 */
      blitScaled(sheet, master, x, rowY + Math.round((scaled.h - s) / 2), s);
      x += s + 14;
    }
  }
  return sheet;
}

/* ================================================================
 * 九、主流程
 * ================================================================ */

const args = process.argv.slice(2);
const fromArg = args.find((a) => a.startsWith('--from='));
const variantArg = args.find((a) => a.startsWith('--variant='));
const previewOnly = args.includes('--preview');

fs.mkdirSync(outDir, { recursive: true });

let master;
let modeLabel;

if (variantArg) {
  const variant = variantArg.split('=')[1];
  if (!(variant in VARIANTS)) {
    console.error(`未知方案：${variant}。可选：${Object.keys(VARIANTS).join(' / ')}`);
    process.exit(1);
  }
  /* 程序化模式也先画在高分辨率，再走同一条降采样链，保证两种模式输出质量一致 */
  master = drawProgrammatic(512, variant);
  modeLabel = `程序化方案 ${variant}`;
} else {
  const sourcePath = path.resolve(baseDir, fromArg ? fromArg.split('=')[1] : 'assets/icon-source.png');
  if (!fs.existsSync(sourcePath)) {
    console.error(`[gen-icon] 找不到源图：${path.relative(baseDir, sourcePath)}`);
    console.error('[gen-icon] 请放置设计源图，或用 --variant=<方案> 走程序化绘制');
    process.exit(1);
  }
  console.log(`[gen-icon] 源图：${path.relative(baseDir, sourcePath)}`);
  const decoded = decodePng(fs.readFileSync(sourcePath));
  master = convertSourceImage(decoded.data, decoded.w, decoded.h);
  modeLabel = '设计源图';
}

/** 日志里显示相对 cwd 的路径，用 --out 时也能显示对实际位置。 */
const rel = (p) => path.relative(baseDir, p) || path.basename(p);

fs.writeFileSync(path.join(outDir, 'icon-preview.png'), encodePng(buildPreviewSheet(master)));
console.log(`[gen-icon] 预览图：${rel(path.join(outDir, 'icon-preview.png'))}（上浅底 / 下深底）`);

if (previewOnly) {
  console.log('[gen-icon] --preview 模式，未写 icon.ico');
  process.exit(0);
}

const entries = SIZES.map((size) => ({ size, png: encodePng(resampleArea(master, size, size)) }));
fs.writeFileSync(outFile, buildIco(entries));
console.log(`[gen-icon] 完成：${rel(outFile)}（${modeLabel}，${SIZES.length} 档：${SIZES.join('/')}，${(fs.statSync(outFile).size / 1024).toFixed(1)} KB）`);

fs.writeFileSync(path.join(outDir, 'icon.png'), entries.find((e) => e.size === 256).png);
console.log(`[gen-icon] 完成：${rel(path.join(outDir, 'icon.png'))}（256×256）`);
