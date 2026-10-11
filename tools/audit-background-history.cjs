/** Offline audit: isolated data, native Electron, no remote site or browser driver. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-ide-background-audit-'));
  const env = { ...process.env, MINI_IDE_BACKGROUND_AUDIT: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = require('node:child_process').spawnSync(require('electron'), [__filename], {
    cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 90000,
  });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  if (run.error) process.stderr.write(run.error.message + '\n');
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exit(run.status ?? 1);
}

require('tsx/cjs');
const { app, BaseWindow, WebContentsView } = require('electron');
const { AutoCollector } = require('../src/main/tools/autoCollector.ts');
const { ReplyMonitor, DEEPSEEK_SEND_ICON } = require('../src/main/tools/replyObservation.ts');
const { ReplyChangeWatcher } = require('../src/main/tools/replyChangeWatcher.ts');
const { ToolHarness } = require('../src/main/tools/harness.ts');
const { ToolStore } = require('../src/main/tools/store.ts');
const { ToolProcesses } = require('../src/main/tools/processes.ts');
const { createToolIntegration } = require('../src/main/tools/integration.ts');
const { FileService } = require('../src/main/fileService.ts');
const { ReturnPathService } = require('../src/main/returnPathService.ts');
const { WebComposerSender } = require('../src/main/webComposerSender.ts');
const { sessionKeyOf } = require('../src/main/consumptionStore.ts');
const temporary = process.env.MINI_IDE_BACKGROUND_AUDIT;
assert.ok(temporary);
app.setPath('userData', path.join(temporary, 'userData'));
const fixture = path.join(temporary, 'fixture.html');
const batch = id => JSON.stringify({ protocol_version: 1, batch_id: id,
  requests: [{ id: 'command', tool: 'run_command', args: {
    command: 'Write-Output audit-history-command-ok', shell: 'powershell', timeout_ms: 10000,
  } }] });
const markup = payload => `<section><article class="markdown"><pre><code class="language-mini-ai-tools">${payload}</code></pre></article><button>Copy</button></section>`;
fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8">
<main id="replies">${markup(batch('baseline-history'))}</main>
<section id="composer"><textarea></textarea><div role="button" aria-disabled="true"
class="ds-button ds-button--primary ds-button--filled ds-button--circle"><svg><path d="${DEEPSEEK_SEND_ICON}"></path></svg></div></section>
<script>
window.delays=[]; window.raf=0; window.clicks=0; window.scheduleMode='timer';
let previous=Date.now(); setInterval(()=>{let now=Date.now();window.delays.push(now-previous);previous=now;},25);
function frame(){window.raf++;requestAnimationFrame(frame);}requestAnimationFrame(frame);
const input=document.querySelector('textarea'),send=document.querySelector('[role=button]');
input.addEventListener('input',()=>{const update=()=>send.setAttribute('aria-disabled',input.value?'false':'true');
  if(window.scheduleMode==='raf')requestAnimationFrame(update);else setTimeout(update,30);});
send.addEventListener('click',()=>{window.clicks++;input.value='';});
</script>`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let win, view, cover;
const read = script => view.webContents.executeJavaScript(script);
const report = (scenario, value) => { results.push({ scenario, ...value }); console.log(JSON.stringify(results.at(-1))); };
async function until(check) {
  const end = Date.now() + 4000;
  while (!await check()) { assert.ok(Date.now() < end, 'audit condition timed out'); await pause(25); }
}
async function resetPage() { await view.webContents.loadFile(fixture); await pause(250); }
async function replaceReplies(payloads) {
  await read(`document.querySelector('#replies').innerHTML=${JSON.stringify(payloads.map(markup).join(''))};`);
}
async function appendReplies(payloads) {
  await read(`document.querySelector('#replies').insertAdjacentHTML('beforeend',${JSON.stringify(payloads.map(markup).join(''))});`);
}

app.whenReady().then(async () => {
  win = new BaseWindow({ show: false, width: 640, height: 480, title: 'Offline background audit' });
  view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 640, height: 440 });
  const bounds = win.getBounds();
  cover = new BaseWindow({ show: false, x: bounds.x - 50, y: bounds.y - 50,
    width: bounds.width + 100, height: bounds.height + 100, backgroundColor: '#ffffff', title: 'Offline audit cover' });
  await resetPage();
  const processes = new ToolProcesses();
  try {
    for (const mode of ['visible', 'covered', 'hidden', 'minimized', 'hidden-unthrottled']) {
      cover.hide();
      if (mode === 'visible' || mode === 'covered') {
        win.restore(); win.show(); win.setAlwaysOnTop(true); view.setVisible(true); win.focus();
      }
      if (mode === 'covered') { win.setAlwaysOnTop(false); cover.setAlwaysOnTop(true); cover.show(); cover.focus(); }
      else if (mode === 'minimized') { win.showInactive(); win.minimize(); }
      else if (mode !== 'visible') win.hide();
      if (mode === 'hidden-unthrottled') view.webContents.setBackgroundThrottling(false);
      await pause(1200);
      const start = await read('({ticks:delays.length,raf,visibility:document.visibilityState})');
      const command = processes.execute(temporary, 'run_command', {
        command: 'Start-Sleep -Milliseconds 500; Write-Output audit-command-ok', shell: 'powershell', timeout_ms: 10000,
      });
      await pause(2200);
      const finish = await read(`({ticks:delays.length,raf,visibility:document.visibilityState,delays:delays.slice(${start.ticks})})`);
      const output = await command;
      const sender = new WebComposerSender(view.webContents, { allowLocalFixture: true });
      const at = Date.now();
      const sent = await sender.send('audit-payload', sessionKeyOf(view.webContents.getURL()), 'prompt', () => true);
      await sender.dispose();
      report(mode, { backgroundThrottling: view.webContents.getBackgroundThrottling(), visibility: finish.visibility,
        nativeVisible: win.isVisible(), nativeMinimized: win.isMinimized(), nativeFocused: win.isFocused(),
        timerTicks: finish.ticks - start.ticks, rafTicks: finish.raf - start.raf,
        timerMaxMs: Math.max(0, ...finish.delays), commandStatus: output.status, commandDurationMs: output.duration_ms,
        commandOutput: output.stdout.trim(), send: sent, sendDurationMs: Date.now() - at });
      assert.equal(output.status, 'done'); assert.match(output.stdout, /audit-command-ok/);
      assert.equal(sent.ok, true);
    }

    view.webContents.setBackgroundThrottling(true);
    for (const mode of ['visible-raf-composer', 'covered-raf-composer']) {
      cover.hide(); win.restore(); win.show(); win.setAlwaysOnTop(true); view.setVisible(true); win.focus();
      if (mode.startsWith('covered')) { win.setAlwaysOnTop(false); cover.setAlwaysOnTop(true); cover.show(); cover.focus(); }
      await pause(1500);
      await read("window.scheduleMode='raf';document.querySelector('[role=button]').setAttribute('aria-disabled','true')");
      const sender = new WebComposerSender(view.webContents, { allowLocalFixture: true });
      const at = Date.now();
      const sent = await sender.send('audit-raf-payload', sessionKeyOf(view.webContents.getURL()), 'prompt', () => true);
      report(mode, { visibility: await read('document.visibilityState'), send: sent, sendDurationMs: Date.now() - at });
      await sender.dispose();
    }
    cover.hide(); win.hide(); view.webContents.setBackgroundThrottling(false);

    // Re-mount an older unreserved message as the last DOM reply, with no new generation.
    await resetPage();
    await replaceReplies([batch('older-unreserved'), batch('another-unreserved'), batch('baseline-history')]);
    await read("window.savedReplies=Array.from(document.querySelector('#replies').children)");
    const store = new ToolStore(path.join(temporary, 'history-state.json')); await store.ready();
    await store.configure({ permission: 'full' });
    const executed = [];
    const harness = new ToolHarness({ store, root: () => temporary, session: () => 'same-session',
      describe: async () => ({ fingerprint: 'audit', external: false, canRemember: false }),
      authorize: async () => 'once', execute: async (cwd, request, started) => {
        executed.push(request.id); return processes.execute(cwd, request.tool, request.args, started);
      },
      changed() {} });
    const monitor = new ReplyMonitor(view.webContents, { allowLocalFixture: true });
    const collected = [];
    const auto = new AutoCollector(() => monitor.read(), async text => { collected.push(text); await harness.collect(text); }, () => {});
    const watcher = new ReplyChangeWatcher(view.webContents, () => auto.tick(), (preserve, history, generated) => {
      if (generated) auto.observeGeneration(sessionKeyOf(view.webContents.getURL()));
      else if (preserve) auto.continueAt(sessionKeyOf(view.webContents.getURL()));
      else auto.reset(history);
    }, message => { throw new Error(message); }, () => {}, { allowLocalFixture: true });
    auto.setEnabled(true); watcher.setEnabled(true); await pause(800);
    await replaceReplies([batch('older-unreserved')]); await pause(350);
    await replaceReplies([batch('unseen-unmounted-history')]); await pause(350);
    assert.equal(executed.length, 0, '回看已见和从未挂载的历史都不得启动命令');
    await read("document.querySelector('#replies').replaceChildren(...window.savedReplies)"); await pause(350);
    await appendReplies([batch('new-command-one')]); await until(() => executed.length === 1 && !harness.getState().busy);
    await appendReplies([batch('new-command-two')]); await until(() => executed.length === 2 && !harness.getState().busy);
    assert.equal(harness.getState().results[0].status, 'done');
    await read(`document.querySelector('#replies').lastElementChild.querySelector('code').textContent=${JSON.stringify(batch('unseen-history-on-reused-node'))}`);
    await pause(350); assert.equal(executed.length, 2, '已完成节点复用旧正文不得启动第三条命令');
    await replaceReplies([batch('new-command-one')]); await pause(350);
    report('history-remount', { generationObserved: false, collections: collected.length,
      executed: executed.length, realCommands: true, historyCollections: collected.length - 2, historicalCommands: 0 });
    assert.equal(executed.length, 2, '新批次执行两次，回看不增加执行');
    assert.equal(collected.length, 2, '历史应在进入工具层之前停止');
    await watcher.dispose(); auto.dispose();

    // An old parsed error cannot gain a new diagnostic after an intervening plain reply.
    await resetPage();
    const files = new FileService(); files.setRoot(temporary);
    const sentDiagnostics = [];
    const system = await createToolIntegration({ ipc: { handle() {} }, editor: { mainFrame: {}, send() {}, isDestroyed: () => false },
      web: view.webContents, files, returnPath: new ReturnPathService(files),
      workspace: { editor: { isDirty: () => false, current: { documents: [] } }, run: fn => fn() },
      storePath: path.join(temporary, 'diagnostic-state.json'), disabled: false, allowLocalFixture: true,
      ask: async () => ({ response: 0, checkboxChecked: false }), notifyFile() {}, copy() {},
      sender: { async send(text) { sentDiagnostics.push(text); return { ok: true }; }, async cancel() {}, async dispose() {} } });
    try {
      await system.configure({ automatic: true, sendIntervalSeconds: 0 }); await pause(800);
      await appendReplies(['{"protocol_version":1,"batch_id":"old-broken",']);
      await until(() => sentDiagnostics.length === 1);
      await read("document.querySelector('#replies').insertAdjacentHTML('beforeend','<section><article class=markdown><p>Finished</p></article><button>Copy</button></section>')");
      await until(() => !system.getState().batchError);
      await appendReplies(['{"protocol_version":1,"batch_id":"old-broken",']); await pause(400);
      await replaceReplies(['{"protocol_version":1,"batch_id":"old-broken",']);
      await pause(400);
      report('old-diagnostic-remount', { sends: sentDiagnostics.length, oldErrorResent: false,
        executedTools: system.getState().results.length });
      assert.equal(sentDiagnostics.length, 1, '旧错误追加和重挂载均不得再次回传');
    } finally { await system.dispose(); }
  } finally { await processes.dispose(); }
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (view && !view.webContents.isDestroyed()) view.webContents.close();
  if (cover && !cover.isDestroyed()) cover.destroy();
  if (win && !win.isDestroyed()) win.destroy();
  app.quit();
});
