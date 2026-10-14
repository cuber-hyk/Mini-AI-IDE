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
 if (run.error) { console.error(run.error.message); code = 1; }
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
 // 同轮前一条assistant自带局部页脚，最后一条使用轮末页脚；较早的工具请求不得执行。
 const earlier=assistant.cloneNode(true);earlier.dataset.chatgptSearchUnitKey='earlier-message';
 earlier.querySelector('[data-dil-message-id]').dataset.dilMessageId='earlier-'+id;
 earlier.querySelector('code').textContent=JSON.stringify({protocol_version:1,batch_id:'earlier-'+id,requests:[{id:'earlier-request',tool:'get_project_info',args:{}}]});
 earlier.append(footer.cloneNode(true));turn.insertBefore(earlier,assistant);
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
let window, system, sender, failed=false;
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
 const handlers=new Map(), copies=[], states=[], changedFiles=[];
 const editor={mainFrame:{},isDestroyed:()=>false,send(_channel,state){states.push(state)}};
 sender=new WebComposerSender(window.webContents);
 system=await createToolIntegration({ipc:{handle:(channel,fn)=>handlers.set(channel,fn)},editor,web:window.webContents,files,
  returnPath:new ReturnPathService(files),workspace:{editor:{isDirty:()=>false,current:{documents:[]}},run:fn=>fn()},sender,
  storePath:path.join(temporary,'tools.json'),disabled:false,ask:async()=>({response:0,checkboxChecked:false}),notifyFile(relative,change){changedFiles.push({relative,change})},copy:text=>copies.push(text)});
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
 await until(async()=>(await readAutoReply(window.webContents)).completion==='complete','新对话回传后的生成结束');
 await run('homepage=false');
 const beforeRecovery=await run('received.length'),copiesBeforeRecovery=copies.length;
 const recoveryBody=JSON.stringify({protocol_version:1,batch_id:'native-json-recovery',requests:[
  {id:'temp',tool:'get_ai_temp_dir',args:{task_id:'native-recovery'}},
  {id:'create',tool:'apply_changes',depends_on:['temp'],args:{changes:[{path:'.mini-ai-ide/ai-temp/native-recovery/recovered.txt',operation:'create',content:'native recovered file'}]}}
 ]});
 async function appendBody(id,body){await run(`(()=>{const item=appendReply(${JSON.stringify(id)},'get_project_info',{},false);item.code.textContent=${JSON.stringify(body)};item.turn.dataset.talvtTurnState='complete';item.turn.append(item.footer)})()`);}
 await appendBody('native-syntax-error',recoveryBody.slice(0,-1)+',}');
 await until(async()=>await run('received.length')===beforeRecovery+1,'真实代码框的解析诊断必须经原生composer回传');
 const draftId=system.getState().batchError?.error.match(/草稿 ([0-9a-f-]{36})/)?.[1];assert.ok(draftId);
 await assert.rejects(fs.access(path.join(root,'.mini-ai-ide')),'语法错误阶段不创建临时目录或文件');
 await until(async()=>(await readAutoReply(window.webContents)).completion==='complete','解析诊断发送后的生成结束');
 const patchBody=JSON.stringify({repair_draft:{draft_id:draftId,version:1,old_string:',}',new_string:'}'}});
 await appendBody('native-repair',patchBody);
 await until(async()=>await run('received.length')===beforeRecovery+2,'恢复来源经真实DOM采集与composer完成整批回传');
 assert.equal(await fs.readFile(path.join(root,'.mini-ai-ide/ai-temp/native-recovery/recovered.txt'),'utf8'),'native recovered file');
 const recoveryReceipt=JSON.parse((await run('received')).at(-1));assert.equal(recoveryReceipt.tool_results.length,2);
 assert.ok(recoveryReceipt.tool_results.every(result=>result.status==='done'));
 assert.equal(copies.length,copiesBeforeRecovery+1,'解析错误不自动复制，恢复后只复制一次真实整批结果');
 assert.equal(copies.at(-1),(await run('received')).at(-1));
 await until(async()=>(await readAutoReply(window.webContents)).completion==='complete','恢复结果回传后的生成结束');
 await appendBody('native-repeat-repair',patchBody);await wait(400);
 assert.equal(await run('received.length'),beforeRecovery+2,'重复恢复补丁不能重新执行或回传');
 const chainStart=await run('received.length'),chainCopies=copies.length;
 const rounds=30,recoveries=[],remounts=[];
 for(let round=1;round<=rounds;round++){
  const suffix=String(round).padStart(2,'0'),id='long-chain-'+suffix,file=id+'.txt',content='真实长链第 '+round+' 轮';
  const before=chainStart+round-1;
  if(round===8||round===19){
   await until(()=>window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:'Boolean(globalThis.__miniAIReplyChanges?.waiter)'}]),'故障注入前必须处于真实等待');
   const stateIndex=states.length;
   const preserved=await window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:`(()=>{const state=globalThis.__miniAIReplyChanges;if(!state?.waiter)return null;const waiter=state.waiter;state.waiter=null;state.observer.disconnect();waiter(false);return {token:state.token,sourceEpoch:state.sourceEpoch}})()`}]);
   assert.ok(preserved,'可控故障必须实际释放原监听等待');
   await until(()=>states.slice(stateIndex).some(state=>state.collection?.phase==='recovering'),'监听失效须显示恢复阶段');
   recoveries.push({round,stateIndex,preserved});
  }
  const body=JSON.stringify({protocol_version:1,batch_id:id,requests:[
   {id:'create',tool:'apply_changes',args:{changes:[{path:file,operation:'create',content}]}},
   {id:'read',tool:'read_file',args:{path:file},depends_on:['create']}
  ]});
  // 故障轮在观察者已断开时挂载新回复，恢复必须保留来源并主动复核这一条。
  await appendBody(id,body);
  await until(async()=>await run('received.length')===before+1&&!system.getState().busy,'第 '+round+' 轮真实执行并回传');
  const receiptText=await run('received.at(-1)'),receipt=JSON.parse(receiptText);
  assert.equal(receipt.tool_results.length,2,'每轮只回传当前两项真实工具结果');
  assert.ok(receipt.tool_results.every(result=>result.batch_id===id&&result.status==='done'),'创建与读取均实际成功');
  assert.deepEqual(receipt.tool_results.map(result=>result.request_id),['create','read']);
  assert.ok(JSON.stringify(receipt.tool_results[1].data).includes(content),'读回内容来自真实临时项目文件');
  assert.equal(await fs.readFile(path.join(root,file),'utf8'),content);
  assert.equal(changedFiles.filter(item=>item.relative===file&&item.change==='created').length,1,'每个文件只创建一次');
  assert.equal(copies.length,chainCopies+round,'每轮只自动复制一次');
  assert.equal(copies.at(-1),receiptText,'逐轮复制与原生回传字节一致');
  assert.equal(system.getState().config.automatic,true,'整个长链不重开自动继续');
  await until(async()=>(await readAutoReply(window.webContents)).completion==='complete','第 '+round+' 轮运输后的生成状态结束');
  if(round===8||round===19){
   const recovery=recoveries.at(-1);
   assert.ok(states.slice(recovery.stateIndex).some(state=>state.collection?.phase==='watching'&&!state.collection.reason),'保留来源修复后恢复监听');
   assert.deepEqual(await window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:'({token:globalThis.__miniAIReplyChanges.token,sourceEpoch:globalThis.__miniAIReplyChanges.sourceEpoch})'}]),recovery.preserved,'恢复不得更换监听身份或清空来源状态');
  }
  if(round===12||round===25){
   await run("(()=>{const latest=[...document.querySelectorAll('[data-dil-message-id]')].at(-1);latest.replaceWith(latest.cloneNode(true))})()");
   await wait(400);
   assert.equal(await run('received.length'),before+1,'同 ID 同正文重挂载不得重复执行回传');
   assert.equal(copies.length,chainCopies+round,'重挂载不得重复复制');
   remounts.push(round);
  }
  if(round===15){
   await run("(()=>{const unrelated=document.createElement('aside');unrelated.textContent='普通界面变化';document.body.append(unrelated);unrelated.className='changed';unrelated.remove();const latest=[...document.querySelectorAll('[data-dil-message-id]')].at(-1);latest.append(document.createElement('span'))})()");
   await wait(400);
   assert.equal(await run('received.length'),before+1,'普通 DOM 和同文变化不能创建新批次');
   assert.equal(copies.length,chainCopies+round);
  }
  if(round===21){
   await run("window.savedChainPath=location.pathname;window.savedChainTurns=[...document.getElementById('turns').children];history.pushState({},'', '/c/long-chain-history');document.getElementById('turns').replaceChildren()");
   await until(()=>window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:"globalThis.__miniAIReplyChanges?.scope === 'https://chatgpt.com/c/long-chain-history' && globalThis.__miniAIReplyChanges.history?.reply === undefined"}]),'历史会话先进入空加载帧');
   await run("appendReply('unexecuted-history-tool','apply_changes',{changes:[{path:'history-must-not-run.txt',operation:'create',content:'must not execute'}]})");
   await until(()=>window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:'globalThis.__miniAIReplyChanges?.history === null'}]),'历史正文挂载并结束历史安静窗');
   assert.equal(await run('received.length'),before+1,'打开未执行历史工具回复不能授权执行');
   assert.equal(copies.length,chainCopies+round,'历史回看不能复制旧工具结果');
   await assert.rejects(fs.access(path.join(root,'history-must-not-run.txt')),{code:'ENOENT'});
   await run("history.pushState({},'',savedChainPath);document.getElementById('turns').replaceChildren()");
   await until(()=>window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:'globalThis.__miniAIReplyChanges?.scope === location.origin + location.pathname && globalThis.__miniAIReplyChanges.history?.reply === undefined'}]),'返回原会话先进入空加载帧');
   await run("document.getElementById('turns').replaceChildren(...savedChainTurns);delete window.savedChainTurns");
   await until(()=>window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:'globalThis.__miniAIReplyChanges?.history === null'}]),'返回后历史正文挂载并结束历史安静窗');
   assert.equal(await run('received.length'),before+1,'返回后已有正文不能重复执行');
   assert.equal(copies.length,chainCopies+round);
  }
  if(round===27){
   // SPA 在一个任务内完成导航和历史 DOM 替换，无额外挂载变化来启动基线。
   await run("window.savedSyncPath=location.pathname;window.savedSyncTurns=[...document.getElementById('turns').children];history.pushState({},'', '/c/long-chain-sync-history');document.getElementById('turns').replaceChildren();appendReply('unexecuted-sync-history-tool','apply_changes',{changes:[{path:'sync-history-must-not-run.txt',operation:'create',content:'must not execute'}]})");
   await until(()=>window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:"globalThis.__miniAIReplyChanges?.scope === 'https://chatgpt.com/c/long-chain-sync-history' && globalThis.__miniAIReplyChanges.history === null"}]),'同步完整历史 DOM 无额外变化也必须落定基线');
   const historical=await readAutoReply(window.webContents);
   assert.equal(historical.completion,'complete');
   assert.equal(historical.source,'history','同步挂载的未执行历史请求仍是历史');
   assert.equal(system.getState().collection?.phase,'watching','历史基线通知已完成且监听保持开启');
   assert.equal(await run('received.length'),before+1,'同步挂载历史命令不得执行回传');
   assert.equal(copies.length,chainCopies+round,'同步历史回看不得复制');
   await assert.rejects(fs.access(path.join(root,'sync-history-must-not-run.txt')),{code:'ENOENT'});
   await run("history.pushState({},'',savedSyncPath);document.getElementById('turns').replaceChildren(...savedSyncTurns);delete window.savedSyncTurns");
   await until(()=>window.webContents.executeJavaScriptInIsolatedWorld(1004,[{code:'globalThis.__miniAIReplyChanges?.scope === location.origin + location.pathname && globalThis.__miniAIReplyChanges.history === null'}]),'同步恢复原会话完整 DOM 后也必须落定历史基线');
   assert.equal((await readAutoReply(window.webContents)).source,'history','返回后已执行的尾部不能恢复新请求资格');
   assert.equal(await run('received.length'),before+1,'同步返回原会话不重放旧批次');
   assert.equal(copies.length,chainCopies+round);
  }
 }
 const chainReceipts=(await run('received')).slice(chainStart);
 assert.equal(chainReceipts.length,rounds,'长链恰好回传三十批');
 assert.equal(new Set(chainReceipts.map(text=>JSON.parse(text).tool_results[0].batch_id)).size,rounds,'没有重复批次');
 assert.deepEqual(chainReceipts,copies.slice(chainCopies),'全链复制与回传同源');
 assert.equal(changedFiles.filter(item=>/^long-chain-\d{2}\.txt$/.test(item.relative)&&item.change==='created').length,rounds,'三十个文件恰好各创建一次');
 assert.equal((await fs.readdir(root)).filter(name=>/^long-chain-\d{2}\.txt$/.test(name)).length,rounds);
 assert.equal(await run("typeof editorBridge === 'undefined' && typeof require === 'undefined' && typeof globalThis.__miniAIReplyChanges === 'undefined'"),true,'长链后网页主世界仍无本地能力');
 console.log(JSON.stringify({fixture:'ChatGPT 原生离线闭环',baselineChecks:11,rounds,executedRequests:rounds*2,watcherRecoveries:recoveries.map(item=>item.round),sameMessageRemounts:remounts,ordinaryDomChange:true,historyMounts:['asynchronous','synchronous'],historyReplayBlocked:true,exactlyOnce:true,clipboardMatches:true,officialSiteVerified:false}));
}).catch(async error=>{
 failed=true;
 console.error(error.stack||error);
 if(system) {const s=system.getState();console.error(JSON.stringify({message:s.message,busy:s.busy,resultStatuses:s.results.map(r=>r.status),return:s.resultReturn?.phase,returnMessage:s.resultReturn?.message,continuation:s.continuation?.phase,continuationMessage:s.continuation?.message,collection:s.collection}));}
 if(window&&!window.isDestroyed()) {
  const snapshot=await readAutoReply(window.webContents).catch(()=>null);
  console.error(JSON.stringify({completion:snapshot?.completion,source:snapshot?.source,length:snapshot?.text.length}));
 }
 process.exitCode=1;
}).finally(async()=>{
 if(system)await system.dispose();else if(sender)await sender.dispose();
 if(window&&!window.isDestroyed())window.destroy();
 assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));
 // 仅父进程拥有已退出profile的删除资格；直接Electron调用保留临时profile。
 app.exit(failed?1:0);
});
