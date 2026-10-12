/** 离线原生视图与真实本地顶栏验收，不连接官网、不操作登录。 */
const { app, BaseWindow, WebContentsView, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { WebPlatformController } = require('../dist/main/webPlatformController');
const { WorkspaceLayoutController } = require('../dist/main/workspaceLayoutController');
const { createChatGPTView } = require('../dist/main/webPlatformView');
const { registerToolWorkspaceStatus } = require('../dist/main/toolWorkspaceStatus');
const { WEB_PLATFORMS } = require('../dist/shared/webPlatform');
const { CHANNELS } = require('../dist/shared/contract');
const { stripSelfDeclarations } = require('../dist/shared/userAgent');
app.setName('mini-ai-ide');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-platform-probe-'));
app.setPath('userData', directory);
let controller;
const checks = [];
function check(name, value) { assert.ok(value, name); checks.push(name); }
async function waitFor(read) {
  for (let count = 0; count < 100; count++) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('本地状态等待超时');
}
app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 1280, height: 850, show: false });
  const local = preload => new WebContentsView({ webPreferences: { ...(preload ? { preload: path.resolve('dist/main', preload) } : {}),
    partition: 'persist:editor-ui', sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const editor = local('preload.js'); const bar = local('webbarPreload.js'); const preview = local();
  const deepseek = new WebContentsView({ webPreferences: { partition: WEB_PLATFORMS.deepseek.partition, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  for (const view of [editor, bar, deepseek, preview]) win.contentView.addChildView(view);
  let saved = { workspaceLayout: {} };
  const layout = new WorkspaceLayoutController(win, { editor, web: deepseek, webbar: bar, preview },
    { get: () => saved, update: patch => { saved = { ...saved, ...patch }; } }, () => {});
  layout.register(); layout.apply();
  registerToolWorkspaceStatus({ ipc: ipcMain, webbar: bar.webContents, open: () => {} });
  ipcMain.handle(CHANNELS.collectReply, () => ({ ok: false, error: '离线夹具' }));
  let busy = false; let raceReject = false; let chatgpt;
  const errors = [];
  bar.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  session.fromPartition(WEB_PLATFORMS.chatgpt.partition).webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, reply) => reply({ cancel: true }));
  controller = new WebPlatformController({ ipc: ipcMain, editor: editor.webContents, webbar: bar.webContents, deepseek,
    createChatGPT: () => { chatgpt = createChatGPTView(); win.contentView.addChildView(chatgpt, 2); return chatgpt; },
    switchBlock: () => busy ? '工具正在执行，完成后可切换' : undefined,
    prepareSwitch: async () => { if (raceReject) { raceReject = false; busy = true; controller.refreshSwitchAvailability(); } if (busy) throw new Error('当前工具执行中'); }, applyView: view => layout.setWebView(view) });
  controller.register();
  await editor.webContents.loadURL('data:text/html,<p>Local editor fixture</p>');
  await deepseek.webContents.loadURL('data:text/html,<p>Local page fixture</p>');
  await bar.webContents.loadFile(path.resolve('dist/renderer/webbar.html'));
  const read = code => bar.webContents.executeJavaScript(code);
  await waitFor(() => read('!document.getElementById("web-platform").disabled'));
  check('默认 DeepSeek 可采集且有顶栏平台入口', await read('document.getElementById("web-platform").value === "deepseek" && !document.getElementById("btn-collect").disabled'));
  busy = true;
  controller.refreshSwitchAvailability();
  await waitFor(() => read('document.getElementById("web-platform").disabled'));
  check('执行中即时禁用，外层原因支持悬停和键盘读取', await read('document.getElementById("web-platform-control").title === "工具正在执行，完成后可切换" && document.getElementById("web-platform-control").tabIndex === 0 && document.getElementById("web-platform-hint").textContent === "工具正在执行，完成后可切换"'));
  const failure = await read('webbarBridge.setWebPlatform("chatgpt").then(() => "", e => e.message)');
  check('执行中拒绝切换并保留原平台', failure.includes('工具正在执行') && controller.state.platform === 'deepseek');
  busy = false;
  controller.refreshSwitchAvailability();
  await waitFor(() => read('!document.getElementById("web-platform").disabled'));
  raceReject = true;
  await read('document.getElementById("web-platform").value="chatgpt";document.getElementById("web-platform").dispatchEvent(new Event("change"));true');
  await waitFor(() => read('document.getElementById("collect-status").textContent === "工具正在执行，完成后可切换"'));
  check('竞态拒绝恢复选择，不向界面显示 IPC 技术异常', await read('document.getElementById("web-platform").value === "deepseek" && !document.body.textContent.includes("Error invoking remote method")'));
  await new Promise(resolve => setTimeout(resolve, 3150));
  check('三秒轻提示退出，执行仍忙时保持禁用', await read('document.getElementById("collect-status").textContent === "" && document.getElementById("web-platform").disabled'));
  busy = false; controller.refreshSwitchAvailability();
  await waitFor(() => read('!document.getElementById("web-platform").disabled'));
  await read('webbarBridge.setWebPlatform("chatgpt")');
  await waitFor(() => Boolean(controller.state.error));
  check('网络失败后可切回，错误为固定中文', controller.state.error === 'ChatGPT 页面加载失败，请手动重试或切回 DeepSeek' && !controller.state.switching);
  check('真实顶栏提供 ChatGPT 采集入口', await read('document.getElementById("web-platform").value === "chatgpt" && !document.getElementById("btn-collect").disabled'));
  check('官网独立分区且隐藏旧视图', chatgpt.webContents.session !== deepseek.webContents.session && !deepseek.getVisible() && chatgpt.getVisible());
  await chatgpt.webContents.loadURL('data:text/html,<p>Offline sandbox fixture</p>');
  const environment = await chatgpt.webContents.executeJavaScript('({ noNode: typeof require === "undefined" && typeof process === "undefined", noBridge: typeof editorBridge === "undefined" && typeof webbarBridge === "undefined", ua: navigator.userAgent })');
  const expected = stripSelfDeclarations(chatgpt.webContents.session.getUserAgent(), app.getName()).effective;
  check('官网无 Node 或本地桥，实际 UA 自洽', environment.noNode && environment.noBridge && environment.ua === expected && !/Electron\//.test(environment.ua));
  const preferences = chatgpt.webContents.getLastWebPreferences();
  check('官网无 preload 且沙箱和隔离开启', !preferences.preload && preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration);
  layout.update({ fileMaximized: true }, false);
  check('文件区全屏隐藏活动官网', !chatgpt.getVisible());
  layout.update({ fileMaximized: false }, false);
  check('恢复后只显示活动官网', chatgpt.getVisible() && !deepseek.getVisible());
  await read('webbarBridge.setWebPlatform("deepseek")');
  check('切回保留原视图且恢复采集按钮', deepseek.getVisible() && !chatgpt.getVisible() && await read('!document.getElementById("btn-collect").disabled'));
  check('编辑器只能读取平台状态', await editor.webContents.executeJavaScript('typeof editorBridge.setWebPlatform === "undefined" && typeof editorBridge.getWebPlatform === "function"'));
  check('竞态技术异常进入日志，顶栏无非预期脚本错误', errors.length === 1 && errors[0].startsWith('[web-platform] 切换失败'));
  const chatgptContents = chatgpt.webContents;
  controller.dispose();
  await waitFor(() => chatgptContents.isDestroyed());
  check('释放新增官网视图', chatgptContents.isDestroyed());
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ checks, pass: checks.length, directory }, null, 2));
  process.stdout.write(JSON.stringify({ pass: checks.length, fail: 0, report: path.join(directory, 'report.json') }) + '\n');
  app.exit(0);
}).catch(error => { controller?.dispose(); process.stderr.write(String(error.stack || error) + '\n'); app.exit(1); });
