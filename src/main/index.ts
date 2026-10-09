import { sessionKeyOf } from './consumptionStore';
import { LocalPromptController } from './localPromptController';
import { LocalPromptAttachments } from './localPromptAttachments';
import { SkillService } from './skills';
import { WebComposerSender } from './webComposerSender';
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
import { app, BaseWindow, clipboard, dialog, ipcMain, Menu, session, WebContentsView } from 'electron';
import * as path from 'node:path';

import { CHANNELS, type PromptPanelState, type PromptComposerStatus, type PromptVariantState, type SavePromptSpecResult, type ReturnPreview, type RootInfo } from '../shared/contract';
import { getFormatSpec, resolveFormatSpec, normalizeVariant, MAX_CUSTOM_FORMAT_SPEC_LENGTH, type CustomFormatSpecs, type FormatSpecVariant } from '../shared/formatSpec';
import { buildSnippetText } from '../shared/snippet';
import { checkUaConsistency, stripSelfDeclarations } from '../shared/userAgent';
import { FileService } from './fileService';
import { registerFileIpc } from './ipc';
import { createFixtures } from './fixtures';
import { runSelfTest } from './selfTest';
import { runDiagnose } from './diagnose';
import { SettingsStore, PRODUCTION_SETTINGS_FILE, SELF_TEST_SETTINGS_FILE, type Settings } from './settings';
import { buildContextSummary } from './contextSummary';
import { ReturnPathService } from './returnPathService';
import { WorkspaceLayoutController } from './workspaceLayoutController';
import { runLayoutProbe } from './layoutProbe';
import { WorkspaceService } from './workspaceService';
import { WorkspaceController } from './workspaceController';
import { configureWorkspaceProbe, runWorkspaceProbe } from './workspaceProbe';
import { createApplicationUpdater, type ApplicationUpdater } from './appUpdater';
import { registerApplicationUpdateIpc } from './applicationUpdateIpc';
import { createToolIntegration, readAutoReply, registerToolShutdown } from './tools/integration';

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
/**
 * 提示词编辑面板（覆盖式浮层）的尺寸区间。
 *
 * 为什么是"窗口比例 + 上下限"而不是固定像素：面板里放的是一个**多行长文本编辑器**，
 * 写格式约定时经常要对照好几屏内容。固定 480px 高在 1080p 上只有十几行可见，
 * 用户会不停滚动；而纯比例在大屏上又会拉到失真。两者取交集最稳。
 */
const PROMPT_PANEL_MIN_WIDTH = 560;
const PROMPT_PANEL_MAX_WIDTH = 980;
const PROMPT_PANEL_MIN_HEIGHT = 420;
const PROMPT_PANEL_MAX_HEIGHT = 900;

const SELF_TEST = process.argv.includes('--self-test');
const WORKSPACE_PROBE = process.argv.includes('--workspace-probe');
/** 界面运行时探针：不联网，加载编辑器后读回 Monaco 实际选项并试改文本，然后退出 */
const UI_PROBE = process.argv.includes('--ui-probe') || WORKSPACE_PROBE;
/** 会话与网络诊断模式：加载目标站点并输出登录态与网络失败明细，然后退出 */
const DIAGNOSE = process.argv.includes('--diagnose');

/** 分区宽度（编辑器内部左侧目录树，渲染进程自绘，这里只持久化用户选择） */

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
/** 预览面板是否可见 + 其宽度（0 表示隐藏） */

/** 右侧 AI 网页是否显示（可隐藏，把空间让给预览面板或编辑器） */


async function bootstrap(): Promise<void> {
  // Electron 的应用名会影响 userData 目录；显式设定以保证分区落盘位置可预期。
  app.setName('mini-ai-ide');
  const probeDirectory = SELF_TEST || UI_PROBE ? configureWorkspaceProbe() : null;
  const workspaceProbeDirectory = WORKSPACE_PROBE ? probeDirectory : null;

  await app.whenReady();

  const fileService = new FileService();
  const settings = new SettingsStore(SELF_TEST ? SELF_TEST_SETTINGS_FILE : PRODUCTION_SETTINGS_FILE);
  const saved = settings.get();
  const workspace = new WorkspaceService(fileService, settings);
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
  const win = new BaseWindow({ width: 1600, height: 960, minWidth: 1080, minHeight: 600, show: !SELF_TEST, title: 'Mini-AI-IDE' });
  let updater: ApplicationUpdater | null = null;
  let closeApproved = false;
  let closePending = false;
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

  // 回程预览：**独立的最右侧视图**（不再挤在编辑器下方，见 computeLayout 注释）
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

  // 网页区顶部工具条：**独立视图**，承载只读采集和受限的本地布局操作。
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

  /**
   * 提示词编辑面板：**独立视图**，默认隐藏，点设置菜单/工具栏齿轮时才显示。
   *
   * 为什么不做成编辑器里的 DOM 弹层：编辑器渲染进程的 CSP 是 `default-src 'none'`，
   * 且它持有的是**文件系统能力**（save/writeFile）。让"编辑提示词文本"这件事
   * 跑在持有文件写权限的进程里，等于给一个纯文本编辑框配上文件写权限 ——
   * 没必要扩大它的能力面。独立视图 + 独立窄桥，风险面最小（与预览面板同一套做法）。
   */
  const promptView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'promptPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 纯本地界面，不需要网络也不需要网页会话
      partition: 'persist:editor-ui',
    },
  });
  const PROMPT_HIDDEN_BOUNDS = { x: -10000, y: -10000, width: 0, height: 0 };

  win.contentView.addChildView(editorView);
  win.contentView.addChildView(webBarView);
  win.contentView.addChildView(webView);
  win.contentView.addChildView(previewView);
  /*
   * 提示词面板**最后添加**：后加入的子视图在更上层。
   * 它是一块覆盖式浮层，必须盖住编辑器与网页，否则打开后会被它们挡住。
   */
  win.contentView.addChildView(promptView);
  const skills = new SkillService(probeDirectory ? path.join(probeDirectory, 'global-skills') : undefined);
  const composerSender = new WebComposerSender(webView.webContents, { allowLocalFixture: WORKSPACE_PROBE });
  let localPrompt: LocalPromptController | undefined;
  const layoutController = new WorkspaceLayoutController(win,
    { editor: editorView, web: webView, webbar: webBarView, preview: previewView }, settings,
    () => buildApplicationMenu());
  let layout = layoutController.layout;
  function relayout(): void { layoutController.apply(); layout = layoutController.layout; }
  relayout();
  promptView.setBounds(PROMPT_HIDDEN_BOUNDS);
  promptView.setVisible(false);

  /**
   * 提示词面板的显示/隐藏（覆盖式浮层）。
   *
   * 与三区布局**刻意解耦**：它是浮层，改窗口大小只需重算它自己的居中几何，
   * 不必（也不该）去动编辑器/网页的 bounds —— 否则打开面板就会把用户的
   * 分栏拖拽结果悄悄改掉。因此这里不调 `relayout()`，只调 `promptPanelBounds()`。
   */
  function promptPanelBounds(): { x: number; y: number; width: number; height: number } {
    const s = win.getContentSize();
    const w = s[0] ?? 1440;
    const h = s[1] ?? 900;
    const width = Math.min(PROMPT_PANEL_MAX_WIDTH, Math.max(PROMPT_PANEL_MIN_WIDTH, Math.round(w * 0.62)));
    const height = Math.min(PROMPT_PANEL_MAX_HEIGHT, Math.max(PROMPT_PANEL_MIN_HEIGHT, Math.round(h * 0.78)));
    // 略偏上：视觉重心在上方，比几何居中更稳（下方留出的空白用于"关闭"后的呼吸感）
    const y = Math.max(24, Math.round((h - height) * 0.42));
    return { x: Math.round((w - width) / 2), y, width, height };
  }

  /**
   * 从设置里取出分版本的自定义内容，喂给 `resolveFormatSpec`。
   *
   * 单独抽一个函数是因为**三条消费链路**（复制提示词 / 只复制格式要求 / 面板状态）
   * 必须都从这里拿，才能保证"能改也真的改了"——分散取值最容易漏掉某一条。
   */
  function customSpecsOf(s: Settings): CustomFormatSpecs {
    return { short: s.customFormatSpecShort, full: s.customFormatSpecFull };
  }

  /**
   * 收集面板需要的全部状态。
   *
   * `defaultSpec` 每次现取（而不是缓存）——「恢复默认」必须拿到**当前版本**的默认文本；
   * 缓存会让"升级后点恢复默认，拿回的还是旧版模板"这种问题静默发生。
   *
   * 分版本返回：面板要能分别展示/编辑简洁版与完整版。
   */
  function promptPanelState(): PromptPanelState {
    const cur = settings.get();
    const mk = (variant: FormatSpecVariant): PromptVariantState => {
      const custom = variant === 'full' ? cur.customFormatSpecFull : cur.customFormatSpecShort;
      return {
        defaultSpec: getFormatSpec(variant),
        customSpec: custom,
        isCustom: typeof custom === 'string' && custom.trim().length > 0,
      };
    };
    return {
      variant: cur.formatSpecVariant,
      short: mk('short'),
      full: mk('full'),
      updatedAt: cur.customFormatSpecUpdatedAt,
      maxLength: MAX_CUSTOM_FORMAT_SPEC_LENGTH,
    };
  }

  function promptStatus(): PromptComposerStatus {
    const cur = settings.get();
    return {
      variant: cur.formatSpecVariant,
      shortIsCustom: Boolean(cur.customFormatSpecShort?.trim()),
      fullIsCustom: Boolean(cur.customFormatSpecFull?.trim()),
    };
  }

  function broadcastPromptStatus(): void {
    if (!editorView.webContents.isDestroyed()) {
      editorView.webContents.send(CHANNELS.promptStatus, promptStatus());
    }
  }

  function showPromptPanel(): void {
    promptView.setBounds(promptPanelBounds());
    promptView.setVisible(true);
    promptView.webContents.focus();
    // 编辑器渲染进程据此点亮工具栏齿轮的激活态（面板是独立视图，它自己看不到）
    if (!editorView.webContents.isDestroyed()) {
      editorView.webContents.send(CHANNELS.openPromptPanel);
    }
  }

  function hidePromptPanel(): void {
    promptView.setVisible(false);
    // 移出可见区域：只 setVisible(false) 在某些平台仍可能保留最后帧
    promptView.setBounds(PROMPT_HIDDEN_BOUNDS);
    // 键盘焦点交还编辑器，否则用户按 Ctrl+S 等快捷键会落在隐藏面板上
    if (!editorView.webContents.isDestroyed()) editorView.webContents.focus();
  }

  win.on('resize', relayout);
  // 面板是浮层：窗口尺寸变了只需重算它自己的居中几何（不动三区，见 promptPanelBounds 注释）
  win.on('resize', () => {
    if (promptView.getVisible()) promptView.setBounds(promptPanelBounds());
  });

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
 * 之所以必须成功：这些视图承载网页只读采集与文件区恢复入口，
 * 加载失败会让用户失去网页采集操作，不能静默跳过。
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

/* ---------------- 提示词编辑面板的 IPC ----------------
 *
 * ⚠️ **必须在加载 prompt.html 之前注册**（用户实测踩坑）：
 * 面板渲染进程在 `DOMContentLoaded` 那一刻就会调 `bridge.getState()`，
 * 而本函数是 `async` 的、中间有一串 `await`。此前这几个 handler 写在文件靠后的
 * "IPC 区"，于是面板加载完成时它们还没注册 → 面板拿到
 * `No handler registered for 'ui:prompt-panel-state'`：
 * 底部报错、编辑框空白（用户看到的正是这两点）。
 *
 * 这也解释了为什么预览面板没出过这个问题：它的 preload 只 `ipcRenderer.on(...)`
 * 订阅广播，用查询面板的关键词搜不到它、看上去"少了"，其实**不需要**被查询到。
 * 而面板要**拉取**状态，是主动 invoke —— 注册时机就成了硬约束。
 *
 * 通用规则：**渲染进程可能在页面加载瞬间调用的 handler，都要在 `loadLocalView` 之前注册。**
 */
  ipcMain.handle(CHANNELS.getPromptStatus, () => promptStatus());
  ipcMain.handle(CHANNELS.promptPanelState, (): PromptPanelState => promptPanelState());

  /** 编辑器工具栏的齿轮 / 快捷键：只负责"把面板显示出来"（三个入口汇聚到这里） */
  ipcMain.handle(CHANNELS.openPromptPanel, () => {
    showPromptPanel();
    return { ok: true };
  });

  /**
   * 保存用户自定义内容（**按版本**）。
   *
   * 语义（与面板文案一致）：**内容为空白 ⇒ 等同于恢复默认**。
   * 这样"清空并保存"与"点恢复默认"是同一个结果，用户不会走到
   * "保存了一个空格式要求、提示词里那段约定凭空消失"的状态
   *（那会让模型输出无法被解析，且没有任何报错）。
   */
  ipcMain.handle(
    CHANNELS.savePromptSpec,
    (_e, variant: unknown, spec: unknown): SavePromptSpecResult => {
      const v = normalizeVariant(variant);
      const raw = typeof spec === 'string' ? spec : '';
      const text = raw.slice(0, MAX_CUSTOM_FORMAT_SPEC_LENGTH);
      const key = v === 'full' ? 'customFormatSpecFull' : 'customFormatSpecShort';
      if (text.trim().length === 0) {
        settings.update({ [key]: null, customFormatSpecUpdatedAt: null });
        broadcastPromptStatus();
        process.stdout.write(`[prompt] 自定义格式要求（${v}）已清空，回到内置默认\n`);
        return { ok: true, variant: v, state: promptPanelState(), resetToDefault: true };
      }
      settings.update({ [key]: text, customFormatSpecUpdatedAt: new Date().toISOString() });
      broadcastPromptStatus();
      // 只记长度：格式要求是用户内容，不整段写日志
      process.stdout.write(`[prompt] 已保存自定义格式要求（${v}，${text.length} 字符）\n`);
      return { ok: true, variant: v, state: promptPanelState() };
    }
  );

  ipcMain.handle(CHANNELS.resetPromptSpec, (_e, variant: unknown): SavePromptSpecResult => {
    const v = normalizeVariant(variant);
    const key = v === 'full' ? 'customFormatSpecFull' : 'customFormatSpecShort';
    settings.update({ [key]: null, customFormatSpecUpdatedAt: null });
    broadcastPromptStatus();
    process.stdout.write(`[prompt] 已恢复默认格式要求（${v}）\n`);
    return { ok: true, variant: v, state: promptPanelState(), resetToDefault: true };
  });

  ipcMain.handle(CHANNELS.closePromptPanel, () => {
    hidePromptPanel();
    return { ok: true };
  });

/* ---------------- 加载本地界面视图 ----------------
 * 顺序：预览面板 → 网页区工具条 → 提示词面板 →（下方）编辑器页面。
 * 顺序本身不是根因（换顺序失败对象会飘移），但先加载几个小页面、
 * 让它们与编辑器页面错开，可以减少并发创建渲染进程的压力。
 */
  await loadLocalView(webBarView, 'webbar.html');
  // 提示词面板：同样是本地页面。它的 handler 已在上方注册完毕（见那段注释）。
  await loadLocalView(promptView, 'prompt.html');

  /* ---------------- IPC ---------------- */

  const layoutChannels = layoutController.register();

  /**
   * 把"输出格式要求"模板写入系统剪贴板。
   *
   * 边界（ADR-0003 零注入）：**只写剪贴板，不写网页**。
   * 用户随后自己把它粘贴到提示词里——发出去的动作仍然是人的。
   */
  ipcMain.handle(CHANNELS.copyFormatSpec, (_e, variant: unknown) => {
    // 版本由调用方指定（不传则回落到当前开关状态）；有自定义内容就用自定义
    //（"用户可以改系统 prompt"的落点之一）
    const s = settings.get();
    const v = variant === undefined || variant === null ? s.formatSpecVariant : normalizeVariant(variant);
    const text = resolveFormatSpec(customSpecsOf(s), v);
    try {
      clipboard.writeText(text);
      return { ok: true, length: text.length };
    } catch (err) {
      return { ok: false, length: 0, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(CHANNELS.getFormatSpecVariant, () => settings.get().formatSpecVariant);

  ipcMain.handle(CHANNELS.setFormatSpecVariant, (_e, variant: unknown) => {
    const v = normalizeVariant(variant);
    settings.update({ formatSpecVariant: v });
    broadcastPromptStatus();
    process.stdout.write(`[format] 提示词版本已切换为 ${v}\n`);
    return v;
  });

  /*
   * 提示词编辑面板的 4 个 handler 已上移到"加载本地界面视图 **之前**"注册
   * （见那一段的长注释）：面板页面一加载就会 `invoke('ui:prompt-panel-state')`，
   * 而本函数中间的 `await` 会让"靠后注册"变成"注册太晚"。
   */

  /** 取工作环境摘要（只读；不含"当前打开的文件"，见 contextSummary 注释） */
  ipcMain.handle(CHANNELS.getContext, () => buildContextSummary(fileService.getRoot()));

  /* ---------------- 工具采集与实际文件变更 ---------------- */
  const returnPath = new ReturnPathService(fileService);

  let announcedRevision = workspace.getState().revision;
  const workspaceController = new WorkspaceController(win, editorView.webContents, fileService, workspace,
    (info) => {
      if (info.revision !== announcedRevision) {
        announcedRevision = info.revision ?? announcedRevision;
        localPrompt?.cancel();
        layoutController.update({ previewVisible: false }, false);
        returnPath.clear();
        tools.reset();
      }
      notifyRootChanged(info); buildApplicationMenu();
    },
    (event) => {
      returnPath.invalidate(event.oldRelPath, event.isDirectory);
      tools.invalidate(event.oldRelPath, event.isDirectory);
      editorView.webContents.send(CHANNELS.entryChanged, event);
    }, () => tools.getReviewState().records.length > 0 || returnPath.undoCount > 0);
  const tools = await createToolIntegration({
    ipc: ipcMain, editor: editorView.webContents, web: webView.webContents,
    review: previewView.webContents, skills,
    // Keep the full sender contract: local prompts pass their current-scope guard and staged attachments.
    sender: composerSender,
    notifyReview: state => {
      if (previewView.webContents.isDestroyed()) return;
      previewView.webContents.send(CHANNELS.reviewState, state);

    },
    files: fileService, returnPath, workspace: workspaceController,
    storePath: path.join(app.getPath('userData'), SELF_TEST || UI_PROBE || DIAGNOSE ? 'tools-probe.json' : 'tools.json'),
    disabled: SELF_TEST || UI_PROBE || DIAGNOSE,
    ask: async (title, detail, buttons, checkboxLabel) => dialog.showMessageBox(win, {
      type: 'question', title, message: title, detail, buttons, defaultId: buttons.length - 1,
      cancelId: buttons.length - 1, ...(checkboxLabel ? { checkboxLabel, checkboxChecked: false } : {}),
    }),
    notifyFile: (relative, change, discard) => notifyFileChanged(relative, change, discard),
    copy: text => clipboard.writeText(text),
  });
  localPrompt = new LocalPromptController({ ipc: ipcMain, editor: editorView.webContents, settings, skills, attachments: new LocalPromptAttachments(),
    chooseFiles: async () => { const root = fileService.getRoot(); const result = await dialog.showOpenDialog(win, { title: '选择需求附件', ...(root ? { defaultPath: root } : {}),
      properties: ['openFile', 'multiSelections'], filters: [{ name: '文档与图片', extensions: ['txt', 'md', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'gif'] }] }); return result.canceled ? [] : result.filePaths; },
    sender: { send: (text, session, _kind, current, attachments) => tools.sendLocalPrompt(text, session, current, attachments), cancel: kind => composerSender.cancel(kind) },
    resolveWorkspacePath: relative => fileService.resolveSafePath(relative).then(result => result.ok ? { ok: true, absolute: result.absolute } : { ok: false, error: result.error }),
    root: () => fileService.getRoot(), session: () => sessionKeyOf(webView.webContents.getURL()),
    busy: () => { const state = tools.getState(); return state.busy || state.resultReturn?.phase === 'sending' || ['countdown', 'sending', 'waiting_tools'].includes(state.continuation?.phase ?? ''); },
    copy: text => clipboard.writeText(text), disabled: SELF_TEST || (UI_PROBE && !WORKSPACE_PROBE) || DIAGNOSE });
  const localPromptChannels = localPrompt.register();
  // 先注册只读变更桥，再加载会立即请求初始状态的面板。
  await loadLocalView(previewView, 'preview.html');
  updater = createApplicationUpdater({
    window: win,
    disabled: SELF_TEST || UI_PROBE || DIAGNOSE,
    onStateChanged: state => {
      buildApplicationMenu();
      if (!editorView.webContents.isDestroyed()) editorView.webContents.send(CHANNELS.updateState, state);
    },
    onOpenPanel: () => {
      if (!editorView.webContents.isDestroyed()) {
        editorView.webContents.focus();
        editorView.webContents.send(CHANNELS.openUpdatePanel);
      }
    },
    approveInstall: () => workspaceController.run(async () => {
      if (win.isDestroyed() || closePending || !await workspaceController.editor.canLeave()) return false;
      return !win.isDestroyed();
    }),
  });
  const registeredChannels = [
    ...tools.channels, ...localPromptChannels,
    ...registerApplicationUpdateIpc(ipcMain, editorView.webContents, updater),
    ...registerFileIpc(fileService, {
      chooseRoot: () => workspaceController.chooseRoot(), getState: () => workspace.getState(),
      write: (relative, text) => workspaceController.write(relative, text),
    }), ...workspaceController.register(), ...layoutChannels,
  ];

  /**
   * 从网页视图**只读**采集最新回复，统一交由工具权限 owner 处理。
   * 采集不修改页面，本地工具执行受独立授权约束。
   */
  let collectionSeq = 0;
  ipcMain.handle(CHANNELS.collectReply, (event): Promise<ReturnPreview> => {
    if (![editorView.webContents, webBarView.webContents].some(view => event.sender === view && event.senderFrame === view.mainFrame)) throw new Error('采集仅供本地视图使用');
    const requestedRevision = workspace.getState().revision;
    return workspaceController.run(async () => {
    const emptyId = `c${(collectionSeq += 1)}`;
    if (workspace.getState().revision !== requestedRevision) return {
      ok: false, collectionId: emptyId, strategyId: null, strategyDescription: null, attempts: [], replyText: '',
      notes: [], blocks: [], error: '目录已切换，请在新目录重新采集',
    };
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

    const snapshot = await readAutoReply(webView.webContents);
    const collected = snapshot.collected;

    if (collected.strategyId === null || collected.replyText.length === 0) {
      // 排查基建：采集失败最需要知道"每个策略各返回了什么"——策略命中数与错误
      // 一步到位写进终端，用户复现时把这几行发来即可定位（页面结构变化 / 未输出完 / 其它）。
      process.stdout.write(
        `[collect] 未采到：${collected.attempts
          .map((a) => `${a.strategyId}:${a.ok ? `${a.length} 字符` : a.error ?? '空'}`)
          .join(' · ')}\n`
      );
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

    await tools.accept(collected.replyText, snapshot.completion);
    return {
      ok: true, collectionId: emptyId, strategyId: collected.strategyId, strategyDescription: collected.strategyDescription,
      attempts: collected.attempts, replyText: collected.replyText, notes: ['回复已交由 IDE 工具入口处理；请查看工具结果'], blocks: [],
    };
    });
  });
  /** 通知编辑器：磁盘上的这个文件刚被改写了（成功落盘后才调用） */
  function notifyFileChanged(filePath: string, change: 'updated' | 'created' | 'deleted' = 'updated', discardDraft = false) {
    if (!editorView.webContents.isDestroyed()) {
      editorView.webContents.send(CHANNELS.fileChanged, filePath, change, workspace.getState().revision, discardDraft);
    }
  }

  /**
   * 把编辑器选中原文组装为只读上下文并写入剪贴板。
   *
   * 上下文头声明路径与原文片段；不添加行号或操作指令。
   * 围栏长度按内容自适应（内容含 ``` 时自动加长，避免提前闭合）。
   * 仍**只写剪贴板**，由用户自己粘贴（ADR-0003）。
   */
  ipcMain.handle(CHANNELS.copyNumberedSnippet, (_e, input: unknown) => {
    const raw = (input ?? {}) as { root?: unknown; relPath?: unknown; text?: unknown; startLine?: unknown };
    const relPath = typeof raw.relPath === 'string' ? raw.relPath : '';
    const text = typeof raw.text === 'string' ? raw.text : '';
    const startLine =
      typeof raw.startLine === 'number' && Number.isFinite(raw.startLine) ? Math.max(1, Math.round(raw.startLine)) : 1;

    if (typeof raw.root !== 'string' || raw.root !== fileService.getRoot() ||
      relPath.replace(/\\/g, '/').toLowerCase() !== workspaceController.editor.current.path?.toLowerCase()) {
      return { ok: false, snippet: '', length: 0, error: '目录或文件已变化，请重新复制片段' };
    }

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

  function notifyRootChanged(info: RootInfo): void {
    if (!editorView.webContents.isDestroyed()) {
      editorView.webContents.send(CHANNELS.rootChanged, info);
    }
  }

  function showWorkspaceError(result: RootInfo): void {
    if (result.error) void dialog.showMessageBox(win, { type: 'error', message: '目录操作失败', detail: result.error });
  }

  /* ---------------- 应用菜单 ---------------- */
  function buildApplicationMenu(): void {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: '文件',
          submenu: [
            {
              label: '打开目录…',
              accelerator: 'CmdOrCtrl+O',
              click: () => {
                void workspaceController.chooseRoot().then(showWorkspaceError);
              },
            },
            {
              label: '最近打开',
              submenu: workspace.getState().recentRoots.length ? workspace.getState().recentRoots.map((root, index) => ({
                label: root, click: () => { void workspaceController.openRecent(index).then(showWorkspaceError); },
              })) : [{ label: '暂无最近目录', enabled: false }],
            },
            { label: '关闭目录', enabled: fileService.getRoot() !== null, click: () => { void workspaceController.closeRoot().then(showWorkspaceError); } },
            {
              label: '只复制输出格式要求（不含上下文）',
              click: () => {
                const s = settings.get();
                const text = resolveFormatSpec(customSpecsOf(s), s.formatSpecVariant);
                clipboard.writeText(text);
                process.stdout.write(
                  `[format] 已复制格式要求（${s.formatSpecVariant}，${text.length} 字符）到剪贴板\n`
                );
              },
            },
            {
              // 与底部开关同一语义，但这里可以**指定版本**（不看当前开关状态）。
              // 留着它是因为"临时想拿另一版"时不必先拨开关、拿完再拨回来。
              label: '复制输出格式要求（指定版本）',
              submenu: [
                {
                  label: '简洁版（Short）',
                  click: () => {
                    const s = settings.get();
                    const text = resolveFormatSpec(customSpecsOf(s), 'short');
                    clipboard.writeText(text);
                    process.stdout.write(`[format] 已复制格式要求（short，${text.length} 字符）到剪贴板\n`);
                  },
                },
                {
                  label: '完整版（Full）',
                  click: () => {
                    const s = settings.get();
                    const text = resolveFormatSpec(customSpecsOf(s), 'full');
                    clipboard.writeText(text);
                    process.stdout.write(`[format] 已复制格式要求（full，${text.length} 字符）到剪贴板\n`);
                  },
                },
              ],
            },
            // 与「设置」菜单同一动作：菜单里放两份是**有意的**
            //（用户找"改提示词"时既可能从 File 找、也可能从 Settings 找）
            {
              label: '修改提示词…',
              accelerator: 'CmdOrCtrl+Shift+P',
              click: () => showPromptPanel(),
            },
            { type: 'separator' },
            { role: 'quit', label: '退出' },
          ],
        },
        {
          label: '视图',
          submenu: [
            { role: 'reload', label: '重新加载编辑器' },
            { role: 'toggleDevTools', label: '开发者工具' },
            { type: 'separator' },
            {
              label: '变更列表',
              type: 'checkbox',
              checked: layoutController.state.previewVisible,
              click: () => {
                layoutController.update({ previewVisible: !layoutController.state.previewVisible, fileVisible: true }, false);
              },
            },
            { type: 'separator' },
            { role: 'resetZoom', label: '重置缩放' },
            { role: 'zoomIn', label: '放大' },
            { role: 'zoomOut', label: '缩小' },
          ],
        },
        {
          /*
           * 应用级设置菜单。
           *
           * 「修改提示词…」放在这里而不是散在别处：用户要找的是"改系统 prompt"
           * 这件事本身，菜单名必须给出可预期的落点（用户原话：
           * "具体可以在 IDE 顶部增加一列 Settings，增加一个关于修改 prompt 的行"）。
           *
           * 为什么同时给快捷键：格式要求是这个应用里**改得最频繁**的一段文本
           *（每换一个模型/一种任务就可能想调），比"打开目录"更常用，
           * 值得一个随手可达的入口。
           */
          label: '设置',
          submenu: [
            {
              label: '修改提示词…',
              accelerator: 'CmdOrCtrl+Shift+P',
              click: () => showPromptPanel(),
            },
            { type: 'separator' },
            {
              // 只读回显当前状态，避免用户"以为自己改过、其实还是默认"。
              // 这里**不**动态更新：菜单在 buildApplicationMenu() 时构建，
              // 保存后面板会重算状态；菜单文本在下一次重建时刷新即可
              //（与 View 菜单的勾选项同一条路径，见 buildApplicationMenu 的调用点）。
              label: (() => {
                const cur = settings.get();
                const v = cur.formatSpecVariant;
                const custom = v === 'full' ? cur.customFormatSpecFull : cur.customFormatSpecShort;
                const using = typeof custom === 'string' && custom.trim().length > 0;
                const vName = v === 'full' ? '完整版' : '简洁版';
                return using
                  ? `提示词：${vName} · 自定义（${custom.split('\n').length} 行）`
                  : `提示词：${vName} · 内置默认`;
              })(),
              enabled: false,
            },
          ],
        },
        { label: '帮助', submenu: updater?.menuItems() ?? [] },
      ])
    );
  }

  /* ---------------- 先决定根目录，再加载页面 ----------------
   * 顺序很重要：渲染进程在页面加载完成时就会调用 `getRoot()`。
   * 早期实现先 `await loadFile()` 再恢复目录，渲染进程**永远拿不到**恢复结果，
   * 表现为"目录记忆没生效"（P2-12）。
   */
  const rootArg = process.argv.find((a) => a.startsWith('--root='))?.slice('--root='.length);
  let restoredRoot: string | null = null;
  let staleRoot: string | null = null;
  let restorationError: string | undefined;

  if (rootArg) {
    const opened = workspace.open(rootArg);
    if (!opened.ok) throw new Error(opened.error);
    restoredRoot = opened.root;
    process.stdout.write(`[fs] 命令行指定根目录：${restoredRoot}\n`);
  } else {
    const restoration = workspace.restore();
    restoredRoot = restoration.root;
    restorationError = restoration.error;
    if (restoration.stale) staleRoot = saved.lastRoot;
    if (!restoration.ok) process.stderr.write(`[fs] 恢复目录失败：${restoration.error}\n`);
    else process.stdout.write(restoredRoot ? `[fs] 已恢复上次打开的目录：${restoredRoot}\n` : '[fs] 无历史目录记录\n');
  }
  announcedRevision = workspace.getState().revision;
  buildApplicationMenu();

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
  relayout();

  // 告知渲染进程：记忆的目录已失效（让界面明确提示，而不是"看似有目录、实际读不了"）
  if ((staleRoot || restorationError) && !editorView.webContents.isDestroyed()) {
    editorView.webContents.send(CHANNELS.rootStale, { root: null, stale: true,
      ...(restorationError ? { error: restorationError } : {}) } satisfies RootInfo);
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

  if (workspaceProbeDirectory) {
    const workspaceReport = await runWorkspaceProbe(editorView.webContents, webView.webContents, previewView.webContents, workspaceController, workspaceProbeDirectory, webBarView.webContents);
    const columns = await runLayoutProbe({
      win, editor: editorView, webbar: webBarView, preview: previewView,
      getLayout: () => layoutController.layout,
      configure: (preview, maximized = false) => { layoutController.update({ previewVisible: preview, fileMaximized: maximized }, false); relayout(); },
    });
    const report = { ...workspaceReport, columns, pass: workspaceReport.pass && columns.ok };
    process.stdout.write(`\n===== 目录与文件管理探针 =====\n${JSON.stringify(report, null, 2)}\n`);
    app.exit(report.pass ? 0 : 1);
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
    const columns = await runLayoutProbe({
      win, editor: editorView, webbar: webBarView, preview: previewView,
      getLayout: () => layoutController.layout,
      captureDirectory: path.join(app.getPath('temp'), 'Mini-AI-IDE-tool-preview'),
      configure: (preview, maximized = false) => {
        layoutController.update({ previewVisible: preview, fileMaximized: maximized }, false);
        relayout();
      },
    });
    process.stdout.write(`\n===== 三列布局探针 =====\n${JSON.stringify(columns, null, 2)}\n`);
    const layoutOk = Boolean(g && g.ok && g.editorFills === true && g.promptVisible === true && columns.ok);
    process.stdout.write(
      `[ui-probe] 编辑器占满可用高度：${g?.editorFills ? '是' : '否'}；需求输入区在视口内：${g?.promptVisible ? '是' : '否'}；布局自洽：${layoutOk ? '是' : '否'}\n`
    );

    // 预览面板已移到最右侧独立视图，其界面契约由自检 L8–L11 覆盖

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
    // 逐个真实悬停 Close / Previous / Next 三个按钮，直接测量弹出的浮层
    // **宽度、高度、行数**。用户截图里的现象是"提示被折成两行"，所以
    // "行数 > 1"就是闪烁根因仍在的直接判据（不需要肉眼观察）。
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
      process.stdout.write(`\n===== 查找框 hover 探针 =====\n${JSON.stringify(hoverProbe, null, 2)}\n`);
      const h = hoverProbe as { ok?: boolean; anyMultiLineHover?: boolean; verdict?: string; buttons?: unknown[] } | null;
      process.stdout.write(
        `[ui-probe] hover 提示折行：${h?.anyMultiLineHover ? '是（仍会抖）' : '否'}；` +
          `判定：${h?.verdict ?? '未知'}；测量按钮数：${Array.isArray(h?.buttons) ? h.buttons.length : 0}\n`
      );
      app.exit(editable && wraps && layoutOk && h?.ok === true && h?.anyMultiLineHover === false ? 0 : 1);
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

  // 退出保护和软件更新不等待 AI 网页联网成功。
  registerToolShutdown(app, () => workspaceController.run(async () => {
    if (!closeApproved && !updater?.installing && !await workspaceController.editor.canLeave()) return false;
    closeApproved = true;
    // 菜单退出也先关闭窗口，停止清理期间新增编辑或工具请求。
    if (!win.isDestroyed()) win.close(); return true;
  }), () => tools.dispose(), error => process.stderr.write(`[tools] 退出时停止命令失败：${String(error)}\n`));
  win.on('close', (event) => {
    // 仅安装进行中复用更新器的离开批准；安装失败恢复普通退出保护。
    if (closeApproved || updater?.installing || SELF_TEST || UI_PROBE || DIAGNOSE) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    void workspaceController.run(async () => {
      try { if (await workspaceController.editor.canLeave()) { closeApproved = true; win.close(); } }
      finally { closePending = false; }
    });
  });
  win.on('closed', () => {
    updater?.dispose();
    workspaceController.editor.reset();
    app.quit();
  });
  updater.start();

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

}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
app.on('window-all-closed', () => app.quit());

bootstrap().catch((err) => {
  process.stderr.write(`[fatal] 启动失败：${err instanceof Error ? err.stack : String(err)}\n`);
  app.exit(2);
});
