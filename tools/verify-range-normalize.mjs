/**
 * 离线运行 selfTest.ts 的 J8-J11：范围只表示原文区间，区间外内容完整保留。
 * 保留既有 npm run verify:range 入口，在无 GUI 的环境验证 dist 产物。
 */
import { parseModelReply, computeApply } from '../dist/shared/returnPath.js';
let pass = 0;
let fail = 0;
const add = (id, name, cond) => {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${id}  ${name}`);
};
  /* ---- J8-J11) 原区间固定，新内容增减行，区间外原文不变 ---- */
  const rangeLines = Array.from({ length: 25 }, (_, i) => `原第 ${i + 1} 行`);
  rangeLines[10] = '}';
  rangeLines[11] = '';
  const replacement = [...Array.from({ length: 7 }, (_, i) => `新增 ${i + 1}`), '}', '', '最后一行'];
  const rangeBlock = parseModelReply(
    ['### 范围：10-10', '````', ...replacement, '````'].join('\n')
  ).blocks[0];
  const rangeApplied = computeApply(rangeLines.join('\n'), rangeBlock, {
    kind: 'replace-lines', start: 10, end: 10,
    expectedOriginal: rangeLines[9], contextPrev: rangeLines[8], contextNext: rangeLines[10],
  });
  const rangeAfter = rangeApplied.ok ? rangeApplied.text.split('\n') : [];
  add('J8', '10-10 替换十行：新内容占第 10-19 行，原第 11 行变为第 20 行',
    rangeApplied.ok && rangeAfter.length === 34 && rangeAfter.slice(9, 19).join('\n') === replacement.join('\n'));
  add('J9', '重复括号与空行不能吞掉原区间外内容',
    rangeApplied.ok && rangeAfter.slice(0, 9).join('\n') === rangeLines.slice(0, 9).join('\n') &&
    rangeAfter.slice(19).join('\n') === rangeLines.slice(10).join('\n'));
  const shortBlock = { ...rangeBlock, code: 'tail' };
  const shortened = computeApply('head\na\nb\nc\ntail', shortBlock, {
    kind: 'replace-lines', start: 2, end: 4,
    expectedOriginal: 'a\nb\nc', contextPrev: 'head', contextNext: 'tail',
  });
  add('J10', '缩短原区间，后续行向前移动且相同行完整保留',
    shortened.ok && shortened.text === 'head\ntail\ntail');
  const atEnd = computeApply(rangeLines.slice(0, 10).join('\n'), rangeBlock, {
    kind: 'replace-lines', start: 10, end: 10, expectedOriginal: rangeLines[9],
  });
  add('J11', '末行替换为十行：文件增长九行',
    atEnd.ok && atEnd.text === [...rangeLines.slice(0, 9), ...replacement].join('\n'));

console.log(`局部替换断言：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
