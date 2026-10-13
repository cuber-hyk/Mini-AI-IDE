/* Deterministic owner fixture; counts are authoritative, time is not a native typing benchmark. */
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const baseline = process.argv.includes('--baseline');
const baselineRef = '37fdd47d770ed1311cd4602b014063e1d9eb73cf';
const source = baseline ? execFileSync('git', ['show', baselineRef + ':src/renderer/editorWorkspace.js'], { encoding: 'utf8' }) : fs.readFileSync('src/renderer/editorWorkspace.js', 'utf8');
async function run() {
  const state = { root: 'fixture', currentPath: null, currentText: '', savedText: '' };
  let reads = 0, reports = 0, rendered = 0, active;
  const context = { window: {} }; vm.runInNewContext(source, context);
  const workspace = context.window.createEditorWorkspace({ state,
    bridge: { readFile: async () => ({ ok: true, text: 'x'.repeat(1000000) }), reportEditorState() { reports++; }, onEditorRequest() {} },
    ready: async () => {}, createModel(path, text) { return { text, getValue() { reads++; return this.text; }, getValueLength() { return this.text.length; } }; },
    showDocument(doc) { active = doc; }, captureViewState() {}, highlight() {}, setInfo() {},
    changed() { workspace.report(); }, renderTabs() { rendered++; },
  });
  for (let i = 0; i < 20; i++) await workspace.open('file-' + i + '.txt');
  reads = reports = rendered = 0;
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    active.model.text += 'a';
    if (baseline) { state.currentText = active.model.getValue(); workspace.report(); }
    else workspace.contentChanged(active.model);
  }
  const ms = performance.now() - start;
  const counts = { getValue: reads, reportEditorState: reports, renderTabs: rendered };
  if (state.currentText.length !== 1000100) throw new Error('Latest snapshot lost');
  return { ...counts, milliseconds: ms, getValueAfterSnapshot: reads };
}
(async () => {
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await run());
  const times = results.map(r => r.milliseconds).sort((a, b) => a - b);
  console.log(JSON.stringify({ mode: baseline ? 'baseline' : 'optimized', baselineRef, documentChars: 1000000, tabs: 20, edits: 100, repeats: 7, counts: results[0], medianMilliseconds: times[3], minMilliseconds: times[0], maxMilliseconds: times[6] }, null, 2));
})();
