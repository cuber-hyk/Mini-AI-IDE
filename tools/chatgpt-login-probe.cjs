/** 手动登录验证，不采集 ChatGPT 输出，不提供网页文件桥或自动化操作。 */
const { app, BaseWindow, WebContentsView, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { stripSelfDeclarations, checkUaConsistency } = require('../dist/shared/userAgent');

app.setName('mini-ai-ide');
const selfTest = process.argv.includes('--self-test');
const probeRoot = selfTest ? fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mini-login-probe-test-'))
  : path.join(app.getPath('userData'), 'probes', 'login-01');
fs.mkdirSync(probeRoot, { recursive: true });
app.setPath('userData', probeRoot);
const partition = 'persist:postcheck-experiment';
const reportPath = path.join(probeRoot, 'login-report.json');
const report = { startedAt: new Date().toISOString(), electron: process.versions.electron,
  chromium: process.versions.chrome, partition, probeRoot, login: 'awaiting-user-confirmation', events: [] };
const origin = raw => { try { return new URL(raw).origin; } catch { return 'unknown'; } };
function record(kind, details = {}) {
  report.events.push({ at: new Date().toISOString(), kind, ...details });
  report.events = report.events.slice(-100);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ kind, ...details }) + '\n');
}
function allowedPopup(raw) {
  try {
    const url = new URL(raw); const host = url.hostname;
    return url.protocol === 'https:' && (host === 'chatgpt.com' || host === 'openai.com' || host.endsWith('.openai.com') ||
      ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com'].includes(host));
  } catch { return false; }
}

app.whenReady().then(async () => {
  const ses = session.fromPartition(partition);
  const ua = stripSelfDeclarations(ses.getUserAgent(), app.getName());
  if (!checkUaConsistency(ua.effective, process.versions.chrome).ok) throw new Error('UA 与实际内核不一致');
  report.userAgent = ua.effective;
  ses.setUserAgent(ua.effective);
  const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    partition, userAgent: ua.effective };
  const window = new BaseWindow({ width: 1280, height: 900, show: !selfTest,
    title: 'Mini-AI-IDE — ChatGPT 登录验证（仅手动操作）' });
  const view = new WebContentsView({ webPreferences: preferences });
  view.webContents.setUserAgent(ua.effective);
  window.contentView.addChildView(view);
  const layout = () => { const [width, height] = window.getContentSize(); view.setBounds({ x: 0, y: 0, width, height }); };
  layout(); window.on('resize', layout);
  view.webContents.setWindowOpenHandler(({ url }) => ({ action: allowedPopup(url) ? 'allow' : 'deny',
    overrideBrowserWindowOptions: { webPreferences: preferences } }));
  view.webContents.on('did-create-window', popup => popup.webContents.setUserAgent(ua.effective));
  ses.webRequest.onErrorOccurred(details => record('network-error', { origin: origin(details.url), code: details.error, type: details.resourceType }));
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === 'mainFrame' && details.statusCode >= 400) record('http-error', { origin: origin(details.url), status: details.statusCode });
    callback({});
  });
  view.webContents.on('did-finish-load', () => record('loaded', { origin: origin(view.webContents.getURL()) }));
  view.webContents.on('did-fail-load', (_event, code, description, url, main) => {
    if (main) record('load-failed', { origin: origin(url), code, description });
  });
  window.on('closed', () => {
    if (!view.webContents.isDestroyed()) view.webContents.close();
    record('closed'); app.quit();
  });
  app.on('before-quit', () => record('exit'));
  record('ready', { reportPath });
  await view.webContents.loadURL(selfTest ? 'data:text/html,<title>Local login probe check</title><p>Offline fixture</p>' : 'https://chatgpt.com/');
  if (selfTest) {
    const checks = await view.webContents.executeJavaScript(`({ noNode: typeof require === 'undefined' && typeof process === 'undefined',
      noBridge: typeof editorBridge === 'undefined', ua: navigator.userAgent, title: document.title })`);
    record('self-test-checks', checks);
    if (!checks.noNode || !checks.noBridge || checks.ua !== ua.effective || checks.title !== 'Local login probe check') throw new Error('离线窗口隔离校验失败');
    record('self-test-pass', { noNode: checks.noNode, noBridge: checks.noBridge, uaMatches: true });
    app.exit(0);
  }
}).catch(error => { record('startup-error', { code: error.code || error.name }); process.exitCode = 1; if (selfTest) app.exit(1); });
app.on('window-all-closed', () => app.quit());
