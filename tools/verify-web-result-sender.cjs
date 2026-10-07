/** 原生离线 Electron DOM 夹具：无驱动、无 CDP、无官方网页或用户会话。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-ide-web-send-'));
  env.MINI_IDE_WEB_SEND_FIXTURE_DIR = directory;
  const run = spawnSync(require('electron'), [__filename], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error) console.error(run.error.message);
  // Electron 退出后删除本次明确创建的目录，避免仍持有日志文件时静默跳过清理。
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
  process.exit(run.status ?? 1);
}

require('tsx/cjs');
const { app, BrowserWindow, session } = require('electron');
const { WebResultSender, RESULT_SEND_WORLD } = require('../src/main/tools/webResultSender.ts');
const { DEEPSEEK_SEND_ICON, ReplyMonitor } = require('../src/main/tools/replyObservation.ts');
const { ReplyChangeWatcher, REPLY_WATCH_WORLD } = require('../src/main/tools/replyChangeWatcher.ts');
const { AutoCollector } = require('../src/main/tools/autoCollector.ts');
const { parseToolBatch } = require('../src/shared/toolProtocol.ts');
const { sessionKeyOf } = require('../src/main/consumptionStore.ts');
const temporary = process.env.MINI_IDE_WEB_SEND_FIXTURE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'mini-ide-web-send-'));
app.setPath('userData', path.join(temporary, 'userData'));
const fixturePath = path.join(temporary, 'composer.html');
fs.writeFileSync(fixturePath, `<!doctype html><meta charset="utf-8"><title>离线工具结果发送夹具</title>
<style>textarea{width:400px;height:100px}.ds-button{width:40px;height:40px}</style>
<section id="composer"><textarea id="input"></textarea><div role="button" aria-disabled="true" class="ds-button ds-button--primary ds-button--filled ds-button--circle"><svg><path d="${DEEPSEEK_SEND_ICON}"/></svg></div></section>
<script>
window.received = []; window.clicks = 0; window.inputs = 0;
window.mode = 'normal'; window.delay = 0;
const input = document.querySelector('textarea'), button = document.querySelector('[role="button"]');
input.addEventListener('input', () => { window.inputs++; if (window.mode === 'disabled') return; setTimeout(() => button.setAttribute('aria-disabled', input.value ? 'false' : 'true'), window.delay); });
button.addEventListener('click', () => { window.clicks++; window.received.push(input.value); if (window.mode === 'normal') input.value = ''; if (window.mode === 'generating') { const stop = document.createElement('button'); stop.textContent = '停止生成'; document.body.append(stop); } });
</script>`, 'utf8');

let window;
let sender;
let passed = 0;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function setup(script = '', local = true) {
  if (sender) await sender.dispose();
  await window.loadFile(fixturePath);
  if (script) await window.webContents.executeJavaScript(script);
  sender = new WebResultSender(window.webContents, { allowLocalFixture: local });
}
const send = text => sender.send(text, sessionKeyOf(window.webContents.getURL()));
const state = () => window.webContents.executeJavaScript(`({value:document.querySelector('textarea').value,clicks:window.clicks,received:window.received,inputs:window.inputs,localBridge:typeof window.require,sendState:typeof window.__miniAIResultSend})`);
async function test(name, check) { await check(); passed++; console.log('ok ' + name); }
async function until(check, message) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > 3000) assert.fail(message); await pause(25); }
}
async function autoFixture() {
  await setup(`
    window.replyRound = 0; window.lastClickTrusted = null;
    window.addToolReply = id => {
      const frame = document.createElement('section'), reply = document.createElement('article');
      reply.className = 'ds-markdown';
      const pre = document.createElement('pre'), code = document.createElement('code');
      code.className = 'language-mini-ai-tools';
      code.textContent = JSON.stringify({ protocol_version:1, batch_id:id, requests:[{id:'project',tool:'get_project_info',args:{}}] });
      pre.append(code); reply.append(pre); frame.append(reply);
      const copy = document.createElement('button'); copy.className = 'ds-button'; copy.textContent = '复制'; frame.append(copy);
      document.body.insertBefore(frame, document.querySelector('#composer'));
    };
    window.addToolReply('history-batch');
    document.querySelector('[role="button"]').addEventListener('click', event => {
      window.lastClickTrusted = event.isTrusted;
      const stop = document.createElement('button'); stop.className = 'ds-button'; stop.textContent = '停止生成'; document.body.append(stop);
      const id = 'next-batch-' + (++window.replyRound);
      setTimeout(() => { window.addToolReply(id); stop.remove(); }, 300);
    });
  `);
  const collected = [], reports = [], trustedTurns = [];
  let changes = 0;
  const monitor = new ReplyMonitor(window.webContents);
  const auto = new AutoCollector(() => monitor.read(), async (text, current) => {
    assert.equal(current(), true);
    const parsed = parseToolBatch(text); assert.equal(parsed.kind, 'batch', text);
    collected.push(parsed.batch.batch_id);
  }, message => reports.push(message));
  auto.setEnabled(true);
  const watcher = new ReplyChangeWatcher(window.webContents, async userTurn => {
    trustedTurns.push(userTurn);
    if (userTurn) auto.noteUserTurn();
    await auto.tick(); changes++;
  }, () => auto.reset(), message => reports.push(message));
  watcher.setEnabled(true);
  await until(() => changes > 0, '生产 watcher 未建立历史基线');
  assert.deepEqual(collected, []);
  return { auto, watcher, collected, reports, trustedTurns, changes: () => changes,
    async dispose() { await watcher.dispose(); auto.dispose(); } };
}

app.whenReady().then(async () => {
  const offline = session.fromPartition('web-result-sender-offline');
  offline.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
  window = new BrowserWindow({ show: false, webPreferences: { session: offline, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await test('默认拒绝本地页面，只有测试显式开启 fixture', async () => { await setup('', false); assert.equal((await send('result')).ok, false); assert.equal((await state()).inputs, 0); });
  await test('真实 textarea 原型 setter/input/click，文本转义与隔离世界无主世界能力', async () => {
    await setup(`Object.defineProperty(document.querySelector('textarea'), 'value', { configurable: true, get: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').get, set: () => { throw Error('必须使用 native setter'); } }); window.mode = 'generating';`);
    const text = '真实工具结果\n</script> " \' \\ ` ${value} <b>text</b>\r\n第二行';
    const result = await send(text); assert.equal(result.ok, true, JSON.stringify(result));
    const s = await state(); assert.equal(s.clicks, 1); assert.deepEqual(s.received, [text.replace(/\r\n?/g, '\n')]); assert.equal(s.inputs, 1); assert.equal(s.localBridge, 'undefined'); assert.equal(s.sendState, 'undefined');
    assert.equal(await window.webContents.executeJavaScriptInIsolatedWorld(RESULT_SEND_WORLD, [{ code: 'typeof globalThis.__miniAIResultSend' }]), 'undefined');
  });
  await test('空输入填入后等待按钮启用，成功只点击一次', async () => { await setup('window.delay=150'); assert.equal((await send('result')).ok, true); assert.equal((await state()).clicks, 1); assert.equal((await state()).value, ''); });
  await test('已有用户草稿不读取回传或覆盖', async () => { await setup(`document.querySelector('textarea').value='用户草稿'`); assert.equal((await send('result')).ok, false); assert.equal((await state()).value, '用户草稿'); assert.equal((await state()).inputs, 0); });
  await test('唯一可见 textarea，隐藏控件可忽略但第二个可见控件暂停', async () => {
    await setup(`document.body.insertAdjacentHTML('beforeend','<textarea hidden></textarea>')`); assert.equal((await send('result')).ok, true);
    await setup(`document.body.insertAdjacentHTML('beforeend','<textarea></textarea>')`); assert.equal((await send('result')).ok, false); assert.equal((await state()).inputs, 0);
  });
  await test('拒绝未知图标、重复发送控件和无局部 composer 关联', async () => {
    for (const script of [`document.querySelector('path').setAttribute('d','unknown')`, `document.querySelector('#composer').append(document.querySelector('[role="button"]').cloneNode(true))`, `document.body.append(document.querySelector('[role="button"]'))`]) { await setup(script); assert.equal((await send('result')).ok, false); assert.equal((await state()).inputs, 0); }
  });
  await test('生成/中断/只读/禁用/maxlength 均在填入前暂停', async () => {
    for (const script of [`document.body.insertAdjacentHTML('beforeend','<button>停止生成</button>')`, `document.body.insertAdjacentHTML('beforeend','<button>继续生成</button>')`, `document.querySelector('textarea').readOnly=true`, `document.querySelector('textarea').disabled=true`, `document.querySelector('textarea').maxLength=2`]) { await setup(script); assert.equal((await send('result')).ok, false); assert.equal((await state()).inputs, 0); }
  });
  await test('关闭立即阻止待启用点击，并清理仍自有结果', async () => {
    await setup('window.delay=500'); const sending = send('result'); await pause(80); await sender.cancel(); assert.equal((await sending).ok, false); const s = await state(); assert.equal(s.clicks, 0); assert.equal(s.value, '');
  });
  await test('等待过程中用户改写不得覆盖，也不得发送', async () => {
    await setup('window.delay=500'); const sending = send('result'); await pause(70); await window.webContents.executeJavaScript(`document.querySelector('textarea').value='用户改写'`); assert.equal((await sending).ok, false); assert.equal((await state()).value, '用户改写'); assert.equal((await state()).clicks, 0);
  });
  await test('等待过程中控件替换或进入生成立即暂停', async () => {
    for (const script of [`document.querySelector('[role="button"]').replaceWith(document.querySelector('[role="button"]').cloneNode(true))`, `document.body.insertAdjacentHTML('beforeend','<button>停止生成</button>')`]) { await setup('window.delay=500'); const sending = send('result'); await pause(70); await window.webContents.executeJavaScript(script); assert.equal((await sending).ok, false); assert.equal((await state()).clicks, 0); assert.equal((await state()).value, ''); }
  });
  await test('发送按钮始终不可用，有界超时且清理未发送结果', async () => { await setup(`window.mode='disabled'`); const r = await send('result'); assert.equal(r.ok, false); assert.equal(r.uncertain, undefined); assert.equal((await state()).clicks, 0); assert.equal((await state()).value, ''); });
  await test('点击后无确认报 unknown，保持内容且不重试', async () => { await setup(`window.mode='unknown'`); const r = await send('result'); assert.equal(r.ok, false); assert.equal(r.uncertain, true); assert.equal((await state()).clicks, 1); assert.equal((await state()).value, 'result'); });
  await test('点击后取消不能清理可能已提交文本', async () => { await setup(`window.mode='unknown'`); const sending = send('result'); await pause(120); await sender.cancel(); const r = await sending; assert.equal(r.uncertain, true); assert.equal((await state()).clicks, 1); assert.equal((await state()).value, 'result'); });
  await test('渲染进程原生导航在按钮等待期间阻止点击', async () => { await setup('window.delay=500'); const sending = send('result'); await pause(70); await window.loadFile(fixturePath); const r = await sending; assert.equal(r.ok, false); assert.equal((await state()).clicks, 0); });
  await test('合成发送不会伪装真实用户新轮：未显式标记时生产 watcher 不采集', async () => {
    const f = await autoFixture();
    try {
      assert.equal((await send('本批真实结果')).ok, true);
      await until(() => f.changes() >= 3, '生成和结束变化未送达生产 watcher');
      assert.deepEqual(f.collected, []);
      assert.equal(await window.webContents.executeJavaScript('window.lastClickTrusted'), false);
      assert.equal(f.trustedTurns.some(Boolean), false);
    } finally { await f.dispose(); }
  });
  await test('sender → 原生 MutationObserver → AutoCollector：显式新轮连续两批只采集各一次', async () => {
    const f = await autoFixture();
    try {
      for (let round = 1; round <= 2; round++) {
        // 与生产集成相同：本地已确认本批结束后、发送结果前显式标记新轮。
        f.auto.noteUserTurn();
        assert.equal((await send('第 ' + round + ' 批真实工具结果')).ok, true);
        await until(() => f.collected.length === round, '自动结果回传的新回复未采集');
        assert.deepEqual(f.collected, Array.from({ length: round }, (_, index) => 'next-batch-' + (index + 1)));
        const previousChanges = f.changes();
        await window.webContents.executeJavaScript(`document.querySelectorAll('.ds-markdown').item(${round}).textContent += ' ';`);
        await until(() => f.changes() > previousChanges, '重复 DOM 通知未送达');
        assert.equal(f.collected.length, round, '重复变化不能执行已采集批次');
      }
      assert.equal((await state()).clicks, 2);
      assert.equal(await window.webContents.executeJavaScript('window.lastClickTrusted'), false);
      assert.equal(f.trustedTurns.some(Boolean), false);
      assert.equal(await window.webContents.executeJavaScript('typeof globalThis.__miniAIReplyChanges'), 'undefined');
      assert.equal(await window.webContents.executeJavaScriptInIsolatedWorld(REPLY_WATCH_WORLD, [{ code: 'typeof globalThis.__miniAIResultSend' }]), 'undefined');
      assert.equal(await window.webContents.executeJavaScriptInIsolatedWorld(RESULT_SEND_WORLD, [{ code: 'typeof globalThis.__miniAIReplyChanges' }]), 'undefined');
      assert.equal(f.reports.some(message => /失败/.test(message)), false, JSON.stringify(f.reports));
    } finally { await f.dispose(); }
  });
  console.log('原生离线 DOM 夹具：通过 ' + passed + '，未连接官方网页；不证明官方网页接受合成发送。');
}).catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (sender) await sender.dispose();
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(process.exitCode || 0);
});
