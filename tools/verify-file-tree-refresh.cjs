/** 原生离线文件树验证：真实树脚本与 CSS，目录数据仅来自内存。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const option = (name, fallback) => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3) ?? fallback;

if (!process.versions.electron) {
  const { spawn, spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-file-tree-refresh-'));
  const reportPath = path.join(profile, 'report.json');
  const output = option('output', path.join(os.tmpdir(), 'mini-file-tree-' + option('mode', 'verify') + '.json'));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2), '--profile=' + profile, '--report=' + reportPath], { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => { if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }, 60000);
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('close', code => {
    clearTimeout(timer);
    let report;
    try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { report = { pass: false, stdout, stderr }; }
    report.exitCode = code; fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, pass: report.pass && code === 0, checks: report.checks?.length, measurements: report.measurements }));
    const resolved = path.resolve(profile);
    if (path.dirname(resolved).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(resolved).startsWith('mini-file-tree-refresh-')) throw new Error('拒绝清理非本次夹具目录');
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch (error) { console.error('临时目录清理失败：' + error.message); process.exitCode = 1; }
    if (!report.pass || code !== 0) process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const profile = option('profile'); app.setPath('userData', profile);
  const source = option('source-root', path.resolve(__dirname, '..', 'src', 'renderer'));
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    const externalRequests = [];
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { externalRequests.push(details.url); callback({ cancel: true }); });
    const fixture = path.join(profile, 'tree.html');
    const styles = [path.resolve(__dirname, '../dist/renderer/ui-tokens.css'), ...['ui.css', 'style.css', 'fileExplorer.css'].map(name => path.join(source, name))].map(file => '<link rel="stylesheet" href="' + pathToFileURL(file).href + '">').join('');
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8">' + styles + '<style>body{margin:0;display:block}.tree-scroll{height:280px;overflow:auto;width:600px}#editor{display:none}</style><script src="' + pathToFileURL(path.join(source, 'fileIcons.js')).href + '"></script><script src="' + pathToFileURL(path.join(source, 'fileExplorer.js')).href + '"></script>');
    try {
      await window.loadFile(fixture);
      window.show(); window.focus();
      const report = await window.webContents.executeJavaScript('(' + runFixture.toString() + ')(' + JSON.stringify(option('mode', 'verify')) + ')');
      if (option('screenshot')) { await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); fs.writeFileSync(option('screenshot'), (await window.webContents.capturePage()).toPNG()); }
      report.source = path.resolve(source); report.scope = 'offline-native-dom-memory-directory'; report.externalRequests = externalRequests;
      report.sourceSha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(source, 'fileExplorer.js'))).digest('hex');
      report.runtime = { electron: process.versions.electron, chromium: process.versions.chrome };
      report.pass = report.pass && externalRequests.length === 0;
      fs.writeFileSync(option('report'), JSON.stringify(report, null, 2)); app.exit(report.pass ? 0 : 1);
    } catch (error) { fs.writeFileSync(option('report'), JSON.stringify({ pass: false, error: error.stack || String(error) })); app.exit(1); }
  });
}

async function runFixture(mode) {
  const checks = []; const measurements = [];
  const check = (name, pass, observed) => checks.push({ name, pass: Boolean(pass), observed });
  const delay = time => new Promise(resolve => setTimeout(resolve, time));
  async function fixture() {
    document.body.innerHTML = '<button id="new-file">new</button><button id="new-folder">folder</button><button id="refresh">refresh</button><input id="outside"><div class="tree-scroll"><ul id="tree" class="tree"></ul></div><div id="welcome"></div><div id="editor"></div>';
    const tree = document.getElementById('tree'); const scroll = tree.parentNode;
    let root = 'A'; let pending = 0; const calls = []; const waiting = []; const info = []; const renames = []; const opened = [];
    const directories = new Map(); const truncated = new Set(); const failures = new Set();
    const entry = (relPath, isDirectory = false) => ({ relPath, name: relPath.split('/').pop(), isDirectory });
    directories.set('', ['a', 'b', 'c', 'd'].map(name => entry(name, true)));
    for (const name of ['a', 'b', 'c', 'd']) directories.set(name, Array.from({ length: 100 }, (_, index) => entry(name + '/file-' + String(index).padStart(3, '0') + '.txt')));
    const bridge = { async listDir(parent) {
      calls.push(parent); pending++;
      const result = failures.has(parent) ? { ok: false, error: 'fixture directory failure' } : { ok: true, entries: (directories.get(parent) || []).map(value => ({ ...value })), truncated: truncated.has(parent) };
      const gate = waiting.find(value => value.parent === parent && !value.used);
      if (gate) { gate.used = true; await gate.promise; }
      pending--; return result;
    }, startWorkspaceFileDrag: async () => ({ ok: true }),
    async createEntry(parent, name, isDirectory) { const relPath = parent ? parent + '/' + name : name; directories.get(parent).push(entry(relPath, isDirectory)); if (isDirectory) directories.set(relPath, []); return { ok: true, relPath, isDirectory }; },
    async renameEntry(oldRelPath, name) { renames.push([oldRelPath, name]); const parent = oldRelPath.split('/').slice(0, -1).join('/'); const relPath = parent ? parent + '/' + name : name; if (directories.get(parent).some(value => value.relPath === relPath)) return { ok: false, error: '目标名称已存在，不能覆盖' }; const old = directories.get(parent).find(value => value.relPath === oldRelPath); directories.set(parent, directories.get(parent).map(value => value.relPath === oldRelPath ? entry(relPath, old.isDirectory) : value)); void explorer.entryChanged({ kind: 'renamed', oldRelPath, relPath, isDirectory: old.isDirectory }); return { ok: true }; },
    async trashEntry(oldRelPath) { const parent = oldRelPath.split('/').slice(0, -1).join('/'); directories.set(parent, directories.get(parent).filter(value => value.relPath !== oldRelPath)); void explorer.entryChanged({ kind: 'deleted', oldRelPath, isDirectory: false }); return { ok: true }; }
    };
    const explorer = window.createFileExplorer({ bridge, tree, getRoot: () => root, setInfo: (...args) => info.push(args), openFile: async path => { opened.push(path); return true; }, currentPath: () => null, newFile: document.getElementById('new-file'), newFolder: document.getElementById('new-folder'), refresh: document.getElementById('refresh'), welcome: document.getElementById('welcome'), editor: document.getElementById('editor') });
    const row = name => Array.from(tree.querySelectorAll('.tree-row')).find(value => value.dataset.relPath === name);
    const settle = async () => { for (let index = 0; index < 200; index++) { await delay(5); if (!pending) { await delay(10); if (!pending) return; } } throw new Error('目录读取未结束'); };
    const toggle = async name => { row(name).click(); await settle(); };
    const gate = parent => { let release; const promise = new Promise(resolve => { release = resolve; }); const value = { parent, promise, release, used: false }; waiting.push(value); return value; };
    await explorer.refresh(true);
    for (const name of ['a', 'b', 'c', 'd']) await toggle(name);
    calls.length = 0;
    return { tree, scroll, explorer, calls, directories, truncated, failures, info, entry, row, settle, toggle, gate, renames, opened, setRoot: value => { root = value; } };
  }
  for (const operation of ['create', 'delete', 'rename']) {
    const f = await fixture(); const keep = f.row('c/file-040.txt'); keep.focus(); f.scroll.scrollTop = 420; const scrollBefore = f.scroll.scrollTop;
    const selectedBefore = f.tree.querySelector('.tree-row.active')?.dataset.relPath;
    const anchor = Array.from(f.tree.querySelectorAll('.tree-row')).find(row => row.getBoundingClientRect().top >= f.scroll.getBoundingClientRect().top);
    const anchorTopBefore = anchor.getBoundingClientRect().top - f.scroll.getBoundingClientRect().top;
    const existing = new Set(f.tree.querySelectorAll('*')); const added = new Set();
    const observer = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) { if (!existing.has(node)) added.add(node); for (const child of node.querySelectorAll('*')) if (!existing.has(child)) added.add(child); } });
    observer.observe(f.tree, { childList: true, subtree: true });
    const entries = f.directories.get('a'); let changedPath = 'a/new.txt';
    if (operation === 'create') entries.push(f.entry(changedPath));
    if (operation === 'delete') { changedPath = entries[10].relPath; entries.splice(10, 1); }
    if (operation === 'rename') { changedPath = entries[10].relPath; entries[10] = f.entry('a/renamed.txt'); }
    const started = performance.now(); await f.explorer.refresh(false, changedPath); await f.settle(); observer.disconnect();
    const measurement = { operation, branches: 4, filesPerBranch: 100, listDirCalls: f.calls.slice(), createdElements: added.size, elapsedMs: performance.now() - started, stableOtherNode: keep === f.row('c/file-040.txt'), focusPreserved: document.activeElement === keep, selectionPreserved: selectedBefore === f.tree.querySelector('.tree-row.active')?.dataset.relPath, scrollBefore, scrollAfter: f.scroll.scrollTop, anchorTopBefore, anchorTopAfter: anchor.getBoundingClientRect().top - f.scroll.getBoundingClientRect().top };
    measurements.push(measurement);
    check(operation + ' 数据确实更新', operation === 'create' ? Boolean(f.row('a/new.txt')) : operation === 'delete' ? !f.row(changedPath) : Boolean(f.row('a/renamed.txt')) && !f.row(changedPath));
    if (mode !== 'measure') {
      check(operation + ' 仅读取受影响父目录', JSON.stringify(f.calls) === '["a"]', f.calls);
      check(operation + ' 未变化节点和选择焦点可见滚动锚点保留', measurement.stableOtherNode && measurement.focusPreserved && measurement.selectionPreserved && Math.abs(measurement.anchorTopBefore - measurement.anchorTopAfter) < 1, measurement);
      check(operation + ' 只创建单项所需节点', added.size <= 12, added.size);
    }
  }
  if (mode !== 'measure') {
    let f = await fixture(); const stable = f.row('b/file-020.txt'); f.directories.get('d').push(f.entry('d/external.txt')); await f.explorer.refresh(false);
    check('手动刷新重读根和全部展开分支并发现外部文件', ['', 'a', 'b', 'c', 'd'].every(name => f.calls.includes(name)) && Boolean(f.row('d/external.txt')), f.calls);
    check('手动刷新保留稳定行', f.row('b/file-020.txt') === stable);
    f.calls.length = 0; f.truncated.add('a'); await f.explorer.refresh(false, 'a/file-000.txt');
    check('局部刷新保留截断提示', f.row('a').parentNode.querySelector('.tree-empty')?.textContent.includes('500'));
    f.truncated.delete('a'); await f.explorer.refresh(false, 'a/file-000.txt');
    check('截断消失时移除提示', !f.row('a').parentNode.querySelector('.tree-empty'));
    f = await fixture(); await f.toggle('a'); f.calls.length = 0; f.directories.get('a').push(f.entry('a/closed.txt')); await f.explorer.refresh(false, 'a/closed.txt');
    check('折叠目录变化只核查可见祖先', !f.calls.includes('a') && f.row('a').getAttribute('aria-expanded') === 'false', f.calls);
    await f.toggle('a'); check('再次展开读取折叠期间的新文件', Boolean(f.row('a/closed.txt')));
    f = await fixture(); f.directories.set('', f.directories.get('').map(value => value.relPath === 'a' ? f.entry('a', false) : value)); await f.explorer.refresh(false, 'a');
    check('同路径目录变文件移除旧子树', f.row('a').parentNode.classList.contains('tree-file') && !f.row('a/file-000.txt') && f.row('a').draggable);
    f = await fixture(); const beforeFailure = f.row('a/file-000.txt'); f.failures.add('a'); await f.explorer.refresh(false, 'a/file-000.txt');
    check('目录读取失败明确反馈并保留已有内容', f.row('a/file-000.txt') === beforeFailure && f.info.some(value => value[0] === 'fixture directory failure' && value[1]));
    f = await fixture(); f.failures.add('a'); f.directories.get('b').push(f.entry('b/after-failure.txt')); await f.explorer.refresh(false);
    check('手动刷新单个分支失败仍继续其余展开分支', Boolean(f.row('a/file-000.txt')) && Boolean(f.row('b/after-failure.txt')) && ['a', 'b', 'c', 'd'].every(name => f.calls.includes(name)) && f.info.some(value => value[0] === 'fixture directory failure' && value[1]), f.calls);
    f = await fixture(); f.directories.get('a').push(f.entry('a/new-sub', true)); f.directories.set('a/new-sub', [f.entry('a/new-sub/new.txt')]); await f.explorer.refresh(false, 'a/new-sub/new.txt');
    check('未知嵌套路径核查最近已显示父目录而不虚构展开', JSON.stringify(f.calls) === '["a"]' && Boolean(f.row('a/new-sub')) && !f.row('a/new-sub/new.txt'), f.calls);
    f = await fixture(); const first = f.gate('a'); f.directories.get('a').push(f.entry('a/stale.txt')); const old = f.explorer.refresh(false, 'a/stale.txt'); await delay(10); f.directories.set('a', [f.entry('a/current.txt')]); await f.explorer.refresh(false, 'a/current.txt'); first.release(); await old;
    check('同目录迟到结果不得覆盖新结果', Boolean(f.row('a/current.txt')) && !f.row('a/stale.txt'));
    f = await fixture(); const a = f.gate('a'); f.directories.get('a').push(f.entry('a/parallel.txt')); const pa = f.explorer.refresh(false, 'a/parallel.txt'); await delay(10); f.directories.get('b').push(f.entry('b/parallel.txt')); await f.explorer.refresh(false, 'b/parallel.txt'); a.release(); await pa;
    check('不同父目录并发互不取消', Boolean(f.row('a/parallel.txt')) && Boolean(f.row('b/parallel.txt')));
    f = await fixture(); const closing = f.gate('a'); f.directories.get('a').push(f.entry('a/late.txt')); const pc = f.explorer.refresh(false, 'a/late.txt'); await delay(10); f.row('a').click(); closing.release(); await pc; await f.settle();
    check('读取期间折叠目录不得重新展开', f.row('a').getAttribute('aria-expanded') === 'false' && f.row('a').parentNode.querySelector('.tree-children').hidden);
    f = await fixture(); const reopen = f.gate('a'); const po = f.explorer.refresh(false, 'a/file-000.txt'); await delay(10); f.row('a').click(); f.directories.set('a', [f.entry('a/reopened.txt')]); f.row('a').click(); await delay(10); reopen.release(); await po; await f.settle();
    check('关闭再打开后旧读取不能覆盖新展开内容', Boolean(f.row('a/reopened.txt')) && !f.row('a/file-000.txt') && f.row('a').getAttribute('aria-expanded') === 'true');
    f = await fixture(); const focus = f.gate('a'); const pf = f.explorer.refresh(false, 'a/file-000.txt'); await delay(10); document.getElementById('outside').focus(); focus.release(); await pf;
    check('等待期间转入其他控件的焦点不会被抢回', document.activeElement === document.getElementById('outside'));
    f = await fixture(); const scrolling = f.gate('a'); const ps = f.explorer.refresh(false, 'a/file-000.txt'); await delay(10); f.scroll.scrollTop = 750; scrolling.release(); await ps; await f.settle();
    check('等待期间用户新滚动位置不被旧快照覆盖', f.scroll.scrollTop === 750, f.scroll.scrollTop);
    f = await fixture(); const fullGate = f.gate('a'); const full = f.explorer.refresh(false); await delay(10); f.directories.set('a', [f.entry('a/newest.txt')]); await f.explorer.refresh(false, 'a/newest.txt'); fullGate.release(); await full; await f.settle();
    check('手动刷新被同父局部请求取代后不续派旧展开分支', Boolean(f.row('a/newest.txt')) && !f.calls.includes('b') && !f.calls.includes('c') && !f.calls.includes('d'), f.calls);
    f = await fixture(); const project = f.gate('a'); const pp = f.explorer.refresh(false, 'a/file-000.txt'); await delay(10); f.setRoot('B'); f.directories.set('', [f.entry('project-b.txt')]); await f.explorer.refresh(true); project.release(); await pp;
    check('切项目拒绝旧目录返回', Boolean(f.row('project-b.txt')) && !f.row('a'));
    f = await fixture(); const revisit = f.gate('a'); const pret = f.explorer.refresh(false, 'a/file-000.txt'); await delay(10); f.setRoot('B'); f.directories.set('', [f.entry('b-only.txt')]); await f.explorer.refresh(true); f.setRoot('A'); f.directories.set('', [f.entry('a-current.txt')]); await f.explorer.refresh(true); revisit.release(); await pret;
    check('A到B再到A也拒绝旧代次结果', Boolean(f.row('a-current.txt')) && !f.row('a') && !f.row('b-only.txt'));
    f = await fixture(); const removed = f.gate('a'); const pr = f.explorer.refresh(false, 'a/file-000.txt'); await delay(10); f.directories.set('', f.directories.get('').filter(value => value.relPath !== 'a')); await f.explorer.entryChanged({ kind: 'deleted', oldRelPath: 'a', isDirectory: true }); removed.release(); await pr; await f.settle();
    check('已删除目录的旧读取不复活子树', !f.row('a') && !f.row('a/file-000.txt'));
    f = await fixture(); const renamed = f.gate('a'); const pn = f.explorer.refresh(false, 'a/file-000.txt'); await delay(10); f.directories.set('', f.directories.get('').map(value => value.relPath === 'a' ? f.entry('renamed-a', true) : value)); f.directories.set('renamed-a', [f.entry('renamed-a/kept.txt')]); await f.explorer.entryChanged({ kind: 'renamed', oldRelPath: 'a', relPath: 'renamed-a', isDirectory: true }); renamed.release(); await pn; await f.settle();
    check('目录改名迁移展开且旧读取不复活旧路径', !f.row('a') && Boolean(f.row('renamed-a/kept.txt')));
    f = await fixture(); await f.toggle('a'); f.calls.length = 0; document.getElementById('new-folder').click(); await f.settle();
    const folderInput = f.tree.querySelector('.tree-name-input'); folderInput.value = 'created-folder'; f.calls.length = 0; folderInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await f.settle();
    check('闭合父目录中新建文件夹只读父目录及新文件夹', JSON.stringify(f.calls) === '["a","a/created-folder"]' && Boolean(f.row('a/created-folder')) && f.row('a/created-folder').getAttribute('aria-expanded') === 'true', f.calls);
    f = await fixture(); f.row('a/file-000.txt').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    const renameInput = f.tree.querySelector('.tree-name-input'); renameInput.value = 'local-renamed.txt'; f.calls.length = 0; renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await f.settle();
    check('本地改名事件与回执只触发一次局部读取', JSON.stringify(f.calls) === '["a"]' && Boolean(f.row('a/local-renamed.txt')) && !f.row('a/file-000.txt'), f.calls);
    f.calls.length = 0; f.row('a/local-renamed.txt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    Array.from(document.querySelectorAll('.file-menu button')).find(button => button.textContent === '移入回收站').click(); await f.settle();
    check('本地删除事件与回执只触发一次局部读取', JSON.stringify(f.calls) === '["a"]' && !f.row('a/local-renamed.txt'), f.calls);

    f = await fixture(); const target = f.row('a/file-000.txt'); const top = target.getBoundingClientRect().top; const height = target.getBoundingClientRect().height;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    let input = target.querySelector('input'); const box = input.getBoundingClientRect();
    check('重命名输入位于目标原行，图标名称对齐且行高不变', input && target.querySelector('.tree-label').hidden && box.left >= target.querySelector('.tree-icon').getBoundingClientRect().right && Math.abs(target.getBoundingClientRect().top - top) < 1 && Math.abs(target.getBoundingClientRect().height - height) < 1 && box.right <= target.getBoundingClientRect().right, { row: target.getBoundingClientRect().toJSON(), input: box.toJSON(), height });
    check('文件默认仅选中扩展名前的主体', input.selectionStart === 0 && input.selectionEnd === 'file-000'.length);
    input.dispatchEvent(new MouseEvent('click', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); await f.settle();
    check('编辑名称时点击和空格不触发打开文件', f.opened.length === 0 && document.activeElement === input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await f.settle();
    check('未变名称确认无磁盘请求且恢复原行', f.renames.length === 0 && !target.querySelector('input') && !target.querySelector('.tree-label').hidden && target.draggable && document.activeElement === target);
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); input = target.querySelector('input'); input.value = 'file-001.txt';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); await f.settle();
    check('中文组字确认键不提交重命名', f.renames.length === 0 && target.querySelector('input') === input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await f.settle();
    check('重名错误原位保留可继续编辑且不覆盖', target.querySelector('input') === input && !input.readOnly && target.querySelector('.tree-name-error').textContent.includes('已存在') && f.row('a/file-001.txt') && document.activeElement === input);
    input.value = 'new-name.md'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await f.settle();
    check('修正名称后改名一次并聚焦新行', f.row('a/new-name.md') && !f.row('a/file-000.txt') && document.activeElement === f.row('a/new-name.md') && !f.tree.querySelector('input'), document.activeElement?.outerHTML);
    const next = f.row('a/new-name.md'); next.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); input = next.querySelector('input'); input.value = 'discard.txt'; const count = f.renames.length;
    document.getElementById('outside').focus(); await f.settle();
    check('失焦取消改名且不抢回焦点', f.renames.length === count && !next.querySelector('input') && !next.querySelector('.tree-label').hidden && document.activeElement === document.getElementById('outside'), { count, renames: f.renames.length, input: Boolean(next.querySelector('input')), hidden: next.querySelector('.tree-label').hidden, active: document.activeElement?.outerHTML });
    f.directories.get('').push(f.entry('folder.v1', true)); await f.explorer.refresh(false, 'folder.v1'); const dotted = f.row('folder.v1'); dotted.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); input = dotted.querySelector('input');
    check('文件夹含点名称全选', input.selectionEnd === 'folder.v1'.length);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('Esc恢复名称和聚焦但不展开目录', !dotted.querySelector('input') && document.activeElement === dotted && dotted.getAttribute('aria-expanded') === 'false');
    f.scroll.style.width = '240px'; const last = f.row('d/file-099.txt'); last.scrollIntoView({ block: 'end' }); last.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); input = last.querySelector('input'); input.value = 'file-098.txt'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await f.settle();
    const errorRect = last.querySelector('.tree-name-error').getBoundingClientRect(); const viewport = f.scroll.getBoundingClientRect();
    check('窄树底部重名错误向上显示且完整位于滚动视口内', errorRect.top >= viewport.top && errorRect.bottom <= viewport.bottom && errorRect.left >= viewport.left && errorRect.right <= viewport.right && errorRect.height > 10, { error: errorRect.toJSON(), viewport: viewport.toJSON() });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    f.directories.set('', ['assets', '作业4.pdf', '作业4解答.md', '作业5.pdf', '作业5解答.md'].map((name, index) => f.entry(name, index === 0))); await f.explorer.refresh(true);
    f.scroll.style.width = '340px'; f.row('作业5解答.md').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
  }
  return { mode, pass: checks.every(value => value.pass), checks, measurements, limits: '真实 Chromium DOM 和生产树代码；内存目录桥，不测磁盘、IPC、项目 FPS 或安装版速度。elapsedMs 含稳定等待，不作为性能结论。' };
}
