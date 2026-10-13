/** 离线原生闭环：本地模拟页面，不连接 ChatGPT、不代表官网验收。 */
// 父进程等原生fixture退出后再清理profile，避免Windows数据库文件仍被Electron持有。
if (!process.versions.electron) {
 const { spawnSync } = require('node:child_process');
 const disk = require('node:fs'), paths = require('node:path'), os = require('node:os');
 const directory = disk.mkdtempSync(paths.join(os.tmpdir(), 'mini-gpt-loop-'));
 const env = { ...process.env, MINI_CHATGPT_TOOL_FIXTURE_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
 const run = spawnSync(require('electron'), [__filename], { cwd: paths.resolve(__dirname, '..'), env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
 if (run.stdout) process.stdout.write(run.stdout); if (run.stderr) process.stderr.write(run.stderr);
 let code = run.status ?? 1;
 if (run.error) console.error(run.error.message);
 try {
   if (paths.dirname(paths.resolve(directory)) !== paths.resolve(os.tmpdir())) throw Error('Invalid fixture cleanup path');
   disk.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
 } catch (error) { console.error(error); code = 1; }
 process.exit(code);
}
require('tsx/cjs');
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createToolIntegration } = require('../src/main/tools/integration.ts');
const { WebComposerSender } = require('../src/main/webComposerSender.ts');
const { FileService } = require('../src/main/fileService.ts');
const { ReturnPathService } = require('../src/main/returnPathService.ts');
const { CHANNELS } = require('../src/shared/contract.ts');
const { readAutoReply } = require('../src/main/tools/replyObservation.ts');
const temporary = process.env.MINI_CHATGPT_TOOL_FIXTURE_DIR || require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'mini-gpt-loop-'));
app.setPath('userData', path.join(temporary, 'profile'));
// 显式finally完成清理后退出，窗口销毁不能抢先以0掩盖失败。
app.on('window-all-closed', () => {});
const html = `<!doctype html><meta charset="utf-8"><style>[data-dil-message-id]{min-height:40px}.ProseMirror{min-height:50px}button{min-height:20px}</style>
<main id="turns"></main><form data-chatgpt-composer><div><div class="ProseMirror" role="textbox" contenteditable="true"><p><br></p></div><button type="submit" aria-label="发送" disabled>Send</button></div></form>
<script>
window.received=[];window.homepage=false;window.homeEpoch=1;
window.appendReply=(id,tool,args,complete=true)=>{
 const turn=document.createElement('div');turn.dataset.talvtTurnState=complete?'complete':'streaming';
 const user=document.createElement('div');user.dataset.userMessageBubble='';
 const userOwner=document.createElement('div');userOwner.className='group/user-message';
 const userFooter=document.createElement('div');userFooter.className='turn-action-controls';const userCopy=document.createElement('button');userCopy.setAttribute('aria-label','复制');userFooter.append(userCopy);userOwner.append(user,userFooter);turn.append(userOwner);
 const assistant=document.createElement('div');assistant.dataset.chatgptSearchUnitKey='message';
 const heading=document.createElement('h4');heading.dataset.conversationRole='assistant';assistant.append(heading);
 const markdown=document.createElement('div');markdown.dataset.markdownTextStyle='';
 const reply=document.createElement('div');reply.className='ExistingConversationAnswer-fixture';reply.dataset.dilMessageId=id;
 const surface=document.createElement('div');surface.className='CodeSurface-fixture';surface.dataset.markdownCopy='';
 const toolbar=document.createElement('div');toolbar.className='StickyActionBar-fixture';toolbar.dataset.markdownCopy='';
 const language=document.createElement('div');language.textContent='mini-ai-tools';toolbar.append(language);
 const code=document.createElement('code');code.className='CodeContent-fixture';
 code.textContent=JSON.stringify({protocol_version:1,batch_id:id,requests:[{id:'request',tool,args}]});
 surface.append(toolbar,code);reply.append(surface);markdown.append(reply);assistant.append(markdown);turn.append(assistant);
 const footer=document.createElement('div');footer.className='turn-action-controls';const copy=document.createElement('button');copy.setAttribute('aria-label','复制');footer.append(copy);if(complete)turn.append(footer);
 document.getElementById('turns').append(turn);return {turn,footer,reply,code};
};
const input=document.querySelector('.ProseMirror'),send=document.querySelector('button[type="submit"]');
for(let i=0;i<11;i++){const box=document.createElement('div');input.replaceWith(box);box.append(input)}
input.addEventListener('input',()=>send.disabled=!input.textContent);
send.addEventListener('click',event=>{event.preventDefault();
 received.push(Array.from(input.children).map(p=>p.textContent).join('\\n'));
 input.innerHTML='<p><br></p>';send.disabled=true;
 const stop=document.createElement('button');stop.setAttribute('aria-label','停止生成');document.querySelector('form').append(stop);
 if(homepage&&received.length===1){
  history.pushState({},'', '/c/local-chatgpt%3A12345678-1234-1234-1234-123456789abc');
  setTimeout(()=>{history.replaceState({},'', '/c/homepage-allocated-'+homeEpoch);stop.remove();appendReply('homepage-first-'+homeEpoch,'get_project_info',{})},800);return;
 }
 if(homepage){setTimeout(()=>{stop.remove();if(received.length===2)appendReply('homepage-second-'+homeEpoch,'read_file',{path:'input.txt'})},250);return;}
 setTimeout(()=>{stop.remove();if(received.length===1)appendReply('second','read_file',{path:'input.txt'});},250);
});
</script>`;
let window, system, sender;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) { const end = Date.now()+12000; while(!await read()) { assert.ok(Date.now()<end,label); await wait(10); } }
app.whenReady().then(async()=>{
 const offline=session.fromPartition('chatgpt-tools-offline');
 await offline.protocol.handle('https', request => request.url.startsWith('https://chatgpt.com/') ? new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}) : new Response('',{status:403}));
 window=new BrowserWindow({show:false,webPreferences:{session:offline,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await window.loadURL('https://chatgpt.com/c/offline');
 const run=code=>window.webContents.executeJavaScript(code);
 await run("appendReply('history','get_project_info',{})");
 const root=path.join(temporary,'project');await fs.mkdir(root);await fs.writeFile(path.join(root,'input.txt'),'真实磁盘内容');
 const files=new FileService();files.setRoot(root);
 const handlers=new Map(), copies=[], states=[];
 const editor={mainFrame:{},isDestroyed:()=>false,send(_channel,state){states.push(state)}};
 sender=new WebComposerSender(window.webContents);
 system=await createToolIntegration({ipc:{handle:(channel,fn)=>handlers.set(channel,fn)},editor,web:window.webContents,files,
  returnPath:new ReturnPathService(files),workspace:{editor:{isDirty:()=>false,current:{documents:[]}},run:fn=>fn()},sender,
  storePath:path.join(temporary,'tools.json'),disabled:false,ask:async()=>({response:0,checkboxChecked:false}),notifyFile(){},copy:text=>copies.push(text)});
 await handlers.get(CHANNELS.setToolConfig)({sender:editor,senderFrame:editor.mainFrame},{permission:'full',automatic:true,sendIntervalSeconds:0});
 await until(()=>window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:'Boolean(globalThis.__miniAIReplyChanges)'}]),'监听必须建立');
 await wait(700);assert.equal(system.getState().results.length,0,'历史基线不得执行');assert.equal(await run('received.length'),0);
 await run("window.first=appendReply('first','get_project_info',{},false);const stop=document.createElement('button');stop.setAttribute('aria-label','停止生成');document.querySelector('form').append(stop)");
 await wait(400);assert.equal(system.getState().results.length,0,'完整JSON仍生成中不得执行');assert.equal(await run('received.length'),0);
 await run("document.querySelector('button[aria-label=\"停止生成\"]').remove();first.turn.dataset.talvtTurnState='complete'");
 await wait(300);assert.equal(system.getState().results.length,0,'新回复缺局部完成页脚不得执行');
 await run('first.turn.append(first.footer)');
 await until(async()=>await run('received.length')===2,'两轮真实工具结果必须经原生composer回传');
 const received=await run('received');assert.deepEqual(received,copies,'回传和自动复制必须同源同字节');
 assert.equal(JSON.parse(received[0]).tool_results[0].batch_id,'first');
 assert.equal(JSON.parse(received[1]).tool_results[0].batch_id,'second');
 assert.ok(received[1].includes('真实磁盘内容'),'第二轮读取真实文件内容');
 await until(async()=>(await readAutoReply(window.webContents)).completion==='complete','第二轮回传后生成态须真实结束');
 await run("[...document.querySelectorAll('[data-dil-message-id]')].at(-1).append(document.createElement('span'))");await wait(400);assert.equal(await run('received.length'),2,'最新回复同文变化不得重复执行回传');
 assert.equal(await run("typeof editorBridge === 'undefined' && typeof require === 'undefined' && typeof globalThis.__miniAIReplyChanges === 'undefined'"),true,'网页主世界无本地能力或监听状态');
 const copiedBefore=copies.length;
 await window.loadURL('https://chatgpt.com/');await run('homepage=true');
 await until(()=>window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:'Boolean(globalThis.__miniAIReplyChanges)'}]),'首页监听必须建立');
 const prompting=system.sendLocalPrompt('获取项目概况后读取 input.txt','https://chatgpt.com/',()=>true);
 await until(()=>window.webContents.getURL().includes('%3A'),'进入编码占位地址');await wait(200);
 assert.equal((await readAutoReply(window.webContents)).completion,'unknown','占位地址不获得采集资格');
 assert.equal(copies.length,copiedBefore,'占位阶段没有工具执行结果');
 assert.equal(await window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:'Boolean(globalThis.__miniAIReplyChanges)'}]),true,'占位阶段不能停止已存在的监听');
 const promptResult=await prompting;assert.equal(promptResult.ok,true);assert.equal(promptResult.session,'https://chatgpt.com/c/homepage-allocated-1');
 await until(async()=>await run('received.length')===3,'首次启动不重开开关也必须完成两轮回传');
 const homeReceived=await run('received');assert.equal(homeReceived[0],'获取项目概况后读取 input.txt');
 assert.deepEqual(homeReceived.slice(1),copies.slice(copiedBefore));assert.ok(homeReceived[2].includes('真实磁盘内容'));
 assert.equal(JSON.parse(homeReceived[1]).tool_results[0].batch_id,'homepage-first-1');
 assert.equal(JSON.parse(homeReceived[2]).tool_results[0].batch_id,'homepage-second-1');
 await until(async()=>(await readAutoReply(window.webContents)).completion==='complete','首发回传生成已结束');
 await run("history.pushState({},'', '/');document.getElementById('turns').replaceChildren();received=[];homeEpoch=2");
 await until(()=>window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:"globalThis.__miniAIReplyChanges?.scope === 'https://chatgpt.com/' && globalThis.__miniAIReplyChanges.lastAction === 'none'"}]),'再次新建对话的首页导航基线须先应用');
 assert.equal((await system.sendLocalPrompt('另一新对话获取概况','https://chatgpt.com/',()=>true)).ok,true);
 await until(async()=>await run('received.length')===3,'再次新建对话仍须两轮继续，无需重开自动开关');
 assert.equal(JSON.parse((await run('received'))[2]).tool_results[0].batch_id,'homepage-second-2');
 console.log('ChatGPT 原生离线闭环：历史不执行、两轮真实工具、复制回传一致、重复不回传、无网页桥及首页编码占位交接，7 项通过；官网验收仍待实际对话。');
}).catch(async error=>{
 console.error(error.stack||error);
 if(system) {const s=system.getState();console.error(JSON.stringify({message:s.message,busy:s.busy,resultStatuses:s.results.map(r=>r.status),return:s.resultReturn?.phase,returnMessage:s.resultReturn?.message,continuation:s.continuation?.phase,continuationMessage:s.continuation?.message}));}
 if(window&&!window.isDestroyed()) {
  const snapshot=await readAutoReply(window.webContents).catch(()=>null);
  console.error(JSON.stringify({completion:snapshot?.completion,source:snapshot?.source,length:snapshot?.text.length}));
 }
 process.exitCode=1;
}).finally(async()=>{
 if(system)await system.dispose();else if(sender)await sender.dispose();
 if(window&&!window.isDestroyed())window.destroy();
 assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));
 // 父进程等Electron退出后清理自有profile，直接Electron调用保留临时数据。
 app.exit(process.exitCode||0);
});
