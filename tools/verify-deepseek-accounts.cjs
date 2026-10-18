/** 原生离线账号验收。只对 synthetic HTTPS 页及本地顶栏运行脚本，不连接官网或读取真实登录资料。 */
const { app, BaseWindow, WebContentsView, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const { DeepSeekAccountStore } = require('../dist/main/deepseekAccounts');
const { DeepSeekAccountViews } = require('../dist/main/deepseekAccountViews');
const { createDeepSeekAccountView, createChatGPTView } = require('../dist/main/webPlatformView');
const { WebPlatformController } = require('../dist/main/webPlatformController');
const { registerToolWorkspaceStatus } = require('../dist/main/toolWorkspaceStatus');
const { deepseekAccountPartition } = require('../dist/shared/deepseekAccounts');
const { WEB_PLATFORMS } = require('../dist/shared/webPlatform');
const { CHANNELS } = require('../dist/shared/contract');
const { stripSelfDeclarations, checkUaConsistency } = require('../dist/shared/userAgent');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const directory = argument('probe-dir');
const phase = argument('probe-phase');
if (!directory || !['write', 'reopen'].includes(phase)) throw new Error('请通过 node tools/run-deepseek-accounts-probe.cjs 运行');
const resolved = fs.realpathSync(directory);
const relative = path.relative(fs.realpathSync(os.tmpdir()), resolved);
if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(resolved).startsWith('mini-deepseek-accounts-probe-')) throw new Error('探针资料目录必须为专用 TEMP 子目录');
app.setName('mini-ai-ide'); app.setPath('userData', resolved); app.setPath('sessionData', resolved);
app.commandLine.appendSwitch('disable-gpu');
const checks = [];
const snapshots = [];
let controller; let win;
function check(name, value) { assert.ok(value, name); checks.push(name); }
async function waitFor(read) {
  for (let count = 0; count < 150; count++) {
    if (await read()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('本地状态等待超时');
}
app.whenReady().then(async () => {
  const intercepted = new Map(); const requests = new Map(); const unexpected = [];
  function offline(partition) {
    const target = session.fromPartition(partition);
    if (intercepted.has(partition)) return target;
    intercepted.set(partition, target);
    target.protocol.handle('https', request => {
      const url = new URL(request.url);
      if (![new URL(WEB_PLATFORMS.deepseek.url).origin, new URL(WEB_PLATFORMS.chatgpt.url).origin].includes(url.origin)) {
        unexpected.push(request.url); return new Response('', { status: 403 });
      }
      requests.set(partition, (requests.get(partition) || 0) + 1);
      return new Response('<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><h1 id="synthetic">Offline account fixture</h1><textarea aria-label="synthetic composer"></textarea></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    });
    target.protocol.handle('http', request => { unexpected.push(request.url); return new Response('', { status: 403 }); });
    return target;
  }
  const store = new DeepSeekAccountStore(path.join(resolved, 'deepseek-accounts.json'));
  const baseSession = offline(WEB_PLATFORMS.deepseek.partition);
  const ua = stripSelfDeclarations(baseSession.getUserAgent(), app.getName()).effective;
  baseSession.setUserAgent(ua);
  const defaultView = new WebContentsView({ webPreferences: {
    partition: WEB_PLATFORMS.deepseek.partition, userAgent: ua, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
  } });
  defaultView.webContents.setUserAgent(ua);
  win = new BaseWindow({ width: 1100, height: 720, show: false });
  const bar = new WebContentsView({ webPreferences: { preload: path.resolve('dist/main/webbarPreload.js'), partition: 'persist:probe-local-ui', sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const editor = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  for (const view of [defaultView, bar, editor]) win.contentView.addChildView(view);
  defaultView.setBounds({ x: 0, y: 44, width: 1000, height: 600 });
  bar.setBounds({ x: 0, y: 0, width: 1000, height: 44 }); editor.setBounds({ x: 1000, y: 44, width: 50, height: 600 });
  const created = [];
  const views = new DeepSeekAccountViews(defaultView, partition => {
    offline(partition); const view = createDeepSeekAccountView(partition); created.push(view);
    view.setBounds(defaultView.getBounds()); win.contentView.addChildView(view); return view;
  });
  let busy = false; let chatgpt;
  const errors = [];
  bar.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  registerToolWorkspaceStatus({ ipc: ipcMain, webbar: bar.webContents, open: () => {} });
  ipcMain.handle(CHANNELS.collectReply, () => ({ ok: true, noNewContent: true }));
  ipcMain.handle(CHANNELS.toggleWorkspace, () => {}); ipcMain.handle(CHANNELS.restoreFileWorkspace, () => {});
  controller = new WebPlatformController({ ipc: ipcMain, editor: editor.webContents, webbar: bar.webContents, deepseek: defaultView, accountStore: store, accountViews: views,
    createChatGPT: () => { offline(WEB_PLATFORMS.chatgpt.partition); chatgpt = createChatGPTView(); chatgpt.setBounds(defaultView.getBounds()); win.contentView.addChildView(chatgpt); return chatgpt; },
    switchBlock: () => busy ? '工具正在执行，完成后可切换' : undefined,
    prepareSwitch: async () => {}, applyView: view => { for (const entry of [defaultView, ...created, chatgpt].filter(Boolean)) entry.setVisible(entry === view); },
  });
  controller.register();
  await editor.webContents.loadURL('data:text/html,<p>Local editor fixture</p>');
  await controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url);
  await bar.webContents.loadFile(path.resolve('dist/renderer/webbar.html'));
  const read = code => bar.webContents.executeJavaScript(code);
  const page = view => view.webContents.executeJavaScript('Boolean(document.getElementById("synthetic"))');
  const paint = () => new Promise(resolve => setTimeout(resolve, 60));
  await waitFor(() => read('!document.getElementById("deepseek-account").disabled'));
  check('旧默认账号继续使用 persist:postcheck 固定分区', deepseekAccountPartition('default') === WEB_PLATFORMS.deepseek.partition && defaultView.webContents.session === session.fromPartition('persist:postcheck'));
  check('账号资料仅位于专用临时目录', app.getPath('userData') === resolved);
  if (phase === 'write') {
    await defaultView.webContents.executeJavaScript('localStorage.setItem("account-probe", "default-marker");document.cookie="account-probe=default-marker; Max-Age=3600; SameSite=Lax; Secure";true');
    check('真实顶栏默认显示原有账号', await read('!document.getElementById("deepseek-accounts").hidden && document.getElementById("deepseek-account").value === "default"'));
    await read('document.getElementById("btn-add-deepseek-account").click();true');
    check('添加入口聚焦真实备注控件，空备注不可提交', await read('document.activeElement === document.getElementById("deepseek-account-name") && document.getElementById("btn-confirm-deepseek-account").disabled'));
    await read('(() => { const e=document.getElementById("deepseek-account-name");e.value=" 默认账号 ";e.dispatchEvent(new Event("input"));return true; })()');
    check('真实输入重名立即显示可改名短提示并拒绝无效提交', await read('document.getElementById("btn-confirm-deepseek-account").disabled && document.getElementById("collect-status").textContent === "账号备注已存在，请使用其他名称"') && store.accounts.length === 1);
    await read('(() => { const e=document.getElementById("deepseek-account-name");e.value="非法"+String.fromCharCode(0)+"备注";e.dispatchEvent(new Event("input"));return true; })()');
    check('真实输入控制字符给出具体原因并保留备注', await read('document.getElementById("btn-confirm-deepseek-account").disabled && document.getElementById("collect-status").textContent === "账号备注不能包含控制字符" && document.getElementById("deepseek-account-name").value.includes(String.fromCharCode(0))'));
    await read('(() => {const e=document.getElementById("deepseek-account-name");e.value="工作账号";e.dispatchEvent(new CompositionEvent("compositionstart"));e.dispatchEvent(new Event("input"));e.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true}));return true;})()');
    check('中文组字 Enter 不会误建账号', store.accounts.length === 1);
    await read('(() => {const e=document.getElementById("deepseek-account-name");e.dispatchEvent(new CompositionEvent("compositionend"));e.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return true;})()');
    await waitFor(() => store.accounts.length === 2 && views.selectedId !== 'default' && !controller.state.switching);
    const account = store.accounts[1]; const extra = views.get(account.id);
    await waitFor(() => page(extra)); await paint();
    check('真实确认控件创建独立账号并切换选项', await read(`document.getElementById("deepseek-account").value === ${JSON.stringify(account.id)} && document.getElementById("deepseek-account-form").hidden`));
    check('新账号相同 HTTPS origin 未继承默认登录存储', await extra.webContents.executeJavaScript('location.origin === "https://chat.deepseek.com" && localStorage.getItem("account-probe") === null && !document.cookie.includes("account-probe=")'));
    await extra.webContents.executeJavaScript('localStorage.setItem("account-probe", "work-marker");document.cookie="account-probe=work-marker; Max-Age=3600; SameSite=Lax; Secure";true');
    const defaultLoads = requests.get(WEB_PLATFORMS.deepseek.partition);
    const extraPartition = deepseekAccountPartition(account.id); const extraLoads = requests.get(extraPartition); const identity = extra.webContents.id;
    await read('webbarBridge.setDeepSeekAccount("default")');
    check('切回默认账号复用原视图并保留独立存储', controller.getView('deepseek') === defaultView && await defaultView.webContents.executeJavaScript('localStorage.getItem("account-probe") === "default-marker" && document.cookie.includes("account-probe=default-marker")'));
    await read(`webbarBridge.setDeepSeekAccount(${JSON.stringify(account.id)})`);
    check('再次切换复用账号视图和存储且没有重新加载', views.current.webContents.id === identity && requests.get(WEB_PLATFORMS.deepseek.partition) === defaultLoads && requests.get(extraPartition) === extraLoads && await extra.webContents.executeJavaScript('localStorage.getItem("account-probe") === "work-marker"'));
    busy = true; controller.refreshSwitchAvailability();
    await waitFor(() => read('document.getElementById("deepseek-account").disabled'));
    check('工具执行时真实账号和平台入口统一禁用并给出原因', await read('document.getElementById("web-platform").disabled && document.getElementById("btn-add-deepseek-account").disabled && document.getElementById("deepseek-account-control").title === "工具正在执行，完成后可切换" && document.getElementById("deepseek-account-control").tabIndex === 0'));
    const denied = await read('webbarBridge.setDeepSeekAccount("default").then(()=>"",e=>e.message)');
    check('绕过禁用控件的真实 IPC 仍拒绝忙时切换', denied.includes('工具正在执行') && views.selectedId === account.id);
    busy = false; controller.refreshSwitchAvailability();
    await read('webbarBridge.setWebPlatform("chatgpt")'); await waitFor(() => page(chatgpt));
    check('ChatGPT 不展示或新增账号控件', await read('document.getElementById("deepseek-accounts").hidden') && store.accounts.length === 2);
    await read('webbarBridge.setWebPlatform("deepseek")');
    for (const view of [defaultView, extra]) {
      const environment = await view.webContents.executeJavaScript('({noNode:typeof require==="undefined"&&typeof process==="undefined",noBridge:typeof editorBridge==="undefined"&&typeof webbarBridge==="undefined",ua:navigator.userAgent})');
      const preferences = view.webContents.getLastWebPreferences();
      check(`账号 ${view === defaultView ? 'default' : account.id} 使用沙箱、隔离、无桥和真实 UA`, environment.noNode && environment.noBridge && preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration && !preferences.preload && !/Electron\//.test(environment.ua) && checkUaConsistency(environment.ua, process.versions.chrome).ok);
    }
    bar.webContents.send(CHANNELS.chromeState, { fileVisible: false, layout: { workspaceVisible: true } });
    await waitFor(() => read('!document.getElementById("btn-file-restore").hidden'));
    for (const width of [320, 380, 440]) {
      bar.setBounds({ x: 0, y: 0, width, height: 44 }); await paint();
      for (const mode of ['select', 'add']) {
        if (mode === 'add') { await read('document.getElementById("btn-add-deepseek-account").click();true'); await paint(); }
        const geometry = await read('(() => { const width=innerWidth; const controls=[...document.querySelectorAll("button,select,input")].filter(e=>e.getClientRects().length); return {width,scroll:document.documentElement.scrollWidth,overflow:controls.filter(e=>{const r=e.getBoundingClientRect();return r.left<-.5||r.right>width+.5;}).map(e=>({id:e.id,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})),input:document.getElementById("deepseek-account-name").getBoundingClientRect().width}; })()');
        check(`${width}px 账号${mode === 'add' ? '添加' : '选择'}与文件恢复入口没有横向溢出：${JSON.stringify(geometry)}`, geometry.scroll <= width && geometry.overflow.length === 0);
        if (mode === 'add') check(`${width}px 添加备注输入至少有 60px：${geometry.input}`, geometry.input >= 60);
        const file = path.join(resolved, `webbar-${width}-${mode}.png`);
        try { fs.writeFileSync(file, (await bar.webContents.capturePage(undefined, { stayHidden: true })).toPNG()); snapshots.push({ file }); }
        catch (error) { snapshots.push({ file, unavailable: String(error.message || error) }); }
        if (mode === 'add') await read('document.getElementById("btn-cancel-deepseek-account").click();true');
      }
    }
    check('本地顶栏无脚本异常且无外部网络请求', errors.length === 0 && unexpected.length === 0);
  } else {
    check('新进程保留真实账号清单并仍默认原账号', store.accounts.length === 2 && views.selectedId === 'default');
    check('新进程默认分区保留 synthetic 登录标记', await defaultView.webContents.executeJavaScript('localStorage.getItem("account-probe") === "default-marker" && document.cookie.includes("account-probe=default-marker")'));
    const account = store.accounts[1]; await read(`webbarBridge.setDeepSeekAccount(${JSON.stringify(account.id)})`); const extra = views.get(account.id); await waitFor(() => page(extra));
    check('新进程账号仍映射相同固定分区', extra.webContents.session === session.fromPartition(deepseekAccountPartition(account.id)));
    check('新进程独立账号分区保留 synthetic 登录标记', await extra.webContents.executeJavaScript('localStorage.getItem("account-probe") === "work-marker" && document.cookie.includes("account-probe=work-marker")'));
    check('新进程未访问外部网络且本地界面无脚本错误', unexpected.length === 0 && errors.length === 0);
  }
  for (const target of intercepted.values()) { target.flushStorageData(); await target.cookies.flushStore(); }
  fs.writeFileSync(path.join(resolved, `${phase}.json`), JSON.stringify({ phase, checks, snapshots }, null, 2));
  process.stdout.write(JSON.stringify({ phase, pass: checks.length, fail: 0, directory: resolved }) + '\n');
  controller.dispose(); win.close(); app.quit();
}).catch(error => { try { controller?.dispose(); win?.close(); } catch {} process.stderr.write(String(error.stack || error) + '\n'); app.exit(1); });
