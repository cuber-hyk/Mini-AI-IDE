/** 单提示词面板离线验证：构建资源、初始化/复制同源与实际面板交互；不操作官网。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { FORMAT_SPEC, getFormatSpec, resolveFormatSpec, buildPrompt } = require(path.join(root, 'dist/shared/formatSpec.js'));
const { TOOL_PROTOCOL_PROMPT, parseToolBatch } = require(path.join(root, 'dist/shared/toolProtocol.js'));
let pass = 0;
async function check(name, run) { await run(); pass++; console.log('ok ' + name); }
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const panelJs = read('dist/renderer/prompt.js');
const html = read('dist/renderer/prompt.html');
const defaults = { window: {} };
vm.runInNewContext(read('dist/renderer/formatSpecDefaults.js'), defaults);
await check('构建默认与完整权威模板逐字一致，全部十五组示例保留且不能直接执行', () => {
  assert.equal(defaults.window.formatSpecDefaults, FORMAT_SPEC);
  assert.equal((FORMAT_SPEC.match(/示例 \d+｜/g) || []).length, 15);
  assert.equal(parseToolBatch(FORMAT_SPEC).kind, 'none');
});
await check('初始化和格式复制使用唯一自定义设置，旧版本入口已移除', () => {
  const main = read('src/main/index.ts'); const controller = read('src/main/localPromptController.ts');
  assert.match(main, /resolveFormatSpec\(settings\.get\(\)\.customFormatSpec\)/);
  assert.match(controller, /resolveFormatSpec\(settings\.customFormatSpec\)/);
  assert.doesNotMatch(main + controller + read('src/main/preload.ts'), /getFormatSpecVariant|setFormatSpecVariant|customFormatSpecShort|customFormatSpecFull/);
  assert.doesNotMatch(html + panelJs + read('src/renderer/index.html'), /data-variant|perVariant|variant-switch/);
  const custom = '\n自定义原文\n';
  const spec = resolveFormatSpec(custom);
  const prompt = buildPrompt({ requirement: '修改', context: { root: null, tree: null, environment: null }, formatSpec: spec });
  assert.equal(spec, TOOL_PROTOCOL_PROMPT + '\n\n' + custom);
  assert.ok(prompt.endsWith(spec));
  assert.equal(prompt.split(TOOL_PROTOCOL_PROMPT).length - 1, 1);
  for (const blank of [null, undefined, '', ' \n']) assert.equal(resolveFormatSpec(blank), getFormatSpec());
});
await check('独立 preload 仅保存唯一原文，handler 在面板加载之前注册', () => {
  const main = read('src/main/index.ts'); const preload = read('src/main/promptPreload.ts');
  assert.match(preload, /save: \(spec: string\) => ipcRenderer.invoke\(CH.save, spec\)/);
  assert.doesNotMatch(preload, /variant|readFile|runCommand|sendPrompt/);
  assert.ok(main.indexOf('ipcMain.handle(CHANNELS.promptPanelState') < main.indexOf('loadLocalView(promptView'));
});
function element() {
  const handlers = {};
  return { value: '', textContent: '', disabled: false, className: '', classList: { toggle() {} },
    addEventListener(name, fn) { handlers[name] = fn; }, focus() {}, fire(name, event = {}) { return handlers[name]?.(event); } };
}
function panel({ readFails = false, saveFails = false } = {}) {
  const names = ['close', 'editor', 'status', 'count', 'hint', 'usage', 'reset', 'cancel', 'save'];
  for (const name of names) assert.ok(html.includes('id="pm-' + name + '"'), name + ' 入口缺失');
  const nodes = Object.fromEntries(names.map(name => ['pm-' + name, element()]));
  const state = { defaultSpec: FORMAT_SPEC, customSpec: '\n原始自定义\n', isCustom: true, maxLength: 10000, updatedAt: null };
  const saves = [];
  const context = { window: { formatSpecDefaults: FORMAT_SPEC, setTimeout(fn) { fn(); }, promptBridge: {
    async getState() { if (readFails) throw new Error('读失败'); return state; },
    async save(text) { saves.push(text); if (saveFails) throw new Error('写失败'); state.customSpec = text === FORMAT_SPEC ? null : text; state.isCustom = state.customSpec !== null; return { ok: true, state, resetToDefault: !state.isCustom }; },
    async close() {} } }, document: { getElementById(id) { return nodes[id]; }, addEventListener() {} } };
  vm.runInNewContext(panelJs, context);
  return { nodes, state, saves };
}
await check('恢复默认先载入编辑器，保存前原设置保留，保存后唯一内容生效', async () => {
  const p = panel(); await flush();
  assert.equal(p.nodes['pm-editor'].value, p.state.customSpec);
  p.nodes['pm-reset'].fire('click');
  assert.equal(p.saves.length, 0); assert.equal(p.state.customSpec, '\n原始自定义\n');
  assert.equal(p.nodes['pm-editor'].value, FORMAT_SPEC);
  await p.nodes['pm-save'].fire('click');
  assert.deepEqual(p.saves, [FORMAT_SPEC]); assert.equal(p.state.customSpec, null);
});
await check('读取失败显式提示并禁止覆盖未知设置', async () => {
  const p = panel({ readFails: true }); await flush(); await flush();
  assert.equal(p.nodes['pm-editor'].value, FORMAT_SPEC);
  assert.equal(p.nodes['pm-save'].disabled, true); assert.equal(p.nodes['pm-reset'].disabled, true);
  assert.match(p.nodes['pm-hint'].textContent, /读取设置失败/);
});
await check('保存失败保留草稿并恢复重试入口', async () => {
  const p = panel({ saveFails: true }); await flush();
  p.nodes['pm-editor'].value = '\n新草稿\n'; p.nodes['pm-editor'].fire('input');
  await p.nodes['pm-save'].fire('click');
  assert.equal(p.nodes['pm-editor'].value, '\n新草稿\n'); assert.equal(p.state.customSpec, '\n原始自定义\n');
  assert.equal(p.nodes['pm-save'].disabled, false); assert.match(p.nodes['pm-hint'].textContent, /保存失败/);
});
console.log('通过 ' + pass + ' / 失败 0');
