/** 原生 Electron 离线候选控件验证；不访问官网，不代表真实网站发送验收。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-chatgpt-send-'));
  env.MINI_CHATGPT_SEND_FIXTURE_DIR = directory;
  const run = spawnSync(require('electron'), [__filename], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
  if (run.error) console.error(run.error.message);
  process.exit(run.status ?? 1);
}
require('tsx/cjs');
const { app, BrowserWindow, session } = require('electron');
const { WebComposerSender } = require('../src/main/webComposerSender.ts');
const temporary = process.env.MINI_CHATGPT_SEND_FIXTURE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'mini-chatgpt-send-'));
app.setPath('userData', path.join(temporary, 'userData'));
const html = `<!doctype html><meta charset="utf-8"><style>.ProseMirror{min-width:300px;min-height:60px}button{min-width:40px;min-height:40px}</style>
<form data-chatgpt-composer><div class="ComposerLayoutBody"><div class="ProseMirror" role="textbox" contenteditable="true"><p><br></p></div><div class="ComposerLayoutFooter"><button type="submit" aria-label="发送" disabled>Send</button><button type="button" data-testid="upload-file-button" aria-label="添加文件等内容">+</button></div></div></form>
<script>
window.mode='normal';window.delay=0;window.clicks=0;window.received=[];window.inputs=0;window.trusted=[];
const input=document.querySelector('.ProseMirror'),send=document.querySelector('button[type="submit"]');
const value=()=>Array.from(input.children).map(p=>p.textContent).join('\\n');
input.addEventListener('input',event=>{window.inputs++;window.trusted.push(event.isTrusted);if(window.mode==='disabled')return;setTimeout(()=>send.disabled=!input.textContent,window.delay)});
send.addEventListener('click',event=>{event.preventDefault();window.clicks++;window.received.push(value());if(window.mode==='normal')input.innerHTML='<p><br></p>';if(window.mode==='generating'){const stop=document.createElement('button');stop.dataset.testid='stop-button';document.body.append(stop)}});
</script>`;
let window, sender, passed = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => window.webContents.executeJavaScript(code);
const state = () => run(`({text:document.querySelector('.ProseMirror')?.textContent,clicks,received,inputs,trusted})`);
async function setup(code = '', url = 'https://chatgpt.com/c/current') {
  if (sender) await sender.dispose();
  await window.loadURL(url);
  if (code) await run(code);
  sender = new WebComposerSender(window.webContents);
}
const send = (text = 'result', kind = 'results', scope = 'https://chatgpt.com/c/current') => sender.send(text, scope, kind);
async function test(name, check) { await check(); passed++; console.log('ok ' + name); }
app.whenReady().then(async () => {
  const offline = session.fromPartition('chatgpt-composer-offline');
  await offline.protocol.handle('https', request => request.url.startsWith('https://chatgpt.com/') ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('', { status: 403 }));
  window = new BrowserWindow({ show: false, webPreferences: { session: offline, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await test('原生contenteditable保持换行与空行，仅一次input和click', async () => {
    await setup(); assert.equal((await send('a\r\nb\n\n尾行')).ok, true);
    const s = await state(); assert.deepEqual(s.received, ['a\nb\n\n尾行']); assert.equal(s.clicks, 1); assert.equal(s.inputs, 1); assert.deepEqual(s.trusted, [false]);
  });
  await test('现场空输入仅语音按钮，填入后等待同form已知发送按钮出现', async () => {
    await setup(`send.remove();const voice=document.createElement('button');voice.type='button';voice.setAttribute('aria-label','开始语音');document.querySelector('.ComposerLayoutFooter').append(voice);window.voiceClicks=0;voice.addEventListener('click',()=>window.voiceClicks++);input.addEventListener('input',()=>setTimeout(()=>voice.replaceWith(send),100))`);
    assert.equal((await send('first\nsecond')).ok,true); assert.deepEqual((await state()).received,['first\nsecond']); assert.equal(await run('window.voiceClicks'),0);
  });
  await test('同FORM深层正文与发送区域分离，动态发送按钮仍只点击一次', async () => {
    await setup(`for(let i=0;i<7;i++){const box=document.createElement('div');input.replaceWith(box);box.append(input)}send.remove();const voice=document.createElement('button');voice.type='button';voice.setAttribute('aria-label','开始语音');document.querySelector('.ComposerLayoutFooter').append(voice);input.addEventListener('input',()=>setTimeout(()=>voice.replaceWith(send),100))`);
    assert.equal((await send('deep composer')).ok,true); assert.deepEqual((await state()).received,['deep composer']); assert.equal((await state()).clicks,1);
  });
  await test('空输入缺已知语音控件不填入，填入后始终无已知send则清理并暂停', async () => {
    await setup(`send.remove()`); assert.equal((await send()).ok,false); assert.equal((await state()).inputs,0);
    await setup(`send.remove();const voice=document.createElement('button');voice.setAttribute('aria-label','开始语音');document.querySelector('.ComposerLayoutFooter').append(voice);window.voiceClicks=0;voice.addEventListener('click',()=>window.voiceClicks++)`);
    assert.equal((await send()).ok,false); assert.equal((await state()).text,''); assert.equal(await run('window.voiceClicks'),0);
  });
  await test('等待send出现时不能接纳另一form或多个发送按钮', async () => {
    for(const mutation of [`const other=document.createElement('form');other.append(send);document.body.append(other)`,`document.querySelector('form').append(send,send.cloneNode(true))`]) {
      await setup(`send.remove();const voice=document.createElement('button');voice.setAttribute('aria-label','开始语音');document.querySelector('.ComposerLayoutFooter').append(voice);input.addEventListener('input',()=>setTimeout(()=>{${mutation}},60))`);
      assert.equal((await send()).ok,false); assert.equal((await state()).clicks,0);
    }
  });
  await test('已有文字或空格草稿不可覆盖', async () => {
    for (const draft of ['用户草稿', ' ']) { await setup(`input.textContent=${JSON.stringify(draft)}`); assert.equal((await send()).ok, false); assert.equal((await state()).text, draft); assert.equal((await state()).clicks, 0); }
  });
  await test('只有空行的用户草稿也不能覆盖', async () => {
    for(const markup of ['<p><br></p><p><br></p>','<p><br><br></p>']) {await setup(`input.innerHTML=${JSON.stringify(markup)}`);assert.equal((await send()).ok,false);assert.equal((await state()).inputs,0);assert.equal(await run('input.innerHTML'),markup);}
  });
  await test('多个可见编辑器/发送控件、未知按钮及跨回复关联暂停', async () => {
    for (const code of [`document.body.append(input.cloneNode(true))`, `send.parentElement.append(send.cloneNode(true))`, `send.removeAttribute('aria-label')`, `document.body.append(send)`, `document.querySelector('form').setAttribute('data-message-author-role','assistant')`]) {
      await setup(code); assert.equal((await send()).ok, false); assert.equal((await state()).clicks, 0); assert.equal((await state()).inputs, 0);
    }
  });
  await test('生成、等待继续及只读状态均不能填入', async () => {
    for (const code of [`const stop=document.createElement('button');stop.dataset.testid='stop-button';document.body.append(stop)`, `const next=document.createElement('button');next.textContent='Continue generating';document.body.append(next)`, `input.setAttribute('aria-readonly','true')`, `input.contentEditable='false'`]) {
      await setup(code); assert.equal((await send()).ok, false); assert.equal((await state()).inputs, 0);
    }
  });
  await test('网页手工已有附件、上传卡片或未知附件区域暂停', async () => {
    for (const code of [`const file=document.createElement('input');file.type='file';const data=new DataTransfer();data.items.add(new File(['x'],'x.txt'));file.files=data.files;document.querySelector('form').append(file)`, `const card=document.createElement('div');card.dataset.testid='file-thumbnail';document.querySelector('form').prepend(card)`, `const image=document.createElement('img');image.src='data:image/png;base64,AA==';image.style='width:30px;height:30px';document.querySelector('form').prepend(image)`, `const remove=document.createElement('button');remove.setAttribute('aria-label','Remove attachment');document.querySelector('form').prepend(remove)`, `const form=document.querySelector('form');form.replaceWith(...form.childNodes)`]) {
      await setup(code); assert.equal((await send()).ok, false); assert.equal((await state()).inputs, 0);
    }
  });
  await test('按钮等待期间取消只清理自有内容', async () => {
    await setup(`window.mode='disabled'`); const sending=send(); await pause(80); await sender.cancel(); assert.equal((await sending).ok,false); assert.equal((await state()).text,''); assert.equal((await state()).clicks,0);
  });
  await test('用户改写后取消不清草稿', async () => {
    await setup(`window.mode='disabled'`); const sending=send(); await pause(80); await run(`input.textContent='用户接管'`); await sender.cancel(); assert.equal((await sending).ok,false); assert.equal((await state()).text,'用户接管'); assert.equal((await state()).clicks,0);
  });
  await test('用户在同文中加入软换行不能当作自有原文清理', async () => {
    await setup(`window.mode='disabled'`);const sending=send();await pause(80);await run(`input.querySelector('p').append(document.createElement('br'))`);assert.equal((await sending).ok,false);assert.equal(await run(`input.querySelector('p').querySelectorAll('br').length`),1);assert.equal((await state()).clicks,0);
  });
  await test('等待期间控件替换或新附件出现均取消而不点击', async () => {
    for (const code of [`send.replaceWith(send.cloneNode(true))`, `const remove=document.createElement('button');remove.setAttribute('aria-label','Remove image');document.querySelector('form').prepend(remove)`]) {
      await setup(`window.mode='disabled'`); const sending=send(); await pause(80); await run(code); assert.equal((await sending).ok,false); assert.equal((await state()).clicks,0);
    }
  });
  await test('按钮持续禁用有界暂停并清理自有文本', async () => { await setup(`window.mode='disabled'`); assert.equal((await send()).ok,false); assert.equal((await state()).clicks,0); assert.equal((await state()).text,''); });
  await test('点击后无确认保持文本且不重试', async () => { await setup(`window.mode='unknown'`); const result=await send(); assert.equal(result.ok,false); assert.equal(result.uncertain,true); assert.equal((await state()).clicks,1); assert.equal((await state()).text,'result'); });
  await test('点击后取消不能清理可能已发送的文本', async () => { await setup(`window.mode='unknown'`); const sending=send(); await pause(100); await sender.cancel(); assert.equal((await sending).uncertain,true); assert.equal((await state()).text,'result'); assert.equal((await state()).clicks,1); });
  await test('输入框断开本身不作为ChatGPT接收证据', async () => { await setup(`window.mode='unknown';send.addEventListener('click',event=>input.remove())`); const result=await send(); assert.equal(result.ok,false); assert.equal(result.uncertain,true); assert.equal((await state()).clicks,1); });
  await test('点击后生成按钮可确认接收', async () => { await setup(`window.mode='generating'`); assert.equal((await send()).ok,true); assert.equal((await state()).clicks,1); });
  await test('首页主动首发可交接一次/c会话', async () => { await setup(`send.addEventListener('click',event=>history.pushState({},'', '/c/allocated'))`, 'https://chatgpt.com/'); const result=await send('prompt','prompt','https://chatgpt.com/'); assert.equal(result.ok,true); assert.equal(result.session,'https://chatgpt.com/c/allocated'); assert.equal((await state()).clicks,1); });
  await test('首页点击后编码临时地址仅等待正式会话，不取消且不重复发送', async () => {
    await setup(`send.addEventListener('click',()=>{history.pushState({},'', '/c/local-chatgpt%3A12345678-1234-1234-1234-123456789abc');setTimeout(()=>history.replaceState({},'', '/c/allocated'),150)})`, 'https://chatgpt.com/');
    const result=await send('prompt','prompt','https://chatgpt.com/'); assert.equal(result.ok,true);assert.equal(result.session,'https://chatgpt.com/c/allocated');assert.equal((await state()).clicks,1);
  });
  await test('编码占位未分配完成有界暂停，点击前或工具结果均无过渡例外', async () => {
    const pending='/c/local-chatgpt%3A12345678-1234-1234-1234-123456789abc';
    await setup(`send.addEventListener('click',()=>history.pushState({},'', '${pending}'))`, 'https://chatgpt.com/');
    let result=await send('prompt','prompt','https://chatgpt.com/');assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal((await state()).clicks,1);
    await setup(`window.mode='disabled'`, 'https://chatgpt.com/');let sending=send('prompt','prompt','https://chatgpt.com/');await pause(80);await run(`history.pushState({},'', '${pending}')`);assert.equal((await sending).ok,false);assert.equal((await state()).clicks,0);
    await setup(`send.addEventListener('click',()=>history.pushState({},'', '${pending}'))`, 'https://chatgpt.com/');result=await send('results','results','https://chatgpt.com/');assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal((await state()).clicks,1);
  });
  await test('临时地址再次换占位标识不能延长交接或重新发送', async () => {
    await setup(`send.addEventListener('click',()=>{history.pushState({},'', '/c/local-chatgpt%3A12345678-1234-1234-1234-123456789abc');setTimeout(()=>history.replaceState({},'', '/c/local-chatgpt%3Aabcdef12-1234-1234-1234-123456789abc'),100)})`, 'https://chatgpt.com/');
    const result=await send('prompt','prompt','https://chatgpt.com/');assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal((await state()).clicks,1);
  });
  await test('点击前地址变化不能借首发例外发送', async () => { await setup(`window.mode='disabled'`, 'https://chatgpt.com/'); const sending=send('prompt','prompt','https://chatgpt.com/'); await pause(80); await run(`history.pushState({},'', '/c/other')`); assert.equal((await sending).ok,false); assert.equal((await state()).clicks,0); });
  await test('工具结果不享有首页会话交接例外', async () => { await setup(`send.addEventListener('click',event=>history.pushState({},'', '/c/allocated'))`, 'https://chatgpt.com/'); const result=await send('results','results','https://chatgpt.com/'); assert.equal(result.ok,false); assert.equal(result.uncertain,true); assert.equal((await state()).clicks,1); });
  await test('首页首发交接后再次换会话暂停且不能重试', async () => { await setup(`window.mode='unknown';send.addEventListener('click',event=>{history.pushState({},'', '/c/allocated');setTimeout(()=>history.pushState({},'', '/c/other'),100)})`, 'https://chatgpt.com/');const result=await send('prompt','prompt','https://chatgpt.com/');assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal((await state()).clicks,1); });
  await sender.dispose(); window.destroy(); console.log(JSON.stringify({ passed, failed: 0, realWebsiteVerified: false })); app.exit(0);
}).catch(async error => { console.error(error); if (sender) await sender.dispose(); if(window&&!window.isDestroyed())window.destroy(); app.exit(1); });
