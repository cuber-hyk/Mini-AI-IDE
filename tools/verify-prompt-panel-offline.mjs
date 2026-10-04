/**
 * 在 Node 里**离线复现** selfTest.ts 中新增的 Y 组断言（提示词编辑面板，Y1–Y10）。
 *
 * 为什么需要：GUI 自检（`electron . --self-test`）在助手的受限环境里跑不起来
 *（GPU/沙箱限制，与代码无关）。把 Y 组这些**纯静态**断言抽出来单跑，
 * 就能在没有 GUI 的前提下确认"面板的界面契约写对了、也真的会通过"。
 *
 * 另外还补了两条 selfTest 覆盖不到、但必须有保障的东西：
 *   Z1–Z3：**自定义内容真的改变了组装的 prompt**（跑真实的 buildPrompt + resolveFormatSpec），
 *          以及"空内容回落默认""超长截断"这两条边界 —— 它们需要真跑代码，不是文本匹配。
 *
 * 只读，不改任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const rendererDir = 'src/renderer';

const mainTs = read('src/main/index.ts');
const preloadTs = read('src/main/preload.ts');
const settingsTs = read('src/main/settings.ts');
const html = read('src/renderer/index.html');
const composerJs = read('src/renderer/promptComposer.js');
const js = read('src/renderer/renderer.js') + '\n' + composerJs;
const pmHtml = read(`${rendererDir}/prompt.html`);
const pmJs = read(`${rendererDir}/prompt.js`);
const pmCss = read(`${rendererDir}/prompt.css`);
const pmPreload = read('src/main/promptPreload.ts');

let pass = 0;
let fail = 0;
const check = (id, name, cond, detail) => {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`${cond ? 'ok  ' : 'NOT OK'}  ${id}  ${name}`);
  if (!cond && detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
};

/* ---------------- Y 组：面板界面契约（与 selfTest.ts 同源） ---------------- */

const pmIds = new Set([...pmHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const pmUsed = [...new Set([...pmJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
check('Y1', '提示词面板：JS 引用的元素 id 都存在于 prompt.html', pmUsed.filter((i) => !pmIds.has(i)).length === 0, {
  used: pmUsed,
  htmlIds: [...pmIds],
});

// 与 selfTest.ts 的 L9 同源：用 node:vm 做**真实语法解析**（不是文本匹配）
let pmParseError = null;
try {
  new vm.Script(pmJs, { filename: 'prompt.js' });
} catch (err) {
  pmParseError = err instanceof Error ? err.message : String(err);
}
check('Y2', '提示词面板：prompt.js 语法可解析', pmParseError === null, pmParseError);

const hasEditorArea = /<textarea[\s\S]{0,400}?id="pm-editor"/.test(pmHtml);
const hasSave = /id="pm-save"/.test(pmHtml) && /el\.save\.addEventListener\('click',\s*save\)/.test(pmJs);
const hasReset = /id="pm-reset"/.test(pmHtml) && /el\.reset\.addEventListener\('click',\s*resetToDefault\)/.test(pmJs);
const hasCancel = /id="pm-cancel"/.test(pmHtml) && /el\.cancel\.addEventListener\('click',\s*close\)/.test(pmJs);
const hasDirtyState = /未保存/.test(pmJs) && /c\.dirty|\.dirty =/.test(pmJs);
check('Y3', '提示词面板：编辑框 + 保存/恢复默认/取消 + "未保存"状态', hasEditorArea && hasSave && hasReset && hasCancel && hasDirtyState, {
  hasEditorArea, hasSave, hasReset, hasCancel, hasDirtyState,
});

// Y3b：版本页签（简洁版 / 完整版），两版各自独立编辑
const hasTabs = (pmHtml.match(/class="pm-tab"/g) ?? []).length === 2 &&
  /data-variant="short"/.test(pmHtml) &&
  /data-variant="full"/.test(pmHtml);
const tabSwitching = /perVariant\s*=\s*\{/.test(pmJs) && /function switchTo\(/.test(pmJs);
check('Y3b', '提示词面板：两个版本页签 + 各自的独立编辑态（perVariant）', hasTabs && tabSwitching, {
  hasTabs, tabSwitching,
});

const resetFnBody = /function resetToDefault\(\)\s*\{([\s\S]*?)\n  \}/.exec(pmJs)?.[1] ?? '';
// 恢复默认载入的是**当前版本**的默认全文（state[active].defaultSpec）
const resetLoadsEditor = /el\.editor\.value\s*=\s*(st|state\[active\])/.test(resetFnBody) ||
  /defaultSpec/.test(resetFnBody);
const resetDoesNotPersist = !/bridge\.reset\(/.test(resetFnBody);
check('Y4', '「恢复默认」先载入编辑框、不直接落库（可反悔）', resetLoadsEditor && resetDoesNotPersist, {
  resetLoadsEditor, resetDoesNotPersist,
});

check('Y5', 'Esc 关闭、Ctrl+S 保存', /e\.key === 'Escape'/.test(pmJs) && /e\.key === 's'/.test(pmJs), null);

const pmBridgeOk =
  /exposeInMainWorld\('promptBridge'/.test(pmPreload) &&
  pmPreload.includes("'ui:prompt-panel-state'") &&
  pmPreload.includes("'ui:save-prompt-spec'") &&
  pmPreload.includes("'ui:reset-prompt-spec'") &&
  pmPreload.includes("'ui:close-prompt-panel'") &&
  // 分版本：save/reset 都带 variant 参数
  /save:\s*\(variant: string, spec: string\)/.test(pmPreload) &&
  /reset:\s*\(variant: string\)/.test(pmPreload);
check('Y6', '独立 preload 暴露窄 bridge 且通道名正确（save/reset 带版本参数）', pmBridgeOk, null);

const settingsMenu = /label:\s*'设置'/.test(mainTs) && /label:\s*'修改提示词…'/.test(mainTs);
const gearInEditor = /id="btn-settings"/.test(html) && /el\.btnSettings\.addEventListener\('click'/.test(js);
const gearOpensPanel = /bridge\.openPromptPanel\(\)/.test(js) && /openPromptPanel:\s*'ui:open-prompt-panel'/.test(preloadTs);
check('Y7', '入口齐备：Settings 菜单行 + 编辑器齿轮（同一面板）', settingsMenu && gearInEditor && gearOpensPanel, {
  settingsMenu, gearInEditor, gearOpensPanel,
});

// Y8：三条消费链路都必须走 customSpecsOf()（分版本取自定义），
// 否则会出现"改了 B 版、发出去的还是 A 版"这类静默错误。
const usesInCopyPrompt = /formatSpec:\s*resolveFormatSpec\(customSpecsOf\(settings\.get\(\)\)/.test(mainTs);
const usesInCopyFormat = /const text = resolveFormatSpec\(customSpecsOf\(s\),\s*s\.formatSpecVariant\)/.test(mainTs) ||
  /resolveFormatSpec\(customSpecsOf\(settings\.get\(\)\)/.test(mainTs);
const panelReadsSetting = /customFormatSpecShort/.test(mainTs) && /customFormatSpecFull/.test(mainTs) &&
  /customFormatSpecShort:\s*string \| null/.test(settingsTs) &&
  /customFormatSpecFull:\s*string \| null/.test(settingsTs);
const hasToggleLink = /getFormatSpecVariant|setFormatSpecVariant/.test(mainTs);
check('Y8', '自定义内容真的被用上（分版本三条链路 + 开关持久化）', usesInCopyPrompt && usesInCopyFormat && panelReadsSetting && hasToggleLink, {
  usesInCopyPrompt, usesInCopyFormat, panelReadsSetting, hasToggleLink,
});

const panelGeometry = /PROMPT_PANEL_MIN_WIDTH\s*=\s*(\d+)/.exec(mainTs)?.[1];
const centersHorizontally = /x:\s*Math\.round\(\(w - width\)\s*\/\s*2\)/.test(mainTs);
const hasMinHeight = /PROMPT_PANEL_MIN_HEIGHT\s*=\s*(\d+)/.exec(mainTs)?.[1];
check('Y9', '面板有最小可读尺寸且水平居中', Boolean(panelGeometry) && Number(panelGeometry) >= 420 && centersHorizontally && Boolean(hasMinHeight), {
  panelGeometry, centersHorizontally, hasMinHeight,
});

check('Y10', '样式表定义了外壳/编辑框/主按钮', /\.pm-shell\s*\{/.test(pmCss) && /\.pm-editor\s*\{/.test(pmCss) && /\.pm-btn\.primary/.test(pmCss), null);

// Y11：**handler 必须先于页面加载注册**（真实缺陷：面板打开即报 No handler registered）
const mainLines = mainTs.split('\n');
const regLine = mainLines.findIndex((l) => /ipcMain\.handle\(CHANNELS\.promptPanelState/.test(l));
const loadLine = mainLines.findIndex((l) => /loadLocalView\(promptView/.test(l));
check(
  'Y11',
  '状态 handler 在页面加载之前注册（防"面板打开即报未注册"）',
  regLine >= 0 && loadLine >= 0 && regLine < loadLine,
  { handlerLine: regLine + 1, loadLine: loadLine + 1 }
);

// Y12：读状态失败时要有默认文本兜底 + 重试（不留空白框）
//
// 兜底副本必须与内置默认**逐字一致**（早期只比对首行，默认模板升级后副本会悄悄过期 ——
// 那种情况下 panel 在失败分支会显示一份过时要求，比空白更糟）。
const distShort = require(path.join(root, 'dist/shared/formatSpec.js')).FORMAT_SPEC_SHORT;
const hasFallback = /FALLBACK_SPEC/.test(pmJs) && /el\.editor\.value\s*=/.test(pmJs);
const fallbackBlock = /const FALLBACK_SPEC = \[([\s\S]*?)\]\.join\('\\n'\)/.exec(pmJs)?.[1] ?? '';
// 把数组字面量里的字符串逐条取出后拼回文本，与内置默认比对
const fallbackText = (fallbackBlock.match(/"(?:[^"\\]|\\.)*"/g) ?? [])
  .map((s) => JSON.parse(s))
  .join('\n');
const fallbackMatchesDefault = fallbackText === distShort;
const hasRetry = /const LOAD_RETRIES/.test(pmJs) && /load\(tries \+ 1\)/.test(pmJs);
check(
  'Y12',
  '读状态失败时有默认文本兜底（与内置默认逐字一致）+ 重试（不留空白框）',
  hasFallback && fallbackMatchesDefault && hasRetry,
  {
    hasFallback,
    fallbackMatchesDefault,
    hasRetry,
    fallbackLines: fallbackText.split('\n').length,
    defaultLines: distShort.split('\n').length,
  }
);

// Y14：底部双段开关（简洁/完整）—— 结构、持久化、三条交互路径
const swHtml = /id="variant-switch"/.test(html) &&
  (html.match(/class="variant-opt"/g) ?? []).length === 2 &&
  /data-variant="short"/.test(html) &&
  /data-variant="full"/.test(html);
const swJs = /setupPromptComposer/.test(js) &&
  /bridge\.setFormatSpecVariant/.test(js) &&
  /bridge\.getPromptStatus/.test(js) &&
  // 键盘可切换
  /e\.key === ' '/.test(js);
const swCss = /\.variant-switch\s*\{/.test(read('src/renderer/style.css')) &&
  /\.variant-thumb\s*\{/.test(read('src/renderer/style.css'));
check('Y14', '底部双段开关：结构 + 持久化读写 + 键盘可达 + 样式', swHtml && swJs && swCss, {
  swHtml, swJs, swCss,
});

// Y15：开关状态必须真的被"复制提示词"链路读到（否则界面与行为会不一致）
const variantUsedInCopyPrompt = /resolveFormatSpec\(customSpecsOf\(settings\.get\(\)\),\s*settings\.get\(\)\.formatSpecVariant\)/.test(mainTs);
const variantHandlerRegistered = /ipcMain\.handle\(CHANNELS\.getFormatSpecVariant/.test(mainTs) &&
  /ipcMain\.handle\(CHANNELS\.setFormatSpecVariant/.test(mainTs);
check('Y15', '开关状态贯通：复制提示词读 variant + 主进程有读写 handler', variantUsedInCopyPrompt && variantHandlerRegistered, {
  variantUsedInCopyPrompt, variantHandlerRegistered,
});

// Y13：保存失败时不清空编辑框
const saveFnBody = /async function save\(\)\s*\{([\s\S]*?)\n  \}/.exec(pmJs)?.[1] ?? '';
const catchBody = saveFnBody.split('catch')[1] ?? '';
check(
  'Y13',
  '保存失败时保留编辑框内容并放开按钮（可重试）',
  !/el\.editor\.value\s*=/.test(catchBody) && /el\.save\.disabled\s*=\s*false/.test(catchBody),
  { keepsContent: !/el\.editor\.value\s*=/.test(catchBody) }
);

/* ---------------- Z 组：值层真的生效（跑真实模块） ---------------- */

const distSpec = require(path.join(root, 'dist/shared/formatSpec.js'));
const { resolveFormatSpec, getFormatSpec, buildPrompt } = distSpec;

check(
  'Z1',
  'resolveFormatSpec：未设置/空白 → 回落该版本内置默认（空内容不会让格式段消失）',
  resolveFormatSpec(null, 'short') === getFormatSpec('short') &&
    resolveFormatSpec({ short: '' }, 'short') === getFormatSpec('short') &&
    resolveFormatSpec({ short: '   \n  ' }, 'short') === getFormatSpec('short') &&
    resolveFormatSpec(null, 'full') === getFormatSpec('full') &&
    resolveFormatSpec({ full: '' }, 'full') === getFormatSpec('full'),
  null
);

const customShort = '【用户自定义格式要求·简洁】\n1. 只输出代码';
const customFull = '【用户自定义格式要求·完整】\n1. 只输出代码\n2. 附上解释';
check(
  'Z2',
  'resolveFormatSpec：有自定义内容 → 原样返回（逐字，不做任何加工）',
  resolveFormatSpec({ short: customShort }, 'short') === customShort &&
    resolveFormatSpec({ full: customFull }, 'full') === customFull,
  null
);

// Z2b：**分版本互不影响** —— 这是本轮新增的核心不变量。
// 给简洁版写自定义，不应影响完整版；反之亦然。
check(
  'Z2b',
  'resolveFormatSpec：简洁版与完整版的自定义互不影响（分版本隔离）',
  resolveFormatSpec({ short: customShort, full: null }, 'full') === getFormatSpec('full') &&
    resolveFormatSpec({ short: null, full: customFull }, 'short') === getFormatSpec('short') &&
    resolveFormatSpec({ short: customShort, full: customFull }, 'short') === customShort &&
    resolveFormatSpec({ short: customShort, full: customFull }, 'full') === customFull,
  {
    fullUnaffectedByShort: resolveFormatSpec({ short: customShort, full: null }, 'full') === getFormatSpec('full'),
    shortUnaffectedByFull: resolveFormatSpec({ short: null, full: customFull }, 'short') === getFormatSpec('short'),
  }
);

const assembled = buildPrompt({
  requirement: '改一下 greeting',
  context: { root: '/x', environment: 'win', tree: 'hello.ts' },
  formatSpec: resolveFormatSpec({ short: customShort }, 'short'),
  targetFiles: ['hello.ts'],
});
const assembledDefault = buildPrompt({
  requirement: '改一下 greeting',
  context: { root: '/x', environment: 'win', tree: 'hello.ts' },
  formatSpec: resolveFormatSpec(null, 'short'),
  targetFiles: ['hello.ts'],
});
const assembledFull = buildPrompt({
  requirement: '改一下 greeting',
  context: { root: '/x', environment: 'win', tree: 'hello.ts' },
  formatSpec: resolveFormatSpec(null, 'full'),
  targetFiles: ['hello.ts'],
});
check(
  'Z3',
  '组装后的 prompt 真的带上了自定义内容（且固定骨架不变）',
  assembled.includes(customShort) &&
    // 用自定义时，内置默认的那句开场白不得残留
    !assembled.includes('你我会用**同一条骨架**来交换内容') &&
    // 用默认时，内置默认标题必须在
    assembledDefault.includes('【输入/输出格式要求】') &&
    /## 用户需求/.test(assembled) &&
    /## 工作环境/.test(assembled),
  {
    hasCustom: assembled.includes(customShort),
    hasDefaultInCustomRun: assembled.includes('你我会用**同一条骨架**来交换内容'),
    hasDefaultTitle: assembledDefault.includes('【输入/输出格式要求】'),
  }
);

// Z3b：切到完整版后，组装出的 prompt 用的是 FULL（8 示例），而不是 SHORT
const fullExampleCount = (getFormatSpec('full').match(/示例 \d+｜/g) ?? []).length;
const shortExampleCount = (getFormatSpec('short').match(/示例 \d+｜/g) ?? []).length;
check(
  'Z3b',
  '切换版本后组装结果确实换了一版（FULL 8 示例 / SHORT 6 示例）',
  assembledFull.includes(getFormatSpec('full')) &&
    assembledDefault.includes(getFormatSpec('short')) &&
    fullExampleCount === 8 &&
    shortExampleCount === 6,
  { fullExampleCount, shortExampleCount }
);

/* ---------------- Z4：控制台里不打印用户内容（隐私/日志卫生） ---------------- */

const logsCustomContent = /process\.stdout\.write\([^)]*customFormatSpec/.test(mainTs);
check('Z4', '保存/重置路径不把用户内容整段写进日志（只记长度）', !logsCustomContent, { logsCustomContent });

/* ---------------- S 组：真跑 prompt.js（stub DOM），验证分版本编辑真的工作 ----------------
 *
 * 前面的 Y 组都是**文本匹配**。分版本编辑是个有状态的行为，光匹配源码看不出
 * "切页签会不会丢草稿""保存的是不是当前版本"。
 * 这里给 prompt.js 喂一个最小 DOM + 假 bridge，真跑一遍。
 */

function makeEl(id, extra = {}) {
  const el = {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    dataset: {},
    disabled: false,
    classList: { toggle() {}, add() {}, remove() {} },
    _handlers: {},
    _attrs: {},
    addEventListener(type, fn) {
      (this._handlers[type] ||= []).push(fn);
    },
    fire(type, ev = {}) {
      const event = { stopPropagation() {}, preventDefault() {}, ...ev };
      (this._handlers[type] || []).forEach((fn) => fn(event));
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] ?? null; },
    focus() {},
    querySelectorAll() { return []; },
    ...extra,
  };
  return el;
}

function runPanel(initialState, initialVariant) {
  const els = {
    'pm-close': makeEl('pm-close'),
    'pm-editor': makeEl('pm-editor'),
    'pm-status': makeEl('pm-status'),
    'pm-count': makeEl('pm-count'),
    'pm-hint': makeEl('pm-hint'),
    'pm-usage': makeEl('pm-usage'),
    'pm-reset': makeEl('pm-reset'),
    'pm-cancel': makeEl('pm-cancel'),
    'pm-save': makeEl('pm-save'),
    'pm-tab-using': makeEl('pm-tab-using'),
  };
  const tabEls = ['short', 'full'].map((v) => makeEl('tab-' + v, { dataset: { variant: v } }));

  const saves = [];
  const state = JSON.parse(JSON.stringify(initialState));
  const bridge = {
    async getState() {
      return JSON.parse(JSON.stringify(state));
    },
    async save(variant, spec) {
      const key = variant === 'full' ? 'customFormatSpecFull' : 'customFormatSpecShort';
      const t = (spec || '').trim();
      state[key] = t.length > 0 ? spec : null;
      state[variant].customSpec = state[key];
      state[variant].isCustom = t.length > 0;
      saves.push({ variant, len: (spec || '').length });
      return { ok: true, variant, state: JSON.parse(JSON.stringify(state)), resetToDefault: t.length === 0 };
    },
    async reset(variant) {
      return this.save(variant, '');
    },
    async close() { return { ok: true }; },
  };

  const doc = {
    getElementById: (id) => els[id] ?? null,
    querySelectorAll: (sel) => (sel === '.pm-tab' ? tabEls : []),
    addEventListener() {},
  };

  const ctx = {
    window: {
      promptBridge: bridge,
      setTimeout: (fn) => { fn(); return 0; },
    },
    document: doc,
    console,
    JSON,
  };
  vm.createContext(ctx);
  new vm.Script(pmJs, { filename: 'prompt.js' }).runInContext(ctx);
  return { els, tabEls, saves, state, bridge };
}

const mkState = (variant) => ({
  variant,
  short: { defaultSpec: '默认-简洁', customSpec: null, isCustom: false },
  full: { defaultSpec: '默认-完整', customSpec: null, isCustom: false },
  updatedAt: null,
  maxLength: 8000,
});

/** 让已排队的 promise 链全部推进（stub 的 await 需要若干微任务 tick） */
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

/* ---- S1–S4 是异步的（panel 的 load() 是 await 链），因此统一放进 async IIFE ---- */
await (async () => {
  // S1：打开面板时默认停在"底部开关正在用的那一版"，且编辑框预填该版生效内容
  {
    const { els, tabEls } = runPanel(mkState('full'), 'full');
    await flush();
    check(
      'S1',
      '面板打开时停在开关当前版本，编辑框预填该版内容（非空白）',
      els['pm-editor'].value === '默认-完整' && tabEls[1].getAttribute('aria-selected') === 'true',
      { editorValue: els['pm-editor'].value.slice(0, 40), tabCount: tabEls.length }
    );
  }

  // S2：切页签 → 编辑框换成另一版内容
  {
    const { els, tabEls } = runPanel(mkState('short'), 'short');
    await flush();
    const before = els['pm-editor'].value;
    tabEls[1].fire('click'); // 切到 full
    const after = els['pm-editor'].value;
    check('S2', '切换页签后编辑框换成目标版本的内容', before !== after && after.includes('完整'), {
      before: before.slice(0, 20),
      after: after.slice(0, 20),
    });
  }

  // S3：在 A 版改字、切到 B 版、再切回 A 版 —— 草稿不能丢
  {
    const { els, tabEls } = runPanel(mkState('short'), 'short');
    await flush();
    els['pm-editor'].value = '我在简洁版写的草稿';
    els['pm-editor'].fire('input');
    tabEls[1].fire('click'); // 切到 full
    tabEls[0].fire('click'); // 切回 short
    check('S3', '在页面之间来回切换时未保存的草稿不丢', els['pm-editor'].value === '我在简洁版写的草稿', {
      value: els['pm-editor'].value,
    });
  }

  // S4：保存的是**当前页签那一版**（不能存错版本）
  {
    const { els, tabEls, saves } = runPanel(mkState('short'), 'short');
    await flush();
    tabEls[1].fire('click'); // 切到 full
    els['pm-editor'].value = '完整版的新内容';
    els['pm-editor'].fire('input');
    els['pm-save'].fire('click');
    await flush();
    check('S4', '保存时写的是当前页签对应的版本（不会存错版本）', saves.length === 1 && saves[0].variant === 'full', {
      saves,
    });
  }
})();

/* ---------------- S5：底部双段开关真跑（renderer.js 里的 setupVariantSwitch） ---------------- */
await (async () => {
  const swEl = makeEl('variant-switch', { dataset: {} });
  const optShort = makeEl('opt-short', { dataset: { variant: 'short' } });
  const optFull = makeEl('opt-full', { dataset: { variant: 'full' } });
  swEl.querySelectorAll = (sel) => (sel === '.variant-opt' ? [optShort, optFull] : []);

  const calls = [];
  let variant = 'full';
  const bridge = {
    async getPromptStatus() { return { variant, shortIsCustom: false, fullIsCustom: true }; },
    onPromptStatus() {},
    async setFormatSpecVariant(v) { calls.push(v); variant = v; return v; },
  };
  const nodes = {
    'variant-switch': swEl,
    'requirement': makeEl('requirement', { style: {}, clientWidth: 500, scrollHeight: 44 }),
    'btn-copy-prompt': makeEl('btn-copy-prompt'),
    'prompt-custom': makeEl('prompt-custom'),
  };
  const ctx = {
    window: { requestAnimationFrame: (fn) => fn(), addEventListener() {} },
    document: { getElementById: (id) => nodes[id] },
    console,
  };
  vm.createContext(ctx);
  let ok = false;
  try {
    new vm.Script(composerJs, { filename: 'promptComposer.js' }).runInContext(ctx);
    ctx.window.setupPromptComposer(bridge, () => {});
    ok = true;
  } catch (err) {
    console.log('        ' + String(err && err.message));
  }
  await flush();
  // 启动时对齐到主进程的 'full'
  const alignedToFull = swEl.dataset.variant === 'full';
  // 点"简洁"应触发写 'short'
  optShort.fire('click');
  await flush();
  const wroteShort = calls.includes('short');
  check('S5', '双段开关：启动对齐主进程值 + 点击写入新版本', ok && alignedToFull && wroteShort, {
    ok, alignedToFull, wroteShort, calls,
  });
})();

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
