/** 隔离原生加载反馈验收：本地协议接管全部 HTTPS，不接触用户登录或公网。 */
const { app, BaseWindow, WebContentsView, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { WebLoadingView } = require('../dist/main/webLoadingView');
const { WebPlatformController } = require('../dist/main/webPlatformController');
const { WorkspaceLayoutController } = require('../dist/main/workspaceLayoutController');
const { CHANNELS } = require('../dist/shared/contract');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-web-loading-'));
app.setPath('userData', directory);
const checks = [];
const check = (label, value) => { assert.ok(value, label); checks.push(label); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) { for (let n = 0; n < 100; n++) { if (await read()) return; await wait(25); } throw new Error('状态等待超时'); }
let controller; let indicator; let win;
app.whenReady().then(async () => {
  win = new BaseWindow({ width: 1280, height: 850, show: false });
  const local = () => new WebContentsView({ webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  let failDeepseek = false; let deepseekLoads = 0; let chatgptLoads = 0; let blocked = 0;
  const official = (platform) => {
    const isolated = session.fromPartition(`loading-probe-${platform}`);
    isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const expected = platform === 'deepseek' ? 'https://chat.deepseek.com/' : 'https://chatgpt.com/';
      const cancel = details.url !== expected; if (cancel) blocked++; callback({ cancel });
    });
    isolated.protocol.handle('https', () => {
      if (platform === 'deepseek') { deepseekLoads++; if (failDeepseek) return Response.error(); }
      else chatgptLoads++;
      return new Response('<!doctype html><html><body><script>setTimeout(()=>{const p=document.createElement("p");p.textContent="Offline rendered page";document.body.append(p)},800)</script></body></html>', { headers: { 'content-type': 'text/html' } });
    });
    return new WebContentsView({ webPreferences: { session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  };
  const editor = local(), bar = local(), preview = local(), deepseek = official('deepseek');
  // 旧界面在导航前只有原生空白视图，无本地提示。
  win.contentView.addChildView(deepseek); deepseek.setBounds({ x: 0, y: 0, width: 600, height: 500 });
  await deepseek.webContents.loadURL('data:text/html,<!doctype html><html><body></body></html>');
  check('基线：未导航原生页没有加载提示正文', await deepseek.webContents.executeJavaScript('document.body?.textContent.length === 0'));
  indicator = new WebLoadingView();
  for (const view of [editor, bar, indicator.view, preview]) win.contentView.addChildView(view);
  const layout = new WorkspaceLayoutController(win, { editor, web: deepseek, webbar: bar, preview, loading: indicator.view },
    { get: () => ({ workspaceLayout: {} }), update: () => {} }, () => {});
  const handlers = new Map(); let chatgpt; const states = [];
  controller = new WebPlatformController({
    ipc: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    editor: editor.webContents, webbar: bar.webContents, deepseek,
    createChatGPT: () => { chatgpt = official('chatgpt'); win.contentView.addChildView(chatgpt, 0); return chatgpt; },
    prepareSwitch: async () => {}, applyView: view => layout.setWebView(view),
    loadingChanged: (platform, loading) => { states.push({ platform, loading }); indicator.setPlatform(platform); layout.setLoadingViewVisible(loading); },
  });
  controller.register(); await indicator.load(); layout.apply();
  const switchTo = platform => handlers.get(CHANNELS.setWebPlatform)({ sender: bar.webContents, senderFrame: bar.webContents.mainFrame }, platform);
  const read = code => indicator.view.webContents.executeJavaScript(code);
  check('初始本地提示含平台名和正在加载', await read('document.body.textContent.includes("DeepSeek") && document.body.textContent.includes("正在加载…")'));
  check('本地提示无网页/文件/工具桥', await read('typeof require === "undefined" && typeof webbarBridge === "undefined" && typeof editorBridge === "undefined"'));
  check('提示严格复用官网区域几何', JSON.stringify(indicator.view.getBounds()) === JSON.stringify(layout.layout.webBounds));
  let screenshot = 'captured';
  try { fs.writeFileSync(path.join(directory, 'loading.png'), (await indicator.view.webContents.capturePage()).toPNG()); }
  catch (error) { screenshot = `unavailable: ${error.message}`; }
  await deepseek.webContents.loadURL('https://chat.deepseek.com/');
  check('真实 did-finish-load 的 SPA 空壳仍显示提示', states.at(-1).loading && indicator.view.getVisible());
  await until(() => states.at(-1)?.loading === false);
  check('正文渲染后收起提示', !indicator.view.getVisible());
  await switchTo('chatgpt'); check('首次切平台显示对应提示', states.at(-1).platform === 'chatgpt' && states.at(-1).loading);
  await until(() => read('document.getElementById("platform").textContent === "ChatGPT"'));
  await switchTo('deepseek'); check('切回已加载平台不显示提示、不重载', !indicator.view.getVisible() && deepseekLoads === 1);
  await wait(1100); check('后台平台完成不影响前台提示状态', states.at(-1).platform === 'deepseek');
  await switchTo('chatgpt'); await until(() => !indicator.view.getVisible());
  check('切回后台已完成平台使用原视图且不重载', chatgptLoads === 1);
  await switchTo('deepseek'); failDeepseek = true; await deepseek.webContents.loadURL('https://chat.deepseek.com/').catch(() => {});
  await until(() => !!controller.state.error);
  check('失败收起提示并保留重载错误', !indicator.view.getVisible() && /ERR_/.test(controller.state.error));
  failDeepseek = false;
  await handlers.get(CHANNELS.reloadWebPlatform)({ sender: bar.webContents, senderFrame: bar.webContents.mainFrame });
  check('点击既有重载入口重新显示加载提示', indicator.view.getVisible());
  layout.update({ fileMaximized: true }, false); check('文件全屏隐藏提示', !indicator.view.getVisible());
  layout.update({ fileMaximized: false }, false); check('退出全屏恢复当前加载提示', indicator.view.getVisible());
  await until(() => !indicator.view.getVisible()); check('重载成功恢复正常页面', !controller.state.error);
  check('未请求公网资源', blocked === 0);
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ checks, total: checks.length, deepseekLoads, chatgptLoads, directory, screenshot }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, directory }));
  controller.dispose(); indicator.dispose(); win.destroy(); app.exit(0);
}).catch(error => { console.error(error); controller?.dispose(); indicator?.dispose(); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
