/** 原生离线 Monaco 回归与模型操作基线；不代表人工输入延迟或帧率。 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const baselineRef = '37fdd47d770ed1311cd4602b014063e1d9eb73cf';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-editor-input-probe-'));
app.setPath('userData', path.join(directory, 'user-data'));
app.disableHardwareAcceleration();
const network = []; const results = []; let window;
const deadline = setTimeout(() => finish(new Error('原生输入验证超过 60 秒')), 60000);
function finish(error) {
  clearTimeout(deadline);
  const report = { ok: !error, baselineRef, directory, results, network, error: error && String(error.stack || error) };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(error ? 1 : 0);
}

async function fixture(baseline) {
  const checks = [];
  function check(name, condition) { checks.push({ name, pass: Boolean(condition) }); if (!condition) throw new Error(name); }
  const original = ('0123456789abcdef\n').repeat(58824).slice(0, 1000000);
  const state = { root: 'memory-fixture', currentPath: null, currentText: '', savedText: '' };
  const models = [];
  let reads = 0, reports = 0, renders = 0, active, lastReport, saveFinish;
  const written = [];
  const empty = monaco.editor.createModel('', 'plaintext');
  const editor = monaco.editor.create(document.getElementById('editor'), {
    model: empty, minimap: { enabled: false }, automaticLayout: false, wordWrap: 'off',
  });
  const workspace = window.createEditorWorkspace({ state,
    bridge: {
      readFile: async () => ({ ok: true, text: original }),
      writeFile: async (file, text) => { written.push({ file, text }); return new Promise(resolve => { saveFinish = resolve; }); },
      reportEditorState(value) { reports++; lastReport = value; }, onEditorRequest() {},
      confirmLeave: async () => ({ ok: false }),
    },
    ready: async () => {},
    createModel(file, text) {
      const model = monaco.editor.createModel(text, 'plaintext');
      const getValue = model.getValue.bind(model);
      model.getValue = function (...args) { reads++; return getValue(...args); };
      models.push(model); return model;
    },
    captureViewState() { return editor.saveViewState(); },
    showDocument(doc) { active = doc; editor.setModel(doc ? doc.model : empty); },
    replaceContent(doc, text) { doc.model.setValue(text); },
    disposeModel(model) { model.dispose(); }, highlight() {}, setInfo() {},
    changed() { workspace.report(); }, renderTabs() { renders++; },
  });
  const listener = editor.onDidChangeModelContent(() => {
    if (baseline) { const text = editor.getValue(); if (text !== state.currentText) { state.currentText = text; workspace.report(); } }
    else workspace.contentChanged(editor.getModel());
  });
  function append(text) {
    const model = editor.getModel(), line = model.getLineCount(), column = model.getLineMaxColumn(line);
    editor.executeEdits('offline-probe', [{ range: new monaco.Range(line, column, line, column), text }]);
  }
  function replace(text) { editor.executeEdits('offline-probe', [{ range: editor.getModel().getFullModelRange(), text }]); }
  try {
    for (let i = 0; i < 20; i++) await workspace.open('file-' + i + '.txt');
    check('20 个独立真实 Monaco 模型', models.length === 20 && lastReport.documents.length === 20);
    reads = reports = renders = 0;
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      append('a');
      if (i === 0) check('首次输入立即报告未保存', lastReport.documents.at(-1).dirty === true);
    }
    const milliseconds = performance.now() - start;
    const counts = { getValue: reads, reportEditorState: reports, renderTabs: renders };
    check('连续输入报告与读取次数符合目标', baseline ? reads >= 100 && reports === 100 : reads === 0 && reports === 1 && renders === 1);
    check('惰性正文读取保留完整 100 次追加', state.currentText === original + 'a'.repeat(100));
    const snapshotReads = reads;
    if (!baseline) {
      replace(original); check('手工还原全文立即清除脏标记', !workspace.isDirty());
      editor.pushUndoStop();
      editor.executeEdits('offline-probe', [{ range: new monaco.Range(1, 1, 1, 2), text: 'Z' }]);
      editor.pushUndoStop(); check('同长度替换仍立即判脏', workspace.isDirty());
      editor.trigger('offline-probe', 'undo', null);
      check('真实 Monaco undo 清除脏标记', !workspace.isDirty() && state.currentText === original);
      append(' pending-save');
      const beforeSave = state.currentText;
      const saving = workspace.save();
      append(' newer-edit');
      await workspace.open('file-0.txt');
      check('切标签保留独立干净状态', !workspace.isDirty());
      saveFinish({ ok: true });
      check('旧保存回执不能将新输入标记为已保存', await saving === false);
      await workspace.open('file-19.txt');
      check('保存中输入切回后完整保留', state.currentText === beforeSave + ' newer-edit' && workspace.isDirty());
      check('保存仅使用提交时快照', written[0].text === beforeSave && state.savedText === beforeSave);
      check('关闭脏标签取消后正文仍存在', await workspace.close('file-19.txt') === false && state.currentText === beforeSave + ' newer-edit');
      state.root = 'next-memory-project'; workspace.clear();
      check('切项目释放旧模型并清除标签与脏状态', models.every(model => model.isDisposed()) && !workspace.isDirty() && lastReport.documents.length === 0);
    }
    return { mode: baseline ? 'baseline' : 'optimized', documentChars: original.length, tabs: 20, edits: 100, counts, getValueAfterSnapshot: snapshotReads, milliseconds, checks };
  } finally {
    listener.dispose(); editor.dispose(); empty.dispose();
    models.forEach(model => { if (!model.isDisposed()) model.dispose(); });
  }
}

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    if (/^https?:/.test(request.url)) { network.push(new URL(request.url).origin); callback({ cancel: true }); }
    else callback({});
  });
  const vendor = pathToFileURL(path.resolve('dist/renderer/vendor/monaco/vs')).href;
  const html = path.join(directory, 'fixture.html');
  fs.writeFileSync(html, '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src file: \'unsafe-inline\' \'unsafe-eval\'; style-src file: \'unsafe-inline\'; font-src file:; worker-src data:; connect-src \'none\'"></head><body><div id="editor" style="width:900px;height:650px"></div><script src="' + vendor + '/loader.js"></script></body></html>');
  await window.loadFile(html);
  await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{window.MonacoEnvironment={getWorkerUrl:()=> 'data:text/javascript,'};require.config({paths:{vs:${JSON.stringify(vendor)}}});require(['vs/editor/editor.main'],()=>resolve(),reject)})`);
  const baselineSource = execFileSync('git', ['show', baselineRef + ':src/renderer/editorWorkspace.js'], { encoding: 'utf8' });
  const currentSource = fs.readFileSync('src/renderer/editorWorkspace.js', 'utf8');
  for (const baseline of [true, false]) {
    await window.webContents.executeJavaScript(baseline ? baselineSource : currentSource);
    results.push(await window.webContents.executeJavaScript('(' + fixture.toString() + ')(' + baseline + ')'));
  }
  if (network.length) throw new Error('离线 probe 尝试联网');
  finish();
}).catch(finish);
