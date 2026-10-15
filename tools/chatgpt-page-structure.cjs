/** 原生验收只读快照；生产采集核验只返回状态与长度，不记录正文、草稿、文件名、会话 ID 或凭据。 */
const ownerPath = require.resolve('../dist/main/chatgptPage');
delete require.cache[ownerPath];
const { CHATGPT_COMPLETION_SCRIPT, CHATGPT_COLLECT_SCRIPT, CHATGPT_REPLY_NODES, CHATGPT_ATTACHMENT_READER, CHATGPT_DOCUMENTS_MATCH } = require(ownerPath);
// 只查询本地编辑器既有状态入口，帮助区分网页识别与自动采集调度；不调用工具或发送。
const { app, webContents } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const flowKey = Symbol.for('mini-ai-ide.chatgpt-preview-flow');
const navigationKey = Symbol.for('mini-ai-ide.chatgpt-preview-navigation-format-current');
const shapeKey = Symbol.for('mini-ai-ide.chatgpt-preview-route-shape');
// 只读运输状态；仅比较当前卡片与 owner 已持有的文件，不返回文件名或字节，不调用发送/清理。
for (const web of webContents.getAllWebContents()) {
  if (web.isDestroyed() || !web.getURL().startsWith('https://chatgpt.com/')) continue;
  void web.executeJavaScriptInIsolatedWorld(1005, [{ code: `(() => {
    const s=globalThis.__miniAIComposerAttachments;if(!s?.read||!s.composer?.isConnected)return {installed:false};
    const view=(${CHATGPT_ATTACHMENT_READER})(s.composer),files=s.expectedFiles||[];
    return {installed:true,takenOver:!!s.takenOver,accepted:!!s.accepted,inputConnected:!!s.input?.isConnected,formConnected:!!s.composer?.isConnected,
      documents:(${CHATGPT_DOCUMENTS_MATCH})(view.cards,files),expected:files.slice(0,50).map(f=>({image:/^image\\//.test(f.type||''),documentMatched:view.cards.some(c=>c.kind==='document'&&c.matchesName(f.name))})),
      cards:view.cards.slice(0,50).map(c=>({kind:c.kind,ready:c.ready})),unknown:view.unknown,pending:view.pending,error:view.error};
  })()` }])
    .then(state => fs.writeFileSync(path.join(app.getPath('temp'), 'mini-chatgpt-attachment-runtime.json'), JSON.stringify({at:new Date().toISOString(),...state}), 'utf8')).catch(() => {});
}
const routeShape = value => {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://chatgpt.com') return '<other-origin>';
    return url.pathname.split('/').map(segment => {
      if (!segment || ['c','s','a','chat','auth','login','sign_in','g','project','projects'].includes(segment)) return segment;
      const punctuation = Array.from(new Set(segment.replace(/[a-zA-Z0-9_-]/g, ''))).join('');
      let decoded = ''; try { decoded = decodeURIComponent(segment); } catch {}
      const suffix = decoded.slice(decoded.indexOf(':') + 1);
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suffix);
      const prefix = uuid && /^[a-zA-Z_-]{1,24}:/.test(decoded) ? decoded.split(':')[0] : '<unknown>';
      return '<id:length=' + segment.length + ';punctuation=' + punctuation + ';prefix=' + prefix + ';uuid=' + uuid + '>';
    }).join('/');
  } catch { return '<invalid>'; }
};
globalThis[shapeKey] = routeShape;
for (const web of webContents.getAllWebContents()) {
  if (web.isDestroyed() || !web.getURL().startsWith('https://chatgpt.com/') || web[navigationKey]) continue;
  web[navigationKey] = true;
  let previous = routeShape(web.getURL());
  web.on('did-navigate-in-page', (_event, url, main) => {
    if (!main) return;
    const next = globalThis[shapeKey](url);
    fs.appendFileSync(path.join(app.getPath('temp'), 'mini-chatgpt-flow.log'), JSON.stringify({at:new Date().toISOString(),event:'probe.navigation-format',fromPath:previous,toPath:next})+'\n','utf8');
    previous = next;
  });
}
if (!globalThis[flowKey]) {
  globalThis[flowKey] = true;
  const trace = require('../dist/main/tools/collectionTrace');
  const previousScope = trace.traceScope;
  trace.traceScope = value => {
    const scoped = previousScope(value);
    try {
      const url = new URL(value);
      return { ...scoped, path: url.pathname.split('/').map(segment => segment && !['c','s','a','chat','auth','login','sign_in','g','project','projects'].includes(segment) ? '<id>' : segment).join('/') };
    } catch { return { ...scoped, path: '<invalid>' }; }
  };
  const previousTrace = trace.traceCollection;
  trace.traceCollection = (event, data = {}) => {
    previousTrace(event, data);
    const fields = {};
    for (const name of ['allowed','userTurn','completion','reason','decision','value','enabled','disposed','polling','pending','revision','tickRevision','baseline','awaitingHistory','waiting','hasToken','source','suspended','ok','hasReplies','preserve','marked','generating','handoffCancelled','action','turn','historyReady','generated','busy','automatic','resultCount']) {
      const value = data[name];
      if (typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && /^[a-z0-9_-]{0,60}$/i.test(value))) fields[name] = value;
    }
    if (data.text && typeof data.text.length === 'number') fields.textLength = data.text.length;
    if (data.reply) { fields.replyCompletion = data.reply.completion; fields.replyLength = data.reply.length; }
    for (const name of ['from','to','scope']) if (data[name]?.path) fields[name+'Path'] = data[name].path;
    fs.appendFileSync(path.join(app.getPath('temp'), 'mini-chatgpt-flow.log'), JSON.stringify({at:new Date().toISOString(),event,...fields}) + '\n', 'utf8');
  };
}
const editorUrl = require('node:url').pathToFileURL(path.resolve(__dirname, '../dist/renderer/index.html')).href;
const editor = webContents.getAllWebContents().find(web => !web.isDestroyed() && web.getURL() === editorUrl);
if (editor) void editor.executeJavaScript(`editorBridge.getToolState().then(s => ({busy:s.busy,automatic:s.config.automatic,permission:s.config.permission,message:s.message,resultStatuses:s.results.map(r=>r.status),hasRunningProcesses:s.hasRunningProcesses,resultReturn:s.resultReturn?{phase:s.resultReturn.phase}:null,continuation:s.continuation?{phase:s.continuation.phase,error:s.continuation.error}:null,hasCompletion:!!s.completion,hasBatchError:!!s.batchError}))`)
  .then(state => fs.writeFileSync(path.join(app.getPath('temp'), 'mini-chatgpt-local-state.json'), JSON.stringify(state), 'utf8')).catch(() => {});
// 仅在只读完整快照返回 generating 时记录结构原因；1005 写入运输完全不接触。
for (const web of webContents.getAllWebContents()) {
  if (web.isDestroyed() || !web.getURL().startsWith('https://chatgpt.com/') || web[flowKey]) continue;
  web[flowKey] = true;
  const execute = web.executeJavaScriptInIsolatedWorld.bind(web);
  web.executeJavaScriptInIsolatedWorld = async (world, scripts, ...rest) => {
    const code = scripts.length === 1 && scripts[0].code;
    if (world !== 1004 || typeof code !== 'string' || !code.includes('const replies =') || !code.includes('const observation =')) return execute(world, scripts, ...rest);
    const diagnostic = `(() => { const result = ${code}; if (!result || result.completion !== 'generating') return result;
      const visible = e => e.getClientRects().length > 0;
      const describe = e => ({tag:e.tagName,classes:typeof e.className==='string'?e.className.slice(0,180):null,inComposer:!!e.closest('form[data-chatgpt-composer]'),inReply:!!e.closest('[data-dil-message-id]'),busy:e.getAttribute('aria-busy'),streaming:e.getAttribute('data-is-streaming')});
      return {...result,__miniAIProbe:{busy:Array.from(document.querySelectorAll('[aria-busy="true"],[data-is-streaming="true"]')).filter(visible).map(describe),stops:Array.from(document.querySelectorAll('button')).filter(e=>visible(e)&&/^(stop|停止|stop generating|stop streaming|停止生成|停止回答|停止流式传输)$/i.test([e.getAttribute('aria-label'),e.getAttribute('title')].filter(Boolean).join(' ').trim())).map(describe)}};
    })()`;
    const result = await execute(world, [{ ...scripts[0], code: diagnostic }], ...rest);
    if (result?.__miniAIProbe) fs.appendFileSync(path.join(app.getPath('temp'), 'mini-chatgpt-flow.log'), JSON.stringify({at:new Date().toISOString(),event:'probe.generating-reason',...result.__miniAIProbe})+'\n','utf8');
    return result;
  };
}
module.exports = `(() => {
  if (location.origin !== 'https://chatgpt.com') return null;
  const visible = e => !!e && e.getClientRects().length > 0;
  const describe = e => ({ tag: e.tagName, role: e.getAttribute('role'), testid: e.getAttribute('data-testid'), attrs: e.getAttributeNames().filter(n => /^data-/.test(n)), classes: typeof e.className === 'string' ? e.className.slice(0, 320) : null,
    semantics: Object.fromEntries(['data-message-author-role','data-conversation-role','data-turn-role','data-role','data-author','data-d-component','data-state','data-status','data-talvt-turn-state','data-d-inline-reveal','data-d-direction','aria-busy'].map(n => [n,e.getAttribute(n)]).filter(([,v]) => v !== null && /^[a-z_-]{1,45}$/i.test(v))),
    languageLabel: !e.children.length && /^(mini-ai-tools|json|javascript|typescript|python|bash|powershell|text|plaintext|markdown)$/i.test(e.textContent.trim()) ? e.textContent.trim() : null });
  const control = e => ({ ...describe(e), id: /^(composer-submit-button|prompt-textarea)$/.test(e.id || '') ? e.id : null, type: e.getAttribute('type'), visible: visible(e), disabled: !!e.disabled, ariaDisabled: e.getAttribute('aria-disabled'), label: /^(send|send prompt|send message|submit|stop generating|stop streaming|copy|copy code|good response|bad response|start voice|start voice mode|发送|发送消息|发送提示|提交|停止生成|停止流式传输|复制|复制代码|赞|踩|点赞|点踩|喜欢|不喜欢|回答不错|回答不好|重新生成|朗读|分享|更多操作|开始语音)$/i.test(e.getAttribute('aria-label') || '') ? e.getAttribute('aria-label') : null,
    icons:Array.from(e.querySelectorAll('svg use')).map(n => n.getAttribute('href')).filter(v => /^#[a-zA-Z0-9_-]+$/.test(v || '')), paths:Array.from(e.querySelectorAll('svg path')).map(n => (n.getAttribute('d') || '').slice(0,400)) });
  const ancestors = e => { const nodes=[];for(let p=e.parentElement,i=0;p&&p!==document.body&&i<14;p=p.parentElement,i++){nodes.push({ ...describe(p), buttons:Array.from(p.querySelectorAll('button')).slice(-14).map(control) });if(p.tagName==='MAIN')break;}return nodes; };
  const roots = Array.from(document.querySelectorAll('[data-message-author-role],[data-dil-message-id]')).slice(-4);
  const tree = (e, depth) => ({ ...describe(e), ...(depth < 7 ? { children: Array.from(e.children).filter(n => !/^(SCRIPT|STYLE|SVG|PATH)$/.test(n.tagName)).slice(0,24).map(n=>tree(n,depth+1)) } : {}) });
  const composers = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible);
  return { ordinary: location.pathname === '/' || /^\\/c\\/[a-zA-Z0-9_-]+$/.test(location.pathname),
    runtimeWatcher:(()=>{const s=globalThis.__miniAIReplyChanges;if(!s)return {installed:false};const current=s.replyNodes?.().at(-1);return {installed:true,scopeCurrent:s.scope===location.origin+location.pathname,initialCount:s.initialReplies?.length,replyCount:s.replyNodes?.().length,lastAction:s.lastAction,dirty:s.dirty,waiting:typeof s.waiter==='function',turn:s.turn,history:!!s.history,historyReady:s.historyReady,generated:s.generated,generating:s.generating?.(),source:s.sources?.source(current)||null,sourceNodeCount:s.sourceNodes?.().length,sourceHistory:s.sourceHistory,hasSubmit:s.submitAt>0,handoffCancelled:s.handoffCancelled};})(),
    productionCompletion: ${CHATGPT_COMPLETION_SCRIPT}, productionCollection: (()=>{try {const replies=${CHATGPT_COLLECT_SCRIPT};return {count:replies.length,lengths:replies.map(r=>r.length),formalToolFence:replies.some(r=>/\\n?\x60{4,}mini-ai-tools\\n/.test(r))};}catch{return {error:'collection structure rejected'};}})(),
    completionEvidence:(()=>{${CHATGPT_REPLY_NODES}return {reply:!!reply,visible:visible(reply),state:frame?.getAttribute('data-talvt-turn-state'),openDetails:!!assistant?.querySelector('details[open]'),footers:frame?Array.from(frame.querySelectorAll('.turn-action-controls')).map(e=>({inAssistant:!!assistant?.contains(e),inExcluded:!!e.closest(excluded),inUser:!!e.closest('[class~="group/user-message"]'),parents:ancestors(e).slice(0,3).map(p=>({tag:p.tag,classes:p.classes,attrs:p.attrs})),buttons:Array.from(e.querySelectorAll('button')).map(control)})):[]};})(),
    attachments: JSON.parse(${fs.readFileSync(path.join(__dirname, 'inspect-chatgpt-attachments.js'), 'utf8').trim().replace(/;\s*$/, '')}),
    attachmentReader: (() => { const form = document.querySelector('div.ProseMirror[contenteditable="true"][role="textbox"]')?.closest('form[data-chatgpt-composer]'); if (!form) return null; const state = (${CHATGPT_ATTACHMENT_READER})(form); return { unknown: state.unknown, pending: state.pending, error: state.error, cards: state.cards.slice(0, 50).map(card => ({ kind: card.kind, ready: card.ready, nameMatchesRemoveLabel: card.matchesName((card.remove.getAttribute('aria-label') || '').replace(/^(?:移除|删除|remove|delete)\\s*/i, '')) })), pendingNodes: Array.from(form.querySelectorAll('[role="progressbar"],[aria-busy="true"]')).filter(visible).slice(0, 16).map(e => ({tag:e.tagName,role:e.getAttribute('role'),inCard:state.cards.some(card=>card.node.contains(e)),inEditable:!!e.closest('[contenteditable="true"]')})) }; })(),
    composers: composers.map(e=>({ ...describe(e), form:!!e.closest('form'), controls:Array.from(e.closest('form')?.querySelectorAll('button')||[]).map(control), ancestors:ancestors(e).slice(0,12) })),
    turns:Array.from(document.querySelectorAll('[data-talvt-turn-state]')).slice(-3).map(e=>({root:describe(e),tree:tree(e,0),controls:Array.from(e.querySelectorAll('button')).map(control)})),
    replies: roots.map(e=>({ root:describe(e), ancestors:ancestors(e), tree:tree(e,0) })),
    code: Array.from(document.querySelectorAll('code')).filter(e=>e.closest('[data-dil-message-id]')).slice(-4).map(e=>({ ...describe(e), language:e.getAttribute('data-language'), ancestors:ancestors(e).slice(0,6) })) };
})()`;
