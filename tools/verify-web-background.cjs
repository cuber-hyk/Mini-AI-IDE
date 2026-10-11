/** Native offline acceptance: no remote site, user profile, CDP, or browser driver. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-ide-background-verify-'));
  const env = { ...process.env, MINI_IDE_BACKGROUND_VERIFY: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = require('node:child_process').spawnSync(require('electron'), [__filename], {
    cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 60000,
  });
  process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
  if (run.error) console.error(run.error.message);
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exit(run.status ?? 1);
}

require('tsx/cjs');
const ts = require('typescript');
const { app, BaseWindow, WebContentsView, session } = require('electron');
const { WebComposerSender } = require('../src/main/webComposerSender.ts');
const { DEEPSEEK_SEND_ICON } = require('../src/main/tools/replyObservation.ts');
const { ToolProcesses } = require('../src/main/tools/processes.ts');
const { sessionKeyOf } = require('../src/main/consumptionStore.ts');
const temporary = process.env.MINI_IDE_BACKGROUND_VERIFY;
assert.ok(temporary);
app.setPath('userData', path.join(temporary, 'userData'));

function productionPolicy(file, owner) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, 'src/main', file), 'utf8'), ts.ScriptTarget.Latest, true);
  let policy;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === owner && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const property = node.initializer.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(source) === 'backgroundThrottling');
      if (property) {
        assert.equal(property.initializer.kind, ts.SyntaxKind.FalseKeyword, `${file} must keep the official page running in the background`);
        policy = false;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source); assert.equal(policy, false, `${file} background policy missing`); return policy;
}
assert.equal(productionPolicy('webPlatformView.ts', 'webPreferences'), false);
const backgroundThrottling = productionPolicy('index.ts', 'webPagePreferences');
const fixture = path.join(temporary, 'composer.html');
fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8"><title>Offline background verification</title>
<style>textarea{width:400px;height:90px}.ds-button{width:40px;height:40px}</style>
<section><textarea></textarea><div role="button" aria-disabled="true" class="ds-button ds-button--primary ds-button--filled ds-button--circle"><svg><path d="${DEEPSEEK_SEND_ICON}"></path></svg></div></section>
<script>
window.ticks=0;window.frames=0;window.maxDelay=0;window.clicks=0;window.received=[];
let previous=Date.now();setInterval(()=>{const now=Date.now();window.maxDelay=Math.max(window.maxDelay,now-previous);previous=now;window.ticks++;},25);
function frame(){window.frames++;requestAnimationFrame(frame);}requestAnimationFrame(frame);
const input=document.querySelector('textarea'),send=document.querySelector('[role=button]');
input.addEventListener('input',()=>requestAnimationFrame(()=>send.setAttribute('aria-disabled',input.value?'false':'true')));
send.addEventListener('click',()=>{window.clicks++;window.received.push(input.value);input.value='';send.setAttribute('aria-disabled','true');});
</script>`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, view, cover;
const processes = new ToolProcesses();
const read = code => view.webContents.executeJavaScript(code);

app.whenReady().then(async () => {
  const offline = session.fromPartition('background-verify-offline');
  offline.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
  win = new BaseWindow({ show: false, width: 640, height: 480, title: 'Offline background verification' });
  view = new WebContentsView({ webPreferences: { session: offline, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling } });
  win.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 640, height: 440 });
  const bounds = win.getBounds();
  cover = new BaseWindow({ show: false, x: bounds.x - 50, y: bounds.y - 50, width: bounds.width + 100,
    height: bounds.height + 100, backgroundColor: '#ffffff', title: 'Offline verification cover' });
  await view.webContents.loadFile(fixture);
  for (const mode of ['visible', 'covered', 'hidden', 'minimized']) {
    cover.hide(); win.restore(); win.show(); win.setAlwaysOnTop(true); view.setVisible(true); win.focus();
    if (mode === 'covered') { win.setAlwaysOnTop(false); cover.setAlwaysOnTop(true); cover.show(); cover.focus(); }
    if (mode === 'hidden') win.hide();
    if (mode === 'minimized') win.minimize();
    await pause(1200);
    await read('window.maxDelay=0');
    const start = await read('({ticks,frames,clicks})');
    const command = processes.execute(temporary, 'run_command', {
      command: 'Start-Sleep -Milliseconds 500; Write-Output background-command-ok', shell: 'powershell', timeout_ms: 10000,
    });
    await pause(1600);
    const end = await read('({ticks,frames,visibility:document.visibilityState,maxDelay})');
    const output = await command;
    const sender = new WebComposerSender(view.webContents, { allowLocalFixture: true });
    const sentAt = Date.now();
    let sent;
    try { sent = await sender.send(`background-${mode}`, sessionKeyOf(view.webContents.getURL()), 'prompt', () => true); }
    finally { await sender.dispose(); }
    const receipt = await read('({clicks,received})');
    const report = { mode, backgroundThrottling: view.webContents.getBackgroundThrottling(), visibility: end.visibility,
      nativeVisible: win.isVisible(), nativeMinimized: win.isMinimized(), nativeFocused: win.isFocused(),
      timerTicks: end.ticks - start.ticks, rafTicks: end.frames - start.frames, timerMaxMs: end.maxDelay,
      commandStatus: output.status, commandOutput: output.stdout.trim(), send: sent, sendDurationMs: Date.now() - sentAt,
      senderClicks: receipt.clicks - start.clicks };
    console.log(JSON.stringify(report));
    assert.equal(report.backgroundThrottling, false);
    assert.ok(report.timerTicks >= 16, `timer stalled while ${mode}`);
    assert.ok(report.rafTicks >= 16, `animation frames stalled while ${mode}`);
    assert.equal(output.status, 'done'); assert.match(output.stdout, /background-command-ok/);
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(report.senderClicks, 1); assert.equal(receipt.received.at(-1), `background-${mode}`);
    assert.equal(await read('typeof window.require'), 'undefined');
  }
  console.log('Passed 4 native background scenarios; 0 skipped.');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await processes.dispose();
  if (view && !view.webContents.isDestroyed()) view.webContents.close();
  if (cover && !cover.isDestroyed()) cover.destroy();
  if (win && !win.isDestroyed()) win.destroy();
  app.quit();
});
