/** 原生离线布局夹具：真实工具 UI、声明式内存状态；不执行工具或连接官网。 */
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-tool-panel-probe-'));
  const env = { ...process.env, MINI_TOOL_PANEL_PROBE_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(require('electron'), [__filename], {
    cwd: path.resolve(__dirname, '..'), env, windowsHide: true, encoding: 'utf8', timeout: 95000,
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error) console.error(run.error.message);
  console.log('布局报告与截图：' + directory);
  process.exit(run.error ? 1 : run.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const directory = process.env.MINI_TOOL_PANEL_PROBE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'mini-tool-panel-probe-'));
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const results = [], screenshots = [], network = [];
let resultRendering;
let window;
const deadline = setTimeout(() => finish(new Error('工具布局验证超过 90 秒')), 90000);

function finish(error) {
  clearTimeout(deadline);
  const report = {
    ok: !error && results.every(item => item.pass), directory, results, screenshots, network, resultRendering,
    scope: '本地离线 Electron 渲染、DOM 焦点与 Escape 处理；不代表人工键盘、官网或真实工具验收。',
    error: error && String(error.stack || error),
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    ok: report.ok, checks: results.length, passed: results.filter(item => item.pass).length,
    failures: results.filter(item => !item.pass), screenshots, report: path.join(directory, 'report.json'),
    network, resultRendering, error: report.error,
  }, null, 2));
  app.exit(report.ok ? 0 : 1);
}

function workspaceMarkup() {
  const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const start = source.indexOf('<section id="tool-workspace"');
  if (start < 0) throw new Error('真实 index.html 缺少 tool-workspace');
  const tags = /<\/?section\b[^>]*>/g;
  tags.lastIndex = start;
  let depth = 0, tag;
  while ((tag = tags.exec(source))) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (!depth) {
      const controls = source.match(/<footer class="prompt-bar">[\s\S]*?<\/footer>/);
      if (!controls) throw new Error('真实 index.html 缺少工具权限与设置控件所在 footer');
      return source.slice(start, tags.lastIndex) + '<div hidden>' + controls[0] + '</div>';
    }
  }
  throw new Error('tool-workspace section 未闭合');
}

function setupFixture() {
  const longPath = 'src/renderer/features/tool-panel/responsive-layout/very-long-directory-name/工具结果面板说明与状态反馈.ts';
  const now = Date.now();
  const result = (request_id, tool, status, data, extra = {}) => ({
    batch_id: 'offline-layout-batch', request_id, tool, status, data,
    started_at: now - 2500, finished_at: now - 1200, ...extra,
  });
  const ordinary = [
    result('read-long', 'read_file', 'done', { path: longPath, start_line: 1, end_line: 80, total_lines: 300, truncated: true }),
    result('search', 'search_text', 'done', { root: 'src/renderer', matches: [{ path: longPath, line: 12 }] }),
    result('skill', 'load_skill', 'done', { name: 'frontend-design:紧凑工具面板与自适应布局规则' }),
    result('failed', 'run_command', 'failed', { process_id: 'offline-process-failed', status: 'failed', exit_code: 1 }, { error: '构建失败：无法解析项目文件中的导入，请核对完整错误输出。' }),
    result('apply', 'apply_changes', 'done', { outcomes: [{ path: longPath, ok: true }] }),
  ];
  const background = result('background', 'run_command', 'done', {
    process_id: 'offline-background-process-with-a-long-identifier', status: 'running', started_at: now - 12000,
    has_more: true, truncated: true, cleanup_pending: true,
  });
  const base = {
    config: { permission: 'ask', automatic: false, completionSound: false, autoCopyResults: false, sendIntervalSeconds: 3 },
    results: ordinary, busy: false, hasRunningProcesses: false, canUndo: true,
    source: 'web', message: '工具结果已返回',
  };
  let state = base, receive;
  const calls = [];
  window.editorBridge = {
    getToolState: async () => state,
    getWebPlatform: async () => ({ platform: 'deepseek', switching: false }),
    onToolState: callback => { receive = callback; }, onWebPlatformState() {},
    onToolSettingsVisibility() {}, onRootChanged() {},
    setToolConfig: async patch => { calls.push('setToolConfig'); state = { ...state, config: { ...state.config, ...patch } }; return state; },
    copyToolResults: async () => { calls.push('copyToolResults'); return { ok: true }; },
    sendToolResults: async () => { calls.push('sendToolResults'); return { ok: true }; },
    undoToolChange: async () => { calls.push('undoToolChange'); return { ok: true }; },
    stopToolCommand: async () => { calls.push('stopToolCommand'); return state; },
    openToolSettings: async () => { calls.push('openToolSettings'); },
    executeToolJson: async text => { calls.push('executeToolJson'); window.toolProbe.submitted = text; return { ok: false, error: '离线夹具不执行工具' }; },
  };
  window.toolProbe = {
    longPath, calls,
    publish(next) { state = next; receive(state); },
    state(kind) {
      state = { ...base, results: kind === 'empty' ? [] : kind === 'background' ? [...ordinary, background] : ordinary,
        canUndo: !['no-undo', 'empty'].includes(kind), hasRunningProcesses: kind === 'background' };
      if (kind === 'batch-error') { state.results = []; state.batchError = { error: '离线批次校验失败：requests 缺少 id。' }; }
      receive(state);
    },
  };
  document.getElementById('tool-workspace').hidden = false;
}

async function measureResultRendering() {
  const originalCreate = document.createElement, originalStringify = JSON.stringify;
  let created = 0, fullBatch = 0, fullResult = 0, serializedCharacters = 0;
  document.createElement = function (...args) { created += 1; return originalCreate.apply(this, args); };
  JSON.stringify = function (value, ...args) {
    const text = originalStringify.call(this, value, ...args);
    const batch = Array.isArray(value) && Array.isArray(value[0]) && value[0].some(item => item && item.batch_id === 'performance-probe');
    const result = value && value.batch_id === 'performance-probe' && value.tool;
    if (batch) fullBatch += 1;
    if (result) fullResult += 1;
    if (batch || result) serializedCharacters += text.length;
    return text;
  };
  const snapshot = () => ({ created, fullBatch, fullResult, serializedCharacters });
  const delta = before => Object.fromEntries(Object.entries(snapshot()).map(([key, value]) => [key, value - before[key]]));
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  const state = { config: { permission: 'ask', automatic: false }, results: [], busy: false, message: '离线性能计数', canUndo: false };
  const rows = Array.from({ length: 20 }, (_, index) => ({
    batch_id: 'performance-probe', request_id: 'large-' + index, tool: 'read_file', status: 'done', data: { path: 'sample-' + index, text: 'x'.repeat(131072) },
  }));
  try {
    window.toolProbe.publish(state); const beforeInitial = snapshot();
    window.toolProbe.publish({ ...state, results: structuredClone(rows) });
    const initial = delta(beforeInitial);
    const items = [...document.querySelectorAll('#tool-results > details')];
    const beforeClone = snapshot();
    for (let index = 0; index < 50; index++) window.toolProbe.publish({ ...state, results: structuredClone(rows), message: '进度 ' + index });
    const clonedBroadcasts = delta(beforeClone);
    items[0].open = true; await settle();
    const body = document.querySelector('#tool-results > details pre');
    const selectedText = body.firstChild;
    const selection = getSelection(); const range = document.createRange(); range.setStart(selectedText, 0); range.setEnd(selectedText, 15);
    selection.removeAllRanges(); selection.addRange(range);
    items[0].querySelector('summary').focus();
    const selected = selection.toString(), focused = document.activeElement;
    let replacedRows = 0;
    const beforeProgress = snapshot();
    for (let index = 0; index < 20; index++) {
      const next = structuredClone(rows); next[1].status = index % 2 ? 'done' : 'failed';
      window.toolProbe.publish({ ...state, results: next });
      replacedRows += items.filter((item, position) => document.querySelectorAll('#tool-results > details')[position] !== item).length;
    }
    const otherRowProgress = delta(beforeProgress);
    const preserved = { nodes: replacedRows === 0, focused: document.activeElement === focused, selection: selection.toString() === selected, body: document.querySelector('#tool-results > details pre') === body };
    const latest = structuredClone(rows); latest[0].data.text = '<img src=x onerror="throw 1">latest';
    const beforeChanged = snapshot(); window.toolProbe.publish({ ...state, results: latest });
    const changedOpenResult = delta(beforeChanged);
    const current = document.querySelector('#tool-results > details');
    const safeLatest = JSON.parse(current.querySelector('pre').textContent).data.text === latest[0].data.text && !current.querySelector('img');
    current.open = false; await settle();
    const releasedClosedBody = !current.querySelector('pre');
    window.toolProbe.publish({ ...state, results: [{ ...rows[0], batch_id: 'next-batch' }] });
    const freshBatchClosed = !document.querySelector('#tool-results > details').open && !current.isConnected;
    return { rows: 20, charactersPerOutput: 131072, cloneBroadcasts: 50, progressBroadcasts: 20, initial, clonedBroadcasts, otherRowProgress, changedOpenResult, replacedRows, preserved, safeLatest, releasedClosedBody, freshBatchClosed };
  } finally {
    document.createElement = originalCreate; JSON.stringify = originalStringify;
  }
}

function inspect(width, phase) {
  const workspace = document.getElementById('tool-workspace');
  const header = document.querySelector('.tool-panel-summary');
  const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const bounds = element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const region = workspace.getBoundingClientRect();
  const checks = [];
  const check = (name, pass, detail) => checks.push({ width, phase, name, pass: Boolean(pass), ...(detail ? { detail } : {}) });
  check('窗口保持宽视口，面板独立收缩', innerWidth >= 1100 && Math.abs(region.width - width) < 1);
  check('头部保持 38px', Math.abs(header.getBoundingClientRect().height - 38) < .5, bounds(header));
  const overflow = [workspace, header, document.getElementById('tool-panel-body'), ...document.querySelectorAll('.tool-result > summary')]
    .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => ({ id: element.id, className: element.className, scroll: element.scrollWidth, client: element.clientWidth }));
  check('面板、头部、正文及结果行无水平溢出', !overflow.length, overflow);
  for (const id of ['tool-json-open', ...(phase === 'empty' ? [] : ['tool-copy'])]) {
    const element = document.getElementById(id), rect = element.getBoundingClientRect();
    check(id + ' 可见且在头部内', visible(element) && rect.width > 0 && rect.left >= region.left - 1 && rect.right <= region.right + 1 && rect.top >= header.offsetTop - 1);
  }
  if (phase !== 'empty' && phase !== 'batch-error') {
    const first = document.querySelector('.tool-result-target');
    check('长目标保留完整 title', first.textContent === window.toolProbe.longPath && first.title === window.toolProbe.longPath);
    check('长目标使用单行省略', getComputedStyle(first).textOverflow === 'ellipsis' && first.scrollWidth > first.clientWidth);
    const label = first.parentElement.querySelector('.tool-result-label');
    if (width <= 380) check('窄工具区目标位于动作下一行', first.getBoundingClientRect().top >= label.getBoundingClientRect().bottom - .5);
    if (width >= 620) check('宽工具区目标与动作同行', Math.abs(first.getBoundingClientRect().top - label.getBoundingClientRect().top) < .5);
    const failed = document.querySelector('.tool-result-status[data-status="failed"]');
    check('失败状态可见', visible(failed));
    const summary = first.closest('summary'), time = summary.querySelector('.tool-result-time'), status = summary.querySelector('.tool-result-status'), detail = summary.querySelector('.tool-result-detail');
    if (visible(time)) {
      check('耗时位于执行状态之前', time.getBoundingClientRect().right <= status.getBoundingClientRect().left + .5);
      if (width >= 620 && visible(detail)) check('宽列耗时位于结果摘要之前，状态位于摘要之后', time.getBoundingClientRect().right <= detail.getBoundingClientRect().left + .5 && detail.getBoundingClientRect().right <= status.getBoundingClientRect().left + .5);
    }
    check('截断信息保留摘要与完整提示', Array.from(document.querySelectorAll('.tool-result-detail')).some(element => element.title.includes('结果已截断') && element.textContent.includes('结果已截断')));
    if (width === 240) {
      check('240px 截断摘要真实可见', Array.from(document.querySelectorAll('.tool-result-detail')).some(element => element.title.includes('结果已截断') && visible(element)));
      check('240px 失败摘要真实可见', visible(failed.parentElement.querySelector('.tool-result-detail')));
    }
  }
  if (phase === 'background') {
    const stop = document.querySelector('.tool-command-stop'), rect = stop.getBoundingClientRect();
    check('后台命令中断按钮可见且未越界', visible(stop) && !stop.disabled && rect.left >= region.left && rect.right <= region.right);
    check('中断仅显示24px图标并保留可访问动作名称', !stop.textContent && Math.abs(rect.width - 24) < .5 && Math.abs(rect.height - 24) < .5 && /中断.*命令.*子进程/.test(stop.getAttribute('aria-label')));
    check('后台、剩余输出、清理状态仍可读取', Array.from(document.querySelectorAll('.tool-result-detail')).some(element => ['进程仍在运行', '还有输出可读取', '进程树待清理'].every(text => element.title.includes(text))));
  }
  const view = document.getElementById('tool-view-changes'), menuView = document.getElementById('tool-menu-view-changes');
  if (phase !== 'empty' && !visible(view)) check('查看改动有可见菜单入口', visible(document.getElementById('tool-more-toggle')) && Boolean(menuView));
  return checks;
}

app.whenReady().then(async () => {
  const styles = ['dist/renderer/ui-tokens.css', 'src/renderer/ui.css', 'src/renderer/style.css', 'src/renderer/toolHarness.css', 'src/renderer/workspaceNavigation.css'];
  styles.forEach(file => { if (!fs.existsSync(path.join(root, file))) throw new Error('缺少 ' + file + '；请先运行 pnpm build'); });
  const html = path.join(directory, 'fixture.html');
  fs.writeFileSync(html, '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src file: \'unsafe-inline\'; script-src \'none\'; connect-src \'none\'">'
    + styles.map(file => '<link rel="stylesheet" href="' + pathToFileURL(path.join(root, file)).href + '">').join('')
    + '<style>#tool-workspace{left:20px;top:20px;width:620px;height:700px}</style></head><body>' + workspaceMarkup() + '</body></html>');
  window = new BrowserWindow({ show: false, width: 1220, height: 800, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    if (/^(?:https?|wss?):/.test(request.url)) { network.push(new URL(request.url).origin); callback({ cancel: true }); }
    else callback({});
  });
  const execute = source => window.webContents.executeJavaScript(source);
  const settle = () => execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const check = (name, pass, detail) => results.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) });
  const resize = async width => {
    await execute(`document.getElementById('tool-workspace').style.width=${JSON.stringify(width + 'px')};document.dispatchEvent(new Event('workspace-layout-changed'));`);
    await settle();
  };
  const screenshot = async name => {
    const file = path.join(directory, name + '.png');
    const rect = await execute('(()=>{const r=document.getElementById("tool-workspace").getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()');
    fs.writeFileSync(file, (await window.webContents.capturePage(rect)).toPNG()); screenshots.push(file);
  };
  await window.loadFile(html);
  await execute('(' + setupFixture.toString() + ')()');
  for (const name of ['toolResultPresentation', 'toolExecutionClock', 'toolPanelLayout', 'toolJsonPanel', 'toolAttention', 'toolCompletionSound', 'toolHarness']) {
    await execute(fs.readFileSync(path.join(root, 'src/renderer/' + name + '.js'), 'utf8'));
  }
  await settle();
  for (const width of [240, 320, 460, 620, 900]) {
    await resize(width);
    await execute('window.toolProbe.state("ordinary")'); await settle();
    results.push(...await execute('(' + inspect.toString() + ')(' + width + ',"ordinary")'));
    await execute('document.getElementById("tool-json-open").click()'); await settle();
    check(width + 'px JSON 展开不折叠主面板并聚焦输入', await execute('!document.getElementById("tool-json-panel").hidden && document.getElementById("tool-panel").open && document.activeElement.id === "tool-json-input"'));
    check(width + 'px JSON 仅保留有动作名称的执行与关闭图标', await execute('document.querySelectorAll("#tool-json-panel button").length === 2 && [...document.querySelectorAll("#tool-json-panel button")].every(button => !button.textContent.trim() && button.querySelector("svg[aria-hidden=true]") && button.title && button.getAttribute("aria-label") && button.getBoundingClientRect().width === 28 && button.getBoundingClientRect().height === 28) && !document.getElementById("tool-json-validate") && !document.getElementById("tool-json-preview")'));
    check(width + 'px 执行嵌入输入框，正文和缩放手柄有预留空间，无独立操作行', await execute('(()=>{const area=document.getElementById("tool-json-input"),input=area.getBoundingClientRect(),close=document.getElementById("tool-json-cancel").getBoundingClientRect(),run=document.getElementById("tool-json-execute").getBoundingClientRect(),label=document.querySelector(".tool-json-head label").getBoundingClientRect(),style=getComputedStyle(area),status=document.getElementById("tool-json-status");return close.left>=label.right && close.bottom<=input.top && run.top>input.top && run.bottom<input.bottom && input.right-run.right>=16 && input.bottom-run.bottom>=12 && run.left>=input.right-parseFloat(style.paddingRight) && run.top>=input.bottom-parseFloat(style.paddingBottom) && !document.querySelector(".tool-json-actions") && (!status.textContent && !status.getClientRects().length || status.getBoundingClientRect().top>=input.bottom)})()'));
    if (width === 240) {
      await execute('document.getElementById("tool-json-input").value="offline original";document.getElementById("tool-json-input").dispatchEvent(new Event("input"));document.getElementById("tool-json-execute").click()'); await settle();
      check('240px 单次提交完整原文，入口拒绝保留输入且纯文本提示', await execute('window.toolProbe.submitted === "offline original" && !document.getElementById("tool-json-panel").hidden && document.getElementById("tool-json-input").value === "offline original" && document.getElementById("tool-json-status").textContent === "离线夹具不执行工具"'));
      check('240px 长错误在框下方换行，不挤压嵌入执行图标或横向溢出', await execute('(()=>{const status=document.getElementById("tool-json-status"),before=status.textContent;status.textContent="Error_".repeat(80);const text=status.getBoundingClientRect(),run=document.getElementById("tool-json-execute").getBoundingClientRect(),input=document.getElementById("tool-json-input").getBoundingClientRect();const pass=text.top>=input.bottom && status.scrollWidth<=status.clientWidth+1 && run.width===28 && run.bottom<input.bottom;status.textContent=before;return pass})()'));
      check('输入框缩放后执行图标仍嵌在框内，正文继续保留空间', await execute('(()=>{const area=document.getElementById("tool-json-input"),before=area.style.height;area.style.height="110px";const input=area.getBoundingClientRect(),run=document.getElementById("tool-json-execute").getBoundingClientRect();const pass=run.top>input.top && run.bottom<=input.bottom-12 && input.right-run.right>=16;area.style.height=before;return pass})()'));
    }
    results.push(...await execute('(' + inspect.toString() + ')(' + width + ',"ordinary")'));
    if (width === 240) await screenshot('tool-panel-240-json');
    await execute('document.getElementById("tool-json-panel").dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))');
    check(width + 'px Escape 收起 JSON 并恢复按钮焦点', await execute('document.getElementById("tool-json-panel").hidden && document.activeElement.id === "tool-json-open" && document.getElementById("tool-json-open").getAttribute("aria-expanded") === "false"'));
    await execute('window.toolProbe.state("background")'); await settle();
    results.push(...await execute('(' + inspect.toString() + ')(' + width + ',"background")'));
    if ([240, 460, 900].includes(width)) await screenshot('tool-panel-' + width + '-results');
    if (width === 240) {
      await execute('document.getElementById("tool-copy").click()'); await settle();
      check('240px 复制按钮调用内存桥且不折叠主面板', await execute('window.toolProbe.calls.includes("copyToolResults") && document.getElementById("tool-panel").open'));
      await execute('document.querySelector(".tool-command-stop").click()'); await settle();
      check('240px 中断按钮调用内存桥且不展开结果或折叠面板', await execute('window.toolProbe.calls.includes("stopToolCommand") && document.getElementById("tool-panel").open && !document.querySelector(".tool-result:last-child").open'));
    }
  }
  await resize(240);
  await execute('window.toolProbe.state("no-undo")'); await settle();
  check('窄列无撤销时仍可访问更多菜单', await execute('document.getElementById("tool-more-toggle").getClientRects().length > 0'));
  await execute('document.getElementById("tool-more-toggle").click()'); await settle();
  check('菜单打开后聚焦可见操作', await execute('!document.getElementById("tool-more").hidden && document.getElementById("tool-more-toggle").getAttribute("aria-expanded") === "true" && document.getElementById("tool-more").contains(document.activeElement) && document.activeElement.getClientRects().length > 0'));
  const menuPlacement = await execute('(()=>{const m=document.getElementById("tool-more").getBoundingClientRect(),h=document.querySelector(".tool-panel-summary").getBoundingClientRect();return {menuTop:m.top,menuBottom:m.bottom,headerTop:h.top,headerBottom:h.bottom}})()');
  check('头部菜单不遮挡头部或触发器', menuPlacement.menuTop >= menuPlacement.headerBottom - .5 || menuPlacement.menuBottom <= menuPlacement.headerTop + .5, menuPlacement);
  await screenshot('tool-panel-240-menu');
  await execute('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))');
  check('Escape 关闭更多菜单并恢复焦点', await execute('document.getElementById("tool-more").hidden && document.activeElement.id === "tool-more-toggle"'));
  await execute('document.getElementById("tool-more-toggle").click()');
  await resize(900);
  check('放宽后隐藏的触发器不会遗留菜单', await execute('document.getElementById("tool-more").hidden && document.getElementById("tool-more-toggle").getAttribute("aria-expanded") === "false"'));
  await execute('window.toolProbe.state("ordinary")'); await resize(900);
  await execute('document.getElementById("tool-more-toggle").click()'); await resize(240);
  check('菜单收窄后仍受工具区边界约束', await execute('(()=>{const menu=document.getElementById("tool-more"),r=menu.getBoundingClientRect(),w=document.getElementById("tool-workspace").getBoundingClientRect();return !menu.hidden && r.left>=w.left && r.right<=w.right && r.top>=w.top && r.bottom<=w.bottom})()'));
  await execute('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}));window.toolProbe.state("empty")'); await settle();
  results.push(...await execute('(' + inspect.toString() + ')(240,"empty")'));
  await execute('window.toolProbe.state("batch-error")'); await settle();
  results.push(...await execute('(' + inspect.toString() + ')(240,"batch-error")'));
  check('仅点击执行、复制与中断的内存替身，未调用其他桥', await execute('window.toolProbe.calls.length === 3 && window.toolProbe.calls.every(name => ["executeToolJson","copyToolResults","stopToolCommand"].includes(name))'));
  const current = await execute('(' + measureResultRendering.toString() + ')()');
  const baselineWindow = new BrowserWindow({ show: false, width: 1220, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await baselineWindow.loadFile(html);
    await baselineWindow.webContents.executeJavaScript('(' + setupFixture.toString() + ')()');
    const baselineRevision = '5286f26628e03e71d08c1bdcba8d62ecf3011c48';
    const baselineHarness = require('node:child_process').execFileSync('git', ['show', baselineRevision + ':src/renderer/toolHarness.js'], { cwd: root, encoding: 'utf8', windowsHide: true });
    for (const name of ['toolResultPresentation', 'toolExecutionClock', 'toolPanelLayout', 'toolJsonPanel', 'toolAttention', 'toolCompletionSound', 'toolHarness']) {
      await baselineWindow.webContents.executeJavaScript(name === 'toolHarness' ? baselineHarness : fs.readFileSync(path.join(root, 'src/renderer/' + name + '.js'), 'utf8'));
    }
    await baselineWindow.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 20))');
    resultRendering = { baselineRevision, baseline: await baselineWindow.webContents.executeJavaScript('(' + measureResultRendering.toString() + ')()'), current };
  } finally { baselineWindow.destroy(); }
  check('大结果折叠时不创建正文或序列化整批', current.initial.fullResult === 0 && current.initial.fullBatch === 0);
  check('50次克隆广播不创建节点或序列化整批', current.clonedBroadcasts.created === 0 && current.clonedBroadcasts.fullBatch === 0 && current.clonedBroadcasts.fullResult === 0);
  check('20次其他行进度保持节点、焦点与选区且不序列化未变详情', Object.values(current.preserved).every(Boolean) && current.otherRowProgress.fullBatch === 0 && current.otherRowProgress.fullResult === 0);
  check('展开行变化只序列化自身并安全显示最新输出', current.changedOpenResult.fullResult === 1 && current.changedOpenResult.fullBatch === 0 && current.safeLatest);
  check('收起移除大正文且新批不继承展开状态', current.releasedClosedBody && current.freshBatchClosed);
  check('离线验证没有网络请求', network.length === 0);
  finish();
}).catch(finish);
