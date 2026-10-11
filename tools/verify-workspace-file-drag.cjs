/** 原生 Electron 本地拖拽 IPC 验收；捕获 startDrag 参数，不执行真实系统拖拽。 */
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const JSZip = createRequire(require.resolve('docx-preview'))('jszip');

const directory = fsSync.mkdtempSync(path.join(os.tmpdir(), 'mini-workspace-file-drag-probe-'));
app.setPath('userData', path.join(directory, 'user-data'));
app.disableHardwareAcceleration();
const checks = []; const dragCalls = []; const networkRequests = []; const rendererErrors = [];
const limitations = ['直接 IPC 验收不证明物理拖拽手势或 DeepSeek 接收附件；startDrag 仅捕获参数，未执行系统拖拽。'];
let finished = false;
const deadline = setTimeout(() => finish(new Error('目录树文件拖拽离线验收超过 30 秒')), 30_000);

function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  console.log(JSON.stringify({ ok: !error, checks, dragCalls, networkRequests, rendererErrors, limitations, directory, error: error && String(error.stack || error) }, null, 2));
  app.exit(error ? 1 : 0);
}
function check(name, pass, observed) {
  const item = { name, pass: Boolean(pass) }; if (observed !== undefined) item.observed = observed;
  checks.push(item); if (!pass) throw new Error(name);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

app.whenReady().then(async () => {
  const { FileService } = require('../dist/main/fileService');
  const { registerWorkspaceFileDrag } = require('../dist/main/workspaceFileDrag');
  const root = path.join(directory, 'project'); const outside = path.join(directory, 'outside.txt');
  await fs.mkdir(root); await fs.mkdir(path.join(root, 'folder'));
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>local fixture</w:t></w:r></w:p></w:body></w:document>');
  const png = nativeImage.createFromBitmap(Buffer.from([80, 150, 220, 255]), { width: 1, height: 1 }).toPNG();
  const fixtures = new Map([
    ['note.txt', Buffer.from('本地纯文本附件\n')], ['notes.md', Buffer.from('# 本地 Markdown\n')], ['image.png', png],
    ['document.pdf', Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF')],
    ['document.docx', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })],
  ]);
  for (const [name, bytes] of fixtures) await fs.writeFile(path.join(root, name), bytes);
  await fs.writeFile(outside, 'outside project');
  const original = new Map(Array.from(fixtures, ([name, bytes]) => [name, hash(bytes)]));
  const page = path.join(directory, 'fixture.html');
  await fs.writeFile(page, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'"></head><body>仅用于本地目录树文件拖拽 IPC 验收</body></html>');
  const settings = { show: false, width: 480, height: 320, webPreferences: { preload: path.resolve(__dirname, '../dist/main/preload.js'), sandbox: true, nodeIntegration: false, contextIsolation: true, offscreen: true } };
  const editor = new BrowserWindow(settings);
  const foreign = new BrowserWindow(settings);
  for (const window of [editor, foreign]) {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
    window.webContents.on('render-process-gone', (_event, details) => finish(new Error('渲染进程退出：' + details.reason)));
  }
  editor.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, reply) => { networkRequests.push(details.url); reply({ cancel: true }); });
  const files = new FileService(); files.setRoot(root);
  // 仅替换当前隐藏 fixture 的运输端，绝不调用原生 startDrag 或模拟用户输入。
  editor.webContents.startDrag = item => {
    dragCalls.push({ file: item.file, iconEmpty: item.icon.isEmpty(), iconSize: item.icon.getSize() });
  };
  const iconRequests = [];
  const channels = registerWorkspaceFileDrag(ipcMain, editor.webContents, files, async absolute => {
    iconRequests.push(absolute); return app.getFileIcon(absolute, { size: 'small' });
  });
  check('真实主进程拖拽 owner 注册单一频道', channels.length === 1 && channels[0] === 'fs:start-workspace-file-drag');
  await Promise.all([editor.loadFile(page), foreign.loadFile(page)]);
  const evaluate = (window, code) => window.webContents.executeJavaScript(code, true);
  check('实际 preload 提供窄拖拽入口且不暴露 Node', await evaluate(editor, "typeof window.editorBridge.startWorkspaceFileDrag === 'function' && typeof window.require === 'undefined' && typeof window.process === 'undefined'"));
  const invoke = (window, relative, expectedRoot = root) => evaluate(window, `window.editorBridge.startWorkspaceFileDrag(${JSON.stringify(relative)},${JSON.stringify(expectedRoot)})`);
  for (const [name, bytes] of fixtures) {
    const before = dragCalls.length; const result = await invoke(editor, name);
    const call = dragCalls[before]; const actual = await fs.realpath(path.join(root, name));
    check(name + ' 将实际本地路径和非空系统图标交给原生运输一次', result.ok === true && dragCalls.length === before + 1 && call.file === actual && call.iconEmpty === false && call.iconSize.width > 0 && call.iconSize.height > 0, { result, call });
    check(name + ' 拖拽不会改变附件字节', hash(await fs.readFile(path.join(root, name))) === original.get(name) && hash(bytes) === original.get(name));
  }
  const accepted = dragCalls.length;
  for (const [label, relative, expectedRoot] of [
    ['文件夹', 'folder', root], ['项目外相对路径', '../outside.txt', root], ['项目外绝对路径', outside, root],
    ['项目内绝对路径', path.join(root, 'note.txt'), root], ['过期根目录', 'note.txt', root + '-old'],
    ['空路径', '', root], ['缺失文件', 'missing.txt', root], ['非法路径类型', 42, root],
  ]) {
    const result = await invoke(editor, relative, expectedRoot);
    check(label + ' 请求拒绝且不调用 startDrag', result.ok === false && dragCalls.length === accepted, result);
  }
  const requestsBeforeForeign = iconRequests.length;
  const foreignResult = await invoke(foreign, 'note.txt');
  check('另一个 WebContents 即使使用相同 preload 也不能发起拖拽', foreignResult.ok === false && dragCalls.length === accepted && iconRequests.length === requestsBeforeForeign, foreignResult);
  files.clearRoot(); const stale = await invoke(editor, 'note.txt');
  check('项目关闭后无法继续拖拽旧项目文件', stale.ok === false && dragCalls.length === accepted, stale);
  check('全部已成功运输的文件内容仍保持原字节', (await Promise.all(Array.from(original, async ([name, digest]) => hash(await fs.readFile(path.join(root, name))) === digest))).every(Boolean));
  check('验收未连接官网或其他 HTTP 服务', networkRequests.length === 0);
  check('真实 preload 与本地页面没有渲染错误', rendererErrors.length === 0);
  finish();
}).catch(finish);
