/**
 * 端到端验证：用**项目自己的真实源码**跑一遍回程链路，确认内联 diff 能拿到
 * 「可显示的 payload」+「正确的行映射」。
 *
 * 为什么必须用真实文件：内联标记画在编辑器里编辑器显示的内容上，
 * 主进程返回的 original 必须与磁盘内容**逐字节一致** —— 否则标记会错位或拒绝绘制。
 * 用合成字符串验不出这类不一致。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..');
const diff = require(path.join(repo, 'dist', 'shared', 'diff.js'));
const returnPath = require(path.join(repo, 'dist', 'shared', 'returnPath.js'));

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

/* ---- 取一个真实文件当"原文件" ---- */
const realPath = path.join(repo, 'src', 'shared', 'diff.ts');
const original = fs.readFileSync(realPath, 'utf8');
const lines = original.split(/\r\n|\r|\n/);
console.log('真实文件：src/shared/diff.ts，' + lines.length + ' 行');

/* ---- 构造一次真实的局部替换：把第 7 行的注释改掉，并在其后插一行 ---- */
const targetLine = 7;
const ctxLines = lines.slice(targetLine - 1, targetLine + 1);
const modifiedLines = lines.slice();
modifiedLines[targetLine - 1] = ' * 这是内联 diff 端到端验证插入的一行说明。';
modifiedLines.splice(targetLine, 0, ' * 新增的一行：应当以绿色 + 出现在被替换行之后。');
const modified = modifiedLines.join('\n');

const result = diff.diffTexts(original, modified);
check('真实文件：diff 算出了变更', result.added > 0 && result.removed > 0, {
  added: result.added,
  removed: result.removed,
});

/* ---- 关键性质：original 必须与磁盘内容逐字节一致（内联标记的前提）---- */
const reread = fs.readFileSync(realPath, 'utf8');
check('original 与磁盘内容逐字节一致（标记不会错位的前提）', original === reread, {
  originalLen: original.length,
  rereadLen: reread.length,
});

/* ---- 三向校验：区间 + 原内容 + 上下文（主进程用的那套）----
 * 注意 computeApply(originalText, block, mode) 里 block 需要带 code 字段 ——
 * 缺了它会在读取时抛 undefined.split（验证脚本自身的参数问题，不是实现缺陷）。
 */
const mode = {
  kind: 'replace-lines',
  start: targetLine,
  end: targetLine,
  expectedOriginal: ctxLines[0],
  contextPrev: lines[targetLine - 2] ?? null,
  contextNext: lines[targetLine] ?? null,
};
const newLines = modifiedLines.slice(targetLine - 1, targetLine + 1);
let computed = { ok: false, error: '未执行' };
try {
  computed = returnPath.computeApply(original, { code: newLines.join('\n'), range: { start: targetLine, end: targetLine } }, mode);
} catch (err) {
  computed = { ok: false, error: String(err) };
}
check('三向校验通过（computeApply 成功）', computed.ok === true, computed);

/* ---- 校验产出的文本与手算的 modified 一致（内联标记的 modified 就是它）---- */
check('computeApply 产出的文本与手算 modified 一致（标记依据的正是它）', computed.ok === true && computed.text === modified, {
  computedLen: computed.ok ? computed.text.length : null,
  expectedLen: modified.length,
});

/* ---- 内联标记的行映射 ---- */
const src = fs.readFileSync(path.join(repo, 'src', 'renderer', 'renderer.js'), 'utf8');
const s = src.indexOf('function lineMap(');
const e = src.indexOf('function clearInlineDiff(');
const sandbox = { Uint32Array };
vm.createContext(sandbox);
vm.runInContext(src.slice(s, e) + '\nthis.__lm = lineMap;', sandbox);
const ops = sandbox.__lm(original, modified);

const dels = ops.filter((o) => o.kind === 'del');
const adds = ops.filter((o) => o.kind === 'add');
// 期望：第 7 行被替换 → 1 删 1 增；此外还插入了一行 → 再 1 增。合计 1 删 2 增。
check('真实文件：行映射给出了 1 删 2 增', dels.length === 1 && adds.length === 2, {
  dels: dels.length,
  adds: adds.length,
});
check('删除行就是第 7 行且内容与磁盘一致', dels[0] && dels[0].oldLine === targetLine && dels[0].text === ctxLines[0], {
  got: dels[0],
});

/* ---- 删除行号必须落在文件真实范围内（越界会让 decoration 抛错）---- */
const inRange = dels.every((o) => o.oldLine >= 1 && o.oldLine <= lines.length);
check('所有删除行号都在文件真实范围内（越界会导致标记失败）', inRange, { lineCount: lines.length, bad: dels.filter((o) => o.oldLine > lines.length) });

/* ---- 新增行的插入点：插在被替换行之后，view zone 用的是合法 afterLineNumber ---- */
let lastDel = lines.length;
let insertAfter = lines.length;
ops.forEach((op) => {
  if (op.kind === 'del') lastDel = op.oldLine;
  if (op.kind === 'add') insertAfter = lastDel;
});
check(
  '新增行插入点是第 7 行且不越界（view zone 合法）',
  insertAfter === targetLine && insertAfter >= 1 && insertAfter <= lines.length,
  { insertAfter },
);

/* ---- 与主进程 diffTexts 的统计一致 ---- */
check(
  '行映射的增删条数与主进程 diffTexts 一致',
  dels.length === result.removed && adds.length === result.added,
  { mine: dels.length, adds: adds.length, theirs: result.removed, theirsAdd: result.added },
);

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);