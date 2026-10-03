/**
 * 离线复现 selfTest.ts 的 J8–J11（覆盖范围归一化）行为断言。
 *
 * 为什么需要：GUI 自检（`electron . --self-test`）在助手的受限环境里跑不起来
 * （GPU/沙箱限制，与代码无关）。这几条是**纯逻辑**断言，可以直接在 Node 里跑 dist 产物，
 * 在没有 GUI 的前提下确认"归一化真的生效、且不会误扩区间"。
 *
 * 只读，不改任何文件。
 */
import { parseModelReply, computeApply, alignConsumedLines } from '../dist/shared/returnPath.js';

let pass = 0;
let fail = 0;
const add = (id, name, cond, extra) => {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${id}  ${name}`);
  if (extra !== undefined) console.log('        ', JSON.stringify(extra));
};

const bubbleOriginal = [
  '冒泡排序：',
  '```python',
  'def bubble_sort(arr):',
  '    """',
  '    冒泡排序(基础版)',
  '    时间复杂度：O(n²)',
  '    空间复杂度：O(1)',
  '    """',
  '    n = len(arr)',
  '    for i in range(n):',
  '        for j in range(0, n - i - 1):',
  '```',
].join('\n');
const bubbleLines = bubbleOriginal.split('\n');
const baseMode = (start, end) => ({
  kind: 'replace-lines',
  start,
  end,
  expectedOriginal: bubbleLines.slice(start - 1, end).join('\n'),
  contextPrev: bubbleLines[start - 2] ?? null,
  contextNext: bubbleLines[end] ?? null,
});

/* J8：模型多写区间外的行 → 收敛区间、不产生重复块 */
const overBlock = parseModelReply(
  [
    '### 范围: 2-10',
    '```python',
    '```python',
    'def bubble_sort(arr):',
    '    n = len(arr)',
    '    for i in range(n):',
    '        for j in range(0, n - i - 1):',
    '```',
  ].join('\n')
).blocks[0];
const overApplied = computeApply(bubbleOriginal, overBlock, baseMode(2, 10));
const overForJ = overApplied.ok ? overApplied.text.split('\n').filter((l) => l.includes('for j in range')).length : -1;
add(
  'J8',
  '覆盖范围归一化：模型多写区间外的行时收敛区间（不产生重复块）',
  overApplied.ok && overApplied.normalized?.from === 10 && overApplied.normalized?.to === 11 && overForJ === 1,
  overApplied.ok ? { normalized: overApplied.normalized, forJ出现次数: overForJ } : overApplied
);

/* J9：模型未越界 → 不改区间（保守） */
const exactBlock = parseModelReply(
  [
    '### 范围: 2-10',
    '```python',
    '```python',
    'def bubble_sort(arr):',
    '    冒泡排序(基础版)',
    '    n = len(arr)',
    '    for i in range(n):',
    '```',
  ].join('\n')
).blocks[0];
const exactApplied = computeApply(bubbleOriginal, exactBlock, baseMode(2, 10));
add(
  'J9',
  '覆盖范围归一化：模型未越界时不改动区间（保守，不误扩）',
  exactApplied.ok && exactApplied.normalized === undefined,
  exactApplied.ok ? { normalized: exactApplied.normalized ?? null } : exactApplied
);

/* J10：对齐函数 —— 多写一行 → 消费 10 行 */
const overAligned = alignConsumedLines(bubbleLines.slice(1), [
  '```python',
  'def bubble_sort(arr):',
  '    n = len(arr)',
  '    for i in range(n):',
  '        for j in range(0, n - i - 1):',
]);
add('J10', '游标对齐：多写区间外的行时消费行数超出区间长度', overAligned === 10, { consumed: overAligned });

/* J11：对齐函数 —— 只重写区间内容 → 不超过区间长度 */
const exactAligned = alignConsumedLines(bubbleLines.slice(1), [
  '```python',
  'def bubble_sort(arr):',
  '    冒泡排序(基础版)',
  '    n = len(arr)',
  '    for i in range(n):',
]);
add('J11', '游标对齐：只重写区间内容时消费行数不超过区间长度', exactAligned <= 9, { consumed: exactAligned });

console.log('');
console.log(`覆盖范围归一化断言：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
