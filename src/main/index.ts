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
import { parseModelReply, type ParsedCodeBlock } from '../shared/returnPath';
import { buildSnippetText, buildWholeFileText } from '../shared/snippet';
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

const SELF_TEST = process.argv.includes('--self-test');
/** 界面运行时探针：不联网，加载编辑器后读回 Monaco 实际选项并试改文本，然后退出 */
const UI_PROBE = process.argv.includes('--ui-probe');
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
  const settings = new SettingsStore(SELF_TEST ? SELF_TEST_SETTINGS_FILE : PRODUCTION_SETTINGS_FILE);
  const saved = settings.get();
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
    settings.update({ editorWidth: layout.editorBounds.width });
    return { editorWidth: layout.editorBounds.width };
  });

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

    // 采集到的开头几行必须可见：否则"解析出 0 个代码块"时无法判断是采集错了位置、
    // 还是解析规则不匹配（实测踩过：抓到的是**不带结尾围栏**的渲染文本）。
    const collectedLines = collected.replyText.split(/\r\n|\r|\n/);
    const fenceMarkCount = (collected.replyText.match(/^[ \t]*(?:`{3,}|~{3,})/gm) ?? []).length;
    const parseNotes = [
      ...parsed.notes,
      `采集方式：策略 ${collected.strategyId}（${collected.strategyDescription ?? ''}）`,
      `采集正文：${collected.replyText.length} 字符 / ${collectedLines.length} 行；整行围栏标记 ${fenceMarkCount} 处`,
      `采集到的开头：\n${collectedLines.slice(0, 8).join('\n')}`,
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

      blocks.push({
        index: i,
        filePath: b.filePath,
        pathSource: b.pathSource,
        range: b.range,
        codeLines: allCodeLines.length,
        codeChars: b.code.length,
        firstLines,
        moreLines: Math.max(0, allCodeLines.length - firstLines.length),
        fileExists,
        fileLines,
        applicable,
        ...(blockedReason ? { blockedReason } : {}),
        hints,
      });
    }

    return {
      ok: true,
      collectionId,
      strategyId: collected.strategyId,
      strategyDescription: collected.strategyDescription,
      attempts: collected.attempts,
      replyText: collected.replyText,
      notes: parseNotes,
      blocks,
    };
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

    return returnPath.applyChange({
      filePath,
      block,
      ...(expectedOriginal !== undefined ? { expectedOriginal } : {}),
      contextPrev,
      contextNext,
    });
  });

  ipcMain.handle(CHANNELS.undoSave, () => returnPath.undoLast());

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
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

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

  await editorView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

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
    const g = geometry as { ok?: boolean; applyVisible?: boolean } | null;
    const layoutOk = Boolean(g && g.ok && g.applyVisible === true);
    process.stdout.write(
      `[ui-probe] 预览面板显示时「应用」按钮可见：${g?.applyVisible ? '是' : '否'}；布局自洽：${layoutOk ? '是' : '否'}\n`
    );

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
