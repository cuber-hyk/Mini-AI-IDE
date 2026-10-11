/** 原生只读诊断；仅输出结构与采集摘要，不记录正文、输入、凭据或网络接口。 */
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const { stripSelfDeclarations } = require('../dist/shared/userAgent');
app.setName('mini-ai-ide');
app.setPath('userData', path.join(app.getPath('userData'), 'probes', 'login-01'));
app.whenReady().then(async () => {
  const partition = 'persist:postcheck-experiment';
  const userAgent = stripSelfDeclarations(session.fromPartition(partition).getUserAgent(), app.getName()).effective;
  const win = new BrowserWindow({ show: false, webPreferences: { partition, userAgent, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  try {
    await win.loadURL('https://chatgpt.com/');
    await new Promise(resolve => setTimeout(resolve, 8000));
    const result = await win.webContents.executeJavaScriptInIsolatedWorld(1004, [{ code: require('./chatgpt-page-structure.cjs') }]);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally { win.destroy(); app.quit(); }
}).catch(error => { process.stderr.write(String(error) + '\n'); app.exit(1); });
