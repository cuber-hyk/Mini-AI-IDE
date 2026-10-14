/** 首次加载恢复离线验证：真实 Electron 导航事件与原生 reload，不访问公网或已有用户分区。 */
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-deepseek-startup-probe-'));
  const env = { ...process.env, MINI_DEEPSEEK_STARTUP_PROBE_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(require('electron'), [__filename], {
    cwd: path.resolve(__dirname, '..'), env, windowsHide: true, encoding: 'utf8', timeout: 35000,
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error) console.error(run.error.message);
  console.log('首次加载验证报告：' + directory);
  process.exit(run.error ? 1 : run.status ?? 1);
}

const { app, BrowserWindow, WebContentsView, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..'), directory = process.env.MINI_DEEPSEEK_STARTUP_PROBE_DIR;
const { WebPlatformController } = require(path.join(root, 'dist/main/webPlatformController.js'));
const { WEB_PLATFORMS } = require(path.join(root, 'dist/shared/webPlatform.js'));
const { CHANNELS } = require(path.join(root, 'dist/shared/contract.js'));
app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], scenarios = [];
const check = (scenario, name, pass) => checks.push({ scenario, name, pass: Boolean(pass) });
const save = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ ok: false, checks, scenarios }, null, 2));
const deadline = setTimeout(() => { save(); console.error('首次加载离线验证总超时'); app.exit(1); }, 30000);

async function fixture(name, response) {
  const network = session.fromPartition('startup-probe-' + name);
  // 失败关闭：即使协议拦截意外失效，实际 HTTP 出口也只指向不可用的本机端口。
  await network.setProxy({ mode: 'fixed_servers', proxyRules: 'http=127.0.0.1:9;https=127.0.0.1:9', proxyBypassRules: '<-loopback>' });
  const events = [], requests = [], states = [], loading = [], handlers = new Map();
  // 当前隔离分区所有 HTTPS 均由本地回调完成；没有真实官网 HTTP 请求。
  const registered = network.protocol.interceptBufferProtocol('https', (request, callback) => {
    const entry = { url: request.url, at: Date.now() }; requests.push(entry);
    if (request.url === WEB_PLATFORMS.deepseek.url) {
      const attempt = requests.filter(item => item.url === WEB_PLATFORMS.deepseek.url).length;
      if (response(attempt) === 'fail') { callback({ error: -100 }); return; }
    } else if (request.url !== WEB_PLATFORMS.chatgpt.url && request.url !== 'https://chat.deepseek.com/other') {
      callback({ error: -2 }); return;
    }
    callback({ mimeType: 'text/html', data: Buffer.from('<!doctype html><main>本地离线导航内容</main>') });
  });
  if (!registered) throw new Error('隔离分区 HTTPS 本地响应注册失败，未发起导航');
  const window = new BrowserWindow({ show: false, width: 600, height: 300,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const makeView = () => new WebContentsView({ webPreferences: {
    session: network, sandbox: true, nodeIntegration: false, contextIsolation: true,
  } });
  const view = makeView(), web = view.webContents;
  window.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 600, height: 300 });
  let reloads = 0, block;
  const reload = web.reload.bind(web);
  web.reload = () => { reloads++; events.push({ name: 'native-reload', url: web.getURL(), at: Date.now() }); reload(); };
  web.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame) events.push({ name: 'did-fail-load', code, description, url, currentURL: web.getURL(), at: Date.now() });
  });
  web.on('did-start-navigation', (_event, url, _inPlace, mainFrame) => {
    if (mainFrame) events.push({ name: 'did-start-navigation', url, at: Date.now() });
  });
  web.on('did-finish-load', () => events.push({ name: 'did-finish-load', url: web.getURL(), at: Date.now() }));
  web.on('did-stop-loading', () => events.push({ name: 'did-stop-loading', url: web.getURL(), at: Date.now() }));
  // 仅替代本地状态接收者，官网 view/加载/读取与重载均为真实 Electron 对象。
  const owner = { mainFrame: { send: (_channel, state) => states.push({ ...state, at: Date.now() }) }, isDestroyed: () => false };
  const controller = new WebPlatformController({
    ipc: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    webbar: owner, editor: owner, deepseek: view, createChatGPT: makeView,
    prepareSwitch: async () => {}, applyView: () => {}, switchBlock: () => block,
    loadingChanged: (platform, value) => loading.push({ platform, loading: value, at: Date.now() }),
  });
  controller.register();
  const result = { name, events, requests, states, loading }; scenarios.push(result);
  console.log('离线场景：' + name);
  return {
    controller, web, view, events, states, loading, requests,
    reloads: () => reloads,
    attempts: () => requests.filter(item => item.url === WEB_PLATFORMS.deepseek.url).length,
    setBlock: value => { block = value; controller.refreshSwitchAvailability(); },
    switchTo: platform => handlers.get(CHANNELS.setWebPlatform)({ sender: owner, senderFrame: owner.mainFrame }, platform),
    close: () => {
      result.finalState = controller.state; result.reloads = reloads;
      controller.dispose(); if (!web.isDestroyed()) web.close(); if (!window.isDestroyed()) window.destroy();
    },
  };
}

app.whenReady().then(async () => {
  const successfulRecovery = await fixture('failure-then-success', attempt => attempt === 1 ? 'fail' : 'success');
  await successfulRecovery.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url);
  await sleep(1800);
  const firstFailure = successfulRecovery.events.find(event => event.name === 'did-fail-load');
  const retry = successfulRecovery.events.find(event => event.name === 'native-reload');
  check('failure-then-success', '真实主 frame 连接关闭错误 -100', firstFailure?.code === -100 && firstFailure.description === 'ERR_CONNECTION_CLOSED');
  check('failure-then-success', '约 1 秒后一次原生重载且请求总数为 2', retry && retry.at - firstFailure.at >= 900 && retry.at - firstFailure.at < 1600 && successfulRecovery.reloads() === 1 && successfulRecovery.attempts() === 2);
  check('failure-then-success', '恢复保持原 view 和官方 URL，成功后清除错误与重载状态', successfulRecovery.controller.getView('deepseek') === successfulRecovery.view && successfulRecovery.web.getURL() === WEB_PLATFORMS.deepseek.url && !successfulRecovery.controller.state.error && !successfulRecovery.controller.state.reloading);
  check('failure-then-success', '等待期间保留真实错误与重载状态，正文加载标记覆盖等待', successfulRecovery.states.some(state => state.error?.includes('ERR_CONNECTION_CLOSED') && state.reloading) && successfulRecovery.loading.some(item => item.loading && item.at >= firstFailure?.at) && successfulRecovery.loading.at(-1)?.loading === false);
  successfulRecovery.close();

  const twiceFailed = await fixture('two-failures', () => 'fail');
  await twiceFailed.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url); await sleep(2400);
  check('two-failures', '二次真实失败后不进行第三次请求', twiceFailed.attempts() === 2 && twiceFailed.reloads() === 1 && twiceFailed.events.filter(event => event.name === 'did-fail-load' && event.code === -100).length === 2);
  check('two-failures', '终止恢复保留真实错误和手动重载状态', twiceFailed.controller.state.error?.includes('ERR_CONNECTION_CLOSED') && !twiceFailed.controller.state.reloading && twiceFailed.loading.at(-1)?.loading === false);
  twiceFailed.close();

  const laterFailure = await fixture('success-then-later-failure', attempt => attempt === 1 ? 'success' : 'fail');
  await laterFailure.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url);
  await laterFailure.web.loadURL(WEB_PLATFORMS.deepseek.url).catch(() => {}); await sleep(1500);
  check('success-then-later-failure', '首次成功后的后续失败不自动恢复', laterFailure.attempts() === 2 && laterFailure.reloads() === 0 && laterFailure.controller.state.error?.includes('ERR_CONNECTION_CLOSED'));
  laterFailure.close();

  const switched = await fixture('switch-cancels', () => 'fail');
  await switched.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url); await switched.switchTo('chatgpt'); await sleep(1500);
  check('switch-cancels', '切换平台取消延迟恢复，不发第二次 DeepSeek 请求', switched.controller.state.platform === 'chatgpt' && switched.attempts() === 1 && switched.reloads() === 0);
  switched.close();

  const navigated = await fixture('navigation-cancels', () => 'fail');
  await navigated.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url);
  await navigated.web.loadURL('https://chat.deepseek.com/other'); await sleep(1500);
  check('navigation-cancels', '新的主 frame 导航取消延迟恢复', navigated.attempts() === 1 && navigated.reloads() === 0 && navigated.web.getURL() === 'https://chat.deepseek.com/other');
  navigated.close();

  const blocked = await fixture('busy-cancels', () => 'fail');
  await blocked.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url); blocked.setBlock('工具正在执行，请稍后切换'); await sleep(1500);
  check('busy-cancels', '等待期间进入忙状态阻止重载并保留失败状态', blocked.attempts() === 1 && blocked.reloads() === 0 && blocked.controller.state.error && !blocked.controller.state.reloading && blocked.loading.at(-1)?.loading === false);
  blocked.close();

  const disposed = await fixture('dispose-cancels', () => 'fail');
  await disposed.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url); disposed.close(); await sleep(1500);
  check('dispose-cancels', '关闭 owner 和视图取消延迟恢复', disposed.attempts() === 1 && disposed.reloads() === 0);

  const report = { ok: checks.every(item => item.pass), checks, scenarios };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, checks }, null, 2)); clearTimeout(deadline); app.exit(report.ok ? 0 : 1);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
