/** 本地离线标签布局验证，使用真实标记、样式和标签 owner，不读取项目文件。 */
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-editor-tabs-probe-'));
  const env = { ...process.env, MINI_EDITOR_TABS_PROBE_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(require('electron'), [__filename], { cwd: path.resolve(__dirname, '..'), env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error) console.error(run.error.message);
  console.log('标签布局报告：' + directory);
  process.exit(run.error ? 1 : run.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), directory = process.env.MINI_EDITOR_TABS_PROBE_DIR;
app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const toolbar = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8').match(/<header class="toolbar">[\s\S]*?<\/header>/)[0];
  const styles = ['dist/renderer/ui-tokens.css', 'src/renderer/ui.css', 'src/renderer/style.css', 'src/renderer/workspaceNavigation.css'];
  const file = path.join(directory, 'fixture.html');
  fs.writeFileSync(file, '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src file: \'unsafe-inline\'; script-src \'none\'; connect-src \'none\'">'
    + styles.map(name => '<link rel="stylesheet" href="' + pathToFileURL(path.join(root, name)).href + '">').join('')
    + '<style>.toolbar{left:0;top:0;width:100%;height:36px}</style>' + toolbar);
  const window = new BrowserWindow({ show: false, width: 1100, height: 160, useContentSize: true, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest((request, callback) => callback({ cancel: /^(https?|wss?):/.test(request.url) }));
  const execute = code => window.webContents.executeJavaScript(code);
  await window.loadFile(file);
  await execute(fs.readFileSync(path.join(root, 'src/renderer/editorTabs.js'), 'utf8'));
  await execute(`(() => {
    const longName = 'CiteVOA_Benchmarking_Evidence_Attribution_for_Trustworthy_Visual_Question_Answering_' + 'very-long-filename-'.repeat(12) + '.pdf';
    const docs = [{path:'result.md',dirty:false},{path:longName,kind:'pdf',dirty:false},{path:'view_for_Trustworthy.pdf',kind:'pdf',dirty:false}];
    const host = document.getElementById('editor-tabs');
    let owner;
    window.tabProbe = { docs, opened: [], closed: [] };
    owner = window.createEditorTabs(host, {
      open: async path => { window.tabProbe.opened.push(path); owner.render(docs,path); },
      close: path => window.tabProbe.closed.push(path), openTools() {}, closeTools() {}, openReview() {}, closeReview() {}
    });
    owner.render(docs,longName);
  })()`);
  const checks = [];
  for (const width of [240, 460, 1000]) {
    await execute(`document.querySelector('.toolbar').style.width='${width}px'`);
    await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const measurement = await execute(`(() => {
      const host = document.getElementById('editor-tabs');
      const tabs = Array.from(host.children).map(item => {
        const label=item.querySelector('.editor-tab-label'),close=item.querySelector('.editor-tab-close');
        const r=item.getBoundingClientRect(),l=label.getBoundingClientRect(),c=close.getBoundingClientRect();
        return { itemRight:r.right, labelRight:l.right, closeLeft:c.left, closeRight:c.right, closeWidth:c.width,
          truncated:label.scrollWidth>label.clientWidth, ellipsis:getComputedStyle(label).textOverflow==='ellipsis',
          title:label.title, accessible:label.getAttribute('aria-label'), text:label.textContent };
      });
      return { tabs, scrolling:host.scrollWidth>host.clientWidth, scrollbar:getComputedStyle(host).scrollbarWidth };
    })()`);
    const check = (name, pass) => checks.push({ width, name, pass: Boolean(pass) });
    check('每个标签的文件名与关闭按钮不重叠或越过本标签', measurement.tabs.every(tab => tab.labelRight <= tab.closeLeft + .5 && tab.closeRight <= tab.itemRight + .5 && tab.closeWidth > 0));
    check('超长文件名省略且保留完整悬停及可访问名称', measurement.tabs[1].truncated && measurement.tabs[1].ellipsis && measurement.tabs[1].title === measurement.tabs[1].text && measurement.tabs[1].accessible === measurement.tabs[1].text);
    check('短文件名保持完整', !measurement.tabs[0].truncated && measurement.tabs[0].text === 'result.md');
    check('横向滚动不新增常驻滚动条', measurement.scrollbar === 'none' && (width !== 240 || measurement.scrolling));
    if (width === 1000) fs.writeFileSync(path.join(directory, 'long-filename-tabs.png'), (await window.webContents.capturePage({ x: 0, y: 0, width, height: 36 })).toPNG());
  }
  await execute(`document.querySelectorAll('.editor-tab-close')[1].click();document.querySelector('.editor-tab-label').click()`);
  checks.push({ name: '独立关闭与切换只操作对应文件', pass: await execute('window.tabProbe.closed[0]===window.tabProbe.docs[1].path && window.tabProbe.opened[0]==="result.md"') });
  const report = { ok: checks.every(check => check.pass), checks };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); app.exit(report.ok ? 0 : 1);
}).catch(error => { console.error(error); app.exit(1); });
