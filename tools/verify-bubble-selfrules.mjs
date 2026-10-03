/**
 * 逐条验证 V 组自检规则的正则是否**真的命中**当前源码。
 *
 * 为什么单独跑一遍：自检里的断言若是"不该命中"的否定式（`!re.test(...)`），
 * 一旦正则本身写错，它会永远为真 —— 表现为"永远 PASS 的假绿灯"。
 * 这个脚本把每条规则的布尔中间量单独打印出来，让人能看出到底是规则失效还是代码违规。
 *
 * 只读，不改任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const js = fs.readFileSync(path.join(root, 'src/renderer/renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

// 与 selfTest.ts 完全一致的"剥注释"处理（避免注释里的错误写法被当成违规代码）
const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
// CSS 注释同样要剥：说明里写着被禁的 `.selection-copy{display:none}` 示例
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

let failed = 0;
const t = (id, name, cond, detail) => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${name}  ${JSON.stringify(detail ?? {})}`);
};

// ---- Q3：无选区时由 getPosition() 返回 null 收起 ----
const hidesViaPosition = /getPosition:\s*function\s*\(\)\s*\{[\s\S]{0,500}?return null/.test(js);
t('Q3', 'hidesViaPosition', hidesViaPosition);
t('Q3', 'hidesWhenEmpty', /selection\.isEmpty\(\)/.test(js) && hidesViaPosition);

// ---- Q5 / V1：样式表不再声明 display ----
const cssDeclaresBubbleDisplay = /\.selection-copy\s*\{[^}]*\bdisplay\s*:/.test(cssCode);
t('Q5', 'bubbleNotOwnedByWrap', !cssDeclaresBubbleDisplay, { cssDeclaresBubbleDisplay });
t('V1', 'cssDeclaresBubbleDisplay', !cssDeclaresBubbleDisplay, { cssDeclaresBubbleDisplay });
t('V1', 'cssHasVisibleClass', !/\.selection-copy\.visible/.test(cssCode));

// ---- V2：不设 useDisplayNone、不写 bubble.hidden ----
t('V2', 'jsSetsUseDisplayNone', !/useDisplayNone:\s*true/.test(jsCode));
t('V2', 'jsSetsHiddenAttr', !/bubble\.hidden\s*=\s*(true|false)/.test(jsCode));

// ---- V3：锚点形状与 layout 调用 ----
t('V3', 'layoutCallShape', /editor\.layoutContentWidget\(contentWidget\)/.test(js));
t('V3', 'returnsPreference', /preference:\s*\[ContentWidgetPositionPreference\.ABOVE/.test(js));
t('V3', 'returnsAffinity', /positionAffinity:/.test(js));

// ---- V4：不得再出现"抑制 Monaco hover"的渲染层补丁（机制已证伪） ----
// 只拦**写**：探针里读 `getAttribute('custom-hover')` 属诊断用途，是允许的。
t('V4', 'noHoverSuppressionPatch', !/function freezeFindWidgetHover\s*\(/.test(js) && !/findHoverObserver/.test(js) && !/setAttribute\(\s*['"]custom-hover['"]/.test(js) && !/removeAttribute\(\s*['"]custom-hover['"]/.test(js) && !/querySelectorAll\([^)]*custom-hover/.test(js));

// ---- V5：锚点必须在选区首行（外接矩形右上角） ----
t('V5', 'anchorsAtStart', /selection\.getStartPosition\(\)/.test(js));
t('V5', 'noLegacyEndAnchor', !/const end = selection\.getEndPosition\(\)/.test(js));
t('U1', 'usesStartAnchor', /selection\.getStartPosition\(\)/.test(jsCode));

// ---- 回归：U3 / U4 仍成立 ----
t('U3', 'bubbleUsesAria', /bubble\.setAttribute\('aria-label'/.test(js));
t('U4', 'noStyleWrites', !/bubble\.style\.(left|top)\s*=/.test(jsCode));

console.log('');
console.log(failed === 0 ? '全部规则命中正确（无假绿灯）' : `有 ${failed} 条规则未通过`);
process.exit(failed === 0 ? 0 : 1);
