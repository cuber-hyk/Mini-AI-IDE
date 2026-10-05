/**
 * 校验 `build/icon.ico` 的负载是否真的嵌进了打包产物的 exe。
 *
 * 为什么需要：electron-builder 在图标没生效时**不报错**，日志里照样打印
 * `updating asar integrity executable resource` 与 `signing with signtool.exe`，
 * 看上去一切正常，实际 exe 里还是 Electron 默认图标。只有真去 exe 的字节里找
 * 一遍才能确认。
 *
 * 做法：把 ICO 里各档 PNG 负载逐个拿去在 exe 里搜索。比对时跳过 PNG 头几个字节
 * （长度/CRC 附近可能被工具重写），只要求一段足够长的数据块原样出现，
 * 既能容忍轻微改写，又不会误判。
 *
 * 用法：node tools/verify-icon-embedded.mjs [exe…]（默认查 release 下的产物）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const icoPath = path.join(repoRoot, 'build', 'icon.ico');
if (!fs.existsSync(icoPath)) {
  console.error('[verify-icon-embedded] 找不到 build/icon.ico，先跑 tools/gen-icon.mjs');
  process.exit(1);
}

/* 解析 ICO，取出各档 PNG 负载 */
const ico = fs.readFileSync(icoPath);
const count = ico.readUInt16LE(4);
const payloads = [];
for (let i = 0; i < count; i += 1) {
  const o = 6 + i * 16;
  const size = ico.readUInt32LE(o + 8);
  const offset = ico.readUInt32LE(o + 12);
  payloads.push({
    w: ico[o] || 256,
    h: ico[o + 1] || 256,
    png: ico.subarray(offset, offset + size),
  });
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  targets.push(
    path.join('release', 'win-unpacked', 'Mini-AI-IDE.exe'),
    path.join('release', 'Mini-AI-IDE-Portable-0.1.0-x64.exe'),
    path.join('release', 'Mini-AI-IDE-Setup-0.1.0-x64.exe'),
  );
}

/** 在 haystack 里找 needle 的首次出现位置，找不到返回 -1。 */
function indexOfBytes(haystack, needle) {
  return haystack.indexOf(needle);
}

let failed = false;
for (const rel of targets) {
  const file = path.resolve(repoRoot, rel);
  if (!fs.existsSync(file)) {
    console.log(`=== ${rel} ===\n  跳过：文件不存在\n`);
    continue;
  }
  const exe = fs.readFileSync(file);
  console.log(`=== ${rel}（${(exe.length / 1024 / 1024).toFixed(1)} MB）===`);

  let matched = 0;
  for (const { w, h, png } of payloads) {
    /*
     * 取中段做指纹：PNG 头（IHDR 的长度与 CRC）可能被写图标资源的工具重算，
     * 中段的像素数据则是原样的。
     *
     * 探针长度随负载收缩，确保**最小的 16×16 也能被检查到** —— 那一档是任务栏
     * 实际使用的尺寸，恰恰最需要确认。负载本身太小时（几百字节）无法可靠指纹，
     * 才跳过。
     */
    const probeLen = Math.min(384, Math.floor(png.length / 2));
    if (probeLen < 128) {
      console.log(`  --   ${w}×${h} 负载过小（${png.length} B），跳过指纹比对`);
      continue;
    }
    const from = Math.floor((png.length - probeLen) / 2);
    const probe = png.subarray(from, from + probeLen);
    const found = indexOfBytes(exe, probe) >= 0;
    if (found) matched += 1;
    console.log(`  ${found ? 'OK  ' : 'MISS'} ${w}×${h} 的像素数据${found ? '已在 exe 中找到' : '未在 exe 中找到'}`);
  }

  if (matched === 0) {
    console.log('  ✗ 没有任何一档图标数据出现在 exe 里 —— 图标没生效，exe 用的是默认图标');
    failed = true;
  } else {
    console.log(`  ✓ 共 ${matched} 档图标数据命中，图标已嵌入`);
  }
  console.log('');
}

process.exit(failed ? 1 : 0);
