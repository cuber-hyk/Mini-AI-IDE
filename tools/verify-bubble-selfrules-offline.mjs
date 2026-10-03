/**
 * 在 Node 里**离线复现** selfTest.ts 中新增/改动的静态断言（Q3 / Q5 / V1–V5）。
 *
 * 为什么需要：GUI 自检（`electron . --self-test`）在助手的受限环境里跑不起来
 * （GPU/沙箱限制，与代码无关）。把这几条**纯静态**断言抽出来单跑，
 * 就能在没有 GUI 的前提下确认"规则写对了、也真的会通过"。
 *
 * 只读，不改任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const js = fs.readFileSync(path.join(root, 'src/renderer/renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

// 与 selfTest.ts 一致：js 剥注释（U1/V2/V4 用），css 也要剥（V1/Q5 用）
const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0;
let fail = 0;
const add = (id, name, cond) => {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`${cond ? 'ok  ' : 'NOT OK'}  ${id}  ${name}`);
};

// Q3
const bubbleExists = /selection-copy/.test(js) && /selection-copy/.test(css);
const hidesViaPosition = /getPosition:\s*function\s*\(\)\s*\{[\s\S]{0,500}?return null/.test(js);
add('Q3', '选区右上角浮动复制按钮存在，且无选区时由 getPosition() 返回 null 收起', bubbleExists && /selection\.isEmpty\(\)/.test(js) && hidesViaPosition);

// Q5
add('Q5', '浮动按钮的 display 不自绘（改由 Monaco ContentWidget 独占管理）', !/\.selection-copy\s*\{[^}]*\bdisplay\s*:/.test(cssCode));

// V1
add('V1', '样式表不再声明 .selection-copy 的 display', !/\.selection-copy\s*\{[^}]*\bdisplay\s*:/.test(cssCode) && !/\.selection-copy\.visible/.test(cssCode));

// V2
add('V2', '不设 useDisplayNone、不写 bubble.hidden', !/useDisplayNone:\s*true/.test(jsCode) && !/bubble\.hidden\s*=\s*(true|false)/.test(jsCode));

// V3
add(
  'V3',
  'content widget 锚点带 preference 且带 positionAffinity，layout 调用传原始 widget',
  /editor\.layoutContentWidget\(contentWidget\)/.test(js) &&
    /preference:\s*\[ContentWidgetPositionPreference\.ABOVE/.test(js) &&
    /positionAffinity:/.test(js)
);

// V4 —— 不得再出现"抑制 Monaco hover"的渲染层补丁（该机制已被源码证伪）
add(
  'V4',
  '不在渲染层做"抑制 Monaco hover"的补丁（机制已证伪，且带 title 清空副作用）',
  !/function freezeFindWidgetHover\s*\(/.test(js) &&
    !/findHoverObserver/.test(js) &&
    !/setAttribute\(\s*['"]custom-hover['"]/.test(js) &&
    !/removeAttribute\(\s*['"]custom-hover['"]/.test(js) &&
    !/querySelectorAll\([^)]*custom-hover/.test(js)
);

// V5 —— 复制按钮锚在选区首行右端（外接矩形右上角）
add(
  'V5',
  '复制按钮锚在选区首行右端（外接矩形右上角），不再锚末行',
  /selection\.getStartPosition\(\)/.test(js) && !/const end = selection\.getEndPosition\(\)/.test(js)
);

// V7 —— 复制按钮横排 + 宽度由内容决定（治"复制"被折成竖排）
const bubbleRule = /\.selection-copy\s*\{([\s\S]*?)\}/.exec(cssCode)?.[1] ?? '';
add(
  'V7',
  '复制按钮横排且宽度由内容决定（nowrap + max-content，均带 !important）',
  /white-space:\s*nowrap\s*!important/.test(bubbleRule) &&
    /width:\s*max-content\s*!important/.test(bubbleRule) &&
    !/^\s*width:\s*\d+px/m.test(bubbleRule) &&
    bubbleRule.length > 0
);

// V8 —— 查找框 hover 提示禁止折行（!important 覆盖 Monaco 内联 pre-wrap）
add(
  'V8',
  '查找框 hover 提示禁止折行（覆盖内联 pre-wrap，且只限纯文本叶子节点）',
  /\.monaco-hover\s+\.hover-contents:not\(:has\(\*\)\)\s*\{[\s\S]*?white-space:\s*nowrap\s*!important/.test(cssCode)
);

// renderer.js 仍可解析
let parseError = null;
try {
  new (await import('node:vm')).Script(js, { filename: 'renderer.js' });
} catch (err) {
  parseError = err instanceof Error ? err.message : String(err);
}
add('L2', 'renderer.js 语法可被解析', parseError === null);

console.log('');
console.log(`离线静态断言：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
