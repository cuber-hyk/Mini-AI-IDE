/** 离线原生启动时序验证；只加载项目本地页面，不连接官网或用户资料。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const childMode = process.argv.includes('--startup-sequence-child');
const option = (name, fallback) => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3) || fallback;
if (!childMode) {
  void (async () => {
  const { spawn, spawnSync } = require('node:child_process');
  const electron = require('electron');
  const mode = option('mode', 'verify');
  const count = Number(option('samples', mode === 'measure' ? '3' : '1'));
  const output = option('output', path.join(os.tmpdir(), 'mini-editor-startup-' + mode + '.json'));
  const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
  const allCases = mode === 'measure' ? Array.from({ length: count }, () => 'normal') : ['normal', 'delayed-open', 'delayed-close', 'retry-once', 'retry-exhausted', 'dirty-close', 'failure-cancel', 'stale-switch', 'layout-collapsed', 'layout-preview'];
  const selected = option('case'); const cases = selected ? allCases.filter(scenario => scenario === selected) : allCases;
  if (!cases.length) throw new Error('Unknown startup verification case');
  const run = args => new Promise(resolve => {
    const child = spawn(electron, args, { cwd:path.resolve(__dirname,'..'), windowsHide:true, env:childEnv, stdio:['ignore','pipe','pipe'] });
    let stdout=''; let stderr=''; let error; let stopped=false;
    const stop = reason => { if(stopped) return; stopped=true; error=reason; if(child.pid) { const killed=spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,encoding:'utf8'}); if(killed.status !== 0) child.kill(); } };
    const timer=setTimeout(()=>stop(new Error('启动原生用例超过60秒，已终止本次子进程树')),60000);
    const receive = key => chunk => { if(key==='stdout') stdout+=chunk; else stderr+=chunk; if(stdout.length+stderr.length>4*1024*1024) stop(new Error('启动原生用例输出超过4MiB')); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data',receive('stdout')); child.stderr.on('data',receive('stderr'));
    child.on('error',failure=>{error=failure;});
    child.on('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr,error});});
  });
  const samples = [];
  for (const [sample, scenario] of cases.entries()) {
    const reportPath = path.join(os.tmpdir(), 'mini-startup-sequence-' + process.pid + '-' + sample + '.json');
    const appFlags = ['dirty-close','failure-cancel','stale-switch'].includes(scenario) ? [] : ['--workspace-probe','--startup-only'];
    const result = await run([__filename, '--startup-sequence-child', ...appFlags, '--mode=' + mode, '--scenario=' + scenario, '--report=' + reportPath]);
    let report;
    try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { report = { pass: false, error: String(result.error || result.stderr || result.stdout) }; }
    if (!report.temporaryDirectory && fs.existsSync(reportPath + '.profile')) report.temporaryDirectory = fs.readFileSync(reportPath + '.profile','utf8');
    report.exitStatus = result.status; report.stderr = result.stderr; report.stdout = result.stdout;
    report.expectedExitStatus = scenario === 'retry-exhausted' ? 2 : 0;
    samples.push(report);
    fs.rmSync(reportPath, { force: true }); fs.rmSync(reportPath + '.profile', { force:true });
    if (report.temporaryDirectory) {
      const resolved = path.resolve(report.temporaryDirectory); const temporaryRoot = path.resolve(os.tmpdir());
      if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('mini-workspace-probe-')) throw new Error('拒绝清理非本次探针目录');
      fs.rmSync(resolved, { force: true, recursive: true, maxRetries:8, retryDelay:150 });
    }
  }
  const median = key => { const values = samples.filter(sample => sample.scenario === 'normal').map(sample => sample[key]).filter(Number.isFinite).sort((a,b) => a-b); return values.length ? values[Math.floor(values.length / 2)] : null; };
  const report = { mode, scope: 'offline-development-fresh-profile', limits: '实际本地应用启动；主进程计时从测试装载入口开始；Monaco ready 使用真实 mini-editor-ready mark。排除构建与模块导入之前的进程启动，不代表安装版冷/热启动。', samples, median: { mainToMonacoReadyMs: median('mainToMonacoReadyMs'), rendererNavigationToEditorReadyMs: median('rendererNavigationToEditorReadyMs') }, pass: samples.every(sample => sample.pass && sample.exitStatus === sample.expectedExitStatus) };
  fs.writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, pass: report.pass, median: report.median, samples: samples.length, checks: samples.reduce((sum, sample) => sum + (sample.checks?.length || 0), 0) })); process.exitCode = report.pass ? 0 : 1;
  })().catch(error => { console.error(error); process.exitCode=1; });
} else {
  const { app, BaseWindow, ipcMain, dialog } = require('electron');
  const handlers = new Map(); const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); return originalHandle(channel, handler); };
  const started = performance.now(); const loads = []; const checks = []; const rendererErrors = []; const actions = [];
  const mode = option('mode', 'verify'); const scenario = option('scenario', 'normal'); const reportPath = option('report');
  const originalSetPath=app.setPath.bind(app);
  app.setPath=(name,value)=>{ originalSetPath(name,value); if(name==='userData') fs.writeFileSync(reportPath + '.profile',value); };
  let editor; let prompt; let webbar; let preview; let earlyLayoutState; let mainToMonacoReadyMs = null; let rendererNavigationToEditorReadyMs = null; let output = ''; let stderr = ''; let promptAttempts = 0; let interaction = Promise.resolve(); let promptLoadedAt = null;
  const normalLifecycle = ['dirty-close','failure-cancel','stale-switch'].includes(scenario);
  const fixtureDirectory = normalLifecycle ? fs.mkdtempSync(path.join(os.tmpdir(), 'mini-workspace-probe-')) : null;
  const dirtyQuestions = []; const errorDialogs = []; const externalRequests = [];
  if (normalLifecycle) {
    app.setPath('userData', fixtureDirectory);
    const root = path.join(fixtureDirectory, 'project'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'draft.txt'), 'saved original');
    fs.writeFileSync(path.join(fixtureDirectory, 'settings.json'), JSON.stringify({ lastRoot:scenario === 'stale-switch' ? path.join(fixtureDirectory,'missing-root') : root, recentRoots:[root], workspaceRoots:[root] }));
    dialog.showMessageBox = async (_window, options) => { if (options.title === '未保存的修改') dirtyQuestions.push(options.message); else errorDialogs.push(options.message); return { response: options.title === '未保存的修改' ? 2 : 0, checkboxChecked:false }; };
    dialog.showOpenDialog = async () => ({ canceled:false, filePaths:[root] });
    dialog.showErrorBox = (title, content) => errorDialogs.push(title + ': ' + content);
  }
  const check = (name, pass, observed) => checks.push({ name, pass: Boolean(pass), ...(observed !== undefined ? { observed } : {}) });
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function(chunk, ...args) { output += String(chunk); return originalWrite(chunk, ...args); };
  const originalErrorWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function(chunk, ...args) { stderr += String(chunk); return originalErrorWrite(chunk, ...args); };
  const originalExit = app.exit.bind(app);
  app.exit = function(code = 0) {
    void interaction.then(async () => {
      const marker = '===== 启动与文件树探针 ====='; const raw = output.slice(output.lastIndexOf(marker) + marker.length).trim(); let probe;
      try { probe = JSON.parse(raw); } catch { probe = null; }
      if (normalLifecycle) {
        check('正常模式未访问官网网络', externalRequests.length === 0, externalRequests);
      } else if (scenario === 'retry-exhausted') {
        check('辅助页面失败4次后明确启动失败', code === 2 && promptAttempts === 4 && /加载 prompt.html 连续 4 次失败/.test(stderr), { code, promptAttempts });
        check('辅助失败不妨碍编辑器先实际就绪', Number.isFinite(mainToMonacoReadyMs));
      } else {
        check('已有真实启动和文件打开探针通过', probe?.pass, probe?.checks);
        check('实际Monaco就绪里程碑已捕获', Number.isFinite(mainToMonacoReadyMs) && Number.isFinite(rendererNavigationToEditorReadyMs));
      }
      if (mode !== 'measure') check('编辑器在辅助页之前开始加载', loads.filter(load => ['index.html','prompt.html','webbar.html','preview.html'].includes(load.file))[0]?.file === 'index.html', loads.map(load => load.file));
      if (scenario === 'layout-collapsed') check('辅助加载后顶栏恢复入口及工作区开关反映早期收起状态', await webbar.executeJavaScript("!document.getElementById('btn-file-restore').hidden && document.getElementById('btn-workspace-toggle').getAttribute('aria-pressed') === 'false'"));
      if (scenario === 'layout-preview') {
        const geometry = await preview.executeJavaScript("({now:Number(document.getElementById('pv-resizer').getAttribute('aria-valuenow')),max:Number(document.getElementById('pv-resizer').getAttribute('aria-valuemax')),expandDisabled:document.getElementById('pv-expand').disabled})");
        check('辅助加载后差异预览采用当前真实宽度与展开上限', geometry.now === Math.round(earlyLayoutState.previewWidth) && geometry.max === Math.round(earlyLayoutState.previewMaxWidth) && geometry.expandDisabled === (earlyLayoutState.previewMaxWidth <= earlyLayoutState.previewWidth + 1), { geometry, expected:{width:earlyLayoutState.previewWidth,max:earlyLayoutState.previewMaxWidth} });
      }
      if (scenario === 'retry-once') check('辅助页面单次故障保留重试且不重载编辑器', promptAttempts === 2 && loads.filter(load => load.file === 'index.html').length === 1 && /第 1\/4 次加载失败/.test(stderr));
      if (scenario.startsWith('delayed-')) {
        check('辅助延迟期间实际Monaco已就绪', Number.isFinite(mainToMonacoReadyMs) && mainToMonacoReadyMs < promptLoadedAt, { mainToMonacoReadyMs, promptLoadedAt });
        check('早期开面板等待同一个加载且最终状态准确', actions.includes('hidden-before-ready') && (scenario === 'delayed-open' ? actions.includes('open-accepted') && actions.includes('visible-after-ready') : actions.includes('open-cancelled') && actions.includes('hidden-after-close')), actions);
        check('提示词页面只加载一次', promptAttempts === 1);
      }
      check('启动期间无缺失IPC或未处理应用渲染器错误', rendererErrors.every(error => error.message === 'Uncaught [object Event]' && /\/vendor\/monaco\/vs\/editorWorkerHost-[^/]+\.js$/.test(error.source)), rendererErrors);
      fs.writeFileSync(reportPath, JSON.stringify({ scenario, pass: checks.every(item => item.pass), checks, loads, mainToMonacoReadyMs, rendererNavigationToEditorReadyMs, probeTiming: probe?.timing, temporaryDirectory: app.getPath('userData'), rendererErrors }, null, 2));
      originalExit(code);
    }).catch(error => { fs.writeFileSync(reportPath, JSON.stringify({ scenario, pass: false, error: String(error.stack || error), checks, loads, temporaryDirectory: app.getPath('userData') }, null, 2)); originalExit(1); });
  };
  app.on('web-contents-created', (_event, contents) => {
    if (path.basename(contents.getLastWebPreferences().preload || '') === 'promptPreload.js') prompt = contents;
    if (normalLifecycle) {
      BaseWindow.getAllWindows().forEach(window => window.hide());
      contents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (details, callback) => { externalRequests.push(details.url); callback({cancel:true}); });
      const originalLoadURL = contents.loadURL.bind(contents);
      contents.loadURL = (url, ...args) => /^https?:/.test(url) ? originalLoadURL('about:blank') : originalLoadURL(url, ...args);
    }
    const originalLoadFile = contents.loadFile.bind(contents);
    contents.loadFile = async function(target, options) {
      if (path.dirname(path.resolve(target)) !== path.resolve(__dirname, '..', 'dist', 'renderer')) return originalLoadFile(target, options);
      const file = path.basename(target); const load = { file, startMs: performance.now() - started }; loads.push(load);
      if (file === 'index.html') editor = contents;
      if (file === 'webbar.html') webbar = contents;
      if (file === 'preview.html') preview = contents;
      if (file === 'prompt.html') {
        prompt = contents; promptAttempts++;
        if (scenario === 'retry-exhausted' || scenario === 'failure-cancel' || (scenario === 'retry-once' && promptAttempts === 1)) { await pause(450); load.endMs = performance.now() - started; load.injectedFailure = true; throw new Error('startup fixture: injected local page failure'); }
        if (scenario.startsWith('delayed-') || scenario === 'dirty-close' || scenario === 'stale-switch') await pause(2400);
      }
      try { const result = await originalLoadFile(target, options); if (file === 'index.html' && scenario === 'stale-switch') await interaction; return result; } finally { load.endMs = performance.now() - started; if (file === 'prompt.html') promptLoadedAt = load.endMs; }
    };
    contents.on('console-message', event => { if (/No handler registered|Unhandled|Uncaught/i.test(event.message || '')) rendererErrors.push({ message: event.message, source: event.sourceId, line: event.lineNumber }); });
    contents.on('did-finish-load', () => {
      if (contents !== editor) return;
      const mainWindow = BaseWindow.getAllWindows()[0];
      if (mode !== 'measure') check('编辑器页面加载时窗口关闭与退出守卫已注册', mainWindow.listenerCount('close') > 0 && app.listenerCount('before-quit') > 0, { close: mainWindow.listenerCount('close'), beforeQuit: app.listenerCount('before-quit') });
      void contents.executeJavaScript(`new Promise(resolve => {
        const read = () => { const entry = performance.getEntriesByName('mini-editor-ready','mark')[0]; if (entry) { resolve(entry.startTime); return true; } return false; };
        if (read()) return; const observer = new PerformanceObserver(() => { if (read()) observer.disconnect(); }); observer.observe({type:'mark', buffered:true});
      })`).then(value => { rendererNavigationToEditorReadyMs = value; mainToMonacoReadyMs = performance.now() - started; });
      interaction = (async () => {
        const initial = await contents.executeJavaScript(`Promise.all([window.editorBridge.getRoot(),window.editorBridge.getToolState(),window.editorBridge.getLocalPromptOptions(),window.editorBridge.getPromptStatus()])`);
        check('编辑器首次导航所需工作区工具需求和提示词IPC均已可用', Array.isArray(initial) && initial.length === 4);
        if (scenario.startsWith('layout-')) {
          earlyLayoutState = await contents.executeJavaScript(scenario === 'layout-collapsed' ? "window.editorBridge.setWorkspaceLayout({fileVisible:false,workspaceVisible:false})" : "window.editorBridge.setWorkspaceLayout({previewVisible:true,fileWidth:970,treeWidth:173,workspaceVisible:false})");
          check('辅助加载前通过真实布局IPC改变初始布局', promptLoadedAt === null); return;
        }
        if (scenario === 'stale-switch') {
          const current = await contents.executeJavaScript("window.__startupStaleCount=0; window.editorBridge.onRootStale(()=>window.__startupStaleCount++); window.editorBridge.chooseRoot()");
          check('启动恢复失效后辅助加载前可选择新项目', current.root === path.join(fixtureDirectory,'project') && promptLoadedAt === null);
          void (async () => {
            for (let attempt = 0; attempt < 180 && !loads.some(load => load.file === 'preview.html' && Number.isFinite(load.endMs)); attempt++) await pause(40);
            await pause(120);
            check('辅助页面均已完成后再核验旧恢复通知', ['prompt.html','webbar.html','preview.html'].every(file => loads.some(load => load.file === file && Number.isFinite(load.endMs))));
            check('旧恢复失效通知不覆盖新项目根目录和树', await contents.executeJavaScript("window.editorBridge.getRoot().then(state=>state.root === " + JSON.stringify(path.join(fixtureDirectory,'project')) + " && window.__startupStaleCount === 0 && Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"draft.txt\"]')))")); app.exit(0);
          })(); return;
        }
        if (normalLifecycle) {
          const waitUntil = async predicate => { for(let i=0;i<140;i++){ if(await predicate()) return true; await pause(40); } return false; };
          if (!await waitUntil(() => contents.executeJavaScript("Boolean(window.monaco?.editor.getEditors()[0] && document.querySelector('#tree .tree-row[data-rel-path=\"draft.txt\"]'))"))) throw new Error('fixture editor/root not ready');
          await contents.executeJavaScript("document.querySelector('#tree .tree-row[data-rel-path=\"draft.txt\"]').click()");
          if (!await waitUntil(() => contents.executeJavaScript("window.monaco.editor.getEditors()[0].getModel()?.getValue() === 'saved original'"))) throw new Error('fixture file not opened');
          await contents.executeJavaScript("window.monaco.editor.getEditors()[0].getModel().setValue('unsaved fixture draft')"); await pause(100);
          check('辅助页仍未就绪时可以真实打开并编辑文件', promptLoadedAt === null && await contents.executeJavaScript("window.monaco.editor.getEditors()[0].getModel().getValue() === 'unsaved fixture draft'"));
          if (scenario === 'dirty-close') mainWindow.close();
          if (!await waitUntil(() => Promise.resolve(dirtyQuestions.length > 0))) throw new Error('dirty close confirmation absent');
          await pause(120);
          check(scenario === 'dirty-close' ? '辅助加载期间关闭窗口经过未保存确认，取消后保留真实草稿' : '辅助连续失败仍经过未保存确认，取消退出后保留真实草稿', !mainWindow.isDestroyed() && await contents.executeJavaScript("window.monaco.editor.getEditors()[0].getModel().getValue() === 'unsaved fixture draft'") && fs.readFileSync(path.join(fixtureDirectory,'project','draft.txt'),'utf8') === 'saved original', dirtyQuestions);
          if (scenario === 'failure-cancel') check('辅助失败已明确报告4次且未强制退出', promptAttempts === 4 && /加载 prompt.html 连续 4 次失败/.test(stderr) && errorDialogs.length > 0, errorDialogs);
          setImmediate(() => app.exit(0)); return;
        }
        if (!scenario.startsWith('delayed-')) return;
        const findPromptView = () => mainWindow.contentView.children.find(view => view.webContents === prompt);
        const earlyOpen = contents.executeJavaScript('window.editorBridge.openPromptPanel()');
        await pause(120);
        if (!findPromptView()?.getVisible()) actions.push('hidden-before-ready');
        if (scenario === 'delayed-close') {
          // 使用真实受限提示词桥的同一IPC通道；页面未导航前无法从该preload调用。
          const handler = handlers.get('ui:close-prompt-panel');
          if (!handler) throw new Error('close prompt handler absent');
          await handler({ sender: prompt, senderFrame: prompt.mainFrame }); actions.push('close-requested');
        }
        const accepted = await earlyOpen; if (accepted?.ok === true) actions.push('open-accepted'); else if (accepted?.ok === false) actions.push('open-cancelled');
        await pause(120);
        if (scenario === 'delayed-open' && findPromptView()?.getVisible()) actions.push('visible-after-ready');
        if (scenario === 'delayed-close' && !findPromptView()?.getVisible()) actions.push('hidden-after-close');
      })();
    });
  });
  require('../dist/main/index.js');
}
