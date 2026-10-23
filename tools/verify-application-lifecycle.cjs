/** 真实应用离线生命周期验收：隔离资料、无官网/CDP/浏览器驱动。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.split('=').slice(1).join('=');

if (!process.versions.electron) {
  (async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-lifecycle-'));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const samples = [];
    try {
      // 同一资料目录连续打开，验证正常退出释放实例锁而非换 profile 绕过。
      for (const scenario of ['quit', 'tray', 'restart', 'cleanup-retry']) {
        const result = await new Promise(resolve => {
          const child = spawn(require('electron'), [__filename, '--scenario=' + scenario, '--profile=' + directory], { cwd: root, env, windowsHide: true });
          let output = ''; let error = '';
          const timer = setTimeout(() => {
            error += '\n真实应用退出超时';
            if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
          }, 55000);
          child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
          child.on('error', failure => { error += failure.message; });
          child.on('close', code => { clearTimeout(timer); resolve({ scenario, code, output, error }); });
        });
        const file = path.join(directory, scenario + '.json');
        const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { pass: false };
        if (scenario === 'tray' && fs.existsSync(path.join(directory, 'command.pid'))) {
          const pid = Number(fs.readFileSync(path.join(directory, 'command.pid'), 'utf8'));
          let alive = true; try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
          report.checks ??= [];
          report.checks.push({ name: '应用退出后所属真实命令进程已消失', pass: !alive, pid });
          report.pass &&= !alive;
        }
        samples.push({ ...result, ...report });
      }
      const report = { scope: 'offline-development-real-application', pass: samples.every(sample => sample.pass && sample.code === 0), samples };
      const output = path.join(os.tmpdir(), 'mini-lifecycle-report-' + process.pid + '.json');
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ pass: report.pass, samples: samples.length, checks: samples.reduce((sum, sample) => sum + (sample.checks?.length || 0), 0), report: output }));
      if (!report.pass) console.error(JSON.stringify(samples.filter(sample => !sample.pass || sample.code !== 0), null, 2));
      process.exitCode = report.pass ? 0 : 1;
    } finally {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('mini-lifecycle-'));
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BaseWindow, Menu, dialog, webContents } = require('electron');
  const directory = option('profile'); const scenario = option('scenario');
  app.setPath('userData', directory);
  const page = path.join(directory, 'offline.html'); fs.writeFileSync(page, '<!doctype html><title>Offline lifecycle fixture</title><p>Offline</p>');
  process.env.MINI_AI_IDE_TARGET_URL = require('node:url').pathToFileURL(page).href;
  app.on('web-contents-created', (_event, contents) => {
    contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  });
  if (scenario === 'second') {
    require(path.join(root, 'dist/main/index.js'));
  } else {
    const checks = []; let window; let ready = false; let expectedQuit = false; let questions = 0; let cleanupFailures = 0;
    const check = (name, pass, observed) => { checks.push({ name, pass: Boolean(pass), observed }); if (!pass) throw new Error(name + ': ' + JSON.stringify(observed)); };
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async predicate => { for (let n = 0; n < 400; n++) { if (await predicate()) return; await pause(50); } throw new Error('等待生命周期状态超时'); };
    dialog.showMessageBox = async (_parent, options) => {
      if (options.title === '未保存的修改') { questions++; return { response: questions === 1 ? 2 : 1 }; }
      if (scenario === 'cleanup-retry' && options.message === '关闭或退出失败，请重试') { cleanupFailures++; return { response: 0 }; }
      throw new Error('意外对话框：' + options.message);
    };
    const project = path.join(directory, 'project'); fs.mkdirSync(project, { recursive: true });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    const writeReport = () => fs.writeFileSync(path.join(directory, scenario + '.json'), JSON.stringify({ pass: ready && expectedQuit && checks.every(item => item.pass), checks }, null, 2));
    const fail = error => { checks.push({ name: String(error.stack || error), pass: false }); writeReport(); app.exit(1); };
    process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
    app.on('will-quit', () => {
      checks.push({ name: '最终退出前释放全部WebContents', pass: webContents.getAllWebContents().every(contents => contents.isDestroyed()), observed: webContents.getAllWebContents().map(contents => contents.getURL()) });
      writeReport();
    });
    app.whenReady().then(async () => {
      await wait(() => BaseWindow.getAllWindows().length > 0); window = BaseWindow.getAllWindows()[0];
      let editor;
      await wait(async () => {
        editor = webContents.getAllWebContents().find(contents => /\/index\.html$/.test(contents.getURL()));
        return editor && await editor.executeJavaScript('Boolean(window.editorBridge && window.monaco && document.querySelector(".monaco-editor"))').catch(() => false)
          && webContents.getAllWebContents().some(contents => /\/preview\.html$/.test(contents.getURL()));
      });
      ready = true;
      const settingsMenu = Menu.getApplicationMenu().items.find(item => item.label === '设置').submenu;
      const behavior = settingsMenu.items.find(item => item.label === '关闭主窗口时').submenu;
      check('设置菜单具有直接退出和缩小至托盘两项', behavior.items.length === 2);
      if (scenario === 'tray') {
        behavior.items[1].click();
        check('托盘偏好已保存', JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8')).closeBehavior === 'tray');
        const script = path.join(project, 'running.ps1');
        const pidFile = path.join(directory, 'command.pid');
        fs.writeFileSync(script, `[System.IO.File]::WriteAllText('${pidFile.replaceAll("'", "''")}', $PID.ToString())\nwhile ($true) { Start-Sleep -Seconds 1 }`);
        await wait(() => webContents.getAllWebContents().some(contents => contents.getURL() === process.env.MINI_AI_IDE_TARGET_URL && !contents.isLoading()));
        await editor.executeJavaScript('window.editorBridge.chooseRoot()');
        await editor.executeJavaScript('window.editorBridge.setToolConfig({permission:"full",automatic:false,autoCopyResults:false})');
        const batch = { protocol_version: 1, batch_id: 'lifecycle-command', requests: [{ id: 'running', tool: 'run_command', args: { command: "& '" + script.replaceAll("'", "''") + "'", shell: 'powershell', background: true, timeout_ms: 30000 } }] };
        const accepted = await editor.executeJavaScript('window.editorBridge.executeToolJson(' + JSON.stringify(JSON.stringify(batch)) + ')');
        check('真实工具入口接受隔离项目后台命令', accepted.ok, accepted);
        try { await wait(() => fs.existsSync(pidFile)); }
        catch (error) { throw new Error(error.message + ': ' + JSON.stringify(await editor.executeJavaScript('window.editorBridge.getToolState()'))); }
        const identities = webContents.getAllWebContents().map(contents => contents.id);
        window.close(); await pause(200);
        check('真实关闭隐藏窗口但保留全部原视图', !window.isVisible() && !window.isDestroyed() && identities.every(id => webContents.fromId(id)));
        check('隐藏后所属真实后台命令继续运行', await editor.executeJavaScript('window.editorBridge.getToolState().then(state=>state.hasRunningProcesses)'));
        const child = spawn(process.execPath, [__filename, '--scenario=second', '--profile=' + directory], { cwd: root, env: process.env, windowsHide: true });
        await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('二次启动失败：' + code))); });
        await wait(() => window.isVisible());
        check('真实二次启动恢复同一窗口', BaseWindow.getAllWindows().includes(window) && identities.every(id => webContents.fromId(id)));
      } else if (scenario === 'restart') {
        check('退出后同资料目录可立即重启并恢复偏好', behavior.items[1].checked);
      } else if (scenario === 'cleanup-retry') {
        const preview = webContents.getAllWebContents().find(contents => /\/preview\.html$/.test(contents.getURL()));
        const original = preview.close.bind(preview);
        // 一个真实视图拒绝关闭，其他视图实际销毁，等待产品5秒超时。
        preview.close = () => {};
        app.quit(); await wait(() => cleanupFailures === 1);
        check('视图部分释放后失败仍保留可操作编辑器和主窗口', !editor.isDestroyed() && !window.isDestroyed() && window.isEnabled() && window.isVisible());
        preview.close = original;
        const [width, height] = window.getSize(); window.setSize(width + 1, height); await pause(100);
        check('部分销毁后调整窗口不重入已释放视图的布局', !editor.isDestroyed() && !window.isDestroyed());
      } else {
        check('首次默认缩小至托盘', behavior.items[1].checked);
        behavior.items[0].click();
        // 经过实际编辑器IPC报告脏文件，验证取消退出不销毁任何视图。
        const { ipcMain } = require('electron');
        ipcMain.emit('editor:state', { sender: editor, senderFrame: editor.mainFrame }, { root: null, path: 'draft.txt', documents: [{ path: 'draft.txt', dirty: true }] });
        window.close(); await wait(() => questions === 1); await pause(100);
        check('未保存取消后窗口和编辑器仍可用', !window.isDestroyed() && window.isEnabled() && !editor.isDestroyed());
      }
      expectedQuit = true;
      if (scenario === 'quit') window.close(); else app.quit();
    }).catch(fail);
    require(path.join(root, 'dist/main/index.js'));
  }
}
