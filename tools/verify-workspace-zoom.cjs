/** 隔离运行本地IDE布局探针，记录原生窗口生命周期与CSS视口；不操作官网。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const option = (name, fallback) => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3) ?? fallback;
if (!process.versions.electron) {
  const { spawn, spawnSync } = require('node:child_process');
  const output = option('output', path.join(os.tmpdir(), 'mini-workspace-zoom.json'));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => { if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }, 180000);
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('close', code => {
    clearTimeout(timer);
    fs.writeFileSync(output + '.log', stdout + '\n' + stderr);
    let report; try { report = JSON.parse(fs.readFileSync(output, 'utf8')); } catch { report = { error: stderr, pass: false }; }
    console.log(JSON.stringify({ output, code, pass: report.pass, samples: report.samples?.map(value => ({ scenario: value.scenario, pass: value.pass, geometryPassed: value.report.ok, cases: value.report.cases.length, error: value.report.error })) }));
    if (code !== 0 || !report.pass) process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const probe = require('../dist/main/layoutProbe.js'); const original = probe.runLayoutProbe;
  const samples = []; const delay = time => new Promise(resolve => setTimeout(resolve, time));
  const output = option('output', path.join(os.tmpdir(), 'mini-workspace-zoom.json'));
  const scenarios = option('scenarios', 'foreground,covered,minimized,restored,capture-empty,capture-rejected,capture-timeout,capture-transient,capture-exhausted,capture-output').split(',');
  const allowed = ['foreground', 'covered', 'minimized', 'restored', 'capture-empty', 'capture-rejected', 'capture-timeout', 'capture-transient', 'capture-exhausted', 'capture-output'];
  if (scenarios.some(scenario => !allowed.includes(scenario))) throw new Error('未知布局检查场景');
  const rounds = Number(option('rounds', '1'));
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error('rounds仅允许1至3');
  probe.runLayoutProbe = async input => {
    for (let round = 0; round < rounds; round++) {
    for (const scenario of scenarios) {
      let cover;
      if (scenario === 'minimized') input.win.minimize();
      else { input.win.restore(); input.win.show(); input.win.focus(); }
      if (scenario === 'covered') {
        cover = new BrowserWindow({ ...input.win.getBounds(), show: true, alwaysOnTop: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
        await cover.loadURL('data:text/html,<title>本地布局遮挡检查</title><body style="background:%23141414;color:white">本地离线布局检查</body>');
        cover.focus();
      }
      await delay(300);
      const priorCapture = input.editor.webContents.capturePage;
      let captureAttempts = 0;
      let recovery;
      if (scenario === 'restored') {
        for (let attempt = 0; attempt < 20; attempt++) {
          const native = input.editor.getBounds(); const zoom = input.editor.webContents.getZoomFactor();
          const css = await input.editor.webContents.executeJavaScript(`(() => { const d=document.getElementById('collaboration-dock').getBoundingClientRect(); return [innerWidth,innerHeight,d.right,d.bottom]; })()`);
          recovery = { native, zoom, css, withoutCapture: true, pass: Math.abs(css[0] * zoom - native.width) <= zoom * 2 && Math.abs(css[1] * zoom - native.height) <= zoom * 2 && css[2] <= css[0] + 1 && css[3] <= css[1] + 1 };
          if (recovery.pass) break;
          await delay(100);
        }
      }
      if (scenario === 'capture-empty') input.editor.webContents.capturePage = async () => ({ isEmpty: () => true });
      if (scenario === 'capture-rejected') input.editor.webContents.capturePage = async () => { throw new Error('fixture_capture_rejected'); };
      if (scenario === 'capture-timeout') input.editor.webContents.capturePage = () => new Promise(() => {});
      if (scenario === 'capture-transient' || scenario === 'capture-exhausted') input.editor.webContents.capturePage = async (...args) => {
        captureAttempts++;
        if (scenario === 'capture-exhausted' || captureAttempts === 1) throw new Error('UnknownVizError');
        return priorCapture.apply(input.editor.webContents, args);
      };
      let report;
      try { report = await original({ ...input, captureDirectory: scenario === 'capture-output' ? output + '.frames' : undefined }); }
      finally { input.editor.webContents.capturePage = priorCapture; cover?.destroy(); }
      const expected = { minimized: 'window_not_presentable', 'capture-empty': 'layout_capture_empty', 'capture-rejected': 'fixture_capture_rejected', 'capture-timeout': 'layout_capture_timeout', 'capture-exhausted': 'UnknownVizError' }[scenario];
      const pass = (expected ? !report.ok && report.error === expected && report.cases.length === 0 : report.ok && (!recovery || recovery.pass)) &&
        (scenario !== 'capture-exhausted' || captureAttempts === 3) && (scenario !== 'capture-transient' || report.captureFailures.includes('UnknownVizError') && captureAttempts > 1) &&
        (scenario !== 'capture-output' || report.cases.length === 10 && report.cases.every(value => value.screenshot && fs.statSync(value.screenshot).size > 0));
      samples.push({ scenario, round, pass, report, captureAttempts, ...(recovery ? { recovery } : {}) });
      const hash = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex');
      fs.writeFileSync(output, JSON.stringify({ pass: samples.length === scenarios.length * rounds && samples.every(value => value.pass), samples, sourceSha256: hash('src/main/layoutProbe.ts'), compiledSha256: hash('dist/main/layoutProbe.js'), runtime: process.versions, scope: 'isolated-real-ide-layout', limits: '遮挡场景核验显式截图采样后的布局；最小化仅验证拒绝几何采样，恢复前检查不调用capturePage。故障注入要求明确失败，不能称为几何通过。' }, null, 2));
    }
    }
    return { ok: samples.every(value => value.pass), cases: samples.flatMap(value => value.report.cases) };
  };
  if (!process.argv.includes('--ui-probe')) process.argv.push('--ui-probe');
  require('../dist/main/index.js');
}
