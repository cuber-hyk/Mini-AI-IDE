// Same synthetic 60-frame drag for both revisions; elapsed time is fixture time, not FPS.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
const baseline = process.argv.includes('--baseline');
const baselineRef = '37fdd47d770ed1311cd4602b014063e1d9eb73cf';
function load(file, dependencies) {
  const source = baseline ? cp.execFileSync('git', ['show', baselineRef + ':' + file], { encoding: 'utf8' }) : fs.readFileSync(file, 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: n => n in dependencies ? dependencies[n] : require(n) });
  return exports;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-layout-benchmark-'));
try {
  const geometry = load('src/main/windowLayout.ts', {});
  const { SettingsStore } = load('src/main/settings.ts', { electron: { app: { getPath: () => dir } } });
  const { WorkspaceLayoutController } = load('src/main/workspaceLayoutController.ts', { electron: { ipcMain: {} }, '../shared/contract': { CHANNELS: { chromeState: 'state' } }, './windowLayout': geometry });
  const runs = [];
  for (let run = 0; run < 7; run++) {
    let writes = 0, menus = 0, layouts = 0, broadcasts = 0;
    const settings = new SettingsStore('settings-' + run + '.json', dir);
    const update = settings.update.bind(settings);
    settings.update = p => { writes++; return update(p); };
    const view = () => ({ setBounds() {}, setVisible() {}, webContents: { isDestroyed: () => false, send() { broadcasts++; } } });
    const controller = new WorkspaceLayoutController({ isDestroyed: () => false, getContentSize: () => [1600, 900] },
      { editor: view(), web: view(), webbar: view(), preview: view() }, settings, () => { menus++; });
    const apply = controller.apply.bind(controller);
    controller.apply = () => { layouts++; apply(); };
    const start = performance.now();
    // Ten pointer events per frame: legacy sends all ten; optimized sends the latest.
    for (let frame = 0; frame < 60; frame++) {
      for (let move = 0; move < 10; move++) {
        if (baseline || move === 9) controller.update({ fileWidth: 600 + frame * 2 + move }, baseline);
      }
    }
    if (!baseline) { controller.update({ fileWidth: 727 }); }
    runs.push({ ms: performance.now() - start, writes, menus, layouts, broadcasts, requests: baseline ? 600 : 61 });
  }
  const sorted = runs.map(r => r.ms).sort((a,b) => a-b);
  console.log(JSON.stringify({ mode: baseline ? 'baseline' : 'optimized', baselineRef, fixture: '600 moves / 60 synthetic frames', medianMs: sorted[3], minMs: sorted[0], maxMs: sorted[6], counts: runs[6], runs: runs.map(r => r.ms) }, null, 2));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
