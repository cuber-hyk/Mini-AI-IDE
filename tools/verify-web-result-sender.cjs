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
  while (!await check()) { if (Date.now() - started > 3000) assert.fail(message); await pause(25); }
}
async function autoFixture() {
  await setup(`
    window.replyRound = 0; window.lastClickTrusted = null;
    window.addToolReply = id => {
      const frame = document.createElement('section'), reply = document.createElement('article');
      frame.className = 'ds-assistant-message-main-content';
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
    await auto.tick(); changes++;
  }, (preserve, awaitHistory) => preserve ? auto.continueAt(sessionKeyOf(window.webContents.getURL())) : auto.reset(awaitHistory), message => reports.push(message));
  watcher.setEnabled(true);
  await until(() => changes > 0, '生产 watcher 未建立历史基线');
  await pause(700);
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
  await test('合成发送无需新轮授权：新回复完成即采集，历史回复不执行', async () => {
    const f = await autoFixture();
    try {
      assert.equal((await send('本批真实结果')).ok, true);
      try { await until(() => f.collected.length === 1, '完成的新回复未送达生产 watcher'); }
      catch (error) {
        const watch = await window.webContents.executeJavaScriptInIsolatedWorld(REPLY_WATCH_WORLD, [{ code: '({scope:globalThis.__miniAIReplyChanges?.scope,dirty:globalThis.__miniAIReplyChanges?.dirty})' }]);
        throw new Error(error.message + ' ' + JSON.stringify({ reports: f.reports, changes: f.changes(), collected: f.collected, scope: sessionKeyOf(window.webContents.getURL()), watch }));
      }
      assert.deepEqual(f.collected, ['next-batch-1']);
      assert.equal(await window.webContents.executeJavaScript('window.lastClickTrusted'), false);
      assert.equal(f.trustedTurns.some(Boolean), false);
    } finally { await f.dispose(); }
  });
  await test('sender → 原生 MutationObserver → AutoCollector：连续两批无需动作授权且各采集一次', async () => {
    const f = await autoFixture();
    try {
      for (let round = 1; round <= 2; round++) {
        assert.equal((await send('第 ' + round + ' 批真实工具结果')).ok, true);
        await until(() => f.collected.length === round, '自动结果回传的新回复未采集');
        assert.deepEqual(f.collected, Array.from({ length: round }, (_, index) => 'next-batch-' + (index + 1)));
        const previousChanges = f.changes();
        await window.webContents.executeJavaScript(`document.querySelectorAll('.ds-markdown').item(${round}).append(document.createElement('span'));`);
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
  // 独立内存 session 用本地 HTML 响应官方 origin；所有请求都在本机终止。
  const officialFixture = session.fromPartition('first-prompt-offline');
  await officialFixture.protocol.handle('https', request => request.url.startsWith('https://chat.deepseek.com/')
    ? new Response(fs.readFileSync(fixturePath), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    : new Response('', { status: 403 }));
  const previousWindow = window;
  window = new BrowserWindow({ show: false, webPreferences: { session: officialFixture, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  async function firstSetup(script) {
    await sender.dispose();
    await window.loadURL('https://chat.deepseek.com/');
    await window.webContents.executeJavaScript(script);
    sender = new WebResultSender(window.webContents);
  }
  await test('官方 origin 离线首页：点击后首次分配会话地址仍确认发送', async () => {
    await firstSetup(`document.querySelector('[role="button"]').addEventListener('click',()=>history.pushState({},'', '/a/chat/s/allocated'));`);
    const result = await sender.send('本地主动需求', 'https://chat.deepseek.com/', 'prompt');
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.session, 'https://chat.deepseek.com/a/chat/s/allocated');
    assert.equal((await state()).clicks, 1);
  });
  await test('官方 origin 离线首页：点击后重挂载 composer 断开旧输入框仍确认发送', async () => {
    await firstSetup(`window.mode='unknown';document.querySelector('[role="button"]').addEventListener('click',()=>{history.pushState({},'', '/a/chat/s/allocated');const composer=document.querySelector('#composer');composer.remove();const next=document.createElement('section');next.id='composer';next.innerHTML='<textarea id="input2"></textarea><div role="button" aria-disabled="true" class="ds-button ds-button--primary ds-button--filled ds-button--circle"><svg><path d="${DEEPSEEK_SEND_ICON}"/></svg></div>';document.body.append(next);});`);
    const result = await sender.send('本地主动需求', 'https://chat.deepseek.com/', 'prompt');
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.session, 'https://chat.deepseek.com/a/chat/s/allocated');
    assert.equal((await state()).clicks, 1);
  });
  await test('官方 origin 离线首页：点击前分配地址拒绝，不能借首发放宽作用域', async () => {
    await firstSetup('window.delay=500');
    const sending = sender.send('本地主动需求', 'https://chat.deepseek.com/', 'prompt');
    await pause(70); await window.webContents.executeJavaScript(`history.pushState({},'', '/a/chat/s/before-click')`);
    assert.equal((await sending).ok, false); assert.equal((await state()).clicks, 0);
  });
  await test('工具结果不能继承首页首发的会话交接例外', async () => {
    await firstSetup(`document.querySelector('[role="button"]').addEventListener('click',()=>history.pushState({},'', '/a/chat/s/allocated'));`);
    assert.equal((await send('本批工具结果')).ok, false); assert.equal((await state()).clicks, 1);
  });
  await test('首发点击后第二次会话迁移拒绝且不重试', async () => {
    await firstSetup(`window.mode='unknown';document.querySelector('[role="button"]').addEventListener('click',()=>{history.pushState({},'', '/a/chat/s/allocated');setTimeout(()=>history.pushState({},'', '/a/chat/s/other'),75);});`);
    const result = await sender.send('本地主动需求', 'https://chat.deepseek.com/', 'prompt');
    assert.equal(result.ok, false); assert.equal(result.uncertain, true); assert.equal((await state()).clicks, 1);
  });
  await test('原生 watcher：同一首页回复节点分配地址保留基线，打开其他会话重建历史基线', async () => {
    await firstSetup('');
    let reset; let calls = 0;
    const watcher = new ReplyChangeWatcher(window.webContents, async () => { calls++; }, (preserve, awaitHistory) => {reset={preserve,awaitHistory};}, message => assert.fail(message));
    watcher.setEnabled(true); await until(()=>calls===1,'未建立初始基线');
    await window.webContents.executeJavaScript(`const reply=document.createElement('article');reply.className='ds-assistant-message-main-content ds-markdown';reply.textContent='正在生成';document.body.append(reply);`);
    await until(()=>calls>1,'未观察到首页新回复');
    await window.webContents.executeJavaScript(`history.pushState({},'', '/a/chat/s/allocated')`);
    await watcher.settleNavigation();
    assert.deepEqual(reset,{preserve:true,awaitHistory:false});
    await window.webContents.executeJavaScript(`history.pushState({},'', '/a/chat/s/other')`);
    await watcher.settleNavigation(); assert.deepEqual(reset,{preserve:false,awaitHistory:true});
    await watcher.dispose();
  });
  const controls = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/deepseek-reply-controls.json'), 'utf8'));
  for (const mode of ['reply-first', 'url-first', 'fast-url-first', 'marked-url-first', 'warm-marked-url-first', 'history-unknown']) await test('真实 watcher/integration：输出生命周期与历史基线 ' + mode, async () => {
    const { createToolIntegration } = require('../src/main/tools/integration.ts');
    const { FileService } = require('../src/main/fileService.ts');
    const { ReturnPathService } = require('../src/main/returnPathService.ts');
    const { CHANNELS } = require('../src/shared/contract.ts');
    const project = path.join(temporary,'output-project-'+mode); fs.mkdirSync(project);
    await firstSetup(`
      const controls=${JSON.stringify(controls)};
      const sendButton=document.querySelector('[role="button"]');
      sendButton.className=controls.send.className.replace('ds-button--disabled','');
      sendButton.querySelector('path').setAttribute('d',controls.send.path);
      window.allocatedSessions=0;
      window.mountFooter=frame=>{
        for(const name of ['copy','regenerate','read']){
          const control=controls[name],button=document.createElement('div');button.setAttribute('role','button');button.className=control.className;
          if(control.aria!==null)button.setAttribute('aria-label',control.aria);
          if(control.ariaDisabled!==null)button.setAttribute('aria-disabled',control.ariaDisabled);
          const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),icon=document.createElementNS('http://www.w3.org/2000/svg','path');
          icon.setAttribute('d',control.path);svg.append(icon);button.append(svg);frame.append(button);
        }
      };
      window.mountReply=(id,footer=true)=>{
        const frame=document.createElement('section'),message=document.createElement('div');message.className='ds-message';
        const reply=document.createElement('article');reply.className='ds-assistant-message-main-content ds-markdown';
        const pre=document.createElement('pre'),code=document.createElement('code');code.className='language-mini-ai-tools';
        code.textContent=JSON.stringify({protocol_version:1,batch_id:id,requests:[{id:'project',tool:'get_project_info',args:{}}]});
        pre.append(code);reply.append(pre);message.append(reply);frame.append(message);
        if(footer)window.mountFooter(frame);
        document.body.insertBefore(frame,document.querySelector('#composer'));
        return frame;
      };
      document.querySelector('[role="button"]').addEventListener('click',()=>{
        if(${JSON.stringify(mode)}.endsWith('marked-url-first')){
          const round=++window.allocatedSessions;
          history.pushState({},'', '/a/chat/s/allocated-'+round);
          // 测试主进程确认导航已处理后才挂载；不让同步正文掩盖提交记录缺陷。
          window.pendingReply='first-native-'+round;
        }else if(${JSON.stringify(mode)}==='url-first'||${JSON.stringify(mode)}==='fast-url-first'){
          history.pushState({},'', '/a/chat/s/allocated');
          setTimeout(()=>{const stop=document.createElement('button');stop.className='ds-button';stop.id='stop';stop.textContent='停止生成';document.body.append(stop);},${mode==='fast-url-first'?30:200});
          setTimeout(()=>{window.mountReply('first-native');document.querySelector('#stop').remove();},${mode==='fast-url-first'?60:450});
        }else{
          const stop=document.createElement('button');stop.className='ds-button';stop.textContent='停止生成';document.body.append(stop);
          window.mountReply('first-native');
          setTimeout(()=>history.pushState({},'', '/a/chat/s/allocated'),200);
          setTimeout(()=>stop.remove(),450);
        }
      });
      if(${JSON.stringify(mode)}==='history-unknown'||${JSON.stringify(mode)}==='warm-marked-url-first'){
        history.pushState({},'', '/a/chat/s/existing');window.mountReply('initial-history',${mode==='warm-marked-url-first'});
      }`);
    const files=new FileService(); files.setRoot(project);
    const { ToolFiles } = require('../src/main/tools/files.ts');
    const executeFile = ToolFiles.prototype.execute;
    let executions=0;
    ToolFiles.prototype.execute=async function(...args){ executions++; return executeFile.apply(this,args); };
    const handlers=new Map();const editor={mainFrame:{},send(){},isDestroyed:()=>false};
    const system=await createToolIntegration({ipc:{handle:(c,f)=>handlers.set(c,f)},editor,web:window.webContents,files,
      returnPath:new ReturnPathService(files),workspace:{editor:{isDirty:()=>false},run:f=>f()},sender,
      storePath:path.join(temporary,'tools-'+mode+'.json'),disabled:false,ask:async()=>({response:0,checkboxChecked:false}),notifyFile(){},copy(){}});
    const waitForScope=scope=>until(async()=>await window.webContents.executeJavaScriptInIsolatedWorld(REPLY_WATCH_WORLD,[{code:'globalThis.__miniAIReplyChanges?.scope'}])===scope,'原生 watcher 未处理导航 '+scope);
    const newHomepage=async()=>{
      await window.webContents.executeJavaScript(`document.querySelectorAll('.ds-message').forEach(element=>element.parentElement.remove());history.pushState({},'', '/');`);
      await waitForScope('https://chat.deepseek.com/');
      await pause(200);
    };
    const sendFirst=async(round)=>{
      const before=executions;
      const result=await system.sendLocalPrompt('本地主动需求','https://chat.deepseek.com/',()=>true);
      assert.equal(result.ok,true,JSON.stringify(result));
      if(mode.endsWith('marked-url-first')){
        await waitForScope('https://chat.deepseek.com/a/chat/s/allocated-'+round);
        await pause(200);
        assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.ds-message').length`),0,'导航处理前不得偷跑挂载首轮回复');
        assert.equal(executions,before,'空白首轮未出现完整回复时不得执行');
        await window.webContents.executeJavaScript(`window.mountReply(window.pendingReply);window.pendingReply=null;`);
      }
      const batch=mode.endsWith('marked-url-first')?'first-native-'+round:'first-native';
      await until(()=>system.getState().results.some(result=>result.batch_id===batch&&result.status==='done'),'真实集成未自动执行首次工具回复 '+mode+' round '+round);
      assert.equal(executions,before+1,'首次工具回复必须真正执行一次');
      await window.webContents.executeJavaScript(`document.querySelector('.ds-markdown').append(document.createElement('span'));`);
      await pause(200);
      assert.equal(executions,before+1,'重复 DOM 通知不得再次执行首批');
      assert.equal((await state()).clicks,round);
    };
    try {
      await handlers.get(CHANNELS.setToolConfig)({sender:editor,senderFrame:editor.mainFrame},{automatic:true,permission:'ask',sendIntervalSeconds:300});
      if(mode==='history-unknown'){
        await pause(700);
        assert.equal(executions,0);
        assert.equal((await new ReplyMonitor(window.webContents).read()).completion,'unknown');
        await window.webContents.executeJavaScript(`window.mountFooter(document.querySelector('.ds-message').parentElement);`);
        await pause(700);
        assert.equal((await new ReplyMonitor(window.webContents).read()).completion,'complete','真实控件组合必须明确表示完成');
        assert.equal(executions,0,'启用时已有 unknown 历史回复后补真实 footer 不得执行');
      }else{
        if(mode==='warm-marked-url-first'){
          await pause(700);
          assert.equal(executions,0,'原有完整历史不得执行');
          await newHomepage();
        }else await pause(100);
        await sendFirst(1);
      }
      const beforeNext=executions;
      await window.webContents.executeJavaScript(`window.mountReply('existing-native')`);
      await until(()=>system.getState().results.some(result=>result.batch_id==='existing-native' && result.status==='done'),'已有会话无需点击的新完整回复未自动采集');
      assert.equal(executions,beforeNext+1,'后续回复必须执行一次');
      assert.equal((await state()).clicks,mode==='history-unknown'?0:1,'采集不得制造发送动作');
      if(mode==='warm-marked-url-first'){
        await newHomepage();
        await sendFirst(2);
      }
      const beforeHistory=executions;
      await window.webContents.executeJavaScript(`document.querySelectorAll('.ds-message').forEach(element=>element.parentElement.remove());history.pushState({},'', '/a/chat/s/history');`);
      await waitForScope('https://chat.deepseek.com/a/chat/s/history');
      await pause(250);
      await window.webContents.executeJavaScript(`window.mountReply('history-native')`);
      await pause(250);
      await window.webContents.executeJavaScript(`window.mountReply('history-native-second')`);
      await pause(750);
      assert.equal(executions,beforeHistory,'分段加载历史会话不得执行其已存在的工具回复');
    } finally { await system.dispose(); ToolFiles.prototype.execute=executeFile; }
  });
  previousWindow.destroy();
  console.log('原生离线 DOM 夹具：通过 ' + passed + '，未连接官方网页；不证明官方网页接受合成发送。');
}).catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (sender) await sender.dispose();
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(process.exitCode || 0);
});
