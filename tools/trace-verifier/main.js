/**
 * P0a 自动化特征核验台 —— 主进程
 *
 * 目标：在**默认 Electron 构建、未打补丁、未伪装**的条件下，逐项核验 A 级自动化特征，
 *      并如实记录 B 级（与真 Chrome 的差异，仅留档不作为修补目标）。
 *
 * 硬边界遵守情况：
 *  - 不使用 CDP / remote-debugging，并把它当作 A 级判据之一核验；
 *  - 不向页面写入任何内容（不注入伪装脚本、不改 DOM、不派发合成事件）；
 *  - 不通过 Node 发起业务网络请求：页面经 localhost HTTP 提供，由 Chromium 自身加载；
 *    主进程只起一个本地静态服务（不是对外网络请求）。
 */
const { app, BaseWindow, WebContentsView, ipcMain } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PARTITION = 'persist:trace-verifier';
const OUT_PATH = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) || null;
const CAPTURE_HEADERS = true;

/* ------------------------------------------------------------------ *
 * 一、本地静态服务：让页面经 HTTP 加载，从而能观测真实请求头（B 级证据）
 * ------------------------------------------------------------------ */
function startLocalServer() {
  const files = {
    '/': ['probe.html', 'text/html; charset=utf-8'],
    '/probe.html': ['probe.html', 'text/html; charset=utf-8'],
    '/probe.js': ['probe.js', 'text/javascript; charset=utf-8'],
  };
  const server = http.createServer((req, res) => {
    const entry = files[req.url.split('?')[0]];
    if (!entry) {
      res.writeHead(404).end('not found');
      return;
    }
    const [name, type] = entry;
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(__dirname, name)));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ *
 * 二、主进程侧可观测信号
 * ------------------------------------------------------------------ */
function collectMainProcessSignals(port) {
  const userDataDir = app.getPath('userData');
  const devtoolsActivePort = path.join(userDataDir, 'DevToolsActivePort');

  const argvFlags = process.argv.filter((a) => /remote-debugging|inspect|automation|headless/i.test(a));
  const declaredSwitches = [];
  for (const key of ['remote-debugging-port', 'remote-debugging-pipe', 'enable-automation', 'headless', 'disable-gpu', 'no-sandbox']) {
    if (app.commandLine.hasSwitch(key)) {
      declaredSwitches.push(`${key}=${app.commandLine.getSwitchValue(key) || 'true'}`);
    }
  }

  return {
    electron: process.versions.chrome ? process.versions.electron : null,
    chromium: process.versions.chrome || null,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: `${process.platform} ${process.arch}`,
    osRelease: os.release(),
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    userDataDir,
    // 调试端口是否真的被打开（比只看开关更硬）
    devToolsActivePortFileExists: fs.existsSync(devtoolsActivePort),
    devToolsActivePortContent: fs.existsSync(devtoolsActivePort)
      ? fs.readFileSync(devtoolsActivePort, 'utf8').trim().split('\n')
      : null,
    automationRelatedSwitches: declaredSwitches,
    argvAutomationFlags: argvFlags,
    localServerPort: port,
  };
}

/* ------------------------------------------------------------------ *
 * 三、核验流程
 * ------------------------------------------------------------------ */
async function run() {
  const { server, port } = await startLocalServer();
  const mainSignals = collectMainProcessSignals(port);

  const win = new BaseWindow({ width: 1020, height: 760, show: true, title: 'P0a 自动化特征核验台' });
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: PARTITION,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  win.contentView.addChildView(view);
  const [w, h] = win.getContentSize();
  view.setBounds({ x: 0, y: 0, width: w, height: h });

  // B 级证据：本次请求实际发出的 HTTP 头（由 Chromium 网络栈发出，非 Node）
  let capturedHeaders = null;
  if (CAPTURE_HEADERS) {
    view.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      if (!capturedHeaders && /127\.0\.0\.1|localhost/.test(details.url)) {
        capturedHeaders = { url: details.url, method: details.method, headers: details.requestHeaders };
      }
      callback({ requestHeaders: details.requestHeaders });
    });
  }

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('探针超时（30s）：页面未回报结果')), 30000);
      ipcMain.once('trace-result', (_evt, payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      view.webContents.once('did-fail-load', (_e, code, desc, url) => {
        clearTimeout(timer);
        reject(new Error(`页面加载失败 ${code} ${desc} ${url}`));
      });
      view.webContents.loadURL(`http://127.0.0.1:${port}/probe.html`);
    });
  } finally {
    server.close();
  }

  // 页面世界附加信息（只读取，不注入）
  let pageLevel = null;
  try {
    pageLevel = await view.webContents.executeJavaScript('window.__traceProbePageLevel ?? null', true);
  } catch (err) {
    pageLevel = { error: String(err) };
  }

  /* --- 追加主进程侧 A 级判据 --- */
  const ua = result.bLevel?.browserSurface?.userAgent || '';
  const uaChromiumMatch = /Chrom(e|ium)\/(\d+\.\d+\.\d+\.\d+)/.exec(ua);
  const uaMajor = uaChromiumMatch ? uaChromiumMatch[2].split('.')[0] : null;
  const kernelMajor = mainSignals.chromium ? mainSignals.chromium.split('.')[0] : null;

  result.aLevel.push(
    {
      id: 'A7',
      name: '未开启 CDP 远程调试（无调试端口）',
      pass: !mainSignals.devToolsActivePortFileExists && mainSignals.automationRelatedSwitches.every((s) => !/remote-debugging/.test(s)),
      observed: {
        devToolsActivePortFileExists: mainSignals.devToolsActivePortFileExists,
        switches: mainSignals.automationRelatedSwitches,
        argvFlags: mainSignals.argvAutomationFlags,
      },
    },
    {
      id: 'A8',
      name: 'UA 声称的内核主版本 == 实际内核主版本（无版本错乱）',
      pass: uaMajor !== null && kernelMajor !== null && uaMajor === kernelMajor,
      observed: { uaMajor, kernelMajor, chromiumFull: mainSignals.chromium, userAgent: ua },
    }
  );

  /* --- 汇总 --- */
  const aFailures = result.aLevel.filter((t) => !t.pass);
  const cFailures = result.cLevel.filter((t) => !t.pass);
  const verdict = aFailures.length === 0 && cFailures.length === 0 ? 'PASS' : 'FAIL';

  const report = {
    reportType: 'automation-trace-verification',
    phase: 'P0a',
    collectedAt: result.collectedAt,
    toolVersion: require('./package.json').version,
    environment: mainSignals,
    aLevel: result.aLevel,
    bLevel: {
      ...result.bLevel,
      pageLevel,
      requestHeaders: capturedHeaders,
      note: 'B 级为如实记录项：与真 Chrome 的差异在此留档，不作为修补目标（见 ADR-0003）',
    },
    cLevel: result.cLevel,
    summary: {
      aTotal: result.aLevel.length,
      aFailures: aFailures.map((t) => ({ id: t.id, name: t.name, observed: t.observed })),
      cFailures: cFailures.map((t) => ({ id: t.id, name: t.name, observed: t.observed })),
      verdict,
    },
  };

  const json = JSON.stringify(report, null, 2);
  process.stdout.write(`\n===== P0a 自动化特征核验结果 =====\n${json}\n`);
  if (OUT_PATH) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, json, 'utf8');
    process.stdout.write(`\n报告已写入: ${OUT_PATH}\n`);
  }

  app.exit(verdict === 'PASS' ? 0 : 1);
}

app.whenReady().then(() =>
  run().catch((err) => {
    process.stderr.write(`核验失败: ${err && err.stack ? err.stack : String(err)}\n`);
    app.exit(2);
  })
);

app.on('window-all-closed', () => app.quit());
