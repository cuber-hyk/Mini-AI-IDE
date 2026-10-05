/**
 * 离线运行 selfTest.ts 的 J8-J11：SEARCH 唯一定位原文，区间外内容完整保留。
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
const replacementBlock = (oldText, newText) => parseModelReply([
  '### 文件：range.txt', '### 操作：替换', '````text',
  '<<<<<<< SEARCH', oldText, '=======', newText, '>>>>>>> REPLACE', '````',
].join('\n')).blocks[0];
const rangeLines = Array.from({ length: 25 }, (_, i) => `原第 ${i + 1} 行`);
rangeLines[10] = '}'; rangeLines[11] = '';
const replacement = [...Array.from({ length: 7 }, (_, i) => `新增 ${i + 1}`), '}', '', '最后一行'];
const block = replacementBlock(rangeLines[9], replacement.join('\n'));
const applied = computeApply(rangeLines.join('\n'), block);
const after = applied.ok ? applied.text.split('\n') : [];
add('J8', '唯一原文在第十行替换十行，IDE 显示新 10–19 并增长九行', applied.ok && after.length === 34 && after.slice(9, 19).join('\n') === replacement.join('\n') && applied.locations[0].newRange.end === 19);
add('J9', '重复括号与空行不能吞掉匹配区间之外内容', applied.ok && after.slice(0, 9).join('\n') === rangeLines.slice(0, 9).join('\n') && after.slice(19).join('\n') === rangeLines.slice(10).join('\n'));
const shortened = computeApply('head\na\nb\nc\ntail', replacementBlock('a\nb\nc', 'tail'));
add('J10', '缩短原文后余下相同行完整保留', shortened.ok && shortened.text === 'head\ntail\ntail');
const atEnd = computeApply(rangeLines.slice(0, 10).join('\n'), block);
add('J11', '无末尾换行的末行替换十行，文件增长九行', atEnd.ok && atEnd.text === [...rangeLines.slice(0, 9), ...replacement].join('\n'));

console.log(`局部替换断言：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
