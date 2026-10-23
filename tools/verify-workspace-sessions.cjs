/** 真实 Electron 离线验收；官网 source 是事件夹具，不证明真实官网导航或页面结构。 */
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-workspace-sessions-probe-'));
  const env = { ...process.env, MINI_WORKSPACE_SESSIONS_PROBE_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { cwd: path.resolve(__dirname, '..'), env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(result.error.message);
  console.log('离线会话验收目录：' + directory);
  process.exit(result.error ? 1 : result.status ?? 1);
}
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), directory = process.env.MINI_WORKSPACE_SESSIONS_PROBE_DIR;
if (!directory) throw new Error('必须由离线夹具包装器启动');
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const checks = [], screenshots = [];
let window, sessions, dialogs = 0, blockedNetwork = 0;
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, description) {
  const until = Date.now() + 7000;
  while (Date.now() < until) { if (await predicate()) return; await delay(20); }
  throw new Error('等待超时：' + description);
}
function finish(error) {
  const report = {
    ok: !error && checks.every(item => item.pass),
    scope: '真实离线 Electron、生产 preload/文件 IPC/会话 owner；官网 source 为 EventEmitter，不证明真实官网导航',
    checks, pass: checks.filter(item => item.pass).length, fail: checks.filter(item => !item.pass).length + (error ? 1 : 0),
    dialogs, blockedNetwork, screenshots, ...(error ? { error: error.stack || String(error) } : {}),
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  sessions?.dispose();
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(report.ok ? 0 : 1);
}
app.whenReady().then(async () => {
  const { CHANNELS } = require('../dist/shared/contract');
  const { workspaceConversationUrl } = require('../dist/shared/workspaceSessions');
  const { WorkspaceSessions } = require('../dist/main/workspaceSessions');
  const { WorkspaceSessionStore } = require('../dist/main/workspaceSessionStore');
  const { WorkspaceController } = require('../dist/main/workspaceController');
  const { FileService } = require('../dist/main/fileService');
  const { WorkspaceService } = require('../dist/main/workspaceService');
  const { SettingsStore } = require('../dist/main/settings');
  const { registerFileIpc } = require('../dist/main/ipc');
  dialog.showMessageBox = async () => { dialogs++; return { response: 2, checkboxChecked: false }; };
  dialog.showOpenDialog = async () => { dialogs++; return { canceled: true, filePaths: [] }; };
  const roots = [path.join(directory, '项目 Alpha'), path.join(directory, '项目 Beta')];
  roots.forEach(project => {
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'note.txt'), 'original note');
    fs.writeFileSync(path.join(project, 'extra.txt'), 'original extra');
  });
  const files = new FileService(), settings = new SettingsStore('fixture-settings.json');
  const workspace = new WorkspaceService(files, settings);
  workspace.open(roots[0]); workspace.open(roots[1]); workspace.open(roots[0]);
  let failWrites = false;
  const realWrite = files.writeFile.bind(files);
  files.writeFile = (...args) => failWrites ? Promise.resolve({ ok: false, error: '离线夹具注入的保存失败' }) : realWrite(...args);
  const nav = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8').match(/<nav id="workspace-navigation"[\s\S]*?<\/nav>/)[0];
  const styles = ['dist/renderer/ui-tokens.css', 'src/renderer/ui.css', 'src/renderer/style.css', 'src/renderer/fileExplorer.css', 'src/renderer/applicationUpdate.css', 'src/renderer/workspaceNavigation.css'];
  const file = path.join(directory, 'fixture.html');
  fs.writeFileSync(file, '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src file: \'unsafe-inline\'; font-src file:; script-src \'none\'; connect-src \'none\'">'
    + styles.map(name => '<link rel="stylesheet" href="' + pathToFileURL(path.join(root, name)).href + '">').join('')
    + '<style>.workspace-navigation{left:0;top:0;width:340px;height:100vh;box-sizing:border-box}.fixture-editor{position:absolute;left:360px;top:30px;width:580px;height:500px;background:var(--ui-bg);color:var(--ui-text);border:1px solid var(--ui-border);padding:12px;font:14px/1.6 Consolas,monospace}</style>'
    + nav + '<textarea id="fixture-editor" class="fixture-editor" aria-label="离线文档编辑夹具"></textarea></html>');
  window = new BrowserWindow({ show: false, width: 1000, height: 800, useContentSize: true, backgroundColor: '#181818',
    webPreferences: { preload: path.join(root, 'dist/main/preload.js'), sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    const blocked = /^(?:https?|wss?):/i.test(request.url);
    if (blocked) blockedNetwork++;
    callback({ cancel: blocked });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file:')) event.preventDefault(); });
  const execute = code => window.webContents.executeJavaScript(code);
  const controller = new WorkspaceController(window, window.webContents, files, workspace, state => {
    window.webContents.send(CHANNELS.rootChanged, state); sessions?.workspaceChanged();
  }, () => {}, () => false);
  controller.register();
  registerFileIpc(files, { chooseRoot: () => controller.chooseRoot(), getState: () => workspace.getState(), write: (relative, text) => controller.write(relative, text) });
  class Source extends EventEmitter {
    constructor(identity, title) { super(); this.url = workspaceConversationUrl(identity); this.title = title; }
    getURL() { return this.url; }
    getTitle() { return this.title; }
    isDestroyed() { return false; }
    visit(url) { this.emit('did-start-navigation', {}, url, true, true); this.url = url; this.emit('did-navigate-in-page', {}, url, true); }
  }
  const one = { platform: 'deepseek', accountId: 'default', conversationId: 'one' };
  const two = { platform: 'deepseek', accountId: 'default', conversationId: 'two' };
  const work = { platform: 'deepseek', accountId: 'account-1', conversationId: 'work' };
  const gpt = { platform: 'chatgpt', accountId: 'default', conversationId: 'gpt' };
  const longTitle = '重要会话：' + '编辑器与工具执行的可靠性讨论_'.repeat(5) + '<img src=x onerror=alert(1)> - DeepSeek';
  const pages = new Map();
  function pageFor(identity, title) {
    const id = identity.platform + ':' + identity.accountId;
    if (!pages.has(id)) pages.set(id, new Source(identity, title || '离线会话'));
    const page = pages.get(id); if (title) page.title = title; return page;
  }
  let source = { web: pageFor(one, longTitle), platform: one.platform, accountId: one.accountId };
  const navigations = [], active = [], storeFile = path.join(directory, 'workspace-sessions.json');
  sessions = new WorkspaceSessions({
    ipc: ipcMain, editor: window.webContents, file: storeFile, workspace: controller,
    source: () => source, available: () => true,
    accountName: (_platform, accountId) => accountId === 'account-1' ? '工作账号（仅本地备注）' : '默认账号',
    switchBlock: () => undefined,
    navigate: async (target, current) => {
      if (!current()) return;
      navigations.push(target);
      const page = pageFor(target); page.url = workspaceConversationUrl(target);
      source = { web: page, platform: target.platform, accountId: target.accountId };
      sessions.platformChanged(); page.visit(page.url);
    },
    setActive: async value => { active.push(value); },
  });
  await window.loadFile(file);
  sessions.register();
  await execute(fs.readFileSync(path.join(root, 'src/renderer/editorWorkspace.js'), 'utf8'));
  await execute(fs.readFileSync(path.join(root, 'src/renderer/fileIcons.js'), 'utf8'));
  await execute(fs.readFileSync(path.join(root, 'src/renderer/workspaceNavigation.js'), 'utf8'));
  async function initializeRenderer() {
    const bridge = window.editorBridge, input = document.getElementById('fixture-editor');
    const state = { root: null, currentPath: null, currentKind: null, currentText: '', savedText: '' };
    const probe = window.sessionProbe = { state, notices: [], shown: null };
    let owner;
    owner = window.createEditorWorkspace({
      state, bridge, ready: async () => {}, kindForPath: () => null,
      changed() { owner.report(); }, highlight() {}, renderTabs() {}, captureViewState() { return null; },
      createModel(path, text) { return { path, text, getValue() { return this.text; }, getValueLength() { return this.text.length; } }; },
      showDocument(doc) { probe.shown = doc; input.value = doc ? doc.text : ''; },
      disposeModel() {}, renameModel() {}, replaceContent(doc, text) { doc.model.text = text; input.value = text; },
      setInfo(text) { probe.notices.push(text); },
    });
    probe.workspace = owner;
    input.addEventListener('input', () => { if (probe.shown) { probe.shown.model.text = input.value; owner.contentChanged(probe.shown.model); } });
    bridge.onRootChanged(info => { if (state.root !== info.root) { state.root = info.root; owner.clear(); } });
    state.root = (await bridge.getRoot()).root; owner.report();
    window.setupWorkspaceNavigation(bridge);
  }
  await execute('(' + initializeRenderer.toString() + ')()');
  await waitFor(() => execute("document.querySelectorAll('.workspace-project').length===2"), '项目列表初始化');
  check('显式绑定前列表为空且未创建持久化记录', sessions.state.sessions.length === 0 && !fs.existsSync(storeFile) && await execute("document.querySelectorAll('.workspace-session').length===0"));
  check('空项目只占项目行，绑定入口位于行内且无空会话容器', await execute("document.querySelectorAll('.workspace-project-sessions,.workspace-expand').length===0 && Array.from(document.querySelectorAll('.workspace-row')).every(row=>row.querySelector('.workspace-bind') && Math.abs(row.getBoundingClientRect().height-34)<.5)"));
  async function click(className, index) {
    const target = 'document.querySelectorAll(' + JSON.stringify('.' + className) + ')[' + index + ']';
    await waitFor(() => execute('Boolean(' + target + ') && !' + target + '.disabled'), '具名入口可用：' + className);
    await execute(target + '.click()');
    await delay(70);
  }
  async function waitIdle() { await waitFor(() => !sessions.state.busy, '会话 owner 空闲'); await delay(70); }
  async function bind(identity, title, index, count) {
    const page = pageFor(identity, title);
    if (source.web === page && source.platform === identity.platform && source.accountId === identity.accountId) page.visit(workspaceConversationUrl(identity));
    else { page.url = workspaceConversationUrl(identity); source = { web: page, platform: identity.platform, accountId: identity.accountId }; sessions.platformChanged(); }
    await waitIdle(); await click('workspace-bind', index);
    await waitFor(() => sessions.state.sessions.length === count, '显式绑定条目落盘'); await waitIdle();
  }
  await bind(one, longTitle, 0, 1);
  await bind(two, 'Beta：命令执行与结果回传', 1, 2);
  await bind(work, '工作账号：编辑器重构方案', 0, 3);
  await bind(gpt, 'ChatGPT：项目架构与文件保存评审', 1, 4);
  check('用户可分别绑定 A/B，真实 store 持久化四条记录', new WorkspaceSessionStore(storeFile).sessions.length === 4);
  function groupsMatch() {
    const groups = Array.from(document.querySelectorAll('.workspace-session-heading'), node => node.textContent);
    return groups.length === 4 && groups.filter(name => name === 'DeepSeek · 默认账号').length === 2
      && groups.includes('DeepSeek · 工作账号（仅本地备注）') && groups.includes('ChatGPT · 默认账号');
  }
  check('按项目及 DeepSeek 不同账号、ChatGPT 展示分组', await execute('(' + groupsMatch.toString() + ')()'));
  const beforeProject = navigations.length, beforeUrl = source.web.getURL();
  await click('workspace-project', 0); await waitFor(() => workspace.getState().root === roots[0], '点击本地项目');
  check('项目点击只切本地目录，不导航网页', navigations.length === beforeProject && source.web.getURL() === beforeUrl);
  // DOM 顺序按项目分组，Alpha 的默认账号、工作账号在前，Beta 默认账号、ChatGPT 在后。
  await click('workspace-session', 3);
  await waitFor(() => workspace.getState().root === roots[1] && sessions.state.selectedId === sessions.state.sessions[3].id, '点击 ChatGPT 会话同步项目');
  check('会话点击联动平台账号与假网页目标，并同步本地项目', source.platform === 'chatgpt' && source.accountId === 'default' && source.web.getURL() === workspaceConversationUrl(gpt));
  await click('workspace-session', 0); await waitFor(() => workspace.getState().root === roots[0] && sessions.state.selectedId === sessions.state.sessions[0].id, '返回 Alpha 会话');

  async function edit(relative, text) {
    await execute('window.sessionProbe.workspace.open(' + JSON.stringify(relative) + ')');
    await execute("(() => {const node=document.getElementById('fixture-editor');node.value=" + JSON.stringify(text) + ";node.dispatchEvent(new Event('input',{bubbles:true}))})()");
    await waitFor(() => controller.editor.hasDirty, '生产编辑状态 IPC 标记草稿');
  }
  const firstText = '用户在 Alpha 中真实输入，切官网会话时自动保存。', secondText = '第二个打开文档也必须保存。';
  await edit('note.txt', firstText); await edit('extra.txt', secondText);
  await execute('window.sessionProbe.notices.length=0');
  source.web.visit(workspaceConversationUrl(two));
  await waitFor(() => workspace.getState().root === roots[1] && !sessions.state.busy, '跨项目静默保存成功');
  check('官网跨项目切换经生产保存 IPC 将全部未保存文档写入磁盘', fs.readFileSync(path.join(roots[0], 'note.txt'), 'utf8') === firstText && fs.readFileSync(path.join(roots[0], 'extra.txt'), 'utf8') === secondText);
  check('静默保存不弹对话框、不发送成功通知，并确认新项目选中', dialogs === 0 && await execute('window.sessionProbe.notices.length===0') && sessions.state.selectedId === sessions.state.sessions[1].id && sessions.canRun);
  await click('workspace-session', 0); await waitFor(() => workspace.getState().root === roots[0] && !sessions.state.busy, '准备失败保护检查');
  const failedDraft = '保存失败时必须保留的真实未保存内容。';
  await edit('note.txt', failedDraft); failWrites = true;
  source.web.visit(workspaceConversationUrl(two));
  await waitFor(() => !sessions.state.busy && Boolean(sessions.state.error), '注入保存失败返回');
  check('保存失败保留原项目、原草稿和磁盘文件，并阻断工具运行', workspace.getState().root === roots[0] && !sessions.canRun
    && fs.readFileSync(path.join(roots[0], 'note.txt'), 'utf8') === firstText
    && await execute('window.sessionProbe.state.currentText===' + JSON.stringify(failedDraft) + ' && window.sessionProbe.workspace.isDirty()'));
  check('保存失败保留官网实际新会话，显示失败和归属提示且没有询问', source.web.getURL() === workspaceConversationUrl(two) && dialogs === 0
    && await execute("document.getElementById('workspace-message').textContent.includes('自动保存未完成') && document.querySelector('.workspace-session-hint').textContent==='当前网页会话属于其他项目'"));
  failWrites = false;
  await execute('window.sessionProbe.workspace.save(undefined,true)');
  await waitFor(() => !controller.editor.hasDirty, '保存恢复');
  await click('workspace-session', 2);
  await waitFor(() => workspace.getState().root === roots[1] && sessions.canRun, '重新选择会话恢复');
  await click('workspace-session', 0);
  await waitFor(() => workspace.getState().root === roots[0] && sessions.state.selectedId === sessions.state.sessions[0].id && sessions.canRun, '截图前确认真实当前项目与会话');

  function measureLayout(originalTitle) {
    const nav = document.getElementById('workspace-navigation'), list = document.getElementById('workspace-list');
    const labels = Array.from(document.querySelectorAll('.workspace-session')), long = labels[0], text = long.querySelector('.workspace-session-label');
    return { overflow: nav.scrollWidth > nav.clientWidth || list.scrollWidth > list.clientWidth,
      labels: labels.every(node => node.getBoundingClientRect().right <= nav.getBoundingClientRect().right + .5),
      truncated: text.scrollWidth > text.clientWidth, ellipsis: getComputedStyle(text).textOverflow === 'ellipsis',
      titleMatches: long.title === '打开会话：' + originalTitle && long.getAttribute('aria-label') === '打开会话：' + originalTitle,
      displayTitle: long.textContent === originalTitle.replace(/ - DeepSeek$/, ''), images: nav.querySelectorAll('img').length,
      projectHeight: Array.from(document.querySelectorAll('.workspace-row')).every(node => Math.abs(node.getBoundingClientRect().height - 34) < .5),
      sessionHeight: Array.from(document.querySelectorAll('.workspace-session-row')).every(node => Math.abs(node.getBoundingClientRect().height - 30) < .5),
      inlineBind: Array.from(document.querySelectorAll('.workspace-row')).every(node => node.querySelector('.workspace-bind')),
      selected: Boolean(document.querySelector('.workspace-row.active .workspace-project[aria-current="true"]') && document.querySelector('.workspace-session-row.selected .workspace-session[aria-current="true"]')) };
  }
  for (const width of [340, 200]) {
    await execute("document.getElementById('workspace-navigation').style.width='" + width + "px'");
    await execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const layout = await execute('(' + measureLayout.toString() + ')(' + JSON.stringify(longTitle) + ')');
    check(width + 'px 侧栏长标题省略、保留纯文本提示且无横向越界', !layout.overflow && layout.labels && layout.truncated && layout.ellipsis && layout.titleMatches && layout.images === 0, layout);
    check(width + 'px 紧凑项目与会话行高、行内绑定和当前选中样例', layout.projectHeight && layout.sessionHeight && layout.inlineBind && layout.selected && layout.displayTitle, layout);
    const screenshot = path.join(directory, 'workspace-sessions-' + width + '.png');
    fs.writeFileSync(screenshot, (await window.webContents.capturePage({ x: 0, y: 0, width, height: 800 })).toPNG());
    screenshots.push(screenshot);
    await click('workspace-session-more', 0);
    const menuState = await execute("(() => { const action=document.querySelector('.workspace-unbind'), menu=action?.closest('[role=menu]'), box=menu?.getBoundingClientRect(), nav=document.getElementById('workspace-navigation').getBoundingClientRect(); return {valid:Boolean(action && menu && document.activeElement===action && !document.querySelector('#workspace-list .workspace-unbind')), fits:Boolean(box && box.left>=nav.left && box.right<=nav.right && box.top>=0 && box.bottom<=innerHeight), expanded:document.querySelector('.workspace-session-more').getAttribute('aria-expanded')==='true'}; })()");
    check(width + 'px 侧栏菜单独立弹出、首项聚焦且有界显示', menuState.valid && menuState.fits && menuState.expanded, menuState);
    const menuShot = path.join(directory, 'workspace-sessions-menu-' + width + '.png');
    fs.writeFileSync(menuShot, (await window.webContents.capturePage({ x: 0, y: 0, width: Math.min(460, width + 180), height: 800 })).toPNG());
    screenshots.push(menuShot);
    await execute("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));");
    check(width + 'px 菜单键盘退出恢复焦点且不解除绑定', sessions.state.sessions.length === 4 && await execute("!document.querySelector('.workspace-unbind') && document.activeElement.classList.contains('workspace-session-more') && document.activeElement.getAttribute('aria-expanded')==='false'"));
    let tabRestored = true;
    for (const shiftKey of [false, true]) {
      await click('workspace-session-more', 0);
      tabRestored = tabRestored && await execute("(() => {const action=document.activeElement;const event=new KeyboardEvent('keydown',{key:'Tab',shiftKey:" + shiftKey + ",bubbles:true,cancelable:true});action.dispatchEvent(event);return !event.defaultPrevented && !document.querySelector('.workspace-action-menu') && document.activeElement.classList.contains('workspace-session-more');})()");
    }
    check(width + 'px Tab和Shift+Tab收起菜单并从入口继续原生焦点顺序', tabRestored && sessions.state.sessions.length === 4);
  }
  const beforeUnbind = navigations.length, unbindUrl = source.web.getURL();
  await click('workspace-session-more', 2);
  await click('workspace-unbind', 0); await waitFor(() => sessions.state.sessions.length === 3, '解除绑定');
  check('解除绑定只移除本地记录，不导航或删除网页会话', navigations.length === beforeUnbind && source.web.getURL() === unbindUrl && new WorkspaceSessionStore(storeFile).sessions.length === 3);
  check('真实 preload 保持渲染进程无 Node 与文件系统直达能力', await execute("typeof window.require==='undefined' && typeof window.process==='undefined' && typeof window.editorBridge.writeFile==='function'"));
  check('全部验收无意外弹窗且活动保护经历撤回与恢复', dialogs === 0 && active.includes(false) && active.includes(true));
  const emptyRoot = path.join(directory, '空项目 Empty');
  fs.mkdirSync(emptyRoot, { recursive: true }); workspace.open(emptyRoot);
  window.webContents.send(CHANNELS.rootChanged, workspace.getState()); sessions.workspaceChanged();
  await waitFor(() => execute("document.querySelectorAll('.workspace-project').length===3"), '末尾空项目截图样例');
  await execute("document.getElementById('workspace-navigation').style.width='340px'");
  check('多项目列表中未绑定项目保持单行且仍有绑定入口', await execute("(() => { const item=Array.from(document.querySelectorAll('.workspace-item')).at(-1); return !item.querySelector('.workspace-project-sessions,.workspace-expand') && Boolean(item.querySelector('.workspace-row .workspace-bind')) && Math.abs(item.getBoundingClientRect().height-34)<.5; })()"));
  await execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await delay(70);
  const emptyShot = path.join(directory, 'workspace-sessions-empty-project.png');
  fs.writeFileSync(emptyShot, (await window.webContents.capturePage({ x: 0, y: 0, width: 340, height: 800 })).toPNG());
  screenshots.push(emptyShot);
  finish();
}).catch(finish);
