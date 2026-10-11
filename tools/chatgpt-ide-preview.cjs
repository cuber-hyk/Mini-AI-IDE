/** 完整 IDE 手动验收：固定独立用户数据，避免与正在运行的安装版共享 profile。 */
const { app, BaseWindow, webContents, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setName('mini-ai-ide');
const directory = path.join(app.getPath('userData'), 'probes', 'ide-01');
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
app.on('second-instance', () => { const win = BaseWindow.getAllWindows()[0]; if (win) { win.show(); win.focus(); } });
// BaseWindow 关闭不会销毁所属 WebContentsView，验证进程不能留下 profile 锁。
let closingViews = false;
app.on('before-quit', async () => {
  if (closingViews || BaseWindow.getAllWindows().length) return;
  closingViews = true;
  const contents = webContents.getAllWebContents().filter(web => !web.isDestroyed());
  const sessions = new Set([...contents.map(web => web.session), ...['persist:postcheck', 'persist:postcheck-02'].map(partition => session.fromPartition(partition))]);
  await Promise.allSettled([...sessions].map(s => s.cookies.flushStore()));
  for (const web of contents) if (!web.isDestroyed()) web.close();
});
process.stdout.write('[preview] 独立 IDE 数据目录：' + directory + '\n');
// 按需只读诊断：不记录正文、草稿、会话 ID 或凭据，不向网页提供桥。
if (process.env.MINI_CHATGPT_STRUCTURE_TRACE === '1') {
  const snapshots = new Map();
  let reading = false;
  const timer = setInterval(async () => {
    if (reading || !app.isReady()) return;
    reading = true;
    try {
      for (const web of webContents.getAllWebContents()) {
        if (web.isDestroyed() || !web.getURL().startsWith('https://chatgpt.com/')) continue;
        const source = require.resolve('./chatgpt-page-structure.cjs');
        delete require.cache[source];
        const snapshot = JSON.stringify(await web.executeJavaScriptInIsolatedWorld(1004, [{ code: require(source) }]));
        if (snapshots.get(web.id) === snapshot) continue;
        snapshots.set(web.id, snapshot);
        fs.writeFileSync(path.join(app.getPath('temp'), 'mini-chatgpt-structure.json'), snapshot, 'utf8');
        const state = JSON.parse(snapshot);
        process.stdout.write('[chatgpt-structure] ' + JSON.stringify({ replies: state?.replies?.length, composers: state?.composers?.length }) + '\n');
      }
    } catch { process.stdout.write('[chatgpt-structure] snapshot unavailable\n'); }
    finally { reading = false; }
  }, 1500);
  app.on('will-quit', () => clearInterval(timer));
}
require('../dist/main/index');
}
