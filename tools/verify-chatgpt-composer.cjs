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
const inlineMarkdownSetup = `input.addEventListener('input',()=>{for(const p of input.children){if(!p.textContent)continue;const outer=document.createElement('span'),inner=document.createElement('span');inner.className='inline-markdown';inner.textContent=p.textContent;outer.append(inner);p.replaceChildren(outer)}})`;
const colorSwatchSetup = `input.addEventListener('input',()=>{for(const p of input.children){const parts=p.textContent.split(/(#[a-fA-F0-9]{6}\\b)/);if(parts.length===1)continue;p.replaceChildren();for(const part of parts){p.append(document.createTextNode(part));if(/^#[a-fA-F0-9]{6}$/.test(part)){const swatch=document.createElement('span');swatch.className='ms-1 me-1 inline-block size-3';swatch.setAttribute('aria-hidden','true');swatch.setAttribute('contenteditable','false');swatch.setAttribute('data-hex-color-swatch','');swatch.style.backgroundColor=part;p.append(swatch)}}}})`;
const autolinkSetup = `input.addEventListener('input',()=>{const walker=document.createTreeWalker(input,NodeFilter.SHOW_TEXT),nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);for(const node of nodes){const parts=node.textContent.split(/(https:\\/\\/example\\.test\\/[a-z]+)/);if(parts.length===1)continue;const fragment=document.createDocumentFragment();for(const part of parts){if(!part.startsWith('https://example.test/')){fragment.append(document.createTextNode(part));continue}const link=document.createElement('span');link.className='Mention-fixture';for(const attr of ['rich-link-source-app-id','data-appearance','data-layout','data-font-weight','data-tone','data-underline-on-hover','data-breakable-url','data-rich-text-generated-autolink'])link.setAttribute(attr,'');link.setAttribute('text-link-href',part);const label=document.createElement('span');label.className='Label-fixture';const icon=document.createElement('span');icon.setAttribute('data-inline-url-icon','');icon.setAttribute('aria-hidden','true');icon.setAttribute('contenteditable','false');icon.className='Mention-fixture ProseMirror-widget';for(const attr of ['data-appearance','data-layout','data-font-weight','data-tone','data-underline-on-hover'])icon.setAttribute(attr,'');const box=document.createElement('span');box.setAttribute('contenteditable','false');box.className='IconContainer-fixture';const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const attr of ['width','height','viewBox','fill','xmlns','class'])svg.setAttribute(attr,attr==='class'?'Icon-fixture':'');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M0 0');path.setAttribute('fill','currentColor');svg.append(path);box.append(svg);icon.append(box,document.createTextNode(''));label.append(icon,document.createTextNode(part));link.append(label);fragment.append(link)}node.replaceWith(fragment)}})`;
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
  await test('推荐提示词仍busy不阻止同轮纯文本发送，不作为点击后确认', async () => {
    await setup("const loading=document.createElement('div');loading.setAttribute('aria-busy','true');loading.textContent='推荐加载';document.body.prepend(loading)");
    assert.equal((await send('recommendation loading')).ok,true);assert.equal((await state()).clicks,1);
    await setup("window.mode='unknown';const loading=document.createElement('div');loading.setAttribute('aria-busy','true');document.body.prepend(loading)");
    const result=await send('must confirm');assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal((await state()).clicks,1);
  });
  await test('ProseMirror同文span和trailingBreak整理后仍仅一次发送，逐字保留换行空格', async () => {
    await setup("input.addEventListener('input',()=>{for(const p of input.children){if(p.textContent){const span=document.createElement('span');span.textContent=p.textContent;p.replaceChildren(span);const br=document.createElement('br');br.className='ProseMirror-trailingBreak';p.append(br)}}})");
    assert.equal((await send(' first \n\n末行 ')).ok,true);assert.deepEqual((await state()).received,[' first \n\n末行 ']);assert.equal((await state()).clicks,1);
  });
  await test('同文编辑器整理时取消能清理自有文本，不误报未知清理', async () => {
    await setup("window.mode='disabled';input.addEventListener('input',()=>{for(const p of input.children){if(p.textContent){const span=document.createElement('span');span.textContent=p.textContent;p.replaceChildren(span)}}})");
    const pending=send('owned');await pause(80);await sender.cancel();const result=await pending;assert.equal(result.ok,false);assert.notEqual(result.uncertain,true);assert.equal((await state()).text,'');assert.equal((await state()).clicks,0);
  });
  await test('官网输入内嵌套inline-markdown同文装饰不属于回复区，长结果逐字发送一次', async () => {
    await setup(inlineMarkdownSetup+`;const suggestions=document.createElement('div');suggestions.setAttribute('aria-busy','true');document.body.append(suggestions)`);
    const payload=JSON.stringify({protocol_version:1,tool_results:[{tool:'read_file',content:'## 标题\n\n text_with_underscores `code` **bold** '+ 'content '.repeat(100)}]},null,2)+'\n\n末行 ';
    const result=await send(payload);assert.equal(result.ok,true);assert.equal((await state()).clicks,1);assert.deepEqual((await state()).received,[payload]);
  });
  await test('输入内inline-markdown装饰取消时仍清理逐字相同的自有文本', async () => {
    await setup(inlineMarkdownSetup+`;window.mode='disabled'`);
    const pending=send('owned\n\nresult');await pause(80);await sender.cancel();assert.equal((await pending).ok,false);assert.equal((await state()).text,'');assert.equal((await state()).clicks,0);
  });
  await test('输入内markdown样式不免除真实回复标记、未知语义或正文改变的保护', async () => {
    for(const mutation of [
      `inner.setAttribute('data-message-author-role','assistant')`, `inner.setAttribute('data-talvt-turn-state','complete')`,
      `inner.setAttribute('data-markdown-text-style','')`, `inner.setAttribute('data-dil-message-id','fixture')`,
      `inner.classList.add('ds-message')`, `inner.setAttribute('contenteditable','false')`,
      `inner.textContent+=' changed'`, `inner.append(document.createElement('br'))`,
      `const outside=document.createElement('div');outside.className='inline-markdown';document.querySelector('form').append(outside)`
    ]) {
      await setup(inlineMarkdownSetup+`;input.addEventListener('input',()=>{const inner=input.querySelector('.inline-markdown');if(inner){${mutation}}})`);
      assert.equal((await send('owned result')).ok,false);assert.equal((await state()).clicks,0);
    }
  });
  await test('工具读取HTML中的颜色值生成空色块，五万字结果仍逐字发送一次', async () => {
    await setup(colorSwatchSetup);
    const payload=JSON.stringify({protocol_version:1,tool_results:[{tool:'read_file',content:'<style>'+':root{--color:#123abc;} '.repeat(23)+'</style>'+ 'x'.repeat(50000)}]},null,2)+'\n\n末行 ';
    const result=await send(payload);assert.equal(result.ok,true);assert.equal((await state()).clicks,1);assert.deepEqual((await state()).received,[payload]);
  });
  await test('空色块装饰下取消只清理逐字相同的自有文本', async () => {
    await setup(colorSwatchSetup+`;window.mode='disabled'`);
    const pending=send('owned #123abc\n\nresult ');await pause(80);await sender.cancel();assert.equal((await pending).ok,false);assert.equal((await state()).text,'');assert.equal((await state()).clicks,0);
  });
  await test('色块带正文、子节点、未知属性或不符合装饰身份仍暂停且不点击', async () => {
    for(const mutation of [
      `swatch.textContent='changed'`, `swatch.append(document.createComment('unknown'))`,
      `swatch.setAttribute('aria-hidden','false')`, `swatch.removeAttribute('aria-hidden')`,
      `swatch.setAttribute('contenteditable','true')`, `swatch.removeAttribute('contenteditable')`,
      `swatch.removeAttribute('data-hex-color-swatch')`, `swatch.setAttribute('data-unknown','')`,
      `swatch.setAttribute('role','button')`, `swatch.setAttribute('aria-label','unknown')`,
      `swatch.replaceWith(document.createElement('svg'))`, `input.firstChild.append(' changed')`
    ]) {
      await setup(colorSwatchSetup+`;input.addEventListener('input',()=>{const swatch=input.querySelector('[data-hex-color-swatch]');if(swatch){${mutation}}})`);
      assert.equal((await send('owned #123abc')).ok,false);assert.equal((await state()).clicks,0);assert.notEqual((await state()).text,'');
    }
  });
  await test('五万字HTML结果中色块与自动链接图标组合只发送原始JSON一次', async () => {
    await setup(colorSwatchSetup+`;`+autolinkSetup+`;const loading=document.createElement('div');loading.setAttribute('aria-busy','true');document.body.append(loading)`);
    const payload=JSON.stringify({protocol_version:1,tool_results:[{tool:'read_file',content:'<style>'+':root{--color:#123abc;} '.repeat(23)+'</style>'+ 'https://example.test/url '.repeat(4)+'x'.repeat(50000)}]},null,2)+'\n\n末行 ';
    assert.equal((await send(payload)).ok,true);assert.equal((await state()).clicks,1);assert.deepEqual((await state()).received,[payload]);
  });
  await test('自动链接排版下取消仍可清理逐字相同的自有文本', async () => {
    await setup(autolinkSetup+`;window.mode='disabled'`);
    const pending=send(' https://example.test/url\n\nresult ');await pause(80);await sender.cancel();assert.equal((await pending).ok,false);assert.equal((await state()).text,'');assert.equal((await state()).clicks,0);
  });
  await test('自动链接及图标未知属性、可编辑控件、非空图标和改文仍拒绝', async () => {
    for(const mutation of [
      `icon.append('changed')`, `icon.removeAttribute('aria-hidden')`, `icon.setAttribute('contenteditable','true')`,
      `icon.setAttribute('data-unknown','')`, `icon.append(document.createElement('img'))`,
      `icon.querySelector('path').setAttribute('onclick','void 0')`, `icon.querySelector('svg').append(document.createElementNS('http://www.w3.org/2000/svg','use'))`,
      `link.setAttribute('data-unknown','')`, `link.setAttribute('contenteditable','false')`,
      `link.removeAttribute('data-rich-text-generated-autolink')`, `link.setAttribute('role','button')`,
      `link.querySelector('.Label-fixture').append('changed')`, `link.querySelector('.Label-fixture').append(document.createElement('br'))`,
      `icon.replaceWith(icon.querySelector('svg'))`
    ]) {
      await setup(autolinkSetup+`;input.addEventListener('input',()=>{const link=input.querySelector('[data-rich-text-generated-autolink]'),icon=input.querySelector('[data-inline-url-icon]');if(link&&icon){${mutation}}})`);
      assert.equal((await send('owned https://example.test/url')).ok,false);assert.equal((await state()).clicks,0);assert.notEqual((await state()).text,'');
    }
  });
  await test('正文变化及未知编辑器原子节点保留原文且不点击', async () => {
    for(const mutation of ["input.firstChild.textContent+=' changed'","input.firstChild.innerHTML='<span contenteditable=false>owned</span>'","input.firstChild.innerHTML='<a href=\"https://example.test\">owned</a>'","input.firstChild.append(document.createElement('br'))"]){
      await setup('input.addEventListener(\'input\',()=>{'+mutation+'})');const result=await send('owned');assert.equal(result.ok,false);assert.equal((await state()).clicks,0);assert.notEqual((await state()).text,'');
    }
  });
  await test('编辑接管处理器保护同文真实编辑，合成事件不冒充用户输入', async () => {
    for(const decoration of [inlineMarkdownSetup,colorSwatchSetup+';'+autolinkSetup]) for(const name of ['beforeinput','input','paste','drop','compositionstart']) {
      await setup(decoration+";window.mode='disabled'");
      const payload='owned #123abc https://example.test/url';
      // 捕获生产事件处理器并传入模拟可信事件；不向官网派发事件，不使用sendInputEvent。
      await window.webContents.executeJavaScriptInIsolatedWorld(1005,[{code:'globalThis.fixtureEdits={};const add=document.addEventListener.bind(document);document.addEventListener=(name,handler,...args)=>{globalThis.fixtureEdits[name]=handler;return add(name,handler,...args)};void 0'}]);
      const pending=send(payload);await pause(80);
      await window.webContents.executeJavaScriptInIsolatedWorld(1005,[{code:'globalThis.fixtureEdits['+JSON.stringify(name)+']({isTrusted:false,target:document.querySelector(".ProseMirror")})'}]);
      assert.equal((await state()).text,payload);
      await window.webContents.executeJavaScriptInIsolatedWorld(1005,[{code:'globalThis.fixtureEdits['+JSON.stringify(name)+']({isTrusted:true,target:document.querySelector(".ProseMirror")})'}]);
      const result=await pending;assert.equal(result.ok,false);assert.match(result.error,/用户正在编辑/);assert.equal((await state()).text,payload);assert.equal((await state()).clicks,0);
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
  await test('等待期间未知控件替换或新附件出现均取消而不点击', async () => {
    for (const code of [`const replacement=send.cloneNode(true);replacement.setAttribute('aria-label','未知动作');send.replaceWith(replacement)`, `const remove=document.createElement('button');remove.setAttribute('aria-label','Remove image');document.querySelector('form').prepend(remove)`]) {
      await setup(`window.mode='disabled'`); const sending=send(); await pause(80); await run(code); assert.equal((await sending).ok,false); assert.equal((await state()).clicks,0);
    }
  });
  await test('控件变化诊断区分按钮与输入重挂载；新输入不因同文获得发送或清理资格', async () => {
    await setup(`input.addEventListener('input',()=>{if(input.textContent){send.style.display='none';send.parentElement.append(send.cloneNode(true));send.parentElement.lastChild.style.display=''}})`);
    let result=await send('owned result');assert.equal(result.ok,false);assert.match(result.error,/发送按钮已替换/);assert.equal(result.controlState.sameInput,true);assert.equal(result.controlState.ownsText,true);assert.equal((await state()).text,'');assert.equal((await state()).clicks,0);
    await setup(`input.addEventListener('input',()=>{if(input.textContent)input.replaceWith(input.cloneNode(true))})`);
    result=await send('owned result');assert.equal(result.ok,false);assert.match(result.error,/输入框已替换/);assert.equal(result.controlState.inputConnected,false);assert.equal(result.controlState.sameInput,false);assert.equal((await state()).text,'owned result');assert.equal((await state()).clicks,0);
    await setup(`input.addEventListener('input',()=>{if(input.textContent)send.parentElement.append(send.cloneNode(true))})`);
    result=await send('owned result');assert.equal(result.ok,false);assert.match(result.error,/无法唯一确认/);assert.equal(result.controlState.controlsKnown,false);assert.equal((await state()).clicks,0);
  });
  await test('同一原输入和FORM内已断开的已知发送按钮重绘，重新核验后只点击一次', async () => {
    for(const mode of ['normal','unknown']) {
      await setup(`window.mode='${mode}';input.addEventListener('input',()=>{if(!input.textContent||window.replaced)return;window.replaced=true;const replacement=send.cloneNode(true);replacement.disabled=false;replacement.addEventListener('click',event=>{event.preventDefault();window.clicks++;window.received.push(value());if(window.mode==='normal')input.innerHTML='<p><br></p>'});send.replaceWith(replacement)})`);
      const result=await send(' original \n\nresult ');assert.equal(result.ok,mode==='normal');assert.equal((await state()).clicks,1);assert.deepEqual((await state()).received,[' original \n\nresult ']);
      if(mode==='unknown'){assert.equal(result.uncertain,true);assert.equal((await state()).text,' original result ')}
    }
  });
  await test('已知按钮重绘不能绕过输入身份、正文、附件或唯一FORM检查', async () => {
    for(const mutation of [
      `const other=document.createElement('form');other.append(replacement);document.body.append(other)`,
      `replacement.parentElement.append(replacement.cloneNode(true))`,
      `input.textContent='用户改写'`,
      `const attachment=document.createElement('div');attachment.dataset.testid='file-thumbnail';document.querySelector('form').prepend(attachment)`,
      `const stop=document.createElement('button');stop.dataset.testid='stop-button';document.body.append(stop)`,
      `input.replaceWith(input.cloneNode(true))`
    ]) {
      await setup(`input.addEventListener('input',()=>{if(!input.textContent||window.replaced)return;window.replaced=true;const replacement=send.cloneNode(true);replacement.disabled=false;send.replaceWith(replacement);${mutation}})`);
      assert.equal((await send('owned result')).ok,false);assert.equal((await state()).clicks,0);
      if(mutation.includes('用户改写'))assert.equal((await state()).text,'用户改写');
      if(mutation.includes('input.replaceWith'))assert.equal((await state()).text,'owned result');
    }
  });
  await test('已知按钮重绘后仍禁用时取消，清理自有结果且不点击', async () => {
    await setup(`window.mode='disabled';input.addEventListener('input',()=>{if(!input.textContent||window.replaced)return;window.replaced=true;send.replaceWith(send.cloneNode(true))})`);
    const pending=send('owned result');await pause(80);await sender.cancel();assert.equal((await pending).ok,false);assert.equal((await state()).clicks,0);assert.equal((await state()).text,'');
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
