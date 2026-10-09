/**
 * P2 启动自检（`electron . --self-test`）
 *
 * 目的：让 P2 的关键契约**可在不联网的情况下被验证** —— 因为执行沙箱会限制子进程对外网络，
 * 右侧网页无法在此环境加载，所以自检只验证"我们自己的这一半"：
 *
 *   A) UA 规则（ADR-0001）：无 Electron/应用名标记；Chrome 主版本 == 真实内核主版本；
 *   B) 会话分区名 == 正式分区（复用 P0b 登录态）；
 *   C) 文件服务链路：列目录 / UTF-8 读取 / GBK 回退 / 二进制拒绝 / 路径越界拒绝；
 *   D) 渲染进程隔离：无 Node 全局、无 webdriver、bridge 可用、编辑器页面已加载。
 *
 * 右侧网页的加载与"程序不向页面写入"由 P0b 实测与代码审查覆盖（见 ADR-0003）。
 */
import type { WebContentsView } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { CHANNELS } from '../shared/contract';
import { buildPrompt, getFormatSpec } from '../shared/formatSpec';
import { parseToolBatch, TOOL_PROTOCOL_PROMPT, type ToolState } from '../shared/toolProtocol';
import {
  computeApply,
  parseModelReply,
  splitFences,
} from '../shared/returnPath';
import { buildSnippetText, buildWholeFileText, fenceFor } from '../shared/snippet';
import { createFixtures, type FixturePaths } from './fixtures';
import type { FileService } from './fileService';
import { SettingsStore, isUsableRoot, SELF_TEST_SETTINGS_FILE } from './settings';
import { computeLayout, type Layout } from './windowLayout';
import { buildContextSummary } from './contextSummary';
import { COLLECT_STRATEGIES, collectReply } from './replyCollector';
import { ConsumptionStore, fingerprintOf, sessionKeyOf } from './consumptionStore';
import { ReturnPathService } from './returnPathService';

interface BootInfo {
  sessionPartition: string;
  userAgent: { original: string; effective: string; removed: string[] };
  uaConsistency: { ok: boolean; uaMajor: string | null; kernelMajor: string | null };
  versions: { electron: string | undefined; chromium: string | undefined; node: string };
}

interface Check {
  id: string;
  name: string;
  pass: boolean;
  observed: unknown;
}

export interface SelfTestInput {
  editorView: WebContentsView;
  webView: WebContentsView;
  fileService: FileService;
  fixtures?: FixturePaths;
  boot: BootInfo;
  layout: Layout;
  /** 主进程实际注册的 IPC 通道名（由 registerFileIpc 返回） */
  registeredChannels: readonly string[];
  /** 设置存储（可选；用于验证"上次打开的目录"持久化） */
  settings?: SettingsStore;
  /**
   * 期望被恢复的根目录（仅在 `--simulate-restart --persist-root=<dir>` 启动时提供）。
   * 用于验证"第二次启动自动恢复上次打开的目录"这条真实路径。
   */
  expectRestoredRoot?: string;
}

export async function runSelfTest(input: SelfTestInput): Promise<{
  collectedAt: string;
  checks: Check[];
  verdict: 'PASS' | 'FAIL';
  failures: string[];
}> {
  const fixtures = input.fixtures ?? createFixtures();
  const registeredChannels = [...input.registeredChannels];
  const checks: Check[] = [];
  const add = (id: string, name: string, pass: boolean, observed: unknown) => checks.push({ id, name, pass, observed });

  /* ---- A) UA 规则 ---- */
  const ua = input.boot.userAgent.effective;
  add('A1', 'UA 不含 Electron 自我声明标记', !/Electron\//i.test(ua), ua);
  add('A2', 'UA 不含应用名标记', !/mini-ai-ide\//i.test(ua), ua);
  add('A3', 'UA 保留真实 Chrome 内核版本', /Chrome\/\d+\.\d+\.\d+\.\d+/.test(ua), ua);
  add('A4', 'UA 内核主版本 == 实际内核主版本', input.boot.uaConsistency.ok, input.boot.uaConsistency);

  /* ---- B) 会话分区与 UA 实际生效 ---- */
  add('B1', '会话分区为正式分区 persist:postcheck', input.boot.sessionPartition === 'persist:postcheck', input.boot.sessionPartition);
  const webPrefsPartition = (input.webView.webContents as unknown as { session?: { storagePath?: string } }).session;
  add('B2', '右侧视图已绑定会话（存在 storagePath）', Boolean(webPrefsPartition && webPrefsPartition.storagePath), webPrefsPartition?.storagePath ?? null);

  // B3/B4：验证 UA 在**视图层面**确实生效（P0B-7 的教训是"报告说改了但实际没改"）
  let viewUa = '<读取失败>';
  try {
    viewUa = input.webView.webContents.getUserAgent();
  } catch (err) {
    viewUa = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  add('B3', '右侧视图实际 UA 不含 Electron 标记', !/Electron\//i.test(viewUa), viewUa);
  add('B4', '右侧视图实际 UA == 计划值（视图层面生效）', viewUa === input.boot.userAgent.effective, {
    viewUa,
    planned: input.boot.userAgent.effective,
  });

  /* ---- C) 文件服务 ---- */
  const root = input.fileService.setRoot(fixtures.root);

  const listed = await input.fileService.listDir('');
  add('C1', '列目录返回条目且不含二进制以外的过滤异常', listed.ok && listed.entries.length >= 3, {
    ok: listed.ok,
    count: listed.entries.length,
    names: listed.entries.map((e) => e.name),
  });

  const utf8 = await input.fileService.readFile('hello.ts');
  add('C2', 'UTF-8 文件读取成功且声明编码正确', utf8.ok && utf8.encoding === 'utf-8' && (utf8.meta?.charCount ?? 0) > 0, {
    ok: utf8.ok,
    encoding: utf8.encoding,
    meta: utf8.meta,
  });

  const gbk = await input.fileService.readFile('gbk-note.txt');
  add('C3', 'GBK 文件回退解码成功且文本正确', gbk.ok && gbk.encoding === 'gbk' && gbk.fellBack === true && gbk.text === '中文编码测试\n', {
    ok: gbk.ok,
    encoding: gbk.encoding,
    fellBack: gbk.fellBack,
    text: gbk.text,
  });

  const binary = await input.fileService.readFile('blob.bin');
  add('C4', '二进制文件被拒绝', binary.ok === false, { ok: binary.ok, error: binary.error });

  const escape = await input.fileService.readFile('../../../windows/win.ini');
  add('C5', '路径越界被拒绝', escape.ok === false && /不在已打开的根目录内/.test(escape.error ?? ''), {
    ok: escape.ok,
    error: escape.error,
  });

  const sliced = await input.fileService.sliceFile('hello.ts', 1, 1);
  // 注意：hello.ts 的内容以换行结尾，按换行切分为 3 段（末尾空行），因此 totalLines === 3
  add('C6', '分片读取正常工作', sliced.ok && sliced.totalLines === 3 && sliced.startLine === 1 && sliced.endLine === 1, sliced);

  const nested = await input.fileService.listDir('src');
  add('C7', '子目录列目录正常', nested.ok && nested.entries.some((e) => e.name === 'nested.ts'), {
    ok: nested.ok,
    names: nested.entries.map((e) => e.name),
  });

  if (root !== fixtures.root) {
    add('C8', '根目录设置为样例目录', false, { expected: fixtures.root, actual: root });
  } else {
    add('C8', '根目录设置为样例目录', true, root);
  }

  /* ---- D) 渲染进程隔离 ---- */
  const editorUrl = input.editorView.webContents.getURL();
  add('D1', '编辑器页面已加载', /renderer\/index\.html$/.test(editorUrl), editorUrl);

  let probe: unknown = null;
  try {
    probe = await input.editorView.webContents.executeJavaScript(
      `(async () => {
         const b = window.editorBridge;
         const req = window.require;
         // contextBridge 在沙箱渲染进程中返回 Proxy，不暴露 ownKeys，
         // 因此用**实际调用**验证能力（比枚举属性更硬的证据）。
         let callOk = false;
         let callError = null;
         let callRoot = null;
         try {
           const r = await b.getRoot();
           callOk = typeof r === 'object' && r !== null && 'root' in r;
           callRoot = r ? r.root : null;
         } catch (e) {
           callError = String(e);
         }
         let listOk = false;
         try {
           const l = await b.listDir('');
           listOk = !!l && l.ok === true && Array.isArray(l.entries);
         } catch (e) {
           callError = String(e);
         }
         // 未暴露的通道：调用它必须失败（Proxy 会拒绝不存在的属性）
         let internalRejected = false;
         try {
           await b.setRootInternal('C:\\\\');
         } catch (e) {
           internalRejected = true;
         }
         return {
           hasBridge: typeof b === 'object' && b !== null,
           callOk,
           callRoot,
           listOk,
           callError,
           internalRejected,
           webdriver: navigator.webdriver,
           nodeGlobals: ['module','process','Buffer','global','__dirname','__filename','ipcRenderer']
             .filter((k) => typeof window[k] !== 'undefined'),
           // window.require 由 Monaco 的 AMD loader 定义，不是 Node 的 require。
           // 用 Node require 特有的 resolve 与 AMD 的 config 做区分。
           requireKind: typeof req !== 'function' ? 'absent'
             : (typeof req.config === 'function' ? 'amd' : (typeof req.resolve === 'function' ? 'node' : 'unknown')),
           requireHasNodeResolve: typeof req === 'function' && typeof req.resolve === 'function',
           title: document.title,
           readyState: document.readyState,
         };
       })()`,
      true
    );
  } catch (err) {
    probe = { error: err instanceof Error ? err.message : String(err) };
  }
  const p = probe as {
    hasBridge?: boolean;
    callOk?: boolean;
    callRoot?: string | null;
    listOk?: boolean;
    callError?: string | null;
    internalRejected?: boolean;
    webdriver?: unknown;
    nodeGlobals?: string[];
    requireKind?: string;
    requireHasNodeResolve?: boolean;
    title?: string;
  };
  add(
    'D2',
    'bridge 可用：实际调用 getRoot() 与 listDir() 均成功',
    p.hasBridge === true && p.callOk === true && p.listOk === true,
    { hasBridge: p.hasBridge, callOk: p.callOk, callRoot: p.callRoot, listOk: p.listOk, callError: p.callError }
  );
  add(
    'D3',
    '未暴露的通道被拒绝：调用 bridge.setRootInternal() 抛错',
    p.internalRejected === true,
    { internalRejected: p.internalRejected }
  );
  add('D4', '渲染进程无非 require 的 Node 全局泄漏', (p.nodeGlobals ?? ['<probe失败>']).length === 0, p.nodeGlobals ?? probe);
  add('D10', 'window.require 是 Monaco 的 AMD loader，而非 Node 的 require', p.requireKind === 'amd' && p.requireHasNodeResolve === false, {
    requireKind: p.requireKind,
    requireHasNodeResolve: p.requireHasNodeResolve,
  });
  add('D5', 'navigator.webdriver 非真值', p.webdriver !== true, p.webdriver);

  const editorPrefs = input.editorView.webContents as unknown as { getLastWebPreferences?: () => Record<string, unknown> };
  const prefs = editorPrefs.getLastWebPreferences?.() ?? {};
  add('D6', '编辑器渲染进程已关闭 nodeIntegration', prefs['nodeIntegration'] !== true, {
    nodeIntegration: prefs['nodeIntegration'],
    contextIsolation: prefs['contextIsolation'],
    sandbox: prefs['sandbox'],
  });
  add('D7', '编辑器渲染进程已开启 contextIsolation', prefs['contextIsolation'] === true, prefs['contextIsolation']);
  add('D8', '编辑器渲染进程已开启 sandbox', prefs['sandbox'] === true, prefs['sandbox']);

  const layoutOk =
    input.layout.editorBounds.x === 0 &&
    (input.layout.workspaceVisible ? input.layout.workspaceBounds.width > 0 : input.layout.workspaceBounds.width === 0) && input.layout.webBounds.width >= 420 &&
    input.layout.workspaceBounds.width === input.layout.webBounds.x &&
    input.layout.webBounds.x + input.layout.webBounds.width === input.layout.fileBounds.x &&
    input.layout.contentBounds.x + input.layout.contentBounds.width === input.layout.treeBounds.x &&
    input.layout.treeBounds.x + input.layout.treeBounds.width === input.layout.editorBounds.width;
  add('D9', '左工作区、中官网、右编辑且目录最右，原生编辑器覆盖本地底层', layoutOk, input.layout);

  /* ---- E) 通道名一致性（preload 在沙箱下无法 require shared，故用源码比对兜底）---- */
  // 主进程 → 渲染进程的单向通道（不需要 ipcMain.handle）
  //
  // ⚠️ 这份排除名单也必须与实现同步：新增一个「主进程 → 渲染进程」的通道时，
  // 只在 contract.ts 里加常量是**不够**的 —— 自检会误报"未注册 ipcMain 处理器"。
  // 判断依据：代码里只有 `webContents.send(CHANNELS.x)`、没有 `ipcMain.handle(CHANNELS.x)`。
  const oneWayChannels: string[] = [
    CHANNELS.toolState,
    CHANNELS.updateState,
    CHANNELS.openUpdatePanel,
    CHANNELS.entryChanged,
    CHANNELS.editorState,
    CHANNELS.editorRequest,
    CHANNELS.reviewState,
    CHANNELS.promptStatus,
    CHANNELS.setRootInternal,
    CHANNELS.rootChanged,
    CHANNELS.rootStale,
    CHANNELS.sidebarChanged,
    // 以下三个是后加的，漏在这里会让 E1/E2 误报（用户实测脚本报 missing 却查不到实现）：
    CHANNELS.chromeState,   // → webbar
    CHANNELS.fileChanged,   // → 编辑器（落盘广播）
    CHANNELS.openPromptPanel, // → 编辑器（请求打开提示词面板；面板本体是独立视图）
  ];
  const requiredChannels = Object.values(CHANNELS).filter((c) => !oneWayChannels.includes(c));
  const missingHandlers = requiredChannels.filter((c) => !registeredChannels.includes(c));
  add('E1', '所有约定通道均已注册 ipcMain 处理器', missingHandlers.length === 0, {
    required: requiredChannels,
    registered: registeredChannels,
    missing: missingHandlers,
  });
  let preloadSrcCheck: { ok: boolean; detail: string } = { ok: false, detail: '未读取到 preload.js' };
  try {
    // 所有本地视图的窄桥一起核对，包括只读变更查看的 review 通道。
    const preloadFiles = ['preload.js', 'previewPreload.js', 'webbarPreload.js', 'promptPreload.js'];
    const literals: string[] = [];
    const perFile: Record<string, string[]> = {};
    for (const f of preloadFiles) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
      const found = [...src.matchAll(/'((?:fs|ui|return|preview|review|editor|tools|skills):[a-z-]+)'/g)].map((m) => m[1] as string);
      perFile[f] = found;
      literals.push(...found);
    }
    const contractSet = new Set<string>(Object.values(CHANNELS));
    // 去重后再判unknown：同一个通道在多个 preload 里出现是正常的
    const unknown = [...new Set(literals)].filter((c) => !contractSet.has(c));
    const missing = requiredChannels.filter((c) => !literals.includes(c));
    preloadSrcCheck = {
      ok: unknown.length === 0 && missing.length === 0,
      detail:
        `unknown=[${unknown.join(',')}] missing=[${missing.join(',')}] ` +
        Object.entries(perFile)
          .map(([f, cs]) => `${f}=[${cs.join(',')}]`)
          .join(' '),
    };
  } catch (err) {
    preloadSrcCheck = { ok: false, detail: `读取失败：${err instanceof Error ? err.message : String(err)}` };
  }
  add(
    'E2',
    '各 preload 内联通道名与 shared/contract 完全一致（无漂移、无错放）',
    preloadSrcCheck.ok,
    preloadSrcCheck.detail,
  );

  /* ---- L) 渲染进程界面契约：HTML 里的 id 与 renderer 的引用必须一致 ----
   * 为什么需要：`document.getElementById('x')` 取不到时返回 null，随后在事件里炸掉或静默失效，
   * 而 TypeScript 看不到 HTML —— 这类"改了 HTML 忘了改 JS"只能靠可执行检查兜住。
   * 同时检查 renderer.js 语法（Node 可解析），因为渲染进程脚本不经 tsc。
   */
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const htmlPath = path.join(rendererDir, 'index.html');
  const jsPath = path.join(rendererDir, 'renderer.js');
  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const editorJs = fs.readFileSync(jsPath, 'utf8');
    const localPromptJs = fs.readFileSync(path.join(rendererDir, 'localPrompt.js'), 'utf8');
    const composerJs = fs.readFileSync(path.join(rendererDir, 'promptComposer.js'), 'utf8');
    const toolbarJs = fs.readFileSync(path.join(rendererDir, 'editorToolbar.js'), 'utf8');
    const updateJs = fs.readFileSync(path.join(rendererDir, 'applicationUpdate.js'), 'utf8');
    const explorerJs = fs.readFileSync(path.join(rendererDir, 'fileExplorer.js'), 'utf8');
    const workspaceJs = fs.readFileSync(path.join(rendererDir, 'editorWorkspace.js'), 'utf8');
    const tabsJs = fs.readFileSync(path.join(rendererDir, 'editorTabs.js'), 'utf8');
    const toolLayoutJs = fs.readFileSync(path.join(rendererDir, 'toolPanelLayout.js'), 'utf8');
    const navigationJs = fs.readFileSync(path.join(rendererDir, 'workspaceNavigation.js'), 'utf8');
    const layoutJs = fs.readFileSync(path.join(rendererDir, 'workspaceLayout.js'), 'utf8');
    const fileWorkspaceJs = fs.readFileSync(path.join(rendererDir, 'fileWorkspace.js'), 'utf8');
    const js = [editorJs, composerJs, localPromptJs, toolbarJs, explorerJs, workspaceJs, tabsJs, updateJs, navigationJs, layoutJs, fileWorkspaceJs].join('\n');
    const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf8');
    /*
     * 主进程 / preload / 契约 / 设置 的**源码**（不是 __dirname 下的编译产物：那里只有 .js）。
     *
     * ⚠️ 必须在 try 的开头就读取：Y 组（提示词面板）等后续分组都要用 `mainTs`/`preloadTs`，
     * 而 `const` 没有提升 —— 读到用不到就会抛 ReferenceError，整份自检报告会退化成一条 FAIL。
     */
    const srcMainDir = path.join(__dirname, '..', '..', 'src', 'main');
    const mainTs = fs.readFileSync(path.join(srcMainDir, 'index.ts'), 'utf8');
    const layoutControllerTs = fs.readFileSync(path.join(srcMainDir, 'workspaceLayoutController.ts'), 'utf8');
    const preloadTs = fs.readFileSync(path.join(srcMainDir, 'preload.ts'), 'utf8');
    /* 通道名的权威定义在契约层，不在 index.ts */
    const contractTs = fs.readFileSync(path.join(srcMainDir, '..', 'shared', 'contract.ts'), 'utf8');
    /* 设置持久化层：自定义格式要求存这里（Y8 要核对字段确实存在） */
    const settingsTs = fs.readFileSync(path.join(srcMainDir, 'settings.ts'), 'utf8');
    const previewHtml = fs.readFileSync(path.join(rendererDir, 'preview.html'), 'utf8');
    // 网页区顶部工具条（webbar）：采集与窄恢复操作入口，单独读取供契约断言
    const webbarHtml = fs.readFileSync(path.join(rendererDir, 'webbar.html'), 'utf8');
    const webbarJs = fs.readFileSync(path.join(rendererDir, 'webbar.js'), 'utf8');
    const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string));
    const usedIds = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1] as string);
    const missingIds = [...new Set(usedIds)].filter((id) => !htmlIds.has(id));
    add('L1', 'renderer 引用的所有元素 id 都存在于 index.html', missingIds.length === 0, {
      htmlIdCount: htmlIds.size,
      usedIdCount: new Set(usedIds).size,
      missing: missingIds,
    });

    /*
     * L1b：`el` 对象必须**逐个**列出渲染进程用到的元素。
     *
     * 为什么单独加这一项：只比对"JS 里出现过的 id ⊆ HTML 的 id"是不够的 ——
     * 曾经出现过"`el` 结构体漏了 btnCollect/preview 等字段，但 `getElementById('btn-collect')`
     * 只在绑定处间接出现、没进结构体"的情形，运行时才在 `undefined.addEventListener`
     * 抛异常并**中断整个渲染脚本**（表现是编辑器与所有按钮全都不工作）。
     * 这里改为：把 `el = { ... }` 里的键与 `getElementById` 调用集合对齐检查。
     */
    // 每个 owner 的局部 el 都要单独检查，不能用另一文件的绑定掩盖漏项。
    const elMaps = [editorJs, composerJs].map((code) => {
      const block = /const el = \{([\s\S]*?)\n  \};/.exec(code)?.[1] ?? '';
      const keys = [...block.matchAll(/(\w+):\s*document\.getElementById\('([^']+)'\)/g)]
        .map((m) => ({ key: m[1] as string, id: m[2] as string }));
      const used = new Set([...code.matchAll(/\bel\.(\w+)\b/g)].map((m) => m[1] as string));
      return { keys, used, missing: [...used].filter((key) => !keys.some((entry) => entry.key === key)) };
    });
    const elKeys = elMaps.flatMap((map) => map.keys);
    const usedElProps = new Set(elMaps.flatMap((map) => [...map.used]));
    const undeclaredElProps = elMaps.flatMap((map) => map.missing);
    add('L1b', 'el 结构体已声明渲染进程用到的全部元素（防 undefined.addEventListener 中断脚本）', undeclaredElProps.length === 0, {
      declaredCount: elKeys.length,
      usedCount: usedElProps.size,
      undeclared: undeclaredElProps,
    });

    // L1c：每个 el.<key> 绑定的 id 必须真的存在于 HTML
    const elIdsMissing = elKeys.filter((k) => !htmlIds.has(k.id)).map((k) => `${k.key}->${k.id}`);
    add('L1c', 'el 结构体里每个元素 id 都存在于 index.html', elIdsMissing.length === 0, { missing: elIdsMissing });

    /*
     * L1d：**界面上的每个按钮都必须真的绑定了事件处理器**。
     *
     * 为什么需要：按钮存在于 HTML、也进了 el 结构体，但如果漏了 `addEventListener`，
     * 它就是"看着有、点了没反应"，而 tsc 与其它检查都看不到（P2-15 同类）。
     * 本项目的按钮 id 与 el 键名有稳定对应（btn-send-prompt → btnSendPrompt），据此逐一对齐。
     */
    const htmlButtonIds = [...html.matchAll(/<button\s+id="([^"]+)"/g)].map((m) => m[1] as string);
    const toCamel = (s: string): string => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    const unboundButtons = htmlButtonIds.filter((id) => {
      const layoutBindings: Record<string, string> = {
        'workspace-collapse': "getElementById('workspace-collapse').addEventListener('click'",
        'workspace-restore': "restore.addEventListener('click'",
        'btn-sidebar': "treeButton.addEventListener('click'",
        'tree-collapse': "getElementById('tree-collapse').addEventListener('click'",
        'file-maximize': "getElementById('file-maximize').addEventListener('click'",
        'file-collapse': "getElementById('file-collapse').addEventListener('click'",
      };
      if (layoutBindings[id]) return !layoutJs.includes(layoutBindings[id]!);
      if (id === 'btn-send-prompt') return !/send\.addEventListener\('click'/.test(localPromptJs);
      if (id === 'skill-preview-close') return !/getElementById\('skill-preview-close'\)\.addEventListener\('click'/.test(localPromptJs);
      if (id === 'workspace-add') return !navigationJs.includes("getElementById('workspace-add').addEventListener('click'");
      if (id === 'tool-view-changes') return !fileWorkspaceJs.includes("getElementById('tool-view-changes').addEventListener('click'");
      if (id === 'btn-copy-context') return !/trigger\.addEventListener\('click'/.test(toolbarJs);
      const updateKeys: Record<string, string> = { 'btn-update': 'trigger', 'update-action': 'action', 'update-notes-toggle': 'notesToggle' };
      if (updateKeys[id]) return !new RegExp(`${updateKeys[id]}\\.addEventListener\\('click'`).test(updateJs);
      if (id === 'update-close') return !/getElementById\('update-close'\)\.addEventListener\('click'/.test(updateJs);
      const explorerKey: Record<string, string> = { 'file-new': 'newFile', 'folder-new': 'newFolder', 'file-refresh': 'refresh' };
      if (explorerKey[id]) return !new RegExp(`options\\.${explorerKey[id]}\\.addEventListener\\('click'`).test(explorerJs);
      if (id.startsWith('tool-')) {
        if (id === 'tool-settings-toggle' || id === 'tool-more-toggle') {
          const registered = id === 'tool-settings-toggle'
            ? /popup\('tool-settings-wrap', 'tool-settings-toggle', 'tool-settings-panel', 'tool-settings-close'\)/.test(toolLayoutJs)
            : /popup\('tool-more-wrap', 'tool-more-toggle', 'tool-more'\)/.test(toolLayoutJs);
          return !registered || !/trigger\.addEventListener\('click'/.test(toolLayoutJs);
        }
        if (id === 'tool-settings-close') return !/getElementById\(closeId\)\.addEventListener\('click'/.test(toolLayoutJs) || !/popup\('tool-settings-wrap', 'tool-settings-toggle', 'tool-settings-panel', 'tool-settings-close'\)/.test(toolLayoutJs);
        const toolJs = fs.readFileSync(path.join(rendererDir, 'toolHarness.js'), 'utf8');
        if (id === 'tool-interval-down' || id === 'tool-interval-up') {
          return !/const intervalDown = document\.getElementById\('tool-interval-down'\)/.test(toolJs) ||
            !/const intervalUp = document\.getElementById\('tool-interval-up'\)/.test(toolJs) ||
            !/\[intervalDown, intervalUp\]\.forEach\(function \(button, index\)\s*\{[\s\S]*?button\.addEventListener\('click'[\s\S]*?configure\(\{ sendIntervalSeconds: Number\(sendInterval\.value\) \}\)/.test(toolJs);
        }
        const declaration = new RegExp(`const (\\w+) = document\\.getElementById\\('${id}'\\)`).exec(toolJs);
        return !declaration || !new RegExp(`\\b${declaration[1]}\\.addEventListener\\(`).test(toolJs);
      }
      const key = toCamel(id);
      const declared = elKeys.some((k) => k.key === key);
      const bound = new RegExp(`\\bel\\.${key}\\.addEventListener\\(`).test(js);
      return !declared || !bound;
    });
    add('L1d', '界面上每个按钮都已绑定事件处理器（防“看着有、点了没反应”）', unboundButtons.length === 0, {
      buttonCount: htmlButtonIds.length,
      unbound: unboundButtons,
    });

    // L6：采集回复这条链路必须首尾相连（按钮 → bridge → IPC 通道 → preload → 主进程处理器）
    // 注意：preload.js 里带 TS 类型注解残留（如 `collectReply: () =>` 或 `(x: string) =>`），
    // 因此匹配必须容忍参数列表，不能写死 `()`。
    const preloadJs = fs.readFileSync(path.join(__dirname, 'webbarPreload.js'), 'utf8');
    const collectChain = {
      buttonInHtml: /id="btn-collect"/.test(webbarHtml),
      inElStruct: /collect:\s*document\.getElementById\('btn-collect'\)/.test(webbarJs),
      bound: /el\.collect\.addEventListener\(/.test(webbarJs),
      callsBridge: /bridge\.collectReply\(/.test(webbarJs),
      channelInContract: Object.values(CHANNELS).includes('return:collect'),
      // 编译后渲染进程模块被重命名为 electron_1，因此用 [\w.]* 容忍别名前缀
      inPreload: /collectReply:\s*\([^)]*\)\s*=>\s*[\w.]*ipcRenderer\.invoke\(\s*CH\.collectReply\s*\)/.test(preloadJs),
      handlerInMain: fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8').includes('CHANNELS.collectReply'),
    };
    const chainOk = Object.values(collectChain).every(Boolean);
    add(
      'L6',
      '「采集回复」链路首尾相连（按钮→bridge→通道→preload→主进程）+ 3 套采集策略已就绪',
      chainOk && COLLECT_STRATEGIES.length >= 3,
      { ...collectChain, strategies: COLLECT_STRATEGIES.map((s) => s.id) }
    );

    /*
     * L7：**未声明变量扫描**。
     *
     * 为什么必须做：`lastPreview = preview`（用了没声明的变量）是纯运行时错误，
     * 静态比对与 tsc（看不到 renderer.js）都抓不到，而它会**中断脚本**、
     * 让整个功能静默失效 —— 实测中「采集回复」就是这样"点了没反应"。
     *
     * 为什么不用"沙箱里跑一遍"：那种冒烟执行到不了**事件处理函数内部**
     * （本 bug 的赋值就在点击处理里），实测证明它抓不到，因此改为静态扫描：
     * 取出所有"裸标识符赋值"，逐个核对是否在同文件中有声明、是否函数参数、
     * 是否是注入的浏览器全局。注意不能用 `let x = (x = 1)` 自赋值，那会掩盖错误。
     */
    const smokeAssigns = new Set([...js.matchAll(/^\s*(\w+)\s*=(?!=)/gm)].map((m) => m[1] as string));
    const smokeDeclared = new Set(
      [...js.matchAll(/(?:^|[\s;{(,])(?:let|const|var)\s+(\w+)/g)].map((m) => m[1] as string)
    );
    for (const m of js.matchAll(/function\s*\w*\s*\(([^)]*)\)/g)) {
      for (const p of (m[1] ?? '').split(',')) {
        const name = p.trim().split(/[=:]/)[0]?.trim();
        if (name) smokeDeclared.add(name);
      }
    }
    for (const m of js.matchAll(/\(([^)]*)\)\s*=>/g)) {
      for (const p of (m[1] ?? '').split(',')) {
        const name = p.trim().split(/[=:]/)[0]?.trim();
        if (name) smokeDeclared.add(name);
      }
    }
    const smokeGlobals = new Set([
      'window', 'document', 'console', 'setTimeout', 'clearTimeout', 'setInterval',
      'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS',
      'module', 'exports', 'require', 'globalThis', 'self', 'undefined',
    ]);
    const smokeUndeclared = [...smokeAssigns].filter(
      (n) => !smokeDeclared.has(n) && !smokeGlobals.has(n)
    );

    add(
      'L7',
      '渲染进程无「赋值给未声明变量」（静态扫描裸标识符赋值，防 ReferenceError 中断脚本）',
      smokeUndeclared.length === 0,
      { undeclared: smokeUndeclared, scannedAssignments: smokeAssigns.size, declaredNames: smokeDeclared.size }
    );

    /* ---- L8) 右下角回程预览面板（独立渲染进程）的界面契约 ---- */
    const vm = await import('node:vm');
    try {
      const pvHtml = fs.readFileSync(path.join(rendererDir, 'preview.html'), 'utf8');
      const pvJs = fs.readFileSync(path.join(rendererDir, 'preview.js'), 'utf8');
      const pvCss = fs.readFileSync(path.join(rendererDir, 'preview.css'), 'utf8');

      const pvIds = new Set([...pvHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string));
      const pvUsed = [...new Set([...pvJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1] as string))];
      const pvMissing = pvUsed.filter((id) => !pvIds.has(id));
      add('L8', '预览面板：renderer 引用的元素 id 都存在于 preview.html', pvMissing.length === 0, {
        htmlIdCount: pvIds.size,
        usedIdCount: pvUsed.length,
        missing: pvMissing,
      });

      let pvParseError: string | null = null;
      try {
        new vm.Script(pvJs, { filename: 'preview.js' });
      } catch (err) {
        pvParseError = err instanceof Error ? err.message : String(err);
      }
      add('L9', '预览面板：preview.js 语法可解析', pvParseError === null, pvParseError ?? 'OK');

      const listsFiles = /pv-file-row/.test(pvJs) && /pv-file-name/.test(pvJs);
      const snapshotDiff = /record\.diff\.hunks/.test(pvJs) && /\.pv-line\.add/.test(pvCss) && /\.pv-line\.del/.test(pvCss);
      const noApply = !/applyChange|showDiffInEditor|pv-apply-all/.test(pvJs + pvHtml);
      add('L10', '变更面板：列出实际修改并只读展示快照差异', listsFiles && snapshotDiff && noApply, { listsFiles, snapshotDiff, noApply });

      // 面板通过独立 preload 暴露桥接口，且通道名与主进程一致
      const pvPreload = fs.readFileSync(path.join(__dirname, 'previewPreload.js'), 'utf8');
      const pvBridgeOk =
        /exposeInMainWorld\('previewBridge'/.test(pvPreload) &&
        pvPreload.includes("'review:get-state'") &&
        pvPreload.includes("'review:state'") &&
        pvPreload.includes("'review:undo'") &&
        !pvPreload.includes("'return:apply'") &&
        pvPreload.includes("'ui:set-preview-panel'");
      add('L11', '预览面板：独立 preload 暴露 narrow bridge 且通道名正确', pvBridgeOk, {
        exposeInMainWorld: /exposeInMainWorld\('previewBridge'/.test(pvPreload),
      });
    } catch (err) {
      add('L8', '预览面板界面契约检查', false, `读取失败：${err instanceof Error ? err.message : String(err)}`);
    }

    /* ---- N) 网页区顶部工具条（webbar）契约 ----
     *
     * 这里核对只读采集与两个受限布局操作是否在 HTML/JS/preload 间对应，
     * 并确保 webbar 不获得通用布局或网页操作能力。
     */
    try {
      const wbHtml = fs.readFileSync(path.join(rendererDir, 'webbar.html'), 'utf8');
      const wbJs = fs.readFileSync(path.join(rendererDir, 'webbar.js'), 'utf8');
      const wbCss = fs.readFileSync(path.join(rendererDir, 'webbar.css'), 'utf8');

      const wbIds = new Set([...wbHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string));
      const wbUsed = [...new Set([...wbJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1] as string))];
      const wbMissing = wbUsed.filter((id) => !wbIds.has(id));
      add('N1', '网页区工具条：JS 引用的元素 id 都存在于 webbar.html', wbMissing.length === 0, {
        htmlIdCount: wbIds.size,
        usedIdCount: wbUsed.length,
        missing: wbMissing,
      });

      let wbParseError: string | null = null;
      try {
        new vm.Script(wbJs, { filename: 'webbar.js' });
      } catch (err) {
        wbParseError = err instanceof Error ? err.message : String(err);
      }
      add('N2', '网页区工具条：webbar.js 语法可解析', wbParseError === null, wbParseError ?? 'OK');

      const collectBound = /el\.collect\.addEventListener/.test(wbJs) && /bridge\.collectReply/.test(wbJs);
      add('N3', '官网常驻顶栏的采集入口仍绑定真实只读采集', collectBound, { collectBound });
      const noToggles = !/id="btn-(web|preview-toggle|restore)"/.test(wbHtml);
      add('N5', '官网顶栏不再提供网页或 Diff 显隐按钮', noToggles, { noToggles });
      add('N6', '官网顶栏不再包含隐藏恢复形态', !/handle-mode|just-hidden/.test(wbJs + wbCss), {});
      const wbPreload = fs.readFileSync(path.join(__dirname, 'webbarPreload.js'), 'utf8');
      const wbBridgeOk = /exposeInMainWorld\('webbarBridge'/.test(wbPreload) &&
        wbPreload.includes("'return:collect'") && wbPreload.includes("'ui:toggle-workspace'") &&
        wbPreload.includes("'ui:restore-file-workspace'") && !/ui:set-web-visible|ui:set-preview-panel/.test(wbPreload);
      add('N4', '官网顶栏 preload 仅暴露只读采集、单一工作区切换和文件区恢复', wbBridgeOk, { wbBridgeOk });
    } catch (err) {
      add('N1', '网页区工具条界面契约检查', false, `读取失败：${err instanceof Error ? err.message : String(err)}`);
    }

    /* ---- Y) 提示词编辑面板（用户自定义系统 prompt 的格式段） ----
     *
     * 用户需求原话："目前这个系统自带提示词是默认固定的，我希望可以支持用户自行修改系统 prompt。
     * 具体可以在 IDE 顶部增加一列 Settings，增加一个关于修改 prompt 的行，
     * 用户点击后打开一个提示词编辑的面板。"
     *
     * 这组断言锁住三件缺一不可的事：
     *   1. **入口存在且不止一个**（设置菜单行 / 编辑器齿轮 / 快捷键），
     *      且都汇聚到同一条主进程路径 —— 入口分散但路径唯一，状态才不会分叉；
     *   2. **面板是真的能编辑**（有编辑框、有状态回显、有恢复默认），
     *      不是只显示一段说明文字；
     *   3. **用户内容真的被用上**（复制 prompt / 复制格式要求 / 复制整段 prompt 三条链路
     *      都必须经过 resolveFormatSpec）—— 否则"能改但改了没用"是最坏的结果。
     */
    try {
      const pmHtml = fs.readFileSync(path.join(rendererDir, 'prompt.html'), 'utf8');
      const pmJs = fs.readFileSync(path.join(rendererDir, 'prompt.js'), 'utf8');
      const pmCss = fs.readFileSync(path.join(rendererDir, 'prompt.css'), 'utf8');

      // Y1：id 对齐（面板自己的 HTML ↔ JS），与预览/工具条同一条契约
      const pmIds = new Set([...pmHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string));
      const pmUsed = [...new Set([...pmJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1] as string))];
      const pmMissing = pmUsed.filter((id) => !pmIds.has(id));
      add('Y1', '提示词面板：JS 引用的元素 id 都存在于 prompt.html', pmMissing.length === 0, {
        htmlIdCount: pmIds.size,
        usedIdCount: pmUsed.length,
        missing: pmMissing,
      });

      let pmParseError: string | null = null;
      try {
        new vm.Script(pmJs, { filename: 'prompt.js' });
      } catch (err) {
        pmParseError = err instanceof Error ? err.message : String(err);
      }
      add('Y2', '提示词面板：prompt.js 语法可解析', pmParseError === null, pmParseError ?? 'OK');

      // Y3：面板必须真的是"编辑器"而不是只读展示 —— 编辑框 + 保存/恢复默认/取消三按钮 + 未保存状态
      const hasEditorArea = /<textarea[\s\S]{0,400}?id="pm-editor"/.test(pmHtml);
      const hasSave = /id="pm-save"/.test(pmHtml) && /el\.save\.addEventListener\('click',\s*save\)/.test(pmJs);
      const hasReset = /id="pm-reset"/.test(pmHtml) && /el\.reset\.addEventListener\('click',\s*resetToDefault\)/.test(pmJs);
      const hasCancel = /id="pm-cancel"/.test(pmHtml) && /el\.cancel\.addEventListener\('click',\s*close\)/.test(pmJs);
      const hasDirtyState = /未保存/.test(pmJs) && /\.dirty =/.test(pmJs);
      add('Y3', '提示词面板：具备编辑框 + 保存/恢复默认/取消，且回显"未保存"状态', hasEditorArea && hasSave && hasReset && hasCancel && hasDirtyState, {
        hasEditorArea,
        hasSave,
        hasReset,
        hasCancel,
        hasDirtyState,
      });

      /*
       * Y3b：**版本页签**（用户设计）。
       *
       * 面板要能分别查看/编辑"简洁版"与"完整版" —— 两版各有自己的内置默认与自定义。
       * 断言 HTML 里确实有两个页签、JS 里确实有 perVariant 的独立编辑态。
       */
      const hasTabs =
        (pmHtml.match(/class="pm-tab"/g) ?? []).length === 2 &&
        /data-variant="short"/.test(pmHtml) &&
        /data-variant="full"/.test(pmHtml);
      const tabSwitching = /perVariant\s*=\s*\{/.test(pmJs) && /function switchTo\(/.test(pmJs);
      add('Y3b', '提示词面板：两个版本页签 + 各自的独立编辑态（切走不丢草稿）', hasTabs && tabSwitching, {
        tabCount: (pmHtml.match(/class="pm-tab"/g) ?? []).length,
        tabSwitching,
      });

      /*
       * Y4：「恢复默认」必须是**两步**（载入编辑框 → 用户再点保存），不能一键直接落库。
       * 一键清空是**不可撤销**的：用户辛苦写的格式约定会瞬间消失。
       * 断言方式是读 resetToDefault 的实现里到底是"写编辑框"还是"调 bridge.reset"。
       * 分版本后载入的是**当前页签那一版**的默认全文（state[active].defaultSpec）。
       */
      const resetFnBody = /function resetToDefault\(\)\s*\{([\s\S]*?)\n  \}/.exec(pmJs)?.[1] ?? '';
      const resetLoadsEditor = /el\.editor\.value\s*=/.test(resetFnBody) && /defaultSpec/.test(resetFnBody);
      const resetDoesNotPersist = !/bridge\.reset\(/.test(resetFnBody);
      add('Y4', '提示词面板：「恢复默认」先载入编辑框、不直接落库（可反悔）', resetLoadsEditor && resetDoesNotPersist, {
        resetLoadsEditor,
        resetDoesNotPersist,
      });

      // Y5：Esc 关闭 + Ctrl+S 保存（浮层类界面的通用约定，也是本窗口里最自然的键位）
      const escCloses = /e\.key === 'Escape'/.test(pmJs) && /close\(\)/.test(pmJs);
      const ctrlSSaves = /e\.key === 's'/.test(pmJs) && /void save\(\)/.test(pmJs);
      add('Y5', '提示词面板：Esc 关闭、Ctrl+S 保存', escCloses && ctrlSSaves, { escCloses, ctrlSSaves });

      // Y6：独立 preload 暴露窄 bridge，通道名与契约一致；save/reset 必须带 variant 参数
      const pmPreload = fs.readFileSync(path.join(__dirname, 'promptPreload.js'), 'utf8');
      const pmBridgeOk =
        /exposeInMainWorld\('promptBridge'/.test(pmPreload) &&
        pmPreload.includes("'ui:prompt-panel-state'") &&
        pmPreload.includes("'ui:save-prompt-spec'") &&
        pmPreload.includes("'ui:reset-prompt-spec'") &&
        pmPreload.includes("'ui:close-prompt-panel'") &&
        /save:\s*\(variant, spec\)\s*=>\s*electron_1\.ipcRenderer\.invoke\(CH\.save, variant, spec\)/.test(pmPreload) &&
        /reset:\s*\(variant\)\s*=>\s*electron_1\.ipcRenderer\.invoke\(CH\.reset, variant\)/.test(pmPreload);
      add('Y6', '提示词面板：独立 preload 暴露窄 bridge，通道名正确且 save/reset 带版本参数', pmBridgeOk, {
        exposeInMainWorld: /exposeInMainWorld\('promptBridge'/.test(pmPreload),
        saveWithVariant: /save:\s*\(variant, spec\)\s*=>\s*electron_1\.ipcRenderer\.invoke\(CH\.save, variant, spec\)/.test(pmPreload),
      });

      /*
       * Y7：**设置菜单里必须有那一行** —— 这是用户点名要的入口
       *（"在 IDE 顶部增加一列 Settings，增加一个关于修改 prompt 的行"）。
       * 同时要求编辑器工具栏也有一枚齿轮（面板/菜单都不在编辑器进程里，
       * 齿轮是"我在编辑器里就能随手打开"的那条路）。
       */
      const settingsMenu = /label:\s*'设置'/.test(mainTs) && /label:\s*'修改提示词…'/.test(mainTs);
      const gearInEditor = /id="btn-settings"/.test(html) && /el\.btnSettings\.addEventListener\('click'/.test(js);
      const gearOpensPanel = /bridge\.openPromptPanel\(\)/.test(js) && /openPromptPanel:\s*'ui:open-prompt-panel'/.test(preloadTs);
      add('Y7', '提示词编辑入口齐备：设置菜单及工具设置浮层（均通往同一面板）', settingsMenu && gearInEditor && gearOpensPanel, {
        settingsMenu,
        gearInEditor,
        gearOpensPanel,
      });

      /*
       * Y8：**用户内容必须真的被用上**。
       *
       * 分版本后链路变成：
       *   ① 编辑器需求提交 → LocalPromptController → resolveFormatSpec(customSpecsOf(...), variant)
       *   ② File 菜单「只复制输出格式要求」→ 同一条 customSpecsOf 取值
       *   ③ 面板读写的是 settings.customFormatSpecShort / customFormatSpecFull
       * 任一条漏了就回到"改了没用"（最坏的失败形态：用户以为生效了）。
       * 另外还要求开关状态（formatSpecVariant）在两个方向上都有 handler。
       */
      const promptControllerTs = fs.readFileSync(path.join(srcMainDir, 'localPromptController.ts'), 'utf8');
      const usesInLocalPrompt = /formatSpec:\s*resolveFormatSpec/.test(promptControllerTs) && /customFormatSpecShort/.test(promptControllerTs) && /customFormatSpecFull/.test(promptControllerTs);
      const usesInCopyFormat = /resolveFormatSpec\(customSpecsOf\(/.test(mainTs) &&
        /formatSpecVariant/.test(mainTs);
      const panelReadsSetting =
        /customFormatSpecShort/.test(mainTs) &&
        /customFormatSpecFull/.test(mainTs) &&
        /customFormatSpecShort:\s*string \| null/.test(settingsTs) &&
        /customFormatSpecFull:\s*string \| null/.test(settingsTs);
      const hasToggleLink = /ipcMain\.handle\(CHANNELS\.getFormatSpecVariant/.test(mainTs) &&
        /ipcMain\.handle\(CHANNELS\.setFormatSpecVariant/.test(mainTs);
      add('Y8', '自定义内容真的被用上（分版本三条链路 + 开关状态可读写）', usesInLocalPrompt && usesInCopyFormat && panelReadsSetting && hasToggleLink, {
        usesInLocalPrompt,
        usesInCopyFormat,
        panelReadsSetting,
        hasToggleLink,
      });

      // Y9：几何 —— 面板是浮层，必须有最小可读尺寸，且显示时居中（不是贴 0,0 的小窗）
      const panelGeometry = /PROMPT_PANEL_MIN_WIDTH\s*=\s*(\d+)/.exec(mainTs)?.[1];
      const centersHorizontally = /x:\s*Math\.round\(\(w - width\)\s*\/\s*2\)/.test(mainTs);
      const hasMinHeight = /PROMPT_PANEL_MIN_HEIGHT\s*=\s*(\d+)/.exec(mainTs)?.[1];
      add('Y9', '提示词面板：有最小可读尺寸且水平居中（是浮层而非贴角小窗）', Boolean(panelGeometry) && Number(panelGeometry) >= 420 && centersHorizontally && Boolean(hasMinHeight), {
        minWidth: panelGeometry ?? null,
        minHeight: hasMinHeight ?? null,
        centersHorizontally,
      });

      // 样式必须存在（否则面板是一片没有边框的裸文本，与其它面板的观感割裂）
      const hasPanelCss = /\.pm-shell\s*\{/.test(pmCss) && /\.pm-editor\s*\{/.test(pmCss) && /\.pm-btn\.primary/.test(pmCss);
      add('Y10', '提示词面板：样式表定义了外壳/编辑框/主按钮', hasPanelCss, { hasPanelCss });

      /*
       * Y11：**handler 必须在页面加载之前注册**（真实缺陷，用户截图报过）。
       *
       * 现象：打开面板 → 编辑框一片空白 + 底部红字
       *   `No handler registered for 'ui:prompt-panel-state'`。
       * 根因：面板渲染进程在 DOMContentLoaded 就会 `invoke` 这个通道来预填内容，
       * 而这几个 `ipcMain.handle` 原先写在 index.ts 靠后的"IPC 区" —— 中间隔着一串
       * `await`，面板加载完成时它们还没注册。
       *
       * 这条断言直接比对**注册位置 vs 加载位置在源码里的先后**：
       * `ipcMain.handle(CHANNELS.promptPanelState` 的行号必须小于
       * `loadLocalView(promptView` 的行号。这类"顺序错误"tsc 与其它断言都看不到。
       */
      const mainLines = mainTs.split('\n');
      const regLine = mainLines.findIndex((l) => /ipcMain\.handle\(CHANNELS\.promptPanelState/.test(l));
      const loadLine = mainLines.findIndex((l) => /loadLocalView\(promptView/.test(l));
      add('Y11', '提示词面板：状态 handler 在页面加载之前注册（防"面板打开即报未注册"）', regLine >= 0 && loadLine >= 0 && regLine < loadLine, {
        handlerLine: regLine >= 0 ? regLine + 1 : null,
        loadLine: loadLine >= 0 ? loadLine + 1 : null,
      });

      /*
       * Y12：**面板自带默认文本兜底**。
       *
       * 万一 `getState()` 仍然失败（任何原因），面板不能只剩一个空白框 + 一行红字：
       * 要先显示内置默认原文让用户有事可做。
       * 断言兜底副本与内置模板**逐字一致** —— 早期只比对首行，默认模板升级后
       * 副本会悄悄过期，那时面板在失败分支会显示一份**过时**的要求，比空白更糟。
       */
      const defaultsScript = fs.readFileSync(path.join(rendererDir, 'formatSpecDefaults.js'), 'utf8');
      const sandbox = { window: {} as { formatSpecDefaults?: { short: string; full: string } } };
      vm.runInNewContext(defaultsScript, sandbox, { timeout: 1000 });
      const fallback = sandbox.window.formatSpecDefaults;
      const hasFallback = /window\.formatSpecDefaults/.test(pmJs) && /formatSpecDefaults\.js/.test(pmHtml) && /el\.editor\.value\s*=/.test(pmJs);
      const fallbackMatchesDefault = fallback?.short === getFormatSpec('short') && fallback?.full === getFormatSpec('full');
      const hasRetry = /const LOAD_RETRIES/.test(pmJs) && /load\(tries \+ 1\)/.test(pmJs);
      add('Y12', '提示词面板：构建生成两版默认兜底与权威模板逐字一致，加载失败可重试', hasFallback && fallbackMatchesDefault && hasRetry, { hasFallback, fallbackMatchesDefault, hasRetry });

      /*
       * Y14：**底部双段开关**（用户设计）。
       *
       * "开 = 完整版（FULL），关 = 简洁版（SHORT）"，放在需求输入框旁。
       * 断言：HTML 有开关结构（两个选项）、JS 有读写持久化（get/set）、
       * 键盘可达（Space/Enter），以及样式表里画了滑块。
       */
      const editorCss = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf8');
      const swHtml =
        /id="variant-switch"/.test(html) &&
        (html.match(/class="variant-opt"/g) ?? []).length === 2 &&
        /data-variant="short"/.test(html) &&
        /data-variant="full"/.test(html);
      const swJs =
        /setupPromptComposer/.test(js) &&
        /bridge\.setFormatSpecVariant/.test(js) &&
        /bridge\.getPromptStatus/.test(js) &&
        /e\.key === ' '/.test(js);
      const swCss = /\.variant-switch\s*\{/.test(editorCss) && /\.variant-thumb\s*\{/.test(editorCss);
      add('Y14', '底部双段开关：结构 + 持久化读写 + 键盘可达 + 样式', swHtml && swJs && swCss, {
        swHtml,
        swJs,
        swCss,
      });

      /*
       * Y15：**开关状态必须贯通到实际发出去的内容**。
       *
       * 最坏的失败形态：界面显示"完整版"，但本地需求仍按短版拼 —— 用户无从察觉。
       * 断言本地需求链路确实读了 settings.formatSpecVariant。
       */
      const variantUsedInLocalPrompt = /resolveFormatSpec[\s\S]{0,250}settings\.formatSpecVariant/.test(promptControllerTs);
      add('Y15', '开关状态贯通：需求提交链路确实读取 formatSpecVariant', variantUsedInLocalPrompt, {
        variantUsedInLocalPrompt,
      });

      /*
       * Y13：保存失败时**不清空编辑框**。
       * 用户刚写的内容不能因为一次调用失败而消失 —— 只报错、保留内容、放开按钮可重试。
       */
      const saveFnBody = /async function save\(\)\s*\{([\s\S]*?)\n  \}/.exec(pmJs)?.[1] ?? '';
      const keepsContentOnFailure = !/el\.editor\.value\s*=/.test(saveFnBody.split('catch')[1] ?? '');
      const reEnablesSave = /el\.save\.disabled\s*=\s*false/.test(saveFnBody.split('catch')[1] ?? '');
      add('Y13', '提示词面板：保存失败时保留编辑框内容并放开按钮（可重试）', keepsContentOnFailure && reEnablesSave, {
        keepsContentOnFailure,
        reEnablesSave,
      });
    } catch (err) {
      add('Y1', '提示词面板界面契约检查', false, `读取失败：${err instanceof Error ? err.message : String(err)}`);
    }

    /* ---- O) 显隐开关的位置与输入区体验（本轮用户反馈的四项） ---- */

    // O1：全局工具栏**不再**放带文字的「目录树」「AI 网页」按钮
    //理由（用户原话）："正常的折叠展开不都是在对应板块顶部增加图标按钮吗，
    //     没见过有这种带文字的按钮"。目录树开关移到编辑器顶部条，网页开关移到网页区顶栏。
    const toolbarBlock = /<header class="toolbar">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? '';
    const toolbarHasTextToggles = /id="btn-sidebar"/.test(toolbarBlock) || /id="btn-web"/.test(toolbarBlock);
    add('O1', '全局工具栏已移除带文字的「目录树」「AI 网页」按钮', toolbarBlock.length > 0 && !toolbarHasTextToggles, {
      toolbarFound: toolbarBlock.length > 0,
      stillHasSidebarBtn: /id="btn-sidebar"/.test(toolbarBlock),
      stillHasWebBtn: /id="btn-web"/.test(toolbarBlock),
    });

    // O2：目录树开关是编辑器顶部条里的**图标按钮**（有 svg、无文字），且仍受 Ctrl+B 控制
    const editorHead = /<div class="editor-head">([\s\S]*?)<div id="monaco"/.exec(html)?.[1] ?? '';
    const sidebarBtnInHead = /id="btn-sidebar"[^>]*class="icon-btn"/.test(editorHead) && /<svg/.test(editorHead);
    const ctrlBKept = /e\.key === 'b'/.test(js);
    add('O2', '目录树开关为编辑器顶部条内的图标按钮，且 Ctrl+B 快捷键保留', sidebarBtnInHead && ctrlBKept, {
      inEditorHead: sidebarBtnInHead,
      ctrlBKept,
    });

    // O3：需求输入框有 JS 高度自适应（此前只有 CSS 的 min/max，实际永远一行高）
    //
    // 判据换过：原来查 `rows >= 3`，那是在没有 auto-grow 时用 HTML 属性当"默认高度"的代理。
    // 现在 auto-grow 接管了，**真实上下限由 CSS min/max-height 决定**（rows 只是折叠时的初始提示，
    // 用户也明确要求过"只有默认高度、没有最大高度"）。
    //
    // ⚠️ 此处**不再重复解析 CSS**：`min ≠ max` 与「CSS/JS 上下限一致」由 R2 / R3 断言，
    // 这里只补它们没覆盖的一点——auto-grow 本身在不在。
    // （曾经在此处再解析一遍，变量名直接与 R2 撞出 TS2451。）
    const hasAutoGrow =
      /setupRequirementAutoGrow/.test(js) && /scrollHeight/.test(js) && /addEventListener\('input'/.test(js);
    const rowsAttr = /id="requirement"[\s\S]{0,200}?rows="(\d+)"/.exec(html)?.[1];
    add('O3', '需求输入框有 JS 高度自适应（高度区间的有效性由 R2/R3 断言）', hasAutoGrow, {
      hasAutoGrow,
      rows: rowsAttr ?? null,
    });

    // 主提交按钮保持圆形图标，并具有可访问名称。
    const harnessCss = fs.readFileSync(path.join(rendererDir, 'toolHarness.css'), 'utf8');
    const sendRule = /\.prompt-actions \.prompt-send\s*\{([^}]*)\}/.exec(harnessCss)?.[1] ?? '';
    const circleStyle = /border-radius:\s*50%/.test(sendRule) && /width:\s*36px/.test(sendRule) && /height:\s*36px/.test(sendRule);
    const namedSend = /id="btn-send-prompt"[^>]*aria-label="发送需求"/.test(html);
    add('O4', '需求提交按钮保持圆形且具有可访问名称', circleStyle && namedSend, { circleStyle, namedSend });

    // 唯一工具入口采用权限与结果状态；实际调用本地 bridge 验证已连接到主进程。
    const mainJs = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    try {
      const state = await input.editorView.webContents.executeJavaScript('window.editorBridge.getToolState()') as ToolState;
      add('O5', '本地工具 bridge 返回主进程真实权限与结果状态', ['ask', 'rules', 'full'].includes(state.config.permission) && typeof state.config.automatic === 'boolean' && Array.isArray(state.results),
        { config: state.config, resultCount: state.results.length });
    } catch (error) { add('O5', '本地工具 bridge 返回主进程真实权限与结果状态', false, String(error)); }

    const permanentLayout = computeLayout(1600, 900, { dockHeight: 10000, previewVisible: true });
    add('O6', '官网区域常驻，展开工具区仍保留官网高度且 Diff 不盖目录',
      permanentLayout.webBounds.height >= 120 && permanentLayout.webBounds.width > 0 &&
      permanentLayout.previewBounds.x + permanentLayout.previewBounds.width === permanentLayout.treeBounds.x, permanentLayout);
    add('O7', '菜单和快捷键不再提供隐藏官网入口',
      !/label:\s*'AI 网页'/.test(mainJs) && !/CmdOrCtrl\+Shift\+A/.test(mainJs), {});

    /* ---------------- P 组：实际工具变更只读查看 ---------------- */
    const previewJs = fs.readFileSync(path.join(rendererDir, 'preview.js'), 'utf8');
    const previewPreloadJs = fs.readFileSync(path.join(__dirname, 'previewPreload.js'), 'utf8');
    const reviewJs = fs.readFileSync(path.join(__dirname, 'tools', 'changeReview.js'), 'utf8');
    const changesJs = fs.readFileSync(path.join(__dirname, 'tools', 'changes.js'), 'utf8');
    const noSecondHost = !/id="monaco-diff"/.test(html) && !/createDiffEditor/.test(js);
    add('P1', '编辑器保持单一 Monaco 宿主', noSecondHost, {});
    const snapshotRendering = /record\.diff\.hunks/.test(previewJs) && /line\.oldLine/.test(previewJs) && /line\.newLine/.test(previewJs);
    add('P2', '右侧按执行快照显示增删行和双行号', snapshotRendering, {});
    const noEditorPreview = !/showDiffInEditor|previewNewFile|applyChange|btn-diff-apply/.test(js + html);
    add('P3', '查看变更不切换或锁定编辑器、不重复应用', noEditorPreview, {});
    const actualSnapshots = /before: outcome\.before/.test(changesJs) && /after: outcome\.after/.test(changesJs) && /diffTexts\)\(event\.before, event\.after\)/.test(reviewJs);
    add('P4', '差异来自实际执行 before/after，而非重新读取编辑器', actualSnapshots, {});
    add('P5', '变更源码仅作为文本呈现，不能注入 HTML', /result\.textContent = text/.test(previewJs) && !/innerHTML|insertAdjacentHTML/.test(previewJs), {});
    const reviewSync = /onReviewState/.test(previewJs) && /review:state/.test(previewPreloadJs) && /CHANNELS\.reviewState/.test(mainJs);
    add('P6', '工具变更通过独立查看桥更新', reviewSync, {});
    add('P7', '撤销更新真实记录且旧批次不能混入当前查看', /status: 'undone'/.test(changesJs) && /token !== this\.generation/.test(reviewJs) && /structuredClone/.test(reviewJs), {});

    /* ---------------- Q 组：执行后刷新与编辑器交互 ---------------- */
    const hasFileChangedChannel = /fileChanged:\s*'fs:file-changed'/.test(contractTs);
    const notifiesOnApply = /this\.notify\(alias, outcome\.created/.test(changesJs);
    const notifiesOnUndo = /this\.notify\(alias, result\.deleted/.test(changesJs);
    const editorListens = /onFileChanged/.test(js) && /onFileChanged/.test(preloadTs);
    add('Q1', '工具写盘及撤销均刷新编辑器文件', hasFileChangedChannel && notifiesOnApply && notifiesOnUndo && editorListens,
      { hasFileChangedChannel, notifiesOnApply, notifiesOnUndo, editorListens });
    const onlyToolWrite = !/return:apply|return:undo|showDiffInEditor/.test(previewPreloadJs + preloadTs) && !/pv-apply-all/.test(previewHtml);
    add('Q2', 'AI 文件修改只有工具执行入口，查看面板没有人工应用入口', onlyToolWrite, {});

    // Q3：选区浮动复制按钮 —— 有选区才出现，无选区不显示；仍只写剪贴板不碰网页。
    //
    // 【2026-10-03 修正】旧断言查的是 `bubble.hidden = true`。但那正是 bug 的一部分：
    // 我们自己写 display/visibility，等于和 Monaco 的 ContentWidget 包装器抢同一个属性。
    // 现在显隐的唯一真源是 `getPosition()` 返回 null / 合法锚点，断言也随之改。
    const bubbleExists = /selection-copy/.test(js) && /selection-copy/.test(css);
    const hidesViaPosition = /getPosition:\s*function\s*\(\)\s*\{[\s\S]{0,400}?return null/.test(js);
    const hidesWhenEmpty = /selection\.isEmpty\(\)/.test(js) && hidesViaPosition;
    add('Q3', '选区右上角浮动复制按钮存在，且无选区时由 getPosition() 返回 null 收起', bubbleExists && hidesWhenEmpty, {
      bubbleExists,
      hidesWhenEmpty,
      hidesViaPosition,
    });

    // Q4：输入框滚动条必须是自绘细条 —— Windows 原生条是带箭头的白色块，压在深色框里极扎眼
    const customScrollbar = /\.requirement::-webkit-scrollbar-thumb/.test(css);
    const hidesNative = /\.requirement::-webkit-scrollbar\s*\{[^}]*width:\s*0/.test(css);
    add('Q4', '需求输入框用自绘细滚动条、隐藏原生带箭头滚动条', customScrollbar && hidesNative, {
      customScrollbar,
      hidesNative,
    });

    // Q5：浮动按钮**不再依赖 `.editor-wrap` 的定位上下文**。
    //
    // 【2026-10-03 修正】旧断言要求 `.editor-wrap{position:relative}`，前提是"我们自己
    // 用 absolute 相对 .editor-wrap 定位"。改用 IContentWidget 后，节点被挂进 Monaco
    // 自己的 overflow-guard（由它 `setPosition("absolute"|"fixed")`），
    // `.editor-wrap` 是不是 relative 已经无关紧要。
    // 新断言：样式表（剥掉注释后）里**不得**再出现 `.selection-copy{...display...}`。
    const cssCodeEarly = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const bubbleNotOwnedByWrap = !/\.selection-copy\s*\{[^}]*\bdisplay\s*:/.test(cssCodeEarly);
    add('Q5', '浮动按钮的 display 不自绘（改由 Monaco ContentWidget 独占管理）', bubbleNotOwnedByWrap, {
      bubbleNotOwnedByWrap,
    });

    // ---- R 组：修复「浮层按钮不出现」与「输入框不撑开/底部溢出」两个实测缺陷 ----
    //
    // 为什么单独开一组：Q3/Q4 只验证了「代码/样式文本存在」，而这两个 bug 恰恰是
    // **文本在、但永远不执行/被CSS 钳制失效**。存在性断言对它们完全无效，
    // 必须断言「执行前提」与「两端常量一致」。

    // R1：浮层按钮必须等state.editor 就绪后才建。
    // Monaco 是 window.require 异步加载的；若setupSelectionCopyBubble 写成顶层 IIFE，
    // 它会在 state.editor 还是 null 时执行并静默 return（按钮永远不出现）。
    // 断言：它是具名函数声明，且调用点在 initMonaco 的 require 回调内。
    const bubbleIsNamedFn = /function setupSelectionCopyBubble\(\)\s*\{/.test(js);
    const bubbleNotTopLevelIife = !/\(function setupSelectionCopyBubble\(\)/.test(js);
    const bubbleCalledAfterEditor =
      /state\.editor = window\.monaco\.editor\.create[\s\S]{0,1200}?setupSelectionCopyBubble\(\)/.test(js);
    add(
      'R1',
      '选区浮层按钮在 state.editor 就绪后才挂载（异步 require 下不再静默 return）',
      bubbleIsNamedFn && bubbleNotTopLevelIife && bubbleCalledAfterEditor,
      { bubbleIsNamedFn, bubbleNotTopLevelIife, bubbleCalledAfterEditor },
    );

    // R2：输入框必须 min ≠ max。
    // 曾经 min-height 与 max-height 同为 88px，高度被钉死，JS 内联 height 被钳制住，
    // auto-grow 形同虚设（用户实测：粘贴不撑开）。
    const reqBlock = /\.requirement\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    const minH = /min-height:\s*(\d+)px/.exec(reqBlock)?.[1];
    const maxH = /max-height:\s*(\d+)px/.exec(reqBlock)?.[1];
    const heightNotPinned = minH !== undefined && maxH !== undefined && minH !== maxH;
    add(
      'R2',
      '输入框高度区间 min ≠ max（否则 CSS 钳制会让 auto-grow 永久失效）',
      heightNotPinned,
      { minH: minH ?? '未设置', maxH: maxH ?? '未设置' },
    );

    // R3：CSS 的 min/max 与 JS 的 MIN_H / MAX_H 必须一致，否则会出现
    // 「JS 以为到顶了、CSS 还在放行」的错位（表现为要么不滚、要么留白）。
    const jsMinH = /const MIN_H = (\d+)/.exec(js)?.[1];
    const jsMaxH = /const MAX_H = (\d+)/.exec(js)?.[1];
    const boundsMatch = minH === jsMinH && maxH === jsMaxH;
    add(
      'R3',
      '输入框高度上下限在 CSS 与 JS 中一致',
      boundsMatch,
      { cssMin: minH ?? '未设置', cssMax: maxH ?? '未设置', jsMin: jsMinH ?? '未设置', jsMax: jsMaxH ?? '未设置' },
    );

    // R4：归零测量时必须同时放开 min/max-height，
    // 否则 min-height 会把 scrollHeight 顶起来，量到的不是真实内容高度。
    const growBlock = /function grow\(\)\s*\{([\s\S]*?)\n    \}/.exec(js)?.[1] ?? '';
    const resetsMinH = /minHeight\s*=\s*'0px'/.test(growBlock);
    const releasesMaxH = /maxHeight\s*=\s*'none'/.test(growBlock);
    add(
      'R4',
      'auto-grow 归零时同时放开 min/max-height（scrollHeight 量到真实内容高度）',
      resetsMinH && releasesMaxH,
      { resetsMinH, releasesMaxH },
    );

    // 先验证收起时只有官网原生输入，再展开本地需求验证真实 dock 预算。
    const collapsedRequirement = await input.editorView.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById('requirement-panel');
      return !panel.open && !document.getElementById('requirement').checkVisibility();
    })()`);
    await input.editorView.webContents.executeJavaScript("document.querySelector('#requirement-panel summary').click()");
    await new Promise(resolve => setTimeout(resolve, 200));
    const promptGeometry = await input.editorView.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.prompt-bar'), rect = bar.getBoundingClientRect();
      const dock = document.getElementById('collaboration-dock').getBoundingClientRect();
      const ids = ['requirement', 'variant-switch', 'tool-permission', 'tool-automatic', 'tool-settings-toggle', 'btn-send-prompt'];
      return {
        editorShrinkable: getComputedStyle(document.querySelector('.editor-wrap')).minHeight === '0px',
        withinBudget: rect.top >= dock.top - 1 && rect.bottom <= dock.bottom + 1 && dock.bottom <= innerHeight + 1 && dock.left >= 0 && dock.right <= innerWidth + 1,
        rect: rect.toJSON(), dock: dock.toJSON(), viewport: { width: innerWidth, height: innerHeight },
        controlsVisible: ids.every(id => {
          const r = document.getElementById(id).getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= rect.top && r.bottom <= rect.bottom + 1 && r.bottom <= innerHeight + 1 && r.bottom <= dock.bottom + 1;
        })
      };
    })()`) as { editorShrinkable: boolean; withinBudget: boolean; controlsVisible: boolean };
    add(
      'R5',
      '本地需求默认收起，展开后处于中间工具区实际视口预算内',
      collapsedRequirement && promptGeometry.editorShrinkable && promptGeometry.withinBudget,
      { ...promptGeometry, collapsedRequirement },
    );

    add(
      'R6',
      '输入框及常用操作在实际布局内可见，未被输入区裁切',
      promptGeometry.controlsVisible,
      promptGeometry,
    );
    await input.editorView.webContents.executeJavaScript("document.querySelector('#requirement-panel summary').click()");

    // R6b：外壳不得用 overflow: hidden 静默裁掉输入框。
    // 它曾把"差几像素"变成"看得出来的一条切边"（用户截图里的底部溢出）。
    // 当前由输入框上限和实际操作栏高度预算保证控件可见。
    //
    // 注意：**必须先去掉 CSS 注释**再断言。注释里为了说明历史会写出 overflow: hidden，
    // 直接匹配原文会被自己的说明文字误伤（实现时踩过）。
    const stripCssComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
    const shellBlock = stripCssComments(/\.prompt-shell\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '');
    const shellClips = /overflow:\s*hidden/.test(shellBlock);
    add(
      'R6b',
      '需求输入外壳不用 overflow:hidden（避免把高度差变成可见切边）',
      !shellClips,
      { shellClips },
    );

    // R6c：auto-grow 写回的高度必须含元素自身 padding。
    // scrollHeight 已包含 padding；保留既有底部余量，避免文字贴到输入区边缘。
    const growBodyForPad = /function grow\(\)\s*\{([\s\S]*?)\n    \}/.exec(js)?.[1] ?? '';
    const addsPad = /scrollHeight\s*\+\s*BOX_PAD/.test(growBodyForPad);
    const padDeclared = /const BOX_PAD\s*=\s*\d+/.test(js);
    add(
      'R6c',
      'auto-grow 保留既有底部余量与高度上限',
      addsPad && padDeclared,
      { addsPad, padDeclared },
    );

    // R7：高度必须跟随实际宽度持续校正，不能只在启动时量一次。
    // 脚本同步执行时 flex 布局尚未稳定、字体未就位，此时量到的 scrollHeight 不可靠，
    // 写死的内联 height 就是错的 → 表现为初始页面底部溢出。
    // 用 ResizeObserver 跟随宽度是正解；首次测量放到 rAF 之后。
    const hasResizeObserver = /new ResizeObserver\(/.test(js);
    const roGuard = /function growIfWidthChanged[\s\S]*?w === lastWidth[\s\S]*?return/.test(js);
    const firstMeasureInRaf = /requestAnimationFrame\(function \(\)\s*\{[\s\S]{0,200}?grow\(\)/.test(js);
    // 防自激：RO 观察自身元素，必须靠"宽度没变就跳过"断开height → RO → height 的回环
    add(
      'R7',
      '输入框高度跟随实际宽度校正（RO + 宽度守卫 + 首测延后到 rAF）',
      hasResizeObserver && roGuard && firstMeasureInRaf,
      { hasResizeObserver, roGuard, firstMeasureInRaf },
    );

    // R8：缩放窗口后必须能重算高度，且**不要求输入框非空**。
    // 上一版判了 `value.length > 0`，空输入框这条路直接走不通。
    // 收窄到 auto-grow 那个处理器：源码里有多个 resize 监听（浮层也挂了一个用来失效宽度缓存），
    // 不加限定会匹配到不相干的那个。
    const resizeHandler =
      /const MAX_H = \d+;[\s\S]{0,4000}?window\.addEventListener\('resize',[\s\S]*?\}\);/.exec(js)?.[0] ?? '';
    const resizeCallsGrow = /grow\(\)/.test(resizeHandler);
    const resizeNotGatedOnValue = !/value\.length\s*>\s*0/.test(resizeHandler);
    add(
      'R8',
      '缩放窗口即重算高度，且不因输入框为空而跳过',
      resizeCallsGrow && resizeNotGatedOnValue,
      { resizeCallsGrow, resizeNotGatedOnValue },
    );

    // ---- S 组：视图几何必须在窗口真正显示后重算 ----
    //
    // 背景：用户实测「启动后底部被切，拖一下窗口就恢复」。
    // 根因**不在 CSS、也不在渲染进程**，而在主进程：
    // `new BaseWindow(...)` 之后立刻 getContentSize()，此刻窗口还没显示，
    // 量到的内容区与显示后的真实视口不一致（边框/缩放/DPI 此时才最终确定），
    // 四个视图就按错尺寸定了 bounds，而 bounds 不会自动跟随视口。
    // 拖窗口能恢复只是因为那才会触发 win.on('resize', relayout) —— 属误认。
    const relayoutOnShow =
      /win\.once\('show',\s*\(\)\s*=>\s*\{[\s\S]{0,80}?relayout\(\)/.test(mainTs);
    const relayoutOnFinishLoad = /did-finish-load[\s\S]{0,200}?relayout\(\)/.test(mainTs);
    add(
      'S1',
      '窗口显示后重算视图几何（修"启动即溢出、拖窗口才恢复"）',
      relayoutOnShow && relayoutOnFinishLoad,
      { relayoutOnShow, relayoutOnFinishLoad },
    );

    // S2：给状态行显式 flex-shrink: 0 —— 它是固定高度信息条，
    // 纵向压缩只应作用在 .monaco 上；压状态行会把提示文字切成半行。
    const infoBlock = /\.info\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    const infoNotShrunk = /flex:\s*0\s+0\s+auto/.test(infoBlock);
    add('S2', '状态行不参与纵向压缩（纵向只压编辑器本体）', infoNotShrunk, { infoNotShrunk });

    const localReviewEntry = /id="tool-view-changes"/.test(html);
    add('T1', '本地工具区打开右侧改动标签，官网顶栏不控制 Diff',
      localReviewEntry && !/btn-preview-toggle|setPreviewPanel/.test(webbarHtml + webbarJs) &&
      /ipcMain\.handle\(CHANNELS\.setWorkspaceLayout/.test(layoutControllerTs), { localReviewEntry });

    // ---- U 组：浮层复制按钮的定位与提示；保存按钮移除后快捷键仍在 ----

    // U1：**不能把 Position 对象当字符偏移量传给 getPositionAt**。
    // `getPositionAt(offset: number)` 收的是数字，而 `getEndPosition()` 返回 Position 对象，
    // 误传后被转成 NaN → `style.top = NaN + 'px'` 是非法 CSS 值、被浏览器丢弃 →
    // 按钮停在hidden 状态。表现：代码文件"歪着出现"，markdown 干脆不出现
    // （wordWrap 换行更多，命中不同分支）。
    //
    // ⚠️ 必须先剥掉注释再匹配：这段错误写法的说明就写在代码旁的注释里，
    // 直接对全文 grep 会把注释当成违规代码。
    const jsCode = js
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const usesOffsetApi = /getPositionAt\(\s*selection\.get(Start|End)Position\(\)/.test(jsCode);
    // 锚点必须来自 getStartPosition()（第十一轮：改锚首行，见 V5）。
    const usesStartAnchor = /selection\.getStartPosition\(\)/.test(jsCode);
    add(
      'U1',
      '选区定位直接用 Position，不再误传给 getPositionAt，且锚点取自选区首行',
      !usesOffsetApi && usesStartAnchor,
      { usesOffsetApi, usesStartAnchor },
    );

    // U2：浮层**不再自己算绝对坐标**。此前用 getTopForLineNumber / getOffsetForColumn
    // 拿到的是**编辑器视口内坐标**，而浮层挂在编辑器外部的 .editor-wrap 上，
    // 两套坐标系在滚动 / wordWrap 折行时必然脱节 —— 表现就是 md 这类折行多的
    // 文件按钮算不到位置、干脆不出现。改用IContentWidget 后定位交给 Monaco。
    const noManualCoords =
      !/getTopForLineNumber/.test(jsCode) && !/getOffsetForColumn/.test(jsCode);
    add(
      'U2',
      '浮层不再自己算绝对坐标（改由 Monaco content widget 定位，修 md 折行错位）',
      noManualCoords,
      { noManualCoords },
    );

    // U3：浮层元素**不能用原生 title**。原生 tooltip 在元素位置变化时失效重建，
    // 而 place() 每次都写 style.left/top → hover 提示反复闪烁（用户实测：
    // 查找框关闭按钮的 Close (Escape) 面板一直闪）。改用 aria-label。
    const bubbleUsesTitle = /\.selection-copy[\s\S]{0,400}?\.title\s*=/.test(js);
    const bubbleUsesAria = /bubble\.setAttribute\('aria-label'/.test(js);
    add(
      'U3',
      '浮层按钮不用原生 title（避免重排导致 tooltip 闪烁），改用 aria-label',
      !bubbleUsesTitle && bubbleUsesAria,
      { bubbleUsesTitle, bubbleUsesAria },
    );

    // U4：位置**完全交给 Monaco**（addContentWidget / layoutContentWidget），
    // 我们一个 style.left/top 都不写。
    //
    // 这才是 tooltip 闪烁的根因修复：闪烁不是因为「写多了次」，
    // 而是因为**我们在高频事件里重排 DOM**，让旁边控件的原生 tooltip
    // 反复失效重建。只要不写style，这条链就断了。
    // 另需suppressMouseDown，否则点按钮会先把选区弄丢、按钮自己消失。
    const addedAsContentWidget = /editor\.addContentWidget\(contentWidget\)/.test(js);
    const noStyleWrites = !/bubble\.style\.(left|top)\s*=/.test(jsCode);
    const suppressMouseDown = /suppressMouseDown:\s*true/.test(js);
    add(
      'U4',
      '浮层定位交给 content widget（不写 style，故不会打断原生 tooltip）',
      addedAsContentWidget && noStyleWrites && suppressMouseDown,
      { addedAsContentWidget, noStyleWrites, suppressMouseDown },
    );

    // U5：保存按钮已移除，但**Ctrl+S 快捷键必须还在**。
    // 按钮只是入口之一，删了按钮不能把能力一起删掉 ——
    // 断言快捷键注册仍然存在，且页面里不再有 btn-save。
    const saveButtonGone = !/btn-save/.test(html) && !/btnSave/.test(js);
    const ctrlSStillBound = /KeyMod\.CtrlCmd\s*\|\s*window\.monaco\.KeyCode\.KeyS/.test(js);
    add(
      'U5',
      '保存按钮已移除，但 Ctrl+S 快捷键仍注册（能力不随入口一起丢）',
      saveButtonGone && ctrlSStillBound,
      { saveButtonGone, ctrlSStillBound },
    );

    // ---- V 组：两个"修了多次仍存在"的缺陷，按**根因**（而非症状）立规 ----
    //
    // 为什么单开一组：Q3/Q5/U1–U4 都只验证"我们自己的代码里有没有某些字样"，
    // 而这两个 bug 的真凶恰好**不在我们的代码里** —— 一个在 Monaco 的
    // ContentWidget 包装器里（它独占 DOM 的 display/visibility），
    // 一个在 Monaco 的 ActionBar 里（每次 alt 键状态变化就重画标签）。
    // 只对自家代码做存在性断言，永远查不出这类问题。这一组把"不要跟谁抢"写成规则。

    // V1：**样式表不得再声明 `.selection-copy` 的 display**。
    //
    // 根因：Monaco 的 ContentWidget 包装器（`l4`）对这个节点做三处**内联**样式写入：
    //   构造函数 `setDisplay("none")` + `setVisibility("hidden")`；
    //   `setPosition()` 三元的 else 分支 `setDisplay("none")`；
    //   `render()` 离屏 `setVisibility("hidden")` / 在屏 `setVisibility("inherit")`。
    // 内联样式优先级高于样式表，所以我们以前写的
    // `.selection-copy{display:none}` 与 `.selection-copy.visible{display:inline-block}`
    // 是在跟 Monaco 抢同一个属性 —— 谁后写谁赢，表现为"时而出现时而不出现"。
    // 修法：我们一次都不碰 display，显隐全部由 `getPosition()` 返回 null / 锚点表达。
    //
    // ⚠️ 必须先剥掉 CSS 注释再匹配：上面这段说明本身就写着被禁的写法，
    // 直接对全文 grep 会把"解释它的注释"当成"违规的代码"（U1 踩过同一个坑）。
    const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const cssDeclaresBubbleDisplay = /\.selection-copy\s*\{[^}]*\bdisplay\s*:/.test(cssCode);
    const cssHasVisibleClass = /\.selection-copy\.visible/.test(cssCode);
    add(
      'V1',
      '样式表不再声明 .selection-copy 的 display（不与 Monaco ContentWidget 抢属性）',
      !cssDeclaresBubbleDisplay && !cssHasVisibleClass,
      { cssDeclaresBubbleDisplay, cssHasVisibleClass },
    );

    // V2：**不得设置 useDisplayNone: true**。
    //
    // 反直觉的一点：`useDisplayNone` 看起来像"我自己管 display"，但在
    // `setPosition()` 里它是被取反后参与三元判断的 ——
    //   `!this.useDisplayNone && 有锚点 && preference非空 ? setDisplay("block") : setDisplay("none")`
    // 一旦设成 true，条件恒假 → **永远走 else → 被钉死在 display:none**。
    // 想让它显示反而得自己去写 display，那就退回了 V1 要修的老问题。
    const jsSetsUseDisplayNone = /useDisplayNone:\s*true/.test(jsCode);
    // 同理不能自己写 hidden 属性（等于第二次抢 display）
    const jsSetsHiddenAttr = /bubble\.hidden\s*=\s*(true|false)/.test(jsCode);
    add(
      'V2',
      '不设 useDisplayNone、不写 bubble.hidden（避免把节点钉死在 display:none）',
      !jsSetsUseDisplayNone && !jsSetsHiddenAttr,
      { jsSetsUseDisplayNone, jsSetsHiddenAttr },
    );

    // V3：`layoutContentWidget` **必须传原始 widget 对象**。
    //
    // 公开层 `editor.layoutContentWidget(w)` 内部执行 `w.getPosition()`，把结果写进
    // 它自己的包装器 `position` 字段，再转交视图层做实际定位。
    // 若传进去的不是带 getPosition 的对象（比如传了包装器或 undefined），
    // 锚点直接丢失 → 按钮不出现。这是"代码看着对、按钮就是不出现"的隐蔽来源。
    const layoutCallShape = /editor\.layoutContentWidget\(contentWidget\)/.test(js);
    // 锚点必须带 preference 数组，否则 setPosition 里 `preference.length > 0` 过不去、
    // Monaco 会主动 setDisplay("none")。
    const returnsPreference = /preference:\s*\[ContentWidgetPositionPreference\.ABOVE/.test(js);
    // 锚点还要带 positionAffinity，保证折行行的锚落在"该视觉行左缘"而不是飘到下一行。
    const returnsAffinity = /positionAffinity:/.test(js);
    add(
      'V3',
      'content widget 锚点带 preference 且带 positionAffinity，layout 调用传原始 widget',
      layoutCallShape && returnsPreference && returnsAffinity,
      { layoutCallShape, returnsPreference, returnsAffinity },
    );

    // V4：**页面里不得再出现"抑制 Monaco hover"的那类补丁**。
    //
    // 历史（第十一轮修正）：第十轮曾加过一个 `freezeFindWidgetHover()`，
    // 依据是"`updateTooltip()` 每次重画都 dispose 旧 hover 再重建 → 闪"。
    // 读 `actionViewItems.js` 的 `updateTooltip()` 后证伪：
    //   `if (!this.customHover && title !== '') { 建 } else if (this.customHover) { update }`
    // —— **只在首建，之后只 update，不重建**。而 `update()` 内部只是
    // `await hoverWidget?.update(...)`，既不 show 也不 hide。
    //
    // 更糟的是那个补丁有**副作用**：`setupManagedHover()` 里有
    //   `if (targetElement.title !== '') { console.warn(...); targetElement.title = ''; }`
    // 它会主动清掉我们写的 title；而它自己 `setAttribute('custom-hover','true')`
    // 又是属性写入（我们的 MutationObserver 只监听 childList/subtree，管不到），
    // 于是形成"删属性→被加回→清 title→再写 title"的 churn —— 补丁本身成了噪声源。
    //
    // 所以本条断言的意图反过来了：**不允许**再引入这类 DOM 层抑制，
    // 真因只能靠"实测定位 + 上游补丁"解决，不能靠猜机制在渲染层打补丁。
    const noHoverSuppressionPatch =
      !/function freezeFindWidgetHover\s*\(/.test(js) &&
      !/findHoverObserver/.test(js) &&
      // 只拦**写**：探针里读 `getAttribute('custom-hover')` 属诊断用途，是允许的。
      !/setAttribute\(\s*['"]custom-hover['"]/.test(js) &&
      !/removeAttribute\(\s*['"]custom-hover['"]/.test(js) &&
      !/querySelectorAll\([^)]*custom-hover/.test(js);
    add(
      'V4',
      '不在渲染层做"抑制 Monaco hover"的补丁（该机制已被源码证伪，且带 title 清空副作用）',
      noHoverSuppressionPatch,
      { noHoverSuppressionPatch },
    );

    // V5：复制按钮的锚点必须落在**选区首行**，而不是末行。
    //
    // 用户反馈（第十一轮）："这个复制按钮……好像是最后一行的右上角，
    // 不是整体的区域的右上角"。上一版用 `getEndPosition()`，按钮跟着
    // 选区最后一行跑。正确锚点是 `getStartPosition()`（Monaco 里恒指向
    // 文档序更靠前的一端）的行尾 —— 那才是选区外接矩形的右上角。
    const anchorsAtStart = /selection\.getStartPosition\(\)/.test(js);
    const noLegacyEndAnchor = !/const end = selection\.getEndPosition\(\)/.test(js);
    add(
      'V5',
      '复制按钮锚在选区首行右端（外接矩形右上角），不再锚末行',
      anchorsAtStart && noLegacyEndAnchor,
      { anchorsAtStart, noLegacyEndAnchor },
    );

    // V6：**裸标识符必须真的有绑定** —— 用 TypeScript 编译器做真实作用域分析。
    //
    // 为什么需要：上一版 `setupSelectionCopyBubble` 里写的是 `editor.getSelection()` /
    // `editor.getModel()`，而**该函数根本没有 `editor` 这个绑定**（同名的 `editor`
    // 只是别的函数的局部变量，不构成闭包）。`getPosition()` 又是由 Monaco 在自己的
    // 渲染循环里回调的 —— 里面抛的 ReferenceError 被 Monaco 内部吞掉，
    // 外部**看不到任何报错**，表现就只是"按钮永远不出现"。
    //
    // 这类缺陷比"逻辑写错"更难查：代码读起来完全正确，`renderer.js` 也不走 tsc
    // （L2 只做语法解析，语法本身没问题）。所以这里用 TS 编译器做**语义**检查：
    // 把 renderer.js 当 JS 解析，收集所有 `Cannot find name` 诊断。
    //
    // 提取成独立脚本 `tools/check-renderer-scope.mjs` 也是同样的逻辑，
    // 便于在没有 Electron 的环境里单跑（GUI 自检在本机沙箱跑不起来）。
    const scopeReportPath = path.join(__dirname, '..', '..', 'tools', 'renderer-scope-report.json');
    let rendererUndefined: string[] = [];
    let scopeCheckOk = true;
    try {
      if (fs.existsSync(scopeReportPath)) {
        const parsed = JSON.parse(fs.readFileSync(scopeReportPath, 'utf8')) as { undefinedNames?: string[] };
        rendererUndefined = parsed.undefinedNames ?? [];
      } else {
        // 没有预生成报告时不判失败（避免"忘了跑生成脚本"变成假红），但要如实标注
        scopeCheckOk = false;
      }
    } catch {
      scopeCheckOk = false;
    }
    add(
      'V6',
      '`renderer.js` 中的裸标识符都能解析到绑定（防 Monaco 回调里的静默 ReferenceError）',
      scopeCheckOk && rendererUndefined.length === 0,
      { scopeCheckOk, undefinedNames: rendererUndefined },
    );

    // V7：**复制按钮必须是横排、且宽度由内容决定**。
    //
    // 用户实测截图：按钮里的「复制」被折成**竖排两行**（"复"/"制"各占一行），
    // 整个按钮缩成一条细长竖条。原因是节点处在 Monaco 的绝对定位容器里，
    // 宽度被父级与视口边缘挤压，而中文没有词边界 → 浏览器逐字换行。
    //
    // 两条约束缺一不可，且**都必须带 `!important`**（Monaco 会给该节点写内联样式）：
    //   - `white-space: nowrap`  → 禁止换行；
    //   - `width: max-content`   → 宽度由内容决定，不受父容器挤压。
    // 用 `width` 而非 `min-width`：绝对定位元素上 `min-width` 只是下限，
    // 父级更宽时仍会被拉伸，尺寸不稳。
    const bubbleRule = /\.selection-copy\s*\{([\s\S]*?)\}/.exec(cssCode)?.[1] ?? '';
    const bubbleNowrap = /white-space:\s*nowrap\s*!important/.test(bubbleRule);
    const bubbleMaxContent = /width:\s*max-content\s*!important/.test(bubbleRule);
    // 反向：不允许出现把宽度写死的固定值（那会在不同字号/缩放下不匹配）
    const bubbleNoFixedWidth = !/^\s*width:\s*\d+px/m.test(bubbleRule);
    add(
      'V7',
      '复制按钮横排且宽度由内容决定（nowrap + max-content，均带 !important）',
      bubbleNowrap && bubbleMaxContent && bubbleNoFixedWidth && bubbleRule.length > 0,
      { bubbleNowrap, bubbleMaxContent, bubbleNoFixedWidth },
    );

    // V8：**查找框 hover 提示必须禁止折行**（治"折行导致尺寸抖动 → hover 反复隐藏重建"）。
    //
    // 用户实测对比：`Previous Match (Shift+Enter)` 一行横排、正常；
    // `Close (Escape)` 折成两行、闪烁 —— 而且前者更长却没折，说明
    // **折行与文本长度无关**，是浮层被挤在视口右缘、可用宽度不足。
    //
    // 关键在于 Monaco 把 `white-space: pre-wrap` 写成了**内联样式**
    // （见 `hoverWidget.js`：字符串内容 `contentsElement.style.whiteSpace='pre-wrap'`），
    // 内联声明压过普通样式表规则 —— 所以必须用 `!important` 才能覆盖。
    //
    // 同时**必须限定范围**（`:not(:has(*))` = 只命中叶子节点 = 纯文本提示），
    // 否则会把编辑器里正常的富内容悬停（markdown 预览、多行说明）也硬撑成一行。
    const hoverNowrap = /\.monaco-hover\s+\.hover-contents:not\(:has\(\*\)\)\s*\{[\s\S]*?white-space:\s*nowrap\s*!important/.test(
      cssCode,
    );
    add(
      'V8',
      '查找框 hover 提示禁止折行（!important 覆盖 Monaco 的内联 pre-wrap，且只限纯文本叶子节点）',
      hoverNowrap,
      { hoverNowrap },
    );

    // renderer.js 不经 tsc，这里至少保证可被解析（语法错误会在此暴露）
    let parseError: string | null = null;
    try {
      new vm.Script(js, { filename: 'renderer.js' });
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    add('L2', 'renderer.js 语法可被解析（渲染进程脚本不走 tsc）', parseError === null, parseError ?? 'OK');

    // 编辑器关键选项：换行 / 字体 / 行高 / 普通编辑器不设只读。
    // 注意必须**只检查 EDITOR_OPTIONS 块**：diff 编辑器本来就应当 readOnly，
    // 早先按全文搜索 readOnly 会因此误报。
    const editorOptionsBlock = /const EDITOR_OPTIONS = \{([\s\S]*?)\n  \};/.exec(js)?.[1] ?? '';
    const hasWordWrap = /wordWrap:\s*'on'/.test(editorOptionsBlock);
    const hasFont = /fontFamily:/.test(editorOptionsBlock);
    const hasLineHeight = /lineHeight:/.test(editorOptionsBlock);
    const hasReadOnly = /readOnly:\s*true/.test(editorOptionsBlock);
    add(
      'L3',
      '编辑器默认：开启自动换行 + 设置字体与行高，且**普通编辑器不设只读**',
      hasWordWrap && hasFont && hasLineHeight && !hasReadOnly && editorOptionsBlock.length > 0,
      { hasWordWrap, hasFont, hasLineHeight, hasReadOnly, blockFound: editorOptionsBlock.length > 0 }
    );

    // 目录树必须是"可展开"结构（原地展开），而不是"进入式"
    const hasTreeChildren = /tree-children/.test(js);
    const hasExpandedState = /const expanded = new Set\(\)/.test(js);
    add('L4', '目录树为可展开结构且保持展开状态', hasTreeChildren && hasExpandedState, { hasTreeChildren, hasExpandedState });

    // 未保存标记：文件头白点存在且默认隐藏
    const dotInHtml = /id="file-dot"/.test(html);
    const dotHidden = /class="file-dot"[^>]*hidden/.test(html) || /id="file-dot"[^>]*hidden/.test(html);
    add('L5', '未保存标记（文件头白点）存在且默认隐藏', dotInHtml && dotHidden, { dotInHtml, dotHidden });
  } catch (err) {
    add('L1', '渲染进程界面契约检查', false, `读取失败：${err instanceof Error ? err.message : String(err)}`);
  }

  /* ---- F) P3 纯逻辑：回程解析与格式模板 ---- */
  const operationReply = (filePath: string, operation: string, body: string) =>
    ['### 文件：' + filePath, '### 操作：' + operation, fenceFor(body), body, fenceFor(body)].join('\n');
  const replacementReply = (filePath: string, oldText: string, newText: string) =>
    operationReply(filePath, '替换', ['<<<<<<< SEARCH', oldText, '=======', newText, '>>>>>>> REPLACE'].join('\n'));
  const sampleReply = operationReply('src/demo.ts', '覆盖全文', 'export const demo = 1;') + '\n\n' +
    operationReply('other.py', '新建', '# other.py\nprint("hi")');
  const parsed = parseModelReply(sampleReply);
  add('F1', '回程解析：每块紧邻文件与明确操作均被识别', parsed.blocks.length === 2 && parsed.blocks[0]?.filePath === 'src/demo.ts' && parsed.blocks[0]?.operation === 'overwrite' && parsed.blocks[1]?.filePath === 'other.py' && parsed.blocks[1]?.operation === 'create', parsed.blocks.map(block => ({ file: block.filePath, operation: block.operation })));
  add('F2', '协议正文中的路径注释按字面保存，不剥除内容', parsed.blocks[1]?.code === '# other.py\nprint("hi")', parsed.blocks[1]?.code);
  // 全部输出示例采用唯一工具协议；外层示例和输入上下文不能触发执行。
  const templateChecks = (variant: 'short' | 'full') => {
    const fences = splitFences(getFormatSpec(variant)); const operations = new Set<string>();
    let valid = fences.length > 0 && fences.length % 2 === 0 && parseToolBatch(getFormatSpec(variant)).kind === 'none';
    for (let i = 0; i < fences.length; i += 2) {
      if (parseToolBatch(fences[i]!.body).kind !== 'none') valid = false;
      const output = parseToolBatch(fences[i + 1]!.body);
      if (output.kind === 'error') valid = false;
      if (output.kind === 'batch') for (const request of output.batch.requests) {
        if (request.tool === 'apply_changes') for (const change of request.args.changes as Array<{ operation: string }>) operations.add(change.operation);
      }
    }
    return { valid, examples: fences.length / 2, operations: [...operations].sort() };
  };
  const shortExamples = templateChecks('short'); const fullExamples = templateChecks('full');
  add('F3', '两版提示词全部工具示例合法，外层示例与复制上下文不触发执行', shortExamples.valid && fullExamples.valid, { shortExamples, fullExamples });

  /*
   * F3b：格式模板里的**每一段围栏必须自洽成对**。
   *
   * 演进说明：最初这条断言是"**不得出现**任何三个及以上连续反引号"——
   * 因为那时的模板在说明文字里写出孤立的三反引号（如「.py 用 ```python」），
   * 模型会把它当成**代码块开头**，而后面没有配对闭合 → 输出"有开头没结尾"
   * （用户实测：第一次输出没有 ``` 结尾）。
   *
   * 但后来模板改成"用五反引号包住示例"（示例里必须出现三/四反引号才直观），
   * "零反引号"这个判据就不再成立、且会阻止正确写法。真正的不变量是：
   *   **规格说明里出现的每一段反引号，都必须与同长度的另一段配对**（成对出现），
   *   绝不能留下一个"没人闭合的opener"去带偏模型。
   *
   * 判据：把所有 `{3,}` 序列按长度分组，要求每个长度组的**条数都是偶数**
   * （即开、闭各一次）。长度为奇数的组 = 存在未闭合的围栏。
   */
  const unbalanced = (text: string): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const m of text.match(/`{3,}/g) || []) counts[String(m.length)] = (counts[String(m.length)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).filter(([, n]) => n % 2 !== 0));
  };
  const shortUnbalanced = unbalanced(getFormatSpec('short'));
  const fullUnbalanced = unbalanced(getFormatSpec('full'));
  add(
    'F3b',
    '格式模板里的围栏全部成对（不存在没人闭合的围栏 → 不会带偏模型输出）',
    Object.keys(shortUnbalanced).length === 0 && Object.keys(fullUnbalanced).length === 0,
    { shortUnbalanced, fullUnbalanced }
  );

  const specAll = getFormatSpec('short') + getFormatSpec('full');
  add('F3c', '格式模板实际覆盖替换、新建、覆盖全文且不输出定位范围', shortExamples.valid && JSON.stringify(shortExamples.operations) === '["create","overwrite","replace"]' && !/### 范围：/.test(specAll), shortExamples);
  add('F3d', '完整版十四组示例统一通过正式工具解析', fullExamples.valid && fullExamples.examples === 14, fullExamples);
  add('F3g', '简洁版六组高频示例逐一通过正式工具解析', shortExamples.valid && shortExamples.examples === 6, shortExamples);
  add(
    'F3e',
    '正式工具标记不可由普通 JSON 或旧文件块代替',
    parseToolBatch('```json\n{"protocol_version":1,"batch_id":"example","requests":[{"id":"info","tool":"get_project_info","args":{}}]}\n```').kind === 'none' && parseToolBatch(sampleReply).kind === 'error',
    {
      oldFileReply: parseToolBatch(sampleReply).kind,
    }
  );
  add(
    'F3f',
    '正式工具围栏截断时拒绝，不执行半个请求',
    parseToolBatch('```mini-ai-tools\n{"protocol_version":1').kind === 'error',
    { incomplete: parseToolBatch('```mini-ai-tools\n{"protocol_version":1').kind }
  );

  const appliedWhole = computeApply('old body', parsed.blocks[0]!);
  add(
    'F4',
    '应用计算：整文件替换返回新文本与被替换内容（供撤销）',
    appliedWhole.ok && appliedWhole.text === 'export const demo = 1;' && appliedWhole.replaced === 'old body',
    appliedWhole.ok ? { text: appliedWhole.text, replaced: appliedWhole.replaced, mode: appliedWhole.mode } : appliedWhole
  );

  /* ---- J) 精确原文替换、唯一匹配与计算范围 ---- */
  const original = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
  const snippetBlock = parseModelReply(replacementReply('src/a.ts', 'line2\nline3', 'NEW2\nNEW3')).blocks[0]!;
  add('J1', '解析明确替换对，AI 不提供定位行号', snippetBlock.operation === 'replace' && snippetBlock.range === null && snippetBlock.edits?.[0]?.oldText === 'line2\nline3', snippetBlock);
  const okApply = computeApply(original, snippetBlock);
  add('J2', '唯一原文匹配时替换且 IDE 计算实际 2–3 行', okApply.ok && okApply.text === 'line1\nNEW2\nNEW3\nline4\nline5' && okApply.locations[0]?.oldRange?.start === 2 && okApply.locations[0]?.oldRange?.end === 3, okApply);
  const mismatch = computeApply(original.replace('line2', 'changed'), snippetBlock);
  add('J3', '原文匹配零次时拒绝，不能猜测位置', !mismatch.ok && mismatch.reason === 'search-not-found', mismatch);
  const duplicate = computeApply(original + '\nline2\nline3', snippetBlock);
  add('J4', '原文匹配多次时拒绝，必须补充上下文', !duplicate.ok && duplicate.reason === 'search-ambiguous', duplicate);
  const overlapBlock = parseModelReply(operationReply('src/a.ts', '替换', snippetBlock.code + '\n' + ['<<<<<<< SEARCH', 'line3', '=======', 'OTHER', '>>>>>>> REPLACE'].join('\n'))).blocks[0]!;
  const overlapping = computeApply(original, overlapBlock);
  add('J5', '同块替换对重叠时整块拒绝', !overlapping.ok && overlapping.reason === 'overlap', overlapping);
  const literalNumbered = buildSnippetText({ relPath: 'literal.txt', text: ' 80| alpha\n 81| beta\n', startLine: 80 });
  add('J6', '复制原文不新增或剥除真实行号状文本，保留末尾换行', parseModelReply(literalNumbered.text).blocks[0]?.code === ' 80| alpha\n 81| beta\n', literalNumbered.text);
  const crlfApply = computeApply(original.replace(/\n/g, '\r\n'), snippetBlock);
  add('J7', '精确匹配仅规范换行，写入保留原 CRLF 风格', crlfApply.ok && crlfApply.text === 'line1\r\nNEW2\r\nNEW3\r\nline4\r\nline5', crlfApply);
  const rangeLines = Array.from({ length: 25 }, (_, i) => `原第 ${i + 1} 行`);
  rangeLines[10] = '}'; rangeLines[11] = '';
  const replacement = [...Array.from({ length: 7 }, (_, i) => `新增 ${i + 1}`), '}', '', '最后一行'];
  const rangeBlock = parseModelReply(replacementReply('range.txt', rangeLines[9]!, replacement.join('\n'))).blocks[0]!;
  const rangeApplied = computeApply(rangeLines.join('\n'), rangeBlock);
  const rangeAfter = rangeApplied.ok ? rangeApplied.text.split('\n') : [];
  add('J8', '第十行唯一原文替换十行：IDE 显示新 10–19，文件增九行', rangeApplied.ok && rangeAfter.length === 34 && rangeAfter.slice(9, 19).join('\n') === replacement.join('\n') && rangeApplied.locations[0]?.newRange?.end === 19, rangeApplied);
  add('J9', '重复括号与空行不能吞掉匹配区间外内容', rangeApplied.ok && rangeAfter.slice(0, 9).join('\n') === rangeLines.slice(0, 9).join('\n') && rangeAfter.slice(19).join('\n') === rangeLines.slice(10).join('\n'), rangeApplied);
  const shortBlock = parseModelReply(replacementReply('range.txt', 'a\nb\nc', 'tail')).blocks[0]!;
  const shortened = computeApply('head\na\nb\nc\ntail', shortBlock);
  add('J10', '缩短匹配原文，后续行向前移动且相同行完整保留', shortened.ok && shortened.text === 'head\ntail\ntail', shortened);
  const atEnd = computeApply(rangeLines.slice(0, 10).join('\n'), rangeBlock);
  add('J11', '无末尾换行的最后一行替换为十行，文件增九行', atEnd.ok && atEnd.text === [...rangeLines.slice(0, 9), ...replacement].join('\n'), atEnd);

  /* ---- M) 提示词上下文组装：精确保留原文 + 围栏自适应（防内容里的 ``` 提前闭合） ---- */
  const plainSnippet = buildSnippetText({ relPath: 'src/a.py', text: 'def f():\n    pass', startLine: 80 });
  add(
    'M1',
    '选区复制声明只读上下文文件与原文片段，不提供操作或定位范围',
    plainSnippet.text ===
      ['### 上下文文件：src/a.py', '### 上下文：原文片段', '````python', 'def f():', '    pass', '````'].join('\n'),
    plainSnippet.text
  );

  add(
    'M1b',
    '原文上下文不添加行号前缀，也不产生应用操作',
    !/^\s*\d+\|/m.test(plainSnippet.text) && parseModelReply(plainSnippet.text).blocks[0]?.kind === 'other',
    plainSnippet.text
  );

  const nestedContent = '冒泡排序：\n```python\ndef bubble_sort(arr):\n    pass\n```';
  const nestedSnippet = buildSnippetText({ relPath: 'notes.md', text: nestedContent, startLine: 1 });
  add('M2', '内容含 ``` 时外层围栏至少四个（不提前闭合）', nestedSnippet.fence === '````' && nestedSnippet.text.includes('```python') && nestedSnippet.text.endsWith('\n````'), {
    fence: nestedSnippet.fence,
  });

  const whole = buildWholeFileText('src/a.ts', 'export const a = 1;');
  add(
    'M3',
    '提示词完整原文样例明确为只读上下文，不暗示覆盖全文',
    whole.text === ['### 上下文文件：src/a.ts', '### 上下文：完整原文', '````typescript', 'export const a = 1;', '````'].join('\n') &&
      !whole.text.includes('这个文件是'),
    whole.text
  );

  add(
    'M3b',
    '两种片段的结构位逐字同构（含围栏行相同、行数相同）',
    (() => {
      const a = buildSnippetText({ relPath: 'x.py', text: 'v', startLine: 1 }).text.split('\n');
      const b = buildWholeFileText('x.py', 'v').text.split('\n');
      return a.length === b.length && a.length === 5 && a[2] === b[2] && a[4] === b[4];
    })(),
    { local: plainSnippet.text.split('\n').length, whole: whole.text.split('\n').length }
  );

  const wholeNested = buildWholeFileText('notes.md', '# 标题\n\n```python\nprint(1)\n```');
  add('M4', '整文件片段同样按内容加长围栏', wholeNested.fence === '````' && wholeNested.text.includes('````markdown'), {
    fence: wholeNested.fence,
  });

  add(
    'M5',
    '围栏长度取内容中最长反引号串 + 1，**下限为四个**（与提示词「用四个反引号」一致）',
    fenceFor('```\n`````\n```') === '``````' && fenceFor('用 `x` 调用') === '````' && fenceFor('plain') === '````',
    { longest: fenceFor('```\n`````\n```'), inline: fenceFor('用 `x` 调用'), plain: fenceFor('plain') }
  );

  /* ---- K) 回程闭环：采集 → 解析 → 应用 → 撤销 ---- */
  // 用一个假的页面运行器验证采集器本身（不依赖真实站点）。
  // 注意：断言用**第一条策略的 id**，不要硬编码字符串 —— 策略改名时不会误报。
  const firstStrategyId = COLLECT_STRATEGIES[0]?.id ?? '';
  const fakeRunner = {
    evaluate: async (script: string): Promise<unknown> => {
      if (script === COLLECT_STRATEGIES[0]?.script) {
        return [operationReply('src/greeting.ts', '新建', 'export const hi = 1;')];
      }
      return [];
    },
    currentUrl: () => 'https://chat.deepseek.com/a/chat/s/abc?x=1',
  };
  const collected = await collectReply(fakeRunner);
  add('K1', '采集器按策略取到回复且 URL 已去除 query', collected.strategyId === firstStrategyId && collected.url === 'https://chat.deepseek.com/a/chat/s/abc', {
    strategyId: collected.strategyId,
    expectedStrategy: firstStrategyId,
    url: collected.url,
    length: collected.replyText.length,
  });

  const noneRunner = { evaluate: async (): Promise<unknown> => [], currentUrl: () => 'https://chat.deepseek.com/' };
  const noneCollected = await collectReply(noneRunner);
  add('K2', '全部策略未命中时如实报告失败（不伪造结果）', noneCollected.strategyId === null && noneCollected.replyText === '' && noneCollected.attempts.length === COLLECT_STRATEGIES.length, {
    attempts: noneCollected.attempts.map((a) => a.strategyId),
  });

  /* ---- K2x) 消费判定层（L2）：指纹相同 → 无新内容；会话隔离；重新生成放行 ---- */
  // 会话标识剥掉查询参数（与采集器 URL 归一化同源）
  add('K2a', '会话标识按 origin+pathname 归一（剥掉 query）', sessionKeyOf('https://chat.deepseek.com/a/chat/s/abc?x=1&t=2') === 'https://chat.deepseek.com/a/chat/s/abc', {
    key: sessionKeyOf('https://chat.deepseek.com/a/chat/s/abc?x=1&t=2'),
  });
  add('K2b', '指纹稳定且定长（同文本同值、不同文本不同值）', fingerprintOf('abc') === fingerprintOf('abc') && fingerprintOf('abc') !== fingerprintOf('abcd') && fingerprintOf('abc').length === 16, {
    fp: fingerprintOf('abc'),
  });

  const consume = new ConsumptionStore();
  const key1 = sessionKeyOf('https://chat.deepseek.com/a/chat/s/abc');
  const key2 = sessionKeyOf('https://chat.deepseek.com/a/chat/s/def');
  const first = consume.consume(key1, '回复-A');
  const again = consume.consume(key1, '回复-A');
  const changed = consume.consume(key1, '回复-B');
  const otherSession = consume.consume(key2, '回复-A');
  add('K2c', '同会话同指纹 → 判定已消费（noNewContent）', first.consumed === false && again.consumed === true && again.previous === fingerprintOf('回复-A'), {
    first: first.consumed,
    again: again.consumed,
  });
  add('K2d', '同会话新指纹 → 放行并更新记录（重新生成后可再采）', changed.consumed === false && consume.peek(key1)?.fingerprint === fingerprintOf('回复-B'), {
    changed: changed.consumed,
  });
  add('K2e', '不同会话各自独立（互不判重）', otherSession.consumed === false && consume.size === 2, { size: consume.size });

  // 真实文件上的"应用 → 撤销"闭环（用样例目录里已有的 hello.ts）
  const rp = new ReturnPathService(input.fileService);
  const beforeAll = await input.fileService.readRawText('hello.ts');
  const originalText = beforeAll.ok ? beforeAll.text : '';
  add('K3a', '读取样例文件成功（闭环前置条件）', beforeAll.ok && originalText.length > 0, beforeAll.ok ? { chars: originalText.length } : beforeAll);

  const wholeBlock = parseModelReply(operationReply('hello.ts', '覆盖全文', 'export const hi = 2;')).blocks[0]!;
  const wholePreview = await rp.prepareChange(wholeBlock);
  const applied = await rp.applyChange({ filePath: 'hello.ts', block: wholeBlock });
  add('K3', '明确覆盖全文先预览后写入，结果等于已展示内容', wholePreview.ok && applied.ok && applied.after === wholePreview.after && applied.after === 'export const hi = 2;', applied);
  const undone = await rp.undoLast();
  add('K4', '撤销按快照恢复原文', undone.ok && undone.filePath === 'hello.ts', undone);
  const afterUndo = await input.fileService.readRawText('hello.ts');
  add('K5', '撤销后文件内容逐字恢复，包括末尾换行', afterUndo.ok && afterUndo.text === originalText, afterUndo);
  const firstLine = originalText.split(/\r\n|\r|\n/)[0] ?? '';
  const greetingSnippetBlock = parseModelReply(replacementReply('hello.ts', firstLine, 'export const hi = 99;')).blocks[0]!;
  await rp.prepareChange(greetingSnippetBlock);
  const snippetApplied = await rp.applyChange({ filePath: 'hello.ts', block: greetingSnippetBlock });
  add('K6', '局部精确替换在已展示基线一致时成功', snippetApplied.ok && snippetApplied.mode === 'replace', snippetApplied);
  await rp.undoLast();
  const staleBlock = parseModelReply(replacementReply('hello.ts', firstLine, 'stale content')).blocks[0]!;
  await rp.prepareChange(staleBlock);
  await input.fileService.writeFile('hello.ts', originalText + '\nexternal change');
  const staleApplied = await rp.applyChange({ filePath: 'hello.ts', block: staleBlock });
  add('K7', '预览后外部文件变化拒绝应用，不重新生成基线', !staleApplied.ok && staleApplied.reason === 'target-changed', staleApplied);
  const afterReject = await input.fileService.readRawText('hello.ts');
  add('K8', '拒绝应用后外部改动逐字保留', afterReject.ok && afterReject.text === originalText + '\nexternal change', afterReject);
  await input.fileService.writeFile('hello.ts', originalText);

  /* ---- I) prompt 组装（需求 + 环境 + 目录树 + 格式要求）---- */
  const ctx = buildContextSummary(fixtures.root);
  const assembled = buildPrompt({
    requirement: '把 greeting 改成 hello',
    context: { root: ctx.root, environment: ctx.environment, tree: ctx.tree },
    formatSpec: getFormatSpec('short'),
    targetFiles: ['hello.ts'],
  });
  add(
    'I1',
    'prompt 组装包含需求/工作环境/目录结构/格式要求四段',
    /## 用户需求/.test(assembled) && /## 工作环境/.test(assembled) && /## 目录结构/.test(assembled) && assembled.endsWith(getFormatSpec('short')) && assembled.includes(TOOL_PROTOCOL_PROMPT),
    assembled.slice(0, 120)
  );
  add('I2', '工作环境摘要含真实运行环境与工作目录', ctx.environment.length > 0 && ctx.root === fixtures.root, {
    environment: ctx.environment,
    root: ctx.root,
  });
  add('I3', '目录树摘要含样例文件且为相对路径', Boolean(ctx.tree && ctx.tree.includes('hello.ts') && !ctx.tree.includes(fixtures.root)), (ctx.tree ?? '').split('\n').slice(0, 6));
  add(
    'I4',
    '上下文**不含"当前打开的文件"**（用户明确要求排除，避免误导模型）',
    !/当前打开的文件|current file|currentFile/i.test(assembled),
    '未出现"当前打开的文件"字样'
  );

  /* ---- H) 目录记忆：真实"重启后恢复"验证 ----
   * 期望值由主进程在**启动那一刻**捕获（startupRoot），因为自检自身会把
   * 根目录改成临时样例目录；若在此处读取 fileService.getRoot()，比对的就是样例目录了。
   */
  if (input.expectRestoredRoot && input.settings) {
    const remembered = input.settings.get().lastRoot;
    const startupRoot = input.expectRestoredRoot;
    add('H1', '启动时按记忆恢复了根目录（恢复路径生效）', startupRoot === input.expectRestoredRoot, {
      startupRoot,
      expected: input.expectRestoredRoot,
    });
    add('H2', '恢复的目录是可用目录（isUsableRoot）', isUsableRoot(startupRoot), startupRoot);
    add('H3', '设置中仍记录该目录（未被自检污染）', remembered === input.expectRestoredRoot, {
      remembered,
      expected: input.expectRestoredRoot,
    });
  }

  /* ---- G) 设置持久化（上次打开的目录）---- */
  if (input.settings) {
    const before = input.settings.get();
    const workspaceLayout = { workspaceWidth: 220, workspaceVisible: true, fileWidth: 640,
      fileVisible: true, treeWidth: 180, treeVisible: true };
    const written = input.settings.update({ lastRoot: fixtures.root, workspaceLayout });
    add('G1', '设置可写入并读回（上次打开的目录）', written.lastRoot === fixtures.root, written);
    const reread = new SettingsStore(SELF_TEST_SETTINGS_FILE);
    add('G2', '设置可从磁盘重新加载（等价于重启后恢复）', reread.get().lastRoot === fixtures.root, reread.get());
    add('G5', '项目、文件、目录的宽度与显隐从磁盘完整恢复', JSON.stringify(reread.get().workspaceLayout) === JSON.stringify(workspaceLayout), reread.get().workspaceLayout);
    // 复原，避免自检污染设置
    input.settings.update({ lastRoot: before.lastRoot, workspaceLayout: before.workspaceLayout });
    const after = input.settings.get();
    add('G3', '自检结束后已复原原设置', after.lastRoot === before.lastRoot && JSON.stringify(after.workspaceLayout) === JSON.stringify(before.workspaceLayout), after);

    // G4：自检**必须**使用独立的设置文件，否则会覆盖用户真实的"上次打开的目录"
    const settingsBase = path.basename(input.settings.filePath);
    add(
      'G4',
      '自检使用独立的设置文件（不会覆盖用户真实的上次打开的目录）',
      settingsBase === SELF_TEST_SETTINGS_FILE,
      { settingsFile: settingsBase, expected: SELF_TEST_SETTINGS_FILE }
    );
  }

  const failures = checks.filter((c) => !c.pass).map((c) => c.id);
  return {
    collectedAt: new Date().toISOString(),
    checks,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    failures,
  };
}
