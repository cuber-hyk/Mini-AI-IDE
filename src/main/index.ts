/**
 * Mini-AI-IDE 主进程
 *
 * 架构（ADR-0002 / ADR-0003）：
 *  - 左侧 `WebContentsView`：编辑器渲染进程（沙箱、无 Node、无网络、无文件系统能力）；
 *  - 右侧 `WebContentsView`：目标平台网页，**独立会话分区**，程序对它**只读不写**；
 *  - 主进程：窗口/分栏布局、IPC 路由、文件读取（唯一持有本地能力）、启动自检。
 *
 * 硬性约束：
 *  - 零注入：不调用 SendInput / sendInputEvent，不改 DOM，不模拟点击 —— 全项目无输入层；
 *  - UA：移除 `Electron/<ver>` 与应用名标记，保留真实内核版本（ADR-0001）；
 *  - 会话分区：固定 `persist:postcheck`，复用 P0b 已登录会话（见 session-persistence 能力文档）。
 */
import { app, BaseWindow, ipcMain, Menu, session, WebContentsView } from 'electron';
import * as path from 'node:path';

import { CHANNELS, type RootInfo } from '../shared/contract';
import { checkUaConsistency, stripSelfDeclarations } from '../shared/userAgent';
import { FileService } from './fileService';
import { registerFileIpc } from './ipc';
import { createFixtures } from './fixtures';
import { runSelfTest } from './selfTest';
import { runDiagnose } from './diagnose';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/**
 * 会话分区 —— **必须是正式分区名**。
 * P0b 实测登录产生的会话就保存在此分区；改名等于换一个新浏览器，用户需重新登录
 * （而重复登录本身有风控风险）。参见 docs/capabilities/session-persistence.md。
 */
const SESSION_PARTITION = 'persist:postcheck';

const TARGET_URL = process.env['MINI_AI_IDE_TARGET_URL'] ?? 'https://chat.deepseek.com/';
const EDITOR_MIN_WIDTH = 360;
const WEB_MIN_WIDTH = 420;

const SELF_TEST = process.argv.includes('--self-test');
/** 会话与网络诊断模式：加载目标站点并输出登录态与网络失败明细，然后退出 */
const DIAGNOSE = process.argv.includes('--diagnose');

interface Layout {
  editorBounds: { x: number; y: number; width: number; height: number };
  webBounds: { x: number; y: number; width: number; height: number };
  dividerX: number;
}

function computeLayout(width: number, height: number, editorWidth: number): Layout {
  const w = Math.max(editorWidth, EDITOR_MIN_WIDTH);
  return {
    editorBounds: { x: 0, y: 0, width: w, height },
    webBounds: { x: w, y: 0, width: Math.max(0, width - w), height },
    dividerX: w,
  };
}

/* ------------------------------------------------------------------ *
 * 启动自检数据（供 --self-test 使用）
 * ------------------------------------------------------------------ */
interface BootInfo {
  sessionPartition: string;
  userAgent: { original: string; effective: string; removed: string[] };
  uaConsistency: { ok: boolean; uaMajor: string | null; kernelMajor: string | null };
  versions: { electron: string | undefined; chromium: string | undefined; node: string };
}

/* ------------------------------------------------------------------ *
 * 应用主流程
 * ------------------------------------------------------------------ */
async function bootstrap(): Promise<void> {
  // Electron 的应用名会影响 userData 目录；显式设定以保证分区落盘位置可预期。
  app.setName('mini-ai-ide');

  await app.whenReady();

  const fileService = new FileService();
  const targetSession = session.fromPartition(SESSION_PARTITION);

  // UA 处理：移除自我声明标记，保留真实内核版本（ADR-0001）
  const rawUa = targetSession.getUserAgent();
  const uaPlan = stripSelfDeclarations(rawUa, 'mini-ai-ide');
  targetSession.setUserAgent(uaPlan.effective);
  const uaConsistency = checkUaConsistency(uaPlan.effective, process.versions.chrome ?? '');

  const boot: BootInfo = {
    sessionPartition: SESSION_PARTITION,
    userAgent: uaPlan,
    uaConsistency,
    versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
  };

  process.stdout.write(
    `[boot] 分区=${boot.sessionPartition} 内核=${boot.versions.chromium} UA自洽=${uaConsistency.ok} 移除标记=[${uaPlan.removed.join(', ')}]\n`
  );
  if (!uaConsistency.ok) {
    process.stderr.write(
      `[boot][警告] UA 声明的内核主版本(${uaConsistency.uaMajor}) 与实际内核(${uaConsistency.kernelMajor}) 不一致\n`
    );
  }
  if (/Electron\//i.test(uaPlan.effective)) {
    process.stderr.write('[boot][警告] UA 中仍存在 Electron 标记，违反 ADR-0001\n');
  }

  /* ---------------- 窗口与两个视图 ---------------- */
  const win = new BaseWindow({ width: 1440, height: 900, show: !SELF_TEST, title: 'Mini-AI-IDE' });
  const size = win.getContentSize();
  const winW = size[0] ?? 1440;
  const winH = size[1] ?? 900;
  let editorWidth = Math.round(winW * 0.45);
  let layout = computeLayout(winW, winH, editorWidth);

  const editorView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 编辑器渲染进程不需要任何网络能力
      partition: 'persist:editor-ui',
    },
  });

  const webView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: SESSION_PARTITION,
    },
  });
  // UA 处理：会话级 setUserAgent 对 WebContentsView **不生效**（P0b 实测教训，见 P0B-7），
  // 因此对视图的 webContents 再显式设置一次，并在自检中验证生效。
  webView.webContents.setUserAgent(uaPlan.effective);

  win.contentView.addChildView(editorView);
  win.contentView.addChildView(webView);
  editorView.setBounds(layout.editorBounds);
  webView.setBounds(layout.webBounds);

  win.on('resize', () => {
    const s = win.getContentSize();
    const w = s[0] ?? 1440;
    const h = s[1] ?? 900;
    editorWidth = Math.min(Math.max(editorWidth, EDITOR_MIN_WIDTH), Math.max(EDITOR_MIN_WIDTH, w - WEB_MIN_WIDTH));
    layout = computeLayout(w, h, editorWidth);
    editorView.setBounds(layout.editorBounds);
    webView.setBounds(layout.webBounds);
  });

  /* ---------------- IPC ---------------- */
  const getEditorWindow = () => null; // 目录选择不需要父窗口句柄；保留签名以便后续接入
  const registeredChannels = registerFileIpc(getEditorWindow, fileService);

  // 分栏比例（由编辑器渲染进程在拖动分隔条时上报）
  ipcMain.handle(CHANNELS.setSplit, (_e, desiredWidth: unknown): { editorWidth: number } => {
    const s = win.getContentSize();
    const total = s[0] ?? 1440;
    const height = s[1] ?? 900;
    const requested = typeof desiredWidth === 'number' && Number.isFinite(desiredWidth) ? desiredWidth : editorWidth;
    editorWidth = Math.min(Math.max(Math.round(requested), EDITOR_MIN_WIDTH), Math.max(EDITOR_MIN_WIDTH, total - WEB_MIN_WIDTH));
    layout = computeLayout(total, height, editorWidth);
    editorView.setBounds(layout.editorBounds);
    webView.setBounds(layout.webBounds);
    return { editorWidth: layout.editorBounds.width };
  });

  function notifyRootChanged(info: RootInfo): void {
    if (!editorView.webContents.isDestroyed()) {
      editorView.webContents.send(CHANNELS.rootChanged, info);
    }
  }

  /* ---------------- 菜单（提供"打开目录"入口） ---------------- */
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: '打开目录…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            void (async () => {
              const { dialog } = await import('electron');
              const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
              if (!picked.canceled && picked.filePaths[0]) {
                const root = fileService.setRoot(picked.filePaths[0]);
                notifyRootChanged({ root });
                process.stdout.write(`[fs] 已打开目录：${root}\n`);
              }
            })();
          },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: '重新加载编辑器' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  /* ---------------- 加载内容 ---------------- */
  // 诊断：把渲染进程的 console 与 preload 失败转写到主进程 stdout。
  // 自检模式下过滤 Electron 的 CSP 告警（Monaco 的 AMD loader 需要 unsafe-eval，
  // 属已知取舍，见 docs/capabilities/app-shell.md）；正常运行时该告警保留。
  editorView.webContents.on('console-message', (event) => {
    const detail = event as unknown as { level?: string | number; message?: string; lineNumber?: number; sourceId?: string };
    const message = String(detail.message ?? '');
    if (SELF_TEST && /Insecure Content-Security-Policy/i.test(message)) return;
    process.stdout.write(`[editor-console:${detail.level ?? '?'}] ${message} (${detail.sourceId ?? '?'}:${detail.lineNumber ?? '?'})\n`);
  });
  editorView.webContents.on('preload-error', (_e, preloadPath, error) => {
    process.stderr.write(`[preload-error] ${preloadPath}: ${error.stack ?? String(error)}\n`);
  });
  editorView.webContents.on('did-finish-load', () => {
    process.stdout.write(`[editor] 加载完成：${editorView.webContents.getURL()}\n`);
  });
  editorView.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) process.stderr.write(`[editor] 加载失败 ${code} ${desc} ${url}\n`);
  });

  await editorView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 命令行指定目录（含自检场景）；正常启动时也可用 --root 指定
  const rootArg = process.argv.find((a) => a.startsWith('--root='))?.slice('--root='.length);
  if (rootArg) {
    const root = fileService.setRoot(rootArg);
    notifyRootChanged({ root });
    process.stdout.write(`[fs] 命令行指定根目录：${root}\n`);
  }

  if (SELF_TEST) {
    const fixtures = createFixtures();
    process.stdout.write(`[self-test] 样例目录：${fixtures.root}\n`);
    const report = await runSelfTest({ editorView, webView, fileService, fixtures, boot, layout, registeredChannels });
    process.stdout.write(`\n===== 自检结果 =====\n${JSON.stringify(report, null, 2)}\n`);
    app.exit(report.verdict === 'PASS' ? 0 : 1);
    return;
  }

  if (DIAGNOSE) {
    process.stdout.write('[diagnose] 开始会话与网络诊断…\n');
    const report = await runDiagnose({
      webView,
      partition: SESSION_PARTITION,
      targetUrl: TARGET_URL,
      userAgent: uaPlan.effective,
      waitMs: 15000,
    });
    process.stdout.write(`\n===== 诊断结果 =====\n${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`[diagnose] 结论：${report.verdict}\n`);
    for (const n of report.notes) process.stdout.write(`[diagnose] ${n}\n`);
    app.exit(report.verdict === 'SESSION_OK' ? 0 : 1);
    return;
  }

  // 正常启动：右侧加载目标平台（**只读**，程序不向页面写入任何内容）
  webView.webContents.on('did-finish-load', () => {
    process.stdout.write(`[web] 已加载：${webView.webContents.getURL()}\n`);
  });
  webView.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) process.stderr.write(`[web] 加载失败 ${code} ${desc} ${url}\n`);
  });
  try {
    await webView.webContents.loadURL(TARGET_URL);
  } catch (err) {
    process.stderr.write(`[web] loadURL 抛错：${err instanceof Error ? err.message : String(err)}\n`);
  }

  // 分隔条由**编辑器渲染进程自身**的 DOM 承载（见 src/renderer 的 #resizer）。
  // 早期实现用一个独立 WebContentsView 覆盖在边界上，但它不接收拖动事件，
  // 导致"分隔条看着能拖、实际不能"——已移除。

  win.on('closed', () => {
    app.quit();
  });
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
app.on('window-all-closed', () => app.quit());

bootstrap().catch((err) => {
  process.stderr.write(`[fatal] 启动失败：${err instanceof Error ? err.stack : String(err)}\n`);
  app.exit(2);
});
