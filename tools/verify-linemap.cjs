/**
 * 验证 renderer.js 里的 lineMap（行级 LCS）算法与主进程 src/shared/diff.ts 一致。
 *
 * 为什么单独验：内联标记的位置**完全**由这个函数决定——
 * 算错了就会出现"标记画在错误的行上"，而这种错误在源码层面看不出来，
 * 也不会被任何类型检查发现。这里用几组典型变更跑真实数据比对。
 *
 * 注意：本脚本必须用编辑器工具写入，不能用 bash heredoc——
 * 模板字符串里的 `${...}` 会被 shell 展开，导致比对恒为 undefined。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..');

/* ---- 把 renderer.js 里的 lineMap 抽出来单独执行 ---- */
const src = fs.readFileSync(path.join(repo, 'src', 'renderer', 'renderer.js'), 'utf8');
const start = src.indexOf('function lineMap(');
const end = src.indexOf('function clearInlineDiff(');
if (start < 0 || end < 0) {
  console.error('FAIL 找不到 lineMap 函数（renderer.js 结构变了？）');
  process.exit(1);
}
const sandbox = { Uint32Array };
vm.createContext(sandbox);
vm.runInContext(src.slice(start, end) + '\nthis.__lineMap = lineMap;', sandbox);
const lineMap = sandbox.__lineMap;

/* ---- 主进程那份实现的对照：直接 require 编译产物 ---- */
const diff = require(path.join(repo, 'dist', 'shared', 'diff.js'));

let pass = 0;
let fail = 0;
function check(desc, ok, detail) {
  if (ok) {
    pass += 1;
    console.log('PASS  ' + desc);
  } else {
    fail += 1;
    console.log('FAIL  ' + desc + '  ' + JSON.stringify(detail));
  }
}

/*
 * 归一化成 "kind@行号" 便于比对。
 * 用 ?? 而不是 ||：删除行 oldLine 有值、newLine 为 null，新增行反之。
 */
function summarize(ops) {
  return ops.filter((o) => o.kind !== 'context').map((o) => o.kind + '@' + (o.oldLine ?? o.newLine));
}

function theirsOf(a, b) {
  return summarize(diff.diffLines(a, b));
}

/* 1. 单行替换 */
{
  const a = 'l1\nl2\nl3\nl4\nl5';
  const b = 'l1\nl2\nCHANGED\nl4\nl5';
  const mine = summarize(lineMap(a, b));
  check('单行替换：行映射与主进程一致', JSON.stringify(mine) === JSON.stringify(theirsOf(a, b)), {
    mine,
    theirs: theirsOf(a, b),
  });
}

/* 2. 纯新增（末尾加两行） */
{
  const a = 'a\nb\nc';
  const b = 'a\nb\nc\nd\ne';
  const mine = summarize(lineMap(a, b));
  check('纯新增：行映射与主进程一致', JSON.stringify(mine) === JSON.stringify(theirsOf(a, b)), {
    mine,
    theirs: theirsOf(a, b),
  });
  check('纯新增：两条 add 指向新文行号 4/5', JSON.stringify(mine) === '["add@4","add@5"]', { mine });
}

/* 3. 纯删除 */
{
  const a = 'a\nb\nc\nd';
  const b = 'a\nd';
  const mine = summarize(lineMap(a, b));
  check('纯删除：行映射与主进程一致', JSON.stringify(mine) === JSON.stringify(theirsOf(a, b)), {
    mine,
    theirs: theirsOf(a, b),
  });
}

/* 4. 增删混合（替换 + 新增 + 删除交错） */
{
  const a = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8';
  const b = 'l1\nNEW_A\nl3\nl4\nl5\nl6\nNEW_B\nl8';
  const mine = summarize(lineMap(a, b));
  check('增删混合：行映射与主进程一致', JSON.stringify(mine) === JSON.stringify(theirsOf(a, b)), {
    mine,
    theirs: theirsOf(a, b),
  });
}

/* 5. 完全相同 → 无任何标记 */
{
  const same = 'x\ny\nz';
  check('内容相同：无任何行级标记', lineMap(same, same).length === 0, { ops: lineMap(same, same) });
}

/* 6. 整文件替换 */
{
  const a = 'old1\nold2';
  const b = 'new1\nnew2\nnew3';
  const ops = lineMap(a, b);
  const dels = ops.filter((o) => o.kind === 'del');
  const adds = ops.filter((o) => o.kind === 'add');
  check('整文件替换：2 删 3 增', dels.length === 2 && adds.length === 3, { dels: dels.length, adds: adds.length });
}

/* 7. 删除行号必须是原文行号（标记画在真实文件上，错了就错位） */
{
  const a = 'l1\nl2\nl3';
  const b = 'l1\nCHANGED\nl3';
  const ops = lineMap(a, b);
  const del = ops.find((o) => o.kind === 'del');
  check('删除行携带原文行号与原文内容', Boolean(del) && del.oldLine === 2 && del.text === 'l2', { del });
}

/* 8. 大文件不卡死（走退化分支） */
{
  const big = Array.from({ length: 4100 }, (_, i) => 'line' + i).join('\n');
  const small = 'short';
  const t0 = Date.now();
  const ops = lineMap(big, small);
  const ms = Date.now() - t0;
  check('大文件走退化分支（不卡死，' + ms + 'ms）', ops.length === 4100 + 1 && ms < 3000, { ops: ops.length, ms });
}

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);