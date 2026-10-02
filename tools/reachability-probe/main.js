/**
 * P0b 可达性与登录实测 —— 主进程
 *
 * 目的：真实加载目标平台，记录**是否出现针对性拦截**（人机验证、风控提示、异常状态码、
 *      异常跳转、登录失败），并原样沉淀证据。这是本项目唯一的存亡关口。
 *
 * 硬边界（严格遵守 ADR-0003 零注入）：
 *  - 不向页面写入任何内容：不注入脚本到页面世界（只用 preload 做只读观察）、不改 DOM、不派发合成事件；
 *  - 不绕过任何验证：**只记录，不代答**。出现验证码就停手并如实记录；
 *  - 不使用 CDP / 远程调试，不引入任何自动化框架；
 *  - 不代写剪贴板、不模拟回车或点击。全部交互由用户手动完成。
 *
 * 稳健性设计（重要）：
 *  报告采用**增量实时落盘**（事件驱动 + 1s 去抖），并在 before-quit / will-quit /
 *  window-all-closed 三处强制落盘。因此无论用户如何结束（关窗、退出、强杀），
 *  已发生的事件都不会丢。Ctrl+S 可随时手动刷新。
 *
 * 隐私处理：
 *  - URL 只保留 origin + path（丢弃 query，避免把会话参数写进仓库）；
 *  - Cookie 只记 name 与长度，不记值。
 */
const { app, BaseWindow, WebContentsView, session, ipcMain, globalShortcut } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const TARGET_URL = process.argv.find((a) => a.startsWith('--url='))?.slice('--url='.length) || 'https://chat.deepseek.com/';
const OUT_PATH =
  process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) ||
  path.join(process.cwd(), 'p0b-report.json');
// 中性分区名（计划"待同步决策"要求：不含应用名/项目名）
const PARTITION = 'persist:neutral-profile';
// 自检模式：在**本进程内**起一个 mock 服务器，用于验证采集链路本身（不访问任何外部站点）
const SELF_TEST = process.argv.includes('--self-test');
// 分区后缀：让不同实验互不污染登录态（例如 --profile b）
const PROFILE = process.argv.find((a) => a.startsWith('--profile='))?.slice('--profile='.length) || '';
const EFFECTIVE_PARTITION = PROFILE ? `${PARTITION}-${PROFILE}` : PARTITION;

/* ------------------------------------------------------------------ *
 * 受控实验：UA 变体（--variant=noident）
 *
 * 规则：**一次只改这一个变量**。除 UA 中移除两个识别标记外，不做任何其他改动：
 *  - 不改 window.chrome（本项目禁止任何 JS 注入）；
 *  - 不改 sec-ch-ua / navigator.userAgentData（由内核生成，动不了，正好留作对照）；
 *  - 不改语言、不伪造任何指纹。
 *
 * 移除：`Electron/<ver>`（内核构建的自我披露）与 `<appName>/<ver>`（应用名）。
 * 保留：Chrome/<真实内核版本>、平台信息、WebKit/Safari —— 全部如实。
 * ------------------------------------------------------------------ */
const VARIANT = process.argv.find((a) => a.startsWith('--variant='))?.slice('--variant='.length) || '';

function applyVariant(ses) {
  const original = ses.getUserAgent();
  if (VARIANT === 'noident') {
    const cleaned = original
      .replace(/\s*Electron\/[\d.]+/i, '')
      .replace(/\s*reachability-probe\/[\d.]+/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    ses.setUserAgent(cleaned);
    return {
      applied: true,
      variant: 'noident',
      original,
      effective: cleaned,
      note: '仅移除 Electron/<ver> 与 <appName>/<ver>；其余一律未改，未做任何 JS 注入',
    };
  }
  return { applied: false, variant: 'baseline', original, effective: original };
}

/**
 * 把变体真正作用到 WebContentsView。
 *
 * 实测教训：只调用 `session.setUserAgent()` **不会**改变 WebContentsView 发出的 UA
 * （会话级设置对新建 view 不生效）。必须在创建 view 的 webPreferences 里显式传
 * `userAgent`，否则会出现"报告说改了、实际没改"的假实验。
 */
function resolveVariantUserAgent(ses) {
  const info = applyVariant(ses);
  return { info, userAgent: info.effective };
}

/* ------------------------------------------------------------------ *
 * 自检用 mock 服务器（仅 --self-test 时启动；进程内，故不受子进程网络限制影响）
 * ------------------------------------------------------------------ */
function startMockServer() {
  const challengeHtml = `<!doctype html><meta charset="utf-8"><title>mock challenge</title>
<h1>请完成安全验证</h1><p>拖动滑块以继续（这是自检用的模拟提示）</p>
<iframe src="/status?code=403" style="width:1px;height:1px;border:0"></iframe>
<iframe src="/status?code=429" style="width:1px;height:1px;border:0"></iframe>`;
  const okHtml = `<!doctype html><meta charset="utf-8"><title>mock plain</title><h1>普通页面</h1><p>无验证提示</p>`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/challenge') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(challengeHtml);
      return;
    }
    if (url.pathname === '/status') {
      res.writeHead(Number(url.searchParams.get('code') || 403)).end('synthetic');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(okHtml);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let targetHost = null;
try {
  targetHost = new URL(TARGET_URL).host;
} catch { /* 地址异常时退化为只按域名族过滤 */ }

const state = {
  startedAt: new Date().toISOString(),
  endedAt: null,
  events: [],
  requests: [],
  responses: [],
  consoleMessages: [],
  challenges: [],
};

/* ------------------------------------------------------------------ *
 * 落盘（增量 + 去抖 + 强制）
 * ------------------------------------------------------------------ */
let debounceTimer = null;
let exitWritten = false;

function buildReport() {
  return {
    reportType: 'p0b-reachability-observation',
    phase: 'P0b',
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    target: state.targetUrl || TARGET_URL,
    partition: EFFECTIVE_PARTITION,
    variant: state.variantInfo || null,
    environment: {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      osRelease: os.release(),
    },
    summary: {
      challengesDetected: state.challenges.length,
      httpErrors: state.responses.length,
      navigationCount: state.events.filter((e) => e.type === 'navigate').length,
      loadFailed: state.events.filter((e) => e.type === 'load-failed').length,
      rendererGone: state.events.filter((e) => e.type === 'render-process-gone').length,
      // 提示值，不是自动结论；请结合人工观察判断
      signal:
        state.challenges.length === 0 &&
        state.responses.filter((r) => r.status === 403 || r.status === 429).length === 0
          ? 'no-blocking-signal-observed'
          : 'blocking-signal-observed',
    },
    challenges: state.challenges,
    responsesWithErrorStatus: state.responses,
    thirdPartyHosts: Array.from(
      new Set(
        state.requests
          .map((r) => {
            try {
              return new URL(r.url).host;
            } catch {
              return null;
            }
          })
          .filter((host) => {
            const tHost = (() => {
              try {
                return new URL(state.targetUrl || TARGET_URL).host;
              } catch {
                return null;
              }
            })();
            return host && host !== tHost && !/(^|\.)deepseek\.com$/.test(host);
          })
      )
    ).sort(),
    sessionFacts: state.sessionFacts || null,
    consoleMessages: state.consoleMessages,
    events: state.events,
  };
}

function writeNow(reason) {
  try {
    const report = buildReport();
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), 'utf8');
    return report;
  } catch (err) {
    process.stderr.write(`[report] 写入失败(${reason}): ${err}\n`);
    return null;
  }
}

function scheduleWrite() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    writeNow('debounce');
  }, 1000);
}

function record(type, detail) {
  state.events.push({ at: new Date().toISOString(), type, detail });
  process.stdout.write(`[event] ${type} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  scheduleWrite();
}

function sanitizeUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(raw);
  }
}

/* ------------------------------------------------------------------ *
 * 只读挑战检测（preload 在隔离世界内观察，主进程只接收）
 * ------------------------------------------------------------------ */
function attachObservers(view, ses) {
  ipcMain.on('challenge-signal', (_evt, payload) => {
    const key = payload.matched.join('|');
    if (state.challenges.some((c) => c.matched.join('|') === key)) return; // 去重
    state.challenges.push({
      at: new Date().toISOString(),
      url: sanitizeUrl(payload.url),
      matched: payload.matched,
      excerpt: payload.excerpt,
    });
    record('challenge-signal', { url: sanitizeUrl(payload.url), matched: payload.matched });
  });
  ipcMain.on('page-ready', (_evt, payload) =>
    record('page-ready', { url: sanitizeUrl(payload.url), title: payload.title })
  );

  // 注意：Electron 的 webRequest 监听器在 Electron 44 下**必须对每个事件调用回调**，
  // 否则该请求会一直挂起（表现为页面永远加载不出来）。因此这里无条件 cb({})，
  // 记录逻辑与之分离。
  ses.webRequest.onBeforeRequest((details, cb) => {
    state.requests.push({
      at: new Date().toISOString(),
      method: details.method,
      url: sanitizeUrl(details.url),
      resourceType: details.resourceType,
    });
    cb({});
  });

  // 用 onHeadersReceived 采集状态码：它天然带回调、且每个响应都会触发
  ses.webRequest.onHeadersReceived((details, cb) => {
    if (details.statusCode >= 400) {
      state.responses.push({
        at: new Date().toISOString(),
        status: details.statusCode,
        url: sanitizeUrl(details.url),
        resourceType: details.resourceType,
      });
      record('http-status', { status: details.statusCode, url: sanitizeUrl(details.url) });
    }
    cb({});
  });

  view.webContents.on('did-start-navigation', (_e, url, _inPlace, isMainFrame) => {
    if (isMainFrame) record('navigate', sanitizeUrl(url));
  });
  view.webContents.on('did-finish-load', () =>
    record('load-finished', sanitizeUrl(view.webContents.getURL()))
  );
  view.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) record('load-failed', { code, desc, url: sanitizeUrl(url) });
  });
  view.webContents.on('render-process-gone', (_e, details) =>
    record('render-process-gone', details)
  );
  view.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (state.consoleMessages.length < 200) {
      state.consoleMessages.push({
        level,
        message: String(message).slice(0, 500),
        source: sanitizeUrl(sourceId),
        line,
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function run() {
  // 自检模式：用进程内 mock 服务器替换真实目标，验证采集链路本身
  let mock = null;
  let targetUrl = TARGET_URL;
  if (SELF_TEST) {
    mock = await startMockServer();
    targetUrl = `http://127.0.0.1:${mock.port}/challenge`;
  }
  state.targetUrl = targetUrl;

  const ses = session.fromPartition(EFFECTIVE_PARTITION);
  const variant = resolveVariantUserAgent(ses);
  const variantInfo = variant.info;
  state.variantInfo = variantInfo;
  process.stdout.write(`[variant] ` + JSON.stringify(variantInfo) + `\n`);
  if (VARIANT === 'noident') {
    process.stdout.write(`[variant] 应用方式: webPreferences.userAgent + session.setUserAgent\n`);
    process.stdout.write(`[variant] 预期 UA : ${variantInfo.effective}\n`);
  }

  const win = new BaseWindow({
    width: 1280,
    height: 900,
    show: true,
    title: 'P0b 可达性实测 —— 请手动登录并手动操作（Ctrl+S 保存报告）',
  });
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: EFFECTIVE_PARTITION,
      webSecurity: true,
      // 关键：会话级 setUserAgent 对 WebContentsView 不生效，必须在此显式传入
      userAgent: variant.userAgent,
    },
  });
  win.contentView.addChildView(view);
  const [w, h] = win.getContentSize();
  view.setBounds({ x: 0, y: 0, width: w, height: h });

  attachObservers(view, ses);

  // Ctrl+S：随时手动刷新报告
  globalShortcut.register('CommandOrControl+S', () => {
    const r = writeNow('manual');
    process.stdout.write(`[report] 已手动保存（事件 ${r ? r.events.length : 0} 条）\n`);
  });

  async function collectSessionFacts() {
    const cookies = await ses.cookies.get({});
    const destroyed = view.webContents.isDestroyed();
    state.sessionFacts = {
      cookieCount: cookies.length,
      cookieNames: cookies.map((c) => `${c.name}(len=${(c.value || '').length})`),
      userAgent: destroyed ? null : view.webContents.getUserAgent(),
      currentUrl: destroyed ? null : sanitizeUrl(view.webContents.getURL()),
    };
  }

  record('target', {
    url: targetUrl,
    partition: EFFECTIVE_PARTITION,
    variant: variantInfo,
    note: '请手动登录并手动完成对话；本工具只记录，不代答任何验证',
    reportPath: OUT_PATH,
  });

  process.stdout.write(`[diag] 开始加载 ${targetUrl}\n`);
  try {
    await view.webContents.loadURL(targetUrl);
    process.stdout.write(`[diag] loadURL 已 resolve，当前 URL = ${view.webContents.getURL()}\n`);
  } catch (err) {
    process.stderr.write(`[diag] loadURL 抛错: ${err && err.message ? err.message : String(err)}\n`);
    record('load-url-error', { message: err && err.message ? err.message : String(err) });
  }
  const r0 = writeNow('after-load');
  process.stdout.write(`[diag] after-load 落盘: ${r0 ? 'OK' : 'FAILED'} (${OUT_PATH})\n`);

  // 用户手动操作期间，定期刷新会话事实并落盘（保证强杀也不丢）
  const sessionTimer = setInterval(() => {
    collectSessionFacts()
      .then(() => scheduleWrite())
      .catch(() => {});
  }, 5000);

  // 自检模式：等待采集完成后自动结束，便于无人值守验证
  if (SELF_TEST) {
    setTimeout(() => {
      process.stdout.write('[self-test] 自动结束\n');
      win.close();
      app.quit();
    }, 8000);
  }

  await new Promise((resolve) => {
    app.once('before-quit', resolve);
    win.once('closed', resolve);
  });

  clearInterval(sessionTimer);
  state.endedAt = new Date().toISOString();
  await collectSessionFacts().catch(() => {});
  const report = writeNow('shutdown');
  if (report) {
    process.stdout.write(`\n===== P0b 报告已写入 =====\n${OUT_PATH}\n`);
    process.stdout.write(`观测结论提示: ${report.summary.signal}\n`);
    process.stdout.write(
      `检测到挑战/验证信号: ${report.summary.challengesDetected} 条；4xx/5xx 响应: ${report.summary.httpErrors} 条\n`
    );
    process.stdout.write(`第三方域: ${report.thirdPartyHosts.join(', ') || '(无)'}\n`);
  }
  app.exit(0);
}

/* 三处强制落盘，确保异常退出也不丢证据 */
app.on('before-quit', () => {
  if (!exitWritten) {
    exitWritten = true;
    state.endedAt = state.endedAt || new Date().toISOString();
    writeNow('before-quit');
  }
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (!exitWritten) {
    exitWritten = true;
    state.endedAt = state.endedAt || new Date().toISOString();
    writeNow('will-quit');
  }
});
app.on('window-all-closed', () => {
  if (!exitWritten) {
    exitWritten = true;
    state.endedAt = state.endedAt || new Date().toISOString();
    writeNow('window-all-closed');
  }
  app.quit();
});

app.whenReady().then(() =>
  run().catch((err) => {
    process.stderr.write(`P0b 运行失败: ${err && err.stack ? err.stack : String(err)}\n`);
    state.endedAt = new Date().toISOString();
    writeNow('error');
    app.exit(2);
  })
);


