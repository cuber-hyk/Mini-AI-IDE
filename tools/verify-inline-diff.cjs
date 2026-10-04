/**
 * 独立验证 P / L10 组断言（不依赖 Electron GUI）。
 *
 * 用途：本机沙箱里 GPU 进程反复崩溃，`npm run self-test` 会在加载视图时
 * 以 `FATAL: GPU process isn't usable` 提前退出，跑不到静态断言那一段。
 * 这些断言本身是纯文本检查，用 node 直接验证，等价于 selfTest.ts 里的同一批正则。
 */
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const rendererDir = path.join(repo, 'src', 'renderer');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const html = read(rendererDir, 'index.html');
const js = read(rendererDir, 'renderer.js') + '\n' + read(rendererDir, 'promptComposer.js');
const previewJs = read(rendererDir, 'preview.js');
const previewCss = read(rendererDir, 'preview.css');
const styleCss = read(rendererDir, 'style.css');
const previewHtml = read(rendererDir, 'preview.html');
const previewPreloadJs = read(path.join(repo, 'dist', 'main', 'previewPreload.js'));
const mainJs = read(path.join(repo, 'dist', 'main', 'index.js'));

let pass = 0;
let fail = 0;
function check(id, desc, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`PASS ${id}  ${desc}`);
  } else {
    fail += 1;
    console.log(`FAIL ${id}  ${desc}  ${JSON.stringify(detail)}`);
  }
}

/* ---- P 组 ---- */
check(
  'P1',
  '不再使用第二个 Monaco 宿主（无 monaco-diff / createDiffEditor）',
  !/id="monaco-diff"/.test(html) && !/createDiffEditor/.test(js),
  { hasMonacoDiffHost: /id="monaco-diff"/.test(html), hasCreateDiffEditor: /createDiffEditor/.test(js) },
);

check(
  'P2',
  '差异以行内标记叠加在原编辑器上（decoration + view zone）',
  /createDecorationsCollection/.test(js) &&
    /changeViewZones/.test(js) &&
    /inline-deleted/.test(js) &&
    /inline-added/.test(js),
  {
    usesDecorations: /createDecorationsCollection/.test(js),
    usesViewZones: /changeViewZones/.test(js),
  },
);

check(
  'P3',
  '预览期只读、退出后恢复可编辑',
  /updateOptions\(\{\s*readOnly:\s*true\s*\}\)/.test(js) &&
    /updateOptions\(\{\s*readOnly:\s*false\s*\}\)/.test(js),
  {},
);

check('P4', '画标记前校验编辑器内容与 original 一致', /model\.getValue\(\) !== original/.test(js), {});

check(
  'P5',
  '右下角面板只列文件、不再渲染逐行 diff',
  !/renderHunk/.test(previewJs) && !/pv-hunk/.test(previewJs),
  { stillRendersHunks: /renderHunk/.test(previewJs) },
);

check(
  'P6',
  '编辑器与右下角面板之间有高亮同步通道',
  /onActiveDiff/.test(previewJs) &&
    /activeDiff/.test(previewPreloadJs) &&
    /CHANNELS\.activeDiff/.test(mainJs),
  {
    panelListens: /onActiveDiff/.test(previewJs),
    preloadExposes: /activeDiff/.test(previewPreloadJs),
    mainForwards: /CHANNELS\.activeDiff/.test(mainJs),
  },
);

/* ---- L8 / L9 / L10 / L11---- */
const pvIds = new Set([...previewHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const pvUsed = [...new Set([...previewJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
const pvMissing = pvUsed.filter((id) => !pvIds.has(id));
check('L8', '预览面板引用的元素 id 都存在', pvMissing.length === 0, { missing: pvMissing });

const vm = require('node:vm');
let parseError = null;
try {
  new vm.Script(previewJs, { filename: 'preview.js' });
} catch (err) {
  parseError = err.message;
}
check('L9', 'preview.js 语法可解析', parseError === null, { parseError });

let rendererParseError = null;
try {
  new vm.Script(js, { filename: 'renderer.js' });
} catch (err) {
  rendererParseError = err.message;
}
check('L9b', 'renderer.js 语法可解析', rendererParseError === null, { rendererParseError });

const listsFiles = /pv-file-row/.test(previewJs) && /pv-file-name/.test(previewJs) && /showDiffInEditor/.test(previewJs);
const hasFileCss = /\.pv-file-name/.test(previewCss) && /\.pv-file-apply/.test(previewCss);
const noInlineDiff = !/pv-line/.test(previewJs) && !/pv-hunk/.test(previewJs);
check('L10', '预览面板只罗列文件且有对应样式', listsFiles && hasFileCss && noInlineDiff, {
  listsFiles,
  hasFileCss,
  noInlineDiff,
});

check(
  'L11',
  '预览面板 preload 暴露 narrow bridge 且通道名正确',
  /exposeInMainWorld\('previewBridge'/.test(previewPreloadJs) &&
    previewPreloadJs.includes("'return:apply'") &&
    previewPreloadJs.includes("'preview:data'") &&
    previewPreloadJs.includes("'ui:set-preview-panel'"),
  {},
);

/* ---- 编辑器侧：新增的导航按钮与通道 ---- */
const editorIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const editorUsed = [...new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
const editorMissing = editorUsed.filter((id) => !editorIds.has(id));
check('E1', 'renderer.js 引用的元素 id 都存在于 index.html', editorMissing.length === 0, { missing: editorMissing });

check(
  'E2',
  '编辑器 preload 与主进程都提供 stepDiff 通道',
  /stepDiff/.test(read(path.join(repo, 'dist', 'main', 'preload.js'))) && /CHANNELS\.stepDiff/.test(mainJs),
  {},
);

check('E3', '内联标记样式在 style.css 中定义', /inline-deleted/.test(styleCss) && /inline-added/.test(styleCss), {});

/* ---- Q 组：应用后刷新 / 全部应用 / 选区浮层 / 输入框观感 ---- */
const mainTs = read(path.join(repo, 'src', 'main', 'index.ts'));
const preloadTs = read(path.join(repo, 'src', 'main', 'preload.ts'));
/* 通道名的权威定义在契约层，不在 index.ts */
const contractTs = read(path.join(repo, 'src', 'shared', 'contract.ts'));

check(
  'Q1',
  '落盘后广播 fileChanged、编辑器收到即重读（修复"应用后仍显示旧代码"）',
  /fileChanged:\s*'fs:file-changed'/.test(contractTs) &&
    /notifyFileChanged\(filePath\)/.test(mainTs) &&
    /notifyFileChanged\(result\.filePath\)/.test(mainTs) &&
    /onFileChanged/.test(js) &&
    /onFileChanged/.test(preloadTs),
  {},
);

check(
  'Q2',
  '「全部应用」顺序执行、单条失败不中断',
  /for \(let i = 0; i < blocks\.length; i \+= 1\)/.test(previewJs) &&
    /failed\.push/.test(previewJs) &&
    !/Promise\.all/.test(previewJs) &&
    /pv-apply-all/.test(previewJs) &&
    /pv-apply-all/.test(previewHtml),
  {},
);

check(
  'Q3',
  '选区右上角浮动复制按钮存在且无选区时收起（收起由 getPosition() 返回 null 驱动）',
  /selection-copy/.test(js) &&
    /selection-copy/.test(styleCss) &&
    /selection\.isEmpty\(\)/.test(js) &&
    /getPosition:\s*function\s*\(\)\s*\{[\s\S]{0,500}?return null/.test(js),
  {},
);

check(
  'Q4',
  '需求输入框用自绘细滚动条、隐藏原生带箭头滚动条',
  /\.requirement::-webkit-scrollbar-thumb/.test(styleCss) &&
    /\.requirement::-webkit-scrollbar\s*\{[^}]*width:\s*0/.test(styleCss),
  {},
);

check(
  'Q5',
  '编辑器容器是浮动按钮的定位上下文（position: relative）',
  /\.editor-wrap\s*\{[^}]*position:\s*relative/.test(styleCss),
  {},
);

// ---- R 组：修复「浮层按钮不出现」与「输入框不撑开 / 底部溢出」两个实测缺陷 ----
//
// 为什么必须单独开一组：Q3/Q4 只验证「代码与样式文本存在」，
// 而这两个 bug 恰恰是**文本在、但永远不执行 / 被 CSS 钳制失效**。
// 存在性断言对它们完全无效，必须断言「执行前提」与「两端常量一致」。

// R1：浮层按钮必须等 state.editor 就绪后才建。
// Monaco 是 window.require 异步加载的；若写成顶层 IIFE，
// 它会在 state.editor 还是 null 时执行并静默 return（按钮永远不出现）。
const r1a = /function setupSelectionCopyBubble\(\)\s*\{/.test(js);
const r1b = !/\(function setupSelectionCopyBubble\(\)/.test(js);
const r1c = /state\.editor = window\.monaco\.editor\.create[\s\S]{0,1200}?setupSelectionCopyBubble\(\)/.test(js);
check(
  'R1',
  '选区浮层按钮在 state.editor 就绪后才挂载（异步 require 下不再静默 return）',
  r1a && r1b && r1c,
  { isNamedFn: r1a, notTopLevelIife: r1b, calledAfterEditor: r1c },
);

// R2：输入框必须 min ≠ max。
// 曾经两者同为 88px，高度被钉死，JS 内联 height 被钳制住，auto-grow 形同虚设。
const reqBlock = /\.requirement\s*\{([\s\S]*?)\}/.exec(styleCss)?.[1] ?? '';
const r2min = /min-height:\s*(\d+)px/.exec(reqBlock)?.[1];
const r2max = /max-height:\s*(\d+)px/.exec(reqBlock)?.[1];
const r2 = r2min !== undefined && r2max !== undefined && r2min !== r2max;
check('R2', '输入框高度区间 min ≠ max（否则 CSS 钳制会让 auto-grow 永久失效）', r2, {
  minH: r2min ?? '未设置',
  maxH: r2max ?? '未设置',
});

// R3：CSS 的 min/max 与 JS 的 MIN_H / MAX_H 必须一致。
const r3jsMin = /const MIN_H = (\d+)/.exec(js)?.[1];
const r3jsMax = /const MAX_H = (\d+)/.exec(js)?.[1];
const r3 = r2min === r3jsMin && r2max === r3jsMax;
check('R3', '输入框高度上下限在 CSS 与 JS 中一致', r3, {
  cssMin: r2min ?? '未设置',
  cssMax: r2max ?? '未设置',
  jsMin: r3jsMin ?? '未设置',
  jsMax: r3jsMax ?? '未设置',
});

// R4：归零测量时必须同时放开 min/max-height。
const growBlock = /function grow\(\)\s*\{([\s\S]*?)\n {4}\}/.exec(js)?.[1] ?? '';
const r4a = /minHeight\s*=\s*'0px'/.test(growBlock);
const r4b = /maxHeight\s*=\s*'none'/.test(growBlock);
check(
  'R4',
  'auto-grow 归零时同时放开 min/max-height（scrollHeight 量到真实内容高度）',
  r4a && r4b,
  { resetsMinH: r4a, releasesMaxH: r4b },
);

// R5：垂直方向两处 flex 收缩许可，缺任一条则输入框撑高时底部被推出视口。
const r5a = /\.editor-wrap\s*\{[^}]*min-height:\s*0/.test(styleCss);
const r5b = /\.prompt-bar\s*\{[\s\S]*?flex:\s*0\s+1\s+auto/.test(styleCss);
check(
  'R5',
  '编辑器容器与输入区允许在 flex 中收缩（输入框撑高不顶出视口）',
  r5a && r5b,
  { wrapAllowsShrink: r5a, promptBarAllowsShrink: r5b },
);

// R6：输入区**可缩，但不能缩到内容放不下**（两个方向都踩过）。
//  · `flex: 0 0 auto`（禁缩）→ 视口紧张时本区不缩，底部边框被顶出可视范围；
//  · `flex: 0 1 auto` + `min-height: 0` → 过头，本区被压到低于内容高度，
//    而 shell 当时是 overflow: hidden，输入框下沿被裁掉一条（用户截图"底部溢出"）。
const r6block = /\.prompt-bar\s*\{([\s\S]*?)\}/.exec(styleCss)?.[1] ?? '';
const r6a = /flex:\s*0\s+1\s+auto/.test(r6block);
const r6b = !/flex:\s*0\s+0\s+auto/.test(r6block);
const r6barMin = Number(/min-height:\s*(\d+)px/.exec(r6block)?.[1] ?? 0);
const r6reqMin = Number(/\.requirement\s*\{([\s\S]*?)\}/.exec(styleCss)?.[1]?.match(/min-height:\s*(\d+)px/)?.[1] ?? 0);
const r6c = r6barMin >= 8 + 10 + r6reqMin + 8 + 32 + 10 + 10 + 3;
check(
  'R6',
  '输入区 flex 可收缩且 min-height 不小于内容自然高度（不切自身内容）',
  r6a && r6b && r6c,
  { shrinkable: r6a, noHardZero: r6b, barMinHeight: r6barMin, required: 8 + 10 + r6reqMin + 8 + 32 + 10 + 10 + 3 },
);

// R6b：外壳不得 overflow: hidden —— 它把"差几像素"变成"看得见的一条切边"。
// 注意：必须**先去掉 CSS 注释**再断言。注释里为了说明历史会写出 overflow: hidden，
// 若直接匹配原文，这些检查会被自己的说明文字误伤（实现时踩过）。
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const r6bBlock = stripCssComments(/\.prompt-shell\s*\{([\s\S]*?)\}/.exec(styleCss)?.[1] ?? '');
check('R6b', '需求输入外壳不用 overflow:hidden（避免把高度差变成可见切边）', !/overflow:\s*hidden/.test(r6bBlock), {
  shellClips: /overflow:\s*hidden/.test(r6bBlock),
});

// R6c：auto-grow 写回的高度必须含元素自身 padding。
// scrollHeight 已包含 padding；保留既有底部余量，避免文字贴到输入区边缘。
const r6cGrow = /function grow\(\)\s*\{([\s\S]*?)\n    \}/.exec(js)?.[1] ?? '';
check(
  'R6c',
  'auto-grow 保留既有底部余量与高度上限',
  /scrollHeight\s*\+\s*BOX_PAD/.test(r6cGrow) && /const BOX_PAD\s*=\s*\d+/.test(js),
  { addsPad: /scrollHeight\s*\+\s*BOX_PAD/.test(r6cGrow) },
);

// R7：高度必须跟随实际宽度持续校正，不能只在启动时量一次。
const r7a = /new ResizeObserver\(/.test(js);
const r7b = /function growIfWidthChanged[\s\S]*?w === lastWidth[\s\S]*?return/.test(js);
const r7c = /requestAnimationFrame\(function \(\)\s*\{[\s\S]{0,200}?grow\(\)/.test(js);
check(
  'R7',
  '输入框高度跟随实际宽度校正（RO + 宽度守卫 + 首测延后到 rAF）',
  r7a && r7b && r7c,
  { hasResizeObserver: r7a, roGuard: r7b, firstMeasureInRaf: r7c },
);

// 分段控件属于下方独立操作栏，不再与输入框共用一行。
const swBlock = /\.variant-switch\s*\{([\s\S]*?)\n\}/.exec(styleCss)?.[1] ?? '';
const swH = Number(/height:\s*(\d+)px/.exec(swBlock)?.[1] ?? 0);
check('R8', '版本与复制控件在独立操作栏内，输入框独占上一行',
  /flex-direction:\s*column/.test(r6bBlock) &&
  /class="prompt-actions"[\s\S]*id="variant-switch"[\s\S]*id="btn-copy-prompt"/.test(html) &&
  swH > 0 && swH <= 32,
  { switchHeight: swH });

// R8：缩放窗口必须重算高度，且不因输入框为空而跳过。
// 收窄到 auto-grow 那个处理器：源码里有多个 resize 监听（浮层也挂了一个用来失效宽度缓存），
// 不加限定会匹配到不相干的那个。
    const r8handler =
      /const MAX_H = \d+;[\s\S]{0,4000}?window\.addEventListener\('resize',[\s\S]*?\}\);/.exec(js)?.[0] ?? '';
const r8a = /grow\(\)/.test(r8handler);
const r8b = !/value\.length\s*>\s*0/.test(r8handler);
check('R8', '缩放窗口即重算高度，且不因输入框为空而跳过', r8a && r8b, {
  callsGrow: r8a,
  notGatedOnValue: r8b,
});

// ---- S 组：视图几何必须在窗口真正显示后重算 ----
//
// 用户实测「启动后底部被切，拖一下窗口就恢复」。根因**不在 CSS、也不在渲染进程**：
// `new BaseWindow(...)` 之后立刻 getContentSize()，此刻窗口还没显示，
// 量到的内容区与显示后的真实视口不一致（边框/缩放/DPI 此时才最终确定），
// 四个视图按错尺寸定了 bounds，而 bounds 不会自动跟随视口。
// 拖窗口能恢复只是因为那才会触发 win.on('resize', relayout) —— 属误认。
const s1a =
  /win\.once\('show',\s*\(\)\s*=>\s*\{[\s\S]{0,80}?relayout\(\)/.test(mainTs);
const s1b = /did-finish-load[\s\S]{0,200}?relayout\(\)/.test(mainTs);
check(
  'S1',
  '窗口显示后重算视图几何（修"启动即溢出、拖窗口才恢复"）',
  s1a && s1b,
  { relayoutOnShow: s1a, relayoutOnFinishLoad: s1b },
);

// S2：状态行显式 flex-shrink: 0 —— 固定高度信息条不参与纵向压缩。
const infoBlock = /\.info\s*\{([\s\S]*?)\}/.exec(styleCss)?.[1] ?? '';
const s2 = /flex:\s*0\s+0\s+auto/.test(infoBlock);
check('S2', '状态行不参与纵向压缩（纵向只压编辑器本体）', s2, { infoNotShrunk: s2 });

// T 组：显隐开关只能有一套，不允许功能重复的第二份入口。
// 用户指出：编辑器工具栏的「回程预览」文字按钮与网页区右上角的分栏图标按钮
// 调的是同一个 setPreviewPanel，连高度算法都逐行相同 —— 纯重复。
// 已删掉工具栏那个，只保留网页区右上角的图标。
const webbarHtml = fs.readFileSync(path.join(rendererDir, 'webbar.html'), 'utf8');
const webbarJs = fs.readFileSync(path.join(rendererDir, 'webbar.js'), 'utf8');
const t1a = /btn-preview-toggle/.test(html) || /btnPreviewToggle/.test(js);
const t1b = /btn-preview-toggle/.test(webbarHtml);
const t1c = /setPreviewPanel/.test(webbarJs);
check(
  'T1',
  '回程预览开关只有网页区右上角一处（编辑器里不再有重复按钮）',
  !t1a && t1b && t1c,
  { inEditor: t1a, inWebbar: t1b, webbarWired: t1c },
);

// ---- U 组：浮层复制按钮的定位与提示；保存按钮移除后快捷键仍在 ----

// 剥掉注释再匹配 —— 错误写法的说明就写在代码旁注释里，直接 grep 会误判。
const jsCode = js
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// U1：不能把 Position 对象当字符偏移量传给 getPositionAt。
// 误传 → NaN → `style.top = NaN + 'px'` 非法 CSS 被丢弃 → 按钮停在 hidden。
// 表现：代码文件"歪着出现"，markdown 干脆不出现（wordWrap 换行更多）。
// 现版本进一步改为直接锚 `getStartPosition()`（Monaco 中恒指向文档序更靠前的一端），
// 使按钮落在**整个选区外接矩形**的右上角，而不是末行的右上角。
const u1a = /getPositionAt\(\s*selection\.get(Start|End)Position\(\)/.test(jsCode);
const u1b = /selection\.getStartPosition\(\)/.test(jsCode);
check(
  'U1',
  '选区定位直接用 Position（锚首行），不再误传给 getPositionAt',
  !u1a && u1b,
  { usesOffsetApi: u1a, usesStartAnchor: u1b },
);

// U2：浮层**不再自己算绝对坐标**。自己算在 markdown 上必然错位：
// `getTopForLineNumber` / `getOffsetForColumn` 返回的是编辑器视口内坐标，
// 而浮层原先挂在编辑器**外面**（.editor-wrap）；且 wordWrap 折行时
// `end.lineNumber` 是逻辑行、取到的是它第一个视觉行的 top。
// 现在定位完全交给 Monaco 的 content widget。
const u2 = !/getTopForLineNumber/.test(jsCode) && !/getOffsetForColumn/.test(jsCode);
check(
  'U2',
  '浮层不再自己算绝对坐标（改由 Monaco content widget 定位，修 md 折行错位）',
  u2,
  { noManualCoords: u2 },
);

// U3：浮层元素不用原生 title —— 原生 tooltip 在元素位置/样式变化时失效重建，
// 而浮层会随选区与滚动不断重定位，tooltip 反复重建即闪烁。改用 aria-label。
const u3a = /\.selection-copy[\s\S]{0,400}?\.title\s*=/.test(jsCode);
const u3b = /bubble\.setAttribute\('aria-label'/.test(js);
check('U3', '浮层按钮不用原生 title（避免重排导致 tooltip 闪烁），改用 aria-label', !u3a && u3b, {
  usesTitle: u3a,
  usesAria: u3b,
});

// U4：位置未变时不得写 DOM —— 查找期间 onDidChangeCursorSelection 触发频繁。
// 关键：位置**完全交给 Monaco**（addContentWidget / layoutContentWidget），
// 我们一个style.left/top 都不写 —— 从根上断掉"重排打断原生 tooltip"这条链。
const u4a = /editor\.addContentWidget\(contentWidget\)/.test(js);
const u4b = !/bubble\.style\.(left|top)\s*=/.test(jsCode);
const u4c = /suppressMouseDown:\s*true/.test(js);
check(
  'U4',
  '浮层定位交给 content widget（不写 style，故不会打断原生 tooltip）',
  u4a && u4b && u4c,
  { addedAsContentWidget: u4a, noStyleWrites: u4b, suppressMouseDown: u4c },
);

// U5：保存按钮已移除，但 Ctrl+S 快捷键必须还在 —— 不能把能力一起删掉。
const u5a = !/btn-save/.test(html) && !/btnSave/.test(js);
const u5b = /KeyMod\.CtrlCmd\s*\|\s*window\.monaco\.KeyCode\.KeyS/.test(js);
check('U5', '保存按钮已移除，但 Ctrl+S 快捷键仍注册（能力不随入口一起丢）', u5a && u5b, {
  saveButtonGone: u5a,
  ctrlSStillBound: u5b,
});

/* ---- W 组：应用状态跨视图同步 ---- */
// 应用有两个入口（面板按钮 / 编辑器工具条）。走编辑器那条时面板不知情，
// 条目会一直显示"应用"可用态、与磁盘脱节（用户实测反馈）。
// 修法：主进程在落盘成功后广播 preview:applied，面板据 index 标「已应用 ✓」。
// 注意：`tsc` 会把 `CHANNELS.appliedChange` 编译成 `contract_1.CHANNELS.appliedChange`，
// 因此**不能**在 dist 产物里直接搜字面量 `preview:applied`（这是记录在案的假失败陷阱）。
const w1a = /\.send\(\s*(?:contract_1\.)?CHANNELS\.appliedChange/.test(mainJs);
const w1b = /preview:applied/.test(previewPreloadJs);
const w1c = /onAppliedChange/.test(previewPreloadJs);
check('W1', '新增 preview:applied 广播通道（主进程 → 预览面板）', w1a && w1b && w1c, {
  inMain: w1a,
  inPreload: w1b,
  preloadExposes: w1c,
});

// 广播必须挂在**落盘成功之后**（outcome.ok），否则失败也会把条目标成已应用。
// 先剥掉注释再匹配，并留足窗口 —— 中间有一大段解释性注释（曾用 200 字符窗口误报）。
const mainJsCode = mainJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const w2a = /if\s*\(\s*outcome\.ok\s*\)[\s\S]{0,600}?notifyChangeState\(\{\s*kind:\s*'applied'/.test(mainJsCode);
// 撤销也要复位（否则撤销后按钮仍显示「已应用 ✓」）
const w2b = /notifyChangeState\(\{\s*kind:\s*'undone'/.test(mainJsCode);
check('W2', '应用成功才广播、撤销后广播复位', w2a && w2b, {
  appliedAfterOk: w2a,
  undoneBroadcast: w2b,
});

// 面板必须订阅并有处理函数（否则通道形同虚设）
const w3a = /bridge\.onAppliedChange\(/.test(previewJs);
const w3b = /function markAppliedIndex/.test(previewJs) && /function markUnapplied/.test(previewJs);
check('W3', '预览面板订阅广播并按 index/filePath 更新条目状态', w3a && w3b, {
  subscribed: w3a,
  handlers: w3b,
});

/* ---- X 组：格式模板的围栏自洽性 ---- */
// 演进：最初不变量是"正文零反引号"（因为写在说明里的裸围栏会被模型当成代码块开头，
// 而后面没有配对闭合 → 输出"有开头没结尾"）。后来改为"用五反引号包示例"，
// 示例里必须出现三/四反引号才直观，于是真正的不变量变成：
//   **每一段围栏都必须与同长度的另一段配对**（绝不留没人闭合的 opener）。
const specSrc = read(path.join(repo, 'src', 'shared', 'formatSpec.ts'));
try {
  const distSpec = read(path.join(repo, 'dist', 'shared', 'formatSpec.js'));
  // 运行期取最终文本（比在源码里做正则更准）
  const mod = require(path.join(repo, 'dist', 'shared', 'formatSpec.js'));
  const unbalanced = (t) => {
    const c = {};
    for (const m of t.match(/`{3,}/g) || []) c[m.length] = (c[m.length] || 0) + 1;
    return Object.entries(c).filter(([, n]) => n % 2 !== 0);
  };
  const bad = unbalanced(mod.FORMAT_SPEC_SHORT).concat(unbalanced(mod.FORMAT_SPEC_FULL));
  check('X1', '格式模板的围栏全部成对（不存在未闭合的 opener）', bad.length === 0, { unbalanced: bad });
} catch (e) {
  check('X1', '格式模板的围栏全部成对（不存在未闭合的 opener）', false, { error: String(e && e.message) });
}
// 最终原则（方案甲）：输入输出共用同一条骨架 —— 行号只在 ### 范围，内容里不写行号
const x2 =
  /完全一致|照着它把结果写回来|同一条骨架|结构完全相同/.test(specSrc) &&
  /### 范围：/.test(specSrc) &&
  /绝不在行首写行号|不含行号/.test(specSrc);
check('X2', '格式模板：结构对称（输入输出同骨架）+ 行号只在 ### 范围', x2, {
  hasSymmetry: /完全一致|照着它把结果写回来|同一条骨架|结构完全相同/.test(specSrc),
  hasRangeAnchor: /### 范围：/.test(specSrc),
  hasNoLineNo: /绝不在行首写行号|不含行号/.test(specSrc),
});
const x3 = /成对|闭合/.test(specSrc) && /四个反引号/.test(specSrc) && /多一个|比它再多/.test(specSrc);
check('X3', '格式模板：围栏成对闭合 + 至少四个反引号（内容含更多时加长）', x3, {
  hasPair: /成对|闭合/.test(specSrc),
  hasFour: /四个反引号/.test(specSrc),
  hasAdaptive: /多一个|比它再多/.test(specSrc),
});
// 用户反馈（few-shot 必须够全）：示例要成体系地覆盖各类场景，且每段都有输入/输出对照。
try {
  const mod2 = require(path.join(repo, 'dist', 'shared', 'formatSpec.js'));
  const full = mod2.FORMAT_SPEC_FULL;
  const short = mod2.FORMAT_SPEC_SHORT;
  const all = short + full;
  const titles = (full.match(/示例 \d+｜/g) || []).length;
  const ins = (full.match(/【我给你的】/g) || []).length;
  const outs = (full.match(/【你该给我的】/g) || []).length;
  check('X4', '格式模板：示例覆盖全部 8 类场景且输入/输出逐一对照', titles === 8 && ins === outs && ins >= 8, {
    titles,
    ins,
    outs,
  });
  check(
    'X5',
    '格式模板：不含解析器不认识的 ### 续： 约定 + 保留语言标注对照表',
    !/###\s*续/.test(all) && /语言标注/.test(all) && /typescript/.test(all),
    {
      hasContinuation: /###\s*续/.test(all),
      hasLangTable: /语言标注/.test(all),
      hasTsLabel: /typescript/.test(all),
    }
  );
  check('X6', '格式模板：截断场景改为分多轮给完整文件', /分多轮/.test(all) && /完整/.test(all), {
    hasMultiRound: /分多轮/.test(all),
  });
} catch (e) {
  check('X4', '格式模板：示例覆盖全部 8 类场景且输入/输出逐一对照', false, { error: String(e && e.message) });
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
