/**
 * 校验 `build/icon.ico` 是否满足 electron-builder 的嵌图要求。
 *
 * 为什么需要单独校验：electron-builder 在打不进图标时**不报错**，
 * 只是静默沿用 Electron 默认图标 —— 到用户看到 exe 才发现，为时已晚。
 * 这里把「icon 文件本身是否合格」变成一条可执行的检查。
 *
 * 检查项：
 *   1. ICO 头（reserved=0, type=1, count≥1）
 *   2. 每档的 PNG 负载签名是否正确（Vista+ 允许 PNG-in-ICO）
 *   3. 偏移与长度是否落在文件范围内（截断的图标会让 builder 报很难懂的错）
 *   4. 是否含 256×256（builder 对最大档有硬要求，缺了可能整份图标被丢）
 *
 * 用法：node tools/verify-icon.mjs [ico 路径]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const file = path.resolve(process.argv[2] ?? 'build/icon.ico');
const buf = fs.readFileSync(file);
const problems = [];
const ok = (msg) => console.log(`  OK  ${msg}`);
const bad = (msg) => { problems.push(msg); console.log(`  ✗   ${msg}`); };

console.log(`=== ${path.basename(file)}（${(buf.length / 1024).toFixed(1)} KB）===`);

/* ICO 头：6 字节 */
if (buf.length < 6 + 16) {
  bad('文件太小，不可能是合法 ICO');
  process.exit(1);
}
const reserved = buf.readUInt16LE(0);
const type = buf.readUInt16LE(2);
const count = buf.readUInt16LE(4);

if (reserved === 0) ok('reserved = 0'); else bad(`reserved 应为 0，实际 ${reserved}`);
if (type === 1) ok('type = 1（icon）'); else bad(`type 应为 1（icon），实际 ${type}`);
if (count >= 1) ok(`共 ${count} 档尺寸`); else bad('档数为 0');

const PNG_SIG = '89504e470d0a1a0a';
const sizes = [];
for (let i = 0; i < count; i += 1) {
  const o = 6 + i * 16;
  const w = buf[o] || 256;
  const h = buf[o + 1] || 256;
  const bytes = buf.readUInt32LE(o + 8);
  const offset = buf.readUInt32LE(o + 12);
  sizes.push({ w, h });

  /* 目录项自身的 16 字节不能越过文件尾 */
  if (o + 16 > buf.length) {
    bad(`第 ${i + 1} 档目录项越界（offset ${o}）`);
    continue;
  }
  if (offset + bytes > buf.length) {
    bad(`${w}×${h} 负载越界：offset ${offset} + ${bytes} > ${buf.length}`);
    continue;
  }
  const sig = buf.subarray(offset, offset + 8).toString('hex');
  if (sig === PNG_SIG) ok(`${w}×${h}  ${(bytes / 1024).toFixed(1)} KB  PNG 负载`);
  else bad(`${w}×${h} 负载不是 PNG（签名 ${sig}）—— builder 只认 PNG-in-ICO`);
}

if (sizes.some((s) => s.w === 256 && s.h === 256)) {
  ok('含 256×256 档');
} else {
  bad('缺 256×256 档 —— electron-builder 可能整份忽略该图标');
}

console.log('');
if (problems.length === 0) {
  console.log('图标合格。');
} else {
  console.log(`发现 ${problems.length} 个问题。`);
  process.exit(1);
}
