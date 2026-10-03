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
import { app, BaseWindow, clipboard, ipcMain, Menu, session, WebContentsView } from 'electron';
import * as path from 'node:path';

import { CHANNELS, type ApplyChangeInput, type ReturnPreview, type RootInfo } from '../shared/contract';
import { buildPrompt, getFormatSpec } from '../shared/formatSpec';
import { parseModelReply, computeApply, type ParsedCodeBlock } from '../shared/returnPath';
import { buildSnippetText, buildWholeFileText } from '../shared/snippet';
import { diffTexts } from '../shared/diff';
import { checkUaConsistency, stripSelfDeclarations } from '../shared/userAgent';
import { FileService } from './fileService';
import { registerFileIpc } from './ipc';
import { createFixtures } from './fixtures';
import { runSelfTest } from './selfTest';
import { runDiagnose } from './diagnose';
import { SettingsStore, isUsableRoot, PRODUCTION_SETTINGS_FILE, SELF_TEST_SETTINGS_FILE } from './settings';
import { buildContextSummary } from './contextSummary';
import { collectReply } from './replyCollector';
import { ReturnPathService } from './returnPathService';

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
/** 回程预览面板（右下角）的最小高度；低于这个值 diff 没法看 */
const PREVIEW_MIN_HEIGHT = 160;
/** 网页区（右上角）的最小高度，保证聊天界面可用 */
const WEB_MIN_HEIGHT = 220;
/**
 * 网页区顶部工具条高度：显隐开关放在**各自板块顶部**（用户反馈：
 * 全局工具栏里一排带文字的「目录树」「AI 网页」按钮不像折叠/展开该有的样子）。
 */
const WEB_BAR_HEIGHT = 30;
/**
 * 网页隐藏后，右边缘**把手**的两种宽度（VS Code 收起侧栏的同款做法）。
 *
 * 为什么需要它：网页隐藏时，若把工具条一起隐藏，开关就跟着消失，
 * 用户**再也点不回来**（本项目已犯过一次，见ADR 与能力文档的陷阱表）。
 * 所以工具条视图永不销毁：网页可见时它是顶部横条，隐藏时贴到右边缘变成竖把手。
 */
const HANDLE_BAR_WIDTH = 28; // hover / 刚隐藏后展开的宽度
const HANDLE_BAR_PEEK = 5; // 静置时的窄条宽度（不干扰阅读）

const SELF_TEST = process.argv.includes('--self-test');
/** 界面运行时探针：不联网，加载编辑器后读回 Monaco 实际选项并试改文本，然后退出 */
const UI_PROBE = process.argv.includes('--ui-probe');
/** 会话与网络诊断模式：加载目标站点并输出登录态与网络失败明细，然后退出 */
const DIAGNOSE = process.argv.includes('--diagnose');

interface Layout {
  editorBounds: { x: number; y: number; width: number; height: number };
  webBounds: { x: number; y: number; width: number; height: number };
  /**
   * 网页区顶部工具条 / 隐藏后的右边缘把手（同一个视图的两种形态）。
   * 始终有非零宽度——它承载着"把网页叫回来"的唯一常驻入口。
   */
  webBarBounds: { x: number; y: number; width: number; height: number };
  previewBounds: { x: number; y: number; width: number; height: number };
  dividerX: number;
  /** 右侧上下分割线（y 坐标）；预览隐藏时等于总高度，即网页占满右列 */
  splitY: number;
  /** 网页是否可见（渲染进程据此决定 webbar 走横条还是竖把手形态） */
  webVisible: boolean;
}

/** 分区宽度（编辑器内部左侧目录树，渲染进程自绘，这里只持久化用户选择） */
const SIDEBAR_MIN_WIDTH = 140;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_DEFAULT_WIDTH = 230;

/** 由文件扩展名推断 Monaco 语言 id（用于 diff 视图的语法高亮） */
function languageIdFor(relPath: string): string {
  const ext = (relPath.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', markdown: 'markdown', py: 'python', go: 'go',
    rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'cpp', cc: 'cpp', cpp: 'cpp',
    hpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift', rb: 'ruby', lua: 'lua',
    sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', bat: 'bat',
    sql: 'sql', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
    xml: 'xml', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini',
    csv: 'plaintext', txt: 'plaintext',
  };
  return map[ext] ?? 'plaintext';
}

/**
 * 三区布局：左侧编辑器 | 右上（网页顶栏 + 网页）| **右下回程预览**
 *
 * 为什么把预览放右下角（用户建议）：原先预览挤在编辑器下方，把编辑器高度压得很低，
 * 而且 diff 只有一百多像素高，根本没法看。放到右列下半区后，编辑器高度不受影响。
 *
 * **网页整体隐藏时（`webVisible=false`）编辑器占满全窗口**：右列没有任何内容视图，
 * 若仍按原样留白就会露出 BaseWindow 的白底（用户实测反馈：隐藏网页就是一片白）。
 *
 * ⚠️ 但**工具条视图不能一起隐藏** —— 它上面的按钮是"把网页叫回来"的唯一常驻入口。
 * 早期实现跟着网页一起隐藏，结果用户点完隐藏就再也回不来（本项目已犯过）。
 * 现在改为：网页隐藏时工具条贴到**窗口右边缘**，变成一条竖把手
 * （静置 `HANDLE_BAR_PEEK` px 窄条，hover 展开到 `HANDLE_BAR_WIDTH`），
 * 与 VS Code 收起侧栏时的把手同一思路。
 *
 * 把手是**覆盖**在右侧一小条上，不占布局宽度，因此编辑器仍能占满 `width`。
 */
function computeLayout(
  width: number,
  height: number,
  editorWidth: number,
  previewHeight = 0,
  webVisible = true
): Layout {
  // 网页隐藏：编辑器独占整个窗口；网页与预览归零；工具条贴右边缘成为竖把手
  if (!webVisible) {
    return {
      editorBounds: { x: 0, y: 0, width, height },
      webBounds: { x: width, y: 0, width: 0, height: 0 },
      webBarBounds: { x: width - HANDLE_BAR_WIDTH, y: 0, width: HANDLE_BAR_WIDTH, height },
      previewBounds: { x: width, y: 0, width: 0, height: 0 },
      dividerX: width,
      splitY: height,
      webVisible: false,
    };
  }

  const w = Math.max(editorWidth, EDITOR_MIN_WIDTH);
  const rightX = w;
  const rightW = Math.max(0, width - w);
  const wanted = previewHeight > 0 ? previewHeight : 0;
  const maxPreview = Math.max(PREVIEW_MIN_HEIGHT, height - WEB_MIN_HEIGHT);
  const ph = Math.min(Math.max(wanted, PREVIEW_MIN_HEIGHT), maxPreview);
  const showPreview = previewHeight > 0;
  const columnH = showPreview ? Math.max(WEB_MIN_HEIGHT, height - ph) : height;
  const webH = Math.max(0, columnH - WEB_BAR_HEIGHT);
  const previewY = columnH;
  const finalPh = showPreview ? height - previewY : 0;
  return {
    editorBounds: { x: 0, y: 0, width: w, height },
    webBounds: { x: rightX, y: WEB_BAR_HEIGHT, width: rightW, height: webH },
    webBarBounds: { x: rightX, y: 0, width: rightW, height: WEB_BAR_HEIGHT },
    previewBounds: { x: rightX, y: previewY, width: rightW, height: finalPh },
    dividerX: w,
    splitY: showPreview ? previewY : height,
    webVisible: true,
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
/** 预览面板是否可见 + 其高度（随窗口持久化在内存里；0 表示隐藏） */
let previewHeight = 0;
/** 右侧 AI 网页是否显示（可隐藏，把空间让给预览面板或编辑器） */
let webVisible = true;

async function bootstrap(): Promise<void> {
  // Electron 的应用名会影响 userData 目录；显式设定以保证分区落盘位置可预期。
  app.setName('mini-ai-ide');

  await app.whenReady();

  const fileService = new FileService();
  const settings = new SettingsStore(SELF_TEST ? SELF_TEST_SETTINGS_FILE : PRODUCTION_SETTINGS_FILE);
  const saved = settings.get();
  /** 左侧目录树宽度（编辑器内部布局；主进程负责持久化与约束） */
  let sidebarWidth = saved.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;
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
  let editorWidth = Math.min(
    Math.max(saved.editorWidth ?? Math.round(winW * 0.45), EDITOR_MIN_WIDTH),
    Math.max(EDITOR_MIN_WIDTH, winW - WEB_MIN_WIDTH)
  );
  let layout = computeLayout(winW, winH, editorWidth, previewHeight);

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

  // 回程预览：**独立的右下角视图**（不再挤在编辑器下方，见 computeLayout 注释）
  const previewView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'previewPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 预览面板不需要任何网络能力
      partition: 'persist:editor-ui',
    },
  });
  // 预览视图与编辑器视图使用同一分区，便于复用同一份 preload 缓存策略

  // 网页区顶部工具条：**独立视图**，只放网页/预览的显隐开关。
  // 为什么不用 <iframe> 也不用盖在网页上：它是本程序自己的界面，
  // 与网页视图同层并排（网页本体从 WEB_BAR_HEIGHT 之下开始），互不遮挡。
  const webBarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'webbarPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 纯本地界面，不需要网络也不需要网页会话
      partition: 'persist:editor-ui',
    },
  });

  win.contentView.addChildView(editorView);
  win.contentView.addChildView(webBarView);
  win.contentView.addChildView(webView);
  win.contentView.addChildView(previewView);
  editorView.setBounds(layout.editorBounds);
  webBarView.setBounds(layout.webBarBounds);
  webView.setBounds(layout.webBounds);
  previewView.setBounds(layout.previewBounds);
  previewView.setVisible(false);

  /** 把当前网页/预览的可见状态广播给网页区工具条（它的按钮高亮靠这个） */
  function broadcastChromeState(): void {
    if (webBarView.webContents.isDestroyed()) return;
    webBarView.webContents.send(CHANNELS.chromeState, {
      webVisible,
      previewVisible: webVisible && previewHeight > 0,
    });
  }

  /**
   * 统一的"显示/隐藏网页"入口。
   *
   * 三个调用方都走这里，保证几何、菜单勾选、三个渲染进程的状态**永远一致**：
   *  1. 网页区顶部工具条的「隐藏」按钮；
   *  2. 网页隐藏后右边缘把手的「展开」按钮；
   *  3. View 菜单的「AI 网页」勾选项（兜底，永远可见）。
   * 另外编辑器的 `Ctrl+Shift+A` 走 IPC，最终也落到 `CHANNELS.setWebVisible`。
   */
  function setWebVisible(visible: boolean): void {
    webVisible = visible;
    relayout();
    buildApplicationMenu();
    // 编辑器渲染进程也持有状态镜像（虽然没有该按钮），一并回灌
    if (!editorView.webContents.isDestroyed()) {
      editorView.webContents.send(CHANNELS.chromeState, {
        webVisible,
        previewVisible: webVisible && previewHeight > 0,
      });
    }
  }

  /** 按当前 previewHeight / webVisible 重算三区并应用 */
  function relayout(): void {
    const s = win.getContentSize();
    const w = s[0] ?? 1440;
    const h = s[1] ?? 900;
    // 网页隐藏时编辑器占满全宽，分栏宽度约束不再有意义（但仍需夹在合法区间）
    editorWidth = Math.min(Math.max(editorWidth, EDITOR_MIN_WIDTH), Math.max(EDITOR_MIN_WIDTH, w - WEB_MIN_WIDTH));
    layout = computeLayout(w, h, editorWidth, previewHeight, webVisible);
    editorView.setBounds(layout.editorBounds);
    webBarView.setBounds(layout.webBarBounds);
    //工具条**始终可见**：网页隐藏时它变成右边缘把手，是"把网页叫回来"的唯一常驻入口
    webBarView.setVisible(true);
    webView.setBounds(layout.webBounds);
    webView.setVisible(webVisible && layout.webBounds.height > 0);
    previewView.setBounds(layout.previewBounds);
    // 网页隐藏时预览一并隐藏：它属于"网页区"，网页不在就没有意义
    previewView.setVisible(webVisible && previewHeight > 0);
    broadcastChromeState();
  }

  win.on('resize', relayout);

  /**
   * 窗口**真正显示 / 尺寸确定**后必须重算一次视图几何。
   *
   * 踩坑（用户实测）：启动后底部内容被切掉，**拖一下窗口就恢复**。
   * 根因不在 CSS 也不在渲染进程的布局，而在主进程这边 ——
   * `new BaseWindow({ width, height })` 之后立刻 `getContentSize()`，
   * 此刻窗口**还没显示**，量到的内容区尺寸与显示后的真实视口不一致
   * （Windows 的边框、缩放、DPI 适配都要到显示时才最终确定）。
   * 于是四个视图按"显示前的尺寸"定了 bounds，而 bounds **不会自动跟随视口** ——
   * 表现就是编辑器底部（需求输入区）被切掉一截。
   * 拖窗口能恢复，是因为那才会触发 `win.on('resize', relayout)`。
   *
   * 为什么不能靠"显示前多 measure 几次"绕过：
   * 显示前量到的尺寸本来就是错的，必须等显示完成才有真实值。
   *
   * 事件选择（**BaseWindow 的事件面比 BrowserWindow 窄，别照抄**）：
   * - `'show'`：窗口显示出来的那一刻 —— 最贴近"初始布局已确定"的信号。
   * - `'resized'`：**真实**尺寸变化完成。macOS 上 `resize` 与 `resized` 是两个事件，
   *   首次显示若被系统按屏幕可用区域调整过尺寸，只有这个能捕获。
   * ⚠️ BaseWindow **没有** `'ready-to-show'`（那是 BrowserWindow 的），写上去编译不过。
   *
   * relayout 幂等，重复调用无副作用，多挂几个入口是安全的。
   */
  win.once('show', () => {
    relayout();
  });
  win.once('resized', () => {
    relayout();
  });
  // 编辑器页面加载完成后再补一次：视图尺寸与页面布局是两件事，
  // 页面真正拿到最终视口宽度后自身会重排，主进程这边也应对齐一次真实尺寸。
  editorView.webContents.on('did-finish-load', () => {
    relayout();
  });

  /**
 * 加载本地界面页面，失败时重试。
 *
 * ⚠️ 为什么需要重试（本机实测踩坑）：
 * 同一分区（`persist:editor-ui`）下连续创建多个 `WebContentsView` 并 `loadFile` 时，
 * 偶发 `ERR_FAILED (-2)`。实测把 webbar.html 的内容换成 preview.html 的内容、
 * 加载顺序也换过，失败对象会**在两个视图之间飘移** —— 与页面内容、加载顺序都无关，
 * 是渲染进程创建时序的问题。因此这里用"重试若干次 + 间隔"把它吸收掉：
 * 失败是偶发的，重试即恢复。
 *
 * 之所以必须成功：这些视图承载着唯一的功能入口（网页区显隐开关在 webbar 里），
 * 加载失败等于整个应用没有网页控制入口，不能静默跳过。
 */
async function loadLocalView(
  view: WebContentsView,
  fileName: string,
  attempts = 4
): Promise<void> {
  const target = path.join(__dirname, '..', 'renderer', fileName);
  let lastErr: unknown = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await view.webContents.loadFile(target);
      return;
    } catch (err) {
      lastErr = err;
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[load] ${fileName} 第 ${i}/${attempts} 次加载失败：${detail}\n`);
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, 150 * i));
      }
    }
  }
  throw new Error(`加载 ${fileName} 连续 ${attempts} 次失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/* ---------------- 加载本地界面视图 ----------------
 * 顺序：预览面板 → 网页区工具条 →（下方）编辑器页面。
 * 顺序本身不是根因（换顺序失败对象会飘移），但先加载两个小页面、
 * 让它们与编辑器页面错开，可以减少并发创建渲染进程的压力。
 */
  await loadLocalView(previewView, 'preview.html');
  await loadLocalView(webBarView, 'webbar.html');

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
    layout = computeLayout(total, height, editorWidth, previewHeight, webVisible);
    editorView.setBounds(layout.editorBounds);
    webBarView.setBounds(layout.webBarBounds);
    webView.setBounds(layout.webBounds);
    previewView.setBounds(layout.previewBounds);
    settings.update({ editorWidth: layout.editorBounds.width });
    return { editorWidth: layout.editorBounds.width };
  });

  /** 显示/隐藏右侧 AI 网页。
   *
   * 三个入口（顶部工具条按钮 / 右边缘把手 / View 菜单）都汇聚到 `setWebVisible`，
   * 它再调用本IPC handler —— 保证走同一条路径、状态不会分叉。
   */
  ipcMain.handle(CHANNELS.setWebVisible, (_e, visible: unknown) => {
    setWebVisible(visible !== false);
    return { visible: webVisible };
  });

  /** 显示/隐藏左侧目录树（编辑器内部面板，主进程只广播 + 持久化） */
  ipcMain.handle(CHANNELS.setSidebarVisible, (_e, visible: unknown) => {
    const v = visible !== false;
    settings.update({ sidebarVisible: v });
    if (!editorView.webContents.isDestroyed()) {
      editorView.webContents.send(CHANNELS.sidebarChanged, { visible: v, width: sidebarWidth });
    }
    return { visible: v };
  });

  /** 调整左侧目录树宽度（约束在 [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]） */
  ipcMain.handle(CHANNELS.setSidebarWidth, (_e, width: unknown) => {
    const raw = typeof width === 'number' && Number.isFinite(width) ? Math.round(width) : sidebarWidth;
    sidebarWidth = Math.min(Math.max(raw, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH);
    settings.update({ sidebarWidth });
    if (!editorView.webContents.isDestroyed()) {
      editorView.webContents.send(CHANNELS.sidebarChanged, { visible: settings.get().sidebarVisible, width: sidebarWidth });
    }
    return { width: sidebarWidth };
  });

  /**
   * 在**编辑器内**以内联标记显示某个变更（删除行标红、新增行插在旁边）。
   * 主进程负责算出两侧完整文本，编辑器只负责渲染。
   */
  ipcMain.handle(CHANNELS.showDiffInEditor, async (_e, collectionId: unknown, index: unknown) => {
    if (typeof collectionId !== 'string' || typeof index !== 'number') {
      return { ok: false, error: '参数不合法' };
    }
    const payload = await buildEditorDiff(collectionId, index);
    if (!payload) return { ok: false, error: '采集结果已过期或该变更不存在，请重新采集' };
    if (!editorView.webContents.isDestroyed()) {
      editorView.webContents.send(CHANNELS.diffData, payload);
    }
    /*
     * 顺手通知右下角面板高亮这一条。
     * 两个视图是独立渲染进程（ADR-0002），彼此不能调用，所以必须经主进程转发；
     * 否则用「上一个 / 下一个」在编辑器里跳走后，面板高亮会停在原地对不上。
     */
    if (!previewView.webContents.isDestroyed()) {
      previewView.webContents.send(CHANNELS.activeDiff, index);
    }
    return { ok: true };
  });

  /**
   * 编辑器内的「上一个 / 下一个」跳转（由 renderer 在切到相邻变更时调用）。
   *
   * 为什么不复用 showDiffInEditor：那是个通用入口（谁都可以请求预览某个变更），
   * 而这里要额外把高亮同步给右下角面板；单独一个通道语义更清楚，
   * 也避免为了同步高亮而给每个调用方都塞一份转发逻辑。
   */
  ipcMain.handle(CHANNELS.stepDiff, async (_e, collectionId: unknown, index: unknown) => {
    if (typeof collectionId !== 'string' || typeof index !== 'number') {
      return { ok: false, error: '参数不合法' };
    }
    const payload = await buildEditorDiff(collectionId, index);
    if (!payload) return { ok: false, error: '采集结果已过期或该变更不存在，请重新采集' };
    if (!editorView.webContents.isDestroyed()) {
      editorView.webContents.send(CHANNELS.diffData, payload);
    }
    if (!previewView.webContents.isDestroyed()) {
      previewView.webContents.send(CHANNELS.activeDiff, index);
    }
    return { ok: true };
  });

  /**
   * 显示/隐藏右下角回程预览面板，并设置其高度。
   * 高度会被约束在 [PREVIEW_MIN_HEIGHT, 窗口高 - WEB_MIN_HEIGHT]，保证网页区仍可用。
   */
  ipcMain.handle(CHANNELS.setPreviewPanel, (_e, height: unknown) => {
    const h = typeof height === 'number' && Number.isFinite(height) ? Math.round(height) : 0;
    previewHeight = h > 0 ? Math.max(PREVIEW_MIN_HEIGHT, h) : 0;
    relayout();
    // View 菜单里「回程预览面板」的勾选状态要跟着变
    buildApplicationMenu();
    return { height: layout.previewBounds.height, visible: previewHeight > 0 };
  });

  /** 把预览数据推给右下角面板 */
  function pushPreviewToPanel(preview: unknown): void {
    if (!previewView.webContents.isDestroyed()) {
      previewView.webContents.send(CHANNELS.previewData, preview);
    }
  }

  /**
   * 构造"编辑器内联 diff"所需的两侧完整文本。
   *
   * 与预览面板共用同一份三向校验：算不出（或校验不过）就返回 null，
   * 由调用方报错——**不会出现"显示了 diff 但应用会失败"**的情况。
   *
   * 附带 `siblings` / `position`：编辑器的「上一个 / 下一个」需要在批次内跳转，
   * 而 payload 本身只描述单个变更，所以这里顺带把同批次的定位信息一起带上。
   */
  async function buildEditorDiff(
    collectionId: string,
    index: number
  ): Promise<import('../shared/contract').EditorDiffPayload | null> {
    const cached = collections.get(collectionId);
    const block = cached?.blocks[index];
    if (!cached || !block || !block.filePath) return null;

    const read = await fileService.readRawText(block.filePath);
    if (!read.ok) return null;

    const lines = read.text.split(/\r\n|\r|\n/);
    const mode: Parameters<typeof computeApply>[2] = block.range
      ? {
          kind: 'replace-lines',
          start: block.range.start,
          end: block.range.end,
          expectedOriginal: lines.slice(block.range.start - 1, block.range.end).join('\n'),
          contextPrev: block.range.start - 2 >= 0 ? (lines[block.range.start - 2] ?? null) : null,
          contextNext: block.range.end < lines.length ? (lines[block.range.end] ?? null) : null,
        }
      : { kind: 'replace-whole-file' };

    const computed = computeApply(read.text, block, mode);
    if (!computed.ok) return null;

    /* 同批次内可导航的变更（供编辑器「上一个 / 下一个」）。
     必须在 map 之后按类型收窄：`filePath` 可能是 null，而 `exactOptionalPropertyTypes`
     下 optional 字段不接受 null。 */
    const siblings: import('../shared/contract').EditorDiffSibling[] = [];
    cached.blocks.forEach((b, i) => {
      if (typeof b.filePath === 'string') {
        siblings.push({ collectionId, index: i, filePath: b.filePath });
      }
    });

    return {
      active: true,
      filePath: read.relPath,
      original: read.text,
      modified: computed.text,
      language: languageIdFor(read.relPath),
      collectionId,
      index,
      identical: computed.text === read.text,
      siblings,
      position: siblings.findIndex((s) => s.index === index),
    };
  }

  /**
   * 把"输出格式要求"模板写入系统剪贴板。
   *
   * 边界（ADR-0003 零注入）：**只写剪贴板，不写网页**。
   * 用户随后自己把它粘贴到提示词里——发出去的动作仍然是人的。
   */
  ipcMain.handle(CHANNELS.copyFormatSpec, (_e, variant: unknown) => {
    const text = getFormatSpec(variant === 'full' ? 'full' : 'short');
    try {
      clipboard.writeText(text);
      return { ok: true, length: text.length };
    } catch (err) {
      return { ok: false, length: 0, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** 取工作环境摘要（只读；不含"当前打开的文件"，见 contextSummary 注释） */
  ipcMain.handle(CHANNELS.getContext, () => buildContextSummary(fileService.getRoot()));

  /* ---------------- 回程：采集 → 解析 → 预览 / 应用 / 撤销 ---------------- */
  const returnPath = new ReturnPathService(fileService);

  /**
   * 采集结果缓存：`collectionId` → 解析出的代码块（**含代码本体**）。
   *
   * 为什么放主进程而不是回传渲染进程：
   *  1. 渲染进程不需要（也不应该）经手大块代码文本；
   *  2. **片段替换的三向校验需要"复制那一刻的原文"** —— 只有主进程在读文件的同一时刻
   *     抓取当前行内容，才能得到真正可用的校验基线。让渲染进程转手就做不到可信。
   * 只保留最近若干批，避免长期驻留。
   */
  const collections = new Map<string, { blocks: ParsedCodeBlock[]; at: string; replyLength: number }>();
  const MAX_COLLECTIONS = 5;
  let collectionSeq = 0;

  /**
   * 从网页视图**只读**采集最新回复并解析为待预览变更。
   * 不落盘、不修改页面（ADR-0003/0004）。
   */
  ipcMain.handle(CHANNELS.collectReply, async (): Promise<ReturnPreview> => {
    const emptyId = `c${(collectionSeq += 1)}`;
    if (webView.webContents.isDestroyed()) {
      return {
        ok: false,
        collectionId: emptyId,
        strategyId: null,
        strategyDescription: null,
        attempts: [],
        replyText: '',
        notes: [],
        blocks: [],
        error: '网页视图不可用',
      };
    }

    const collected = await collectReply({
      evaluate: (script) => webView.webContents.executeJavaScript(script, true) as Promise<unknown>,
      currentUrl: () => webView.webContents.getURL(),
    });

    if (collected.strategyId === null || collected.replyText.length === 0) {
      const diagLines: string[] = [];
      if (collected.diagnostic) {
        const d = collected.diagnostic;
        diagLines.push(`页面标题：${d.title || '<空>'}`);
        diagLines.push(`页面可见文本长度：${d.bodyTextLength}`);
        diagLines.push(`页面里是否存在 \`\`\` 围栏：${d.bodyHasFence ? '是' : '否'}`);
        diagLines.push(
          '候选选择器命中数：' +
            Object.entries(d.counts)
              .map(([k, v]) => `${k}=${v}`)
              .join('，')
        );
        if (d.counts['pre'] === 0 && !d.bodyHasFence) {
          diagLines.push('判断：页面里没有代码块——可能模型尚未输出，或当前不在对话页');
        } else if (d.counts['pre'] === 0 && d.bodyHasFence) {
          diagLines.push('判断：围栏在文本里存在但不在 <pre> 中——采集选择器需要按实际结构补充策略');
        }
      }
      return {
        ok: false,
        collectionId: emptyId,
        strategyId: null,
        strategyDescription: null,
        attempts: collected.attempts,
        replyText: '',
        notes: ['未采集到任何回复文本；可能是页面尚未输出、结构已变化，或当前不在对话页', ...diagLines],
        blocks: [],
        ...(collected.diagnostic ? { diagnostic: collected.diagnostic } : {}),
        error: '未采集到回复',
      };
    }

    const parsed = parseModelReply(collected.replyText);

    /*
     * 诊断信息必须**紧凑**。
     * 实测教训：早期把"采集到的开头 8 行"整段塞进备注，结果备注占满面板高度，
     * 列表与其中的「应用」按钮被挤出视口 —— 诊断本身把界面搞坏了。
     * 现在只给一行摘要：规模 + 首行（截断）。
     */
    const collectedLines = collected.replyText.split(/\r\n|\r|\n/);
    const fenceMarkCount = (collected.replyText.match(/^[ \t]*(?:`{3,}|~{3,})/gm) ?? []).length;
    const firstLine = (collectedLines[0] ?? '').slice(0, 60);
    const parseNotes = [
      ...parsed.notes,
      `采集：策略 ${collected.strategyId} · ${collected.replyText.length} 字符 / ${collectedLines.length} 行 · 围栏标记 ${fenceMarkCount} 处`,
      `首行：${firstLine}${(collectedLines[0] ?? '').length > 60 ? '…' : ''}`,
    ];

    const collectionId = emptyId;
    collections.set(collectionId, { blocks: parsed.blocks, at: collected.collectedAt, replyLength: collected.replyText.length });
    while (collections.size > MAX_COLLECTIONS) {
      const oldest = collections.keys().next();
      if (oldest.done) break;
      collections.delete(oldest.value);
    }

    const blocks: ReturnPreview['blocks'] = [];

    for (let i = 0; i < parsed.blocks.length; i += 1) {
      const b = parsed.blocks[i] as ParsedCodeBlock;
      const hints: string[] = [];
      if (b.pathSource === 'unique-mention') {
        hints.push('目标文件来自"全文唯一候选"推断（可靠性最低），请务必核对');
      }
      if (b.pathSource === 'none' || !b.filePath) {
        hints.push('未能确定目标文件，请手动填写路径');
      }

      let fileExists = false;
      let fileLines: number | null = null;
      let applicable = false;
      let blockedReason: string | undefined;

      if (b.filePath) {
        const read = await fileService.readRawText(b.filePath);
        if (read.ok) {
          fileExists = true;
          fileLines = read.text.split(/\r\n|\r|\n/).length;
        } else {
          blockedReason = read.error;
        }
      } else {
        blockedReason = '未确定目标文件';
      }

      if (b.range) {
        if (!fileExists) {
          applicable = false;
          blockedReason = blockedReason ?? '目标文件不存在，无法做片段替换';
        } else if (fileLines !== null && (b.range.end > fileLines || b.range.start < 1)) {
          applicable = false;
          blockedReason = `行区间 ${b.range.start}-${b.range.end} 超出文件范围（共 ${fileLines} 行）`;
        } else {
          // 片段替换还需要"复制时的原文"做三向校验；此处只有区间，故标记为"需人工确认"
          applicable = true;
          hints.push('片段替换：应用时会用当前行内容做三向校验，不一致将被拒绝');
        }
      } else {
        applicable = fileExists;
        if (!fileExists) hints.push('目标文件不存在，应用将创建新文件（需你确认）');
      }

      // 行号预览：整文件替换从第 1 行起算；片段替换用"范围起始行"，
      // 这样用户看到的就是**应用后会落在文件里的真实行号**。
      const previewStart = b.range ? b.range.start : 1;
      const allCodeLines = b.code.length === 0 ? [] : b.code.split(/\r\n|\r|\n/);
      const PREVIEW_LINES = 6;
      const firstLines = allCodeLines.slice(0, PREVIEW_LINES).map((text, k) => ({ lineNo: previewStart + k, text }));

      /*
       * 逐行 diff —— 顺带完成"三向校验"。
       *
       * 这里复用 computeApply 得到"应用后的完整文本"，再与原文对比：
       *  - 校验通过 → 给出 diff，用户在落盘前就能看到具体增删了哪些行；
       *  - 校验失败（区间越界 / 原内容不匹配 / 上下文不匹配）→ 不给 diff，
       *    直接把该块标成阻塞并说明原因。**绝不让用户以为可以应用**。
       */
      let diff: ReturnPreview['blocks'][number]['diff'] = null;
      if (b.filePath && fileExists) {
        const readForDiff = await fileService.readRawText(b.filePath);
        if (readForDiff.ok) {
          let mode: Parameters<typeof computeApply>[2];
          if (b.range) {
            const lines = readForDiff.text.split(/\r\n|\r|\n/);
            const sliceOk = b.range.start >= 1 && b.range.end <= lines.length;
            if (sliceOk) {
              mode = {
                kind: 'replace-lines',
                start: b.range.start,
                end: b.range.end,
                expectedOriginal: lines.slice(b.range.start - 1, b.range.end).join('\n'),
                contextPrev: b.range.start - 2 >= 0 ? (lines[b.range.start - 2] ?? null) : null,
                contextNext: b.range.end < lines.length ? (lines[b.range.end] ?? null) : null,
              };
            } else {
              mode = { kind: 'replace-lines', start: b.range.start, end: b.range.end, expectedOriginal: '' };
            }
          } else {
            mode = { kind: 'replace-whole-file' };
          }

          const computed = computeApply(readForDiff.text, b, mode);
          if (computed.ok) {
            diff = diffTexts(readForDiff.text, computed.text);
            if (diff.identical) {
              hints.push('应用后内容与当前文件完全相同，无需改动');
            }
          } else {
            applicable = false;
            blockedReason = computed.detail;
          }
        }
      }

      blocks.push({
        index: i,
        filePath: b.filePath,
        pathSource: b.pathSource,
        range: b.range,
        codeLines: allCodeLines.length,
        codeChars: b.code.length,
        firstLines,
        moreLines: Math.max(0, allCodeLines.length - firstLines.length),
        diff,
        fileExists,
        fileLines,
        applicable,
        ...(blockedReason ? { blockedReason } : {}),
        hints,
      });
    }

    const previewResult: ReturnPreview = {
      ok: true,
      collectionId,
      strategyId: collected.strategyId,
      strategyDescription: collected.strategyDescription,
      attempts: collected.attempts,
      replyText: collected.replyText,
      notes: parseNotes,
      blocks,
    };
    // 推到右下角预览面板，并把面板显示出来（用户建议的位置：不压编辑器高度）
    if (previewHeight <= 0) {
      previewHeight = Math.max(PREVIEW_MIN_HEIGHT, Math.round((win.getContentSize()[1] ?? 900) * 0.4));
      relayout();
    }
    pushPreviewToPanel(previewResult);

    /*
     * 采集成功后**自动把第一个可应用的变更送进编辑器**（Monaco DiffEditor）。
     *
     * 为什么必须自动（用户实测反馈："diff 还是在右下角，没有在编辑器中渲染"）：
     * 之前的 `showDiffInEditor` 链路是通的，但**唯一调用点在右下角面板的按钮上**——
     * 等于要求用户先看面板、再点一次按钮，才看得到 diff。主流编辑器的行为是
     * "变更出现在哪就在哪看"，所以这里在采集返回时直接进编辑器。
     *
     * 仍然复用 `buildEditorDiff`：它带同一份三向校验，
     * 因此**不会出现"编辑器里显示了 diff、点应用却失败"**的情况。
     * 校验不过（文件已变 / 区间非法）就跳过自动打开，理由留给面板显示。
     */
    const firstApplicable = blocks.find((b) => b.applicable);
    if (firstApplicable && !editorView.webContents.isDestroyed()) {
      const payload = await buildEditorDiff(collectionId, firstApplicable.index);
      if (payload) {
        editorView.webContents.send(CHANNELS.diffData, payload);
      }
    }
    return previewResult;
  });
  /**
   * 应用一个变更。
   *
   * 由 `collectionId` + `index` 引用主进程缓存里的代码块（渲染进程不转手代码文本）。
   * 若是片段替换，主进程在**读文件的同一时刻**抓取该区间当前内容作为"复制时的原文"——
   * 这样三向校验才有可信基线；此后文件若被改动，校验必然失败并拒绝写入。
   */
  ipcMain.handle(CHANNELS.applyChange, async (_e, input: unknown) => {
    const raw = (input ?? {}) as Partial<ApplyChangeInput>;
    if (typeof raw.collectionId !== 'string' || typeof raw.index !== 'number' || typeof raw.filePath !== 'string') {
      return { ok: false, error: '参数不合法：需要 collectionId / index / filePath' };
    }

    const cached = collections.get(raw.collectionId);
    if (!cached) {
      return { ok: false, error: '采集结果已过期（只保留最近几批），请重新点「采集回复」' };
    }
    const block = cached.blocks[raw.index];
    if (!block) {
      return { ok: false, error: `代码块序号 ${raw.index} 不存在于该批次中` };
    }

    const filePath = raw.filePath.trim();
    if (filePath.length === 0) return { ok: false, error: '目标文件路径为空' };

    let expectedOriginal: string | undefined;
    let contextPrev: string | null = null;
    let contextNext: string | null = null;

    if (block.range) {
      const read = await fileService.readRawText(filePath);
      if (!read.ok) return { ok: false, error: read.error };
      const lines = read.text.split(/\r\n|\r|\n/);
      if (block.range.start < 1 || block.range.end > lines.length) {
        return {
          ok: false,
          reason: 'range-invalid',
          error: `行区间 ${block.range.start}-${block.range.end} 超出文件范围（文件共 ${lines.length} 行），已拒绝写入`,
        };
      }
      expectedOriginal = lines.slice(block.range.start - 1, block.range.end).join('\n');
      contextPrev = block.range.start - 2 >= 0 ? (lines[block.range.start - 2] ?? null) : null;
      contextNext = block.range.end < lines.length ? (lines[block.range.end] ?? null) : null;
    }

    /*
     * 落盘成功后**必须广播给编辑器**，否则它一直显示旧内容。
     * 用户实测："应用后没有及时刷新文件，显示仍然是旧代码，
     * 只有关闭文件重新打开才会显示应用后的代码" ——
     * 因为落盘在主进程，而编辑器是另一个渲染进程，不会自动察觉磁盘变化。
     */
    const outcome = await returnPath.applyChange({
      filePath,
      block,
      ...(expectedOriginal !== undefined ? { expectedOriginal } : {}),
      contextPrev,
      contextNext,
    });
    if (outcome.ok) {
      notifyFileChanged(filePath);
    }
    return outcome;
  });

  /** 通知编辑器：磁盘上的这个文件刚被改写了（成功落盘后才调用） */
  function notifyFileChanged(filePath: string) {
    if (!editorView.webContents.isDestroyed()) {
      editorView.webContents.send(CHANNELS.fileChanged, filePath);
    }
  }

  ipcMain.handle(CHANNELS.undoSave, async () => {
    const result = await returnPath.undoLast();
    // 撤销也是改写磁盘，同样要通知编辑器刷新
    if (result.ok && result.filePath) {
      notifyFileChanged(result.filePath);
    }
    return result;
  });

  /**
   * 把编辑器里的选中内容格式化为"带文件真实行号"的片段并写入剪贴板。
   *
   * 用于**局部修改**：片段头部带 `### 文件：` 与 `### 范围：N-M`，正文带行号前缀。
   * 围栏长度按内容自适应（内容含 ``` 时自动加长，避免提前闭合）。
   * 仍**只写剪贴板**，由用户自己粘贴（ADR-0003）。
   */
  ipcMain.handle(CHANNELS.copyNumberedSnippet, (_e, input: unknown) => {
    const raw = (input ?? {}) as { relPath?: unknown; text?: unknown; startLine?: unknown };
    const relPath = typeof raw.relPath === 'string' ? raw.relPath : '';
    const text = typeof raw.text === 'string' ? raw.text : '';
    const startLine =
      typeof raw.startLine === 'number' && Number.isFinite(raw.startLine) ? Math.max(1, Math.round(raw.startLine)) : 1;

    if (relPath.length === 0) return { ok: false, snippet: '', length: 0, error: '未指定文件路径（请先打开一个文件）' };
    if (text.length === 0) return { ok: false, snippet: '', length: 0, error: '没有可复制的内容（请先选中代码或打开文件）' };

    const parts = buildSnippetText({ relPath, text, startLine });
    try {
      clipboard.writeText(parts.text);
      return { ok: true, snippet: parts.text, length: parts.text.length, startLine: parts.startLine, endLine: parts.endLine };
    } catch (err) {
      return { ok: false, snippet: parts.text, length: parts.text.length, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * 把当前打开的**整个文件**写入剪贴板，作为**上下文**交给模型。
   *
   * 格式：`这个文件是 <相对路径>` + 代码围栏 + 全文。
   * 刻意**不使用 `### ` 标题行** —— 那是"待应用变更"的标记，而这里给的是上下文，
   * 不该被回程解析器当成一个待写入的代码块。
   */
  ipcMain.handle(CHANNELS.copyWholeFile, async (_e, relPath: unknown) => {
    const rel = typeof relPath === 'string' ? relPath.trim() : '';
    if (rel.length === 0) return { ok: false, snippet: '', length: 0, error: '未指定文件路径（请先打开一个文件）' };

    const read = await fileService.readRawText(rel);
    if (!read.ok) return { ok: false, snippet: '', length: 0, error: read.error };

    const parts = buildWholeFileText(read.relPath, read.text);
    try {
      clipboard.writeText(parts.text);
      return {
        ok: true,
        snippet: parts.text,
        length: parts.text.length,
        relPath: parts.relPath,
        lineCount: parts.lineCount,
        fence: parts.fence,
      };
    } catch (err) {
      return { ok: false, snippet: parts.text, length: parts.text.length, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * 组装完整 prompt（需求 + 工作环境 + 目录结构 + 格式要求）并写入剪贴板。
   *
   * 边界（ADR-0003 零注入）：**只写剪贴板**。用户在应用内输入框写需求 →
   * 点「复制 prompt」→ 自己 Ctrl+V 到网页 → 自己回车。
   * 程序不接触网页输入框，因此不产生任何"程序在操作"的特征。
   */
  ipcMain.handle(CHANNELS.copyPrompt, (_e, requirement: unknown, targetFiles: unknown) => {
    const req = typeof requirement === 'string' ? requirement : '';
    const files = Array.isArray(targetFiles) ? targetFiles.filter((f): f is string => typeof f === 'string') : [];
    const ctx = buildContextSummary(fileService.getRoot());
    const prompt = buildPrompt({
      requirement: req,
      context: {
        root: ctx.root,
        environment: ctx.environment,
        tree: ctx.tree ? `${ctx.tree}${ctx.treeTruncated ? '\n…（目录较多，已截断）' : ''}` : null,
      },
      formatSpec: getFormatSpec('short'),
      targetFiles: files,
    });
    try {
      clipboard.writeText(prompt);
      return { ok: true, prompt, length: prompt.length };
    } catch (err) {
      return { ok: false, prompt, length: prompt.length, error: err instanceof Error ? err.message : String(err) };
    }
  });

  function notifyRootChanged(info: RootInfo): void {
    if (!editorView.webContents.isDestroyed()) {
      editorView.webContents.send(CHANNELS.rootChanged, info);
    }
  }

  function setRootAndNotify(absPath: string): string {
    const root = fileService.setRoot(absPath);
    settings.update({ lastRoot: root });
    notifyRootChanged({ root });
    process.stdout.write(`[fs] 已打开目录：${root}\n`);
    return root;
  }

  /* ---------------- 菜单 ----------------
   *
   * View 菜单里的「AI 网页」是**最后一道兜底**：网页显隐的主入口在网页区顶部工具条，
   * 而网页隐藏时那块工具条变成右边缘把手。菜单是应用级 UI、**永远不会被隐藏**，
   * 保证"网页永远能被叫回来"（与把手、`Ctrl+Shift+A` 快捷键并存）。
   *
   * 因为菜单项带勾选状态，必须跟随实际显隐重建 —— 故抽成函数而不是一次性常量。
   */
  function buildApplicationMenu(): void {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
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
                    setRootAndNotify(picked.filePaths[0]);
                  }
                })();
              },
            },
            {
              label: '只复制输出格式要求（不含上下文）',
              click: () => {
                const text = getFormatSpec('short');
                clipboard.writeText(text);
                process.stdout.write(`[format] 已复制格式要求（${text.length} 字符）到剪贴板\n`);
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
            {
              label: 'AI 网页',
              type: 'checkbox',
              checked: webVisible,
              accelerator: 'CmdOrCtrl+Shift+A',
              click: () => {
                setWebVisible(!webVisible);
              },
            },
            {
              label: '回程预览面板',
              type: 'checkbox',
              checked: previewHeight > 0,
              click: () => {
                previewHeight =
                  previewHeight > 0
                    ? 0
                    : Math.max(PREVIEW_MIN_HEIGHT, Math.round((win.getContentSize()[1] ?? 900) * 0.4));
                relayout();
                buildApplicationMenu();
              },
            },
            { type: 'separator' },
            { role: 'resetZoom', label: '重置缩放' },
            { role: 'zoomIn', label: '放大' },
            { role: 'zoomOut', label: '缩小' },
          ],
        },
      ])
    );
  }
  buildApplicationMenu();

  /* ---------------- 先决定根目录，再加载页面 ----------------
   * 顺序很重要：渲染进程在页面加载完成时就会调用 `getRoot()`。
   * 早期实现先 `await loadFile()` 再恢复目录，渲染进程**永远拿不到**恢复结果，
   * 表现为"目录记忆没生效"（P2-12）。
   */
  const rootArg = process.argv.find((a) => a.startsWith('--root='))?.slice('--root='.length);
  let restoredRoot: string | null = null;
  let staleRoot: string | null = null;

  if (rootArg) {
    restoredRoot = fileService.setRoot(rootArg);
    process.stdout.write(`[fs] 命令行指定根目录：${restoredRoot}\n`);
  } else if (isUsableRoot(saved.lastRoot)) {
    restoredRoot = fileService.setRoot(saved.lastRoot);
    process.stdout.write(`[fs] 已恢复上次打开的目录：${restoredRoot}\n`);
  } else if (saved.lastRoot) {
    staleRoot = saved.lastRoot;
    settings.update({ lastRoot: null });
    process.stdout.write(`[fs] 上次打开的目录已不存在，已清除记忆：${staleRoot}\n`);
  } else {
    process.stdout.write('[fs] 无历史目录记录\n');
  }

  // 记下启动时的恢复结果：自检会把根目录改成临时样例目录，
  // 因此"恢复断言"必须比对**启动那一刻**的值（P2-12 的验证就靠它）。
  const startupRoot = fileService.getRoot();

  // 模拟"第二次启动"：把当前目录写入设置但不真正恢复，用于自检/验证记忆功能
  if (process.argv.includes('--simulate-restart')) {
    const target = process.argv.find((a) => a.startsWith('--persist-root='))?.slice('--persist-root='.length);
    if (target) {
      settings.update({ lastRoot: target });
      process.stdout.write(`[simulate-restart] 已把 lastRoot 写入设置：${target}\n`);
    } else {
      process.stdout.write('[simulate-restart] 未提供 --persist-root，跳过写入\n');
    }
  }

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

  await loadLocalView(editorView, 'index.html');

  // 告知渲染进程：记忆的目录已失效（让界面明确提示，而不是"看似有目录、实际读不了"）
  if (staleRoot && !editorView.webContents.isDestroyed()) {
    editorView.webContents.send(CHANNELS.rootStale, { root: null, stale: true } satisfies RootInfo);
  }

  if (SELF_TEST) {
    const fixtures = createFixtures();
    process.stdout.write(`[self-test] 样例目录：${fixtures.root}\n`);
    const report = await runSelfTest({
      editorView,
      webView,
      fileService,
      fixtures,
      boot,
      layout,
      registeredChannels,
      settings,
      ...(process.argv.includes('--test-restore') && startupRoot ? { expectRestoredRoot: startupRoot } : {}),
    });
    process.stdout.write(`\n===== 自检结果 =====\n${JSON.stringify(report, null, 2)}\n`);
    app.exit(report.verdict === 'PASS' ? 0 : 1);
    return;
  }

  if (UI_PROBE) {
    // 等待 Monaco 完成 AMD 加载（create 发生在 require 回调里），再读回**实际生效**的选项
    const deadline = Date.now() + 25000;
    let probe: unknown = null;
    for (;;) {
      try {
        probe = await editorView.webContents.executeJavaScript(
          'typeof window.__uiProbe === "function" ? window.__uiProbe() : null',
          true
        );
      } catch (err) {
        probe = { ready: false, reason: err instanceof Error ? err.message : String(err) };
      }
      const p = probe as { ready?: boolean; reason?: string } | null;
      if (p && p.ready === true) break;
      if (p && typeof p.reason === 'string' && p.reason !== '编辑器尚未创建') break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    process.stdout.write(`\n===== 界面探针结果 =====\n${JSON.stringify(probe, null, 2)}\n`);
    const p = probe as
      | { ready?: boolean; readOnly?: unknown; wordWrap?: unknown; editTest?: { changed?: boolean } }
      | null;
    const editable = Boolean(p && p.ready && p.readOnly === false && p.editTest && p.editTest.changed === true);
    const wraps = Boolean(p && (p.wordWrap === 'on' || p.wordWrap === 1));
    process.stdout.write(
      `[ui-probe] 可编辑：${editable ? '是' : '否'}；readOnly=${String(p?.readOnly)}；wordWrap=${String(p?.wordWrap)}（判定换行：${wraps ? '开' : '关'}）\n`
    );

    // 几何测量：把预览面板显示出来，确认「应用」按钮真的在视口内
    let geometry: unknown = null;
    try {
      geometry = await editorView.webContents.executeJavaScript(
        'typeof window.__uiGeometryProbe === "function" ? window.__uiGeometryProbe() : null',
        true
      );
    } catch (err) {
      geometry = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    process.stdout.write(`\n===== 界面几何 =====\n${JSON.stringify(geometry, null, 2)}\n`);
    const g = geometry as { ok?: boolean; editorFills?: boolean; promptVisible?: boolean } | null;
    const layoutOk = Boolean(g && g.ok && g.editorFills === true && g.promptVisible === true);
    process.stdout.write(
      `[ui-probe] 编辑器占满可用高度：${g?.editorFills ? '是' : '否'}；需求输入区在视口内：${g?.promptVisible ? '是' : '否'}；布局自洽：${layoutOk ? '是' : '否'}\n`
    );

    // 预览面板已移到右下角独立视图，其界面契约由自检 L8–L11 覆盖

    // 选区浮层复制按钮实测（仅在 `--test-bubble` 时做）：
    // 真的设一个跨折行选区，读回按钮的 computed display/visibility 与几何矩形。
    if (process.argv.includes('--test-bubble')) {
      let bubbleProbe: unknown = null;
      try {
        bubbleProbe = await editorView.webContents.executeJavaScript(
          'typeof window.__uiSelectionProbe === "function" ? window.__uiSelectionProbe() : null',
          true
        );
      } catch (err) {
        bubbleProbe = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      process.stdout.write(`\n===== 选区浮层探针 =====\n${JSON.stringify(bubbleProbe, null, 2)}\n`);
      const b = bubbleProbe as { ok?: boolean; visible?: boolean; reason?: string } | null;
      process.stdout.write(
        `[ui-probe] 选区浮层按钮真的出现：${b?.visible ? '是' : '否'}${b?.reason ? '（' + b.reason + '）' : ''}\n`
      );
      app.exit(editable && wraps && layoutOk && b?.visible === true ? 0 : 1);
      return;
    }

    // 查找框 hover 闪烁归属实测（仅在 `--test-findhover` 时做）：
    // 派发合成 Alt 事件并在窗口期内统计 monaco-hover 浮层节点的增删次数，
    // 用来判定"闪"是 SimpleButton 共性还是 close 独有 —— 决定补丁落点。
    if (process.argv.includes('--test-findhover')) {
      let hoverProbe: unknown = null;
      try {
        hoverProbe = await editorView.webContents.executeJavaScript(
          'typeof window.__uiFindHoverProbe === "function" ? window.__uiFindHoverProbe() : null',
          true
        );
      } catch (err) {
        hoverProbe = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      process.stdout.write(`\n===== 查找框 hover 闪烁探针 =====\n${JSON.stringify(hoverProbe, null, 2)}\n`);
      const h = hoverProbe as { ok?: boolean; flashing?: boolean; buttonsFound?: unknown[] } | null;
      process.stdout.write(
        `[ui-probe] 浮层被反复重建（会闪）：${h?.flashing ? '是' : '否'}；` +
          `识别到的查找框按钮：${Array.isArray(h?.buttonsFound) ? h?.buttonsFound.length : 0} 个\n`
      );
      app.exit(editable && wraps && layoutOk ? 0 : 1);
      return;
    }

    // 差异视图实测（仅在 `--test-diff` 时做）：确认 Monaco DiffEditor 真能创建并拿到两侧模型
    if (process.argv.includes('--test-diff')) {
      const sample = 'const a = 1;\nconst b = 2;\n';
      const changed = 'const a = 1;\nconst b = 22;\nconst c = 3;\n';
      let diffProbe: unknown = null;
      try {
        diffProbe = await editorView.webContents.executeJavaScript(
          `typeof window.__uiDiffProbe === "function" ? window.__uiDiffProbe(${JSON.stringify(sample)}, ${JSON.stringify(changed)}) : null`,
          true
        );
      } catch (err) {
        diffProbe = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      process.stdout.write(`\n===== 差异视图探针 =====\n${JSON.stringify(diffProbe, null, 2)}\n`);
      const d = diffProbe as { ok?: boolean } | null;
      process.stdout.write(`[ui-probe] 编辑器内差异视图可用：${d?.ok ? '是' : '否'}\n`);
      app.exit(editable && wraps && layoutOk && d?.ok === true ? 0 : 1);
      return;
    }

    app.exit(editable && wraps && layoutOk ? 0 : 1);
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
