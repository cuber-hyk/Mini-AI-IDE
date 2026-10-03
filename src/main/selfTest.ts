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

import { CHANNELS } from '../shared/contract';
import { buildPrompt, getFormatSpec } from '../shared/formatSpec';
import { computeApply, formatNumberedSnippet, parseModelReply, stripNumberedPrefix } from '../shared/returnPath';
import { buildSnippetText, buildWholeFileText, fenceFor } from '../shared/snippet';
import { createFixtures, type FixturePaths } from './fixtures';
import type { FileService } from './fileService';
import { SettingsStore, isUsableRoot, SELF_TEST_SETTINGS_FILE } from './settings';
import { buildContextSummary } from './contextSummary';
import { COLLECT_STRATEGIES, collectReply } from './replyCollector';
import { ReturnPathService } from './returnPathService';

interface BootInfo {
  sessionPartition: string;
  userAgent: { original: string; effective: string; removed: string[] };
  uaConsistency: { ok: boolean; uaMajor: string | null; kernelMajor: string | null };
  versions: { electron: string | undefined; chromium: string | undefined; node: string };
}

interface Layout {
  editorBounds: { width: number; height: number };
  webBounds: { width: number; height: number };
  dividerX: number;
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
    input.layout.editorBounds.width >= 360 &&
    input.layout.webBounds.width >= 420 &&
    input.layout.dividerX === input.layout.editorBounds.width;
  add('D9', '左右分栏布局已计算且满足最小宽度', layoutOk, input.layout);

  /* ---- E) 通道名一致性（preload 在沙箱下无法 require shared，故用源码比对兜底）---- */
  // 主进程 → 渲染进程的单向通道（不需要 ipcMain.handle）
  //
  // ⚠️ 这份排除名单也必须与实现同步：新增一个「主进程 → 渲染进程」的通道时，
  // 只在 contract.ts 里加常量是**不够**的 —— 自检会误报"未注册 ipcMain 处理器"。
  // 判断依据：代码里只有 `webContents.send(CHANNELS.x)`、没有 `ipcMain.handle(CHANNELS.x)`。
  const oneWayChannels: string[] = [
    CHANNELS.setRootInternal,
    CHANNELS.rootChanged,
    CHANNELS.rootStale,
    CHANNELS.previewData,
    CHANNELS.diffData,
    CHANNELS.sidebarChanged,
    // 以下三个是后加的，漏在这里会让 E1/E2 误报（用户实测脚本报 missing 却查不到实现）：
    CHANNELS.chromeState,   // → webbar
    CHANNELS.activeDiff,    // → 预览面板
    CHANNELS.fileChanged,   // → 编辑器（落盘广播）
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
    /*
     * 必须把**三个 preload 一起扫**：现在有四个渲染进程，每个各有自己的窄桥
     *（editor / webbar / preview，以及 web 视图无 preload）。
     * 只扫 `preload.js` 会误报 —— 例如 `preview:active-diff` 属于**预览面板**的桥，
     * 编辑器 preload 里本来就不该出现它，缺了是正确的，断言却判成 FAIL。
     *
     * 通道名前缀也放宽到 `preview:`（此前只认 fs|ui|return，
     * 等于对 preview 侧的通道完全不做漂移检查）。
     */
    const preloadFiles = ['preload.js', 'previewPreload.js', 'webbarPreload.js'];
    const literals: string[] = [];
    const perFile: Record<string, string[]> = {};
    for (const f of preloadFiles) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
      const found = [...src.matchAll(/'((?:fs|ui|return|preview):[a-z-]+)'/g)].map((m) => m[1] as string);
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
    const js = fs.readFileSync(jsPath, 'utf8');
    const css = fs.readFileSync(path.join(rendererDir, 'style.css'), 'utf8');
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
    const elBlockMatch = /const el = \{([\s\S]*?)\n  \};/.exec(js);
    const elKeys = elBlockMatch
      ? [...(elBlockMatch[1] ?? '').matchAll(/(\w+):\s*document\.getElementById\('([^']+)'\)/g)].map((m) => ({
          key: m[1] as string,
          id: m[2] as string,
        }))
      : [];
    // 渲染进程里以 `el.xxx` 形式被真正用到、但没在结构体里声明的键
    const usedElProps = new Set([...js.matchAll(/\bel\.(\w+)\b/g)].map((m) => m[1] as string));
    const declaredKeys = new Set(elKeys.map((k) => k.key));
    const undeclaredElProps = [...usedElProps].filter((p) => !declaredKeys.has(p));
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
     * 本项目的按钮 id 与 el 键名有稳定对应（btn-copy-prompt → btnCopyPrompt），据此逐一对齐。
     */
    const htmlButtonIds = [...html.matchAll(/<button\s+id="([^"]+)"/g)].map((m) => m[1] as string);
    const toCamel = (s: string): string => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    const unboundButtons = htmlButtonIds.filter((id) => {
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
    const preloadJs = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
    const collectChain = {
      buttonInHtml: /id="btn-collect"/.test(html),
      inElStruct: elKeys.some((k) => k.key === 'btnCollect'),
      bound: /el\.btnCollect\.addEventListener\(/.test(js),
      callsBridge: /bridge\.collectReply\(/.test(js),
      channelInContract: Object.values(CHANNELS).includes('return:collect'),
      // 编译后渲染进程模块被重命名为 electron_1，因此用 [\w.]* 容忍别名前缀
      inPreload: /collectReply:\s*\([^)]*\)\s*=>\s*[\w.]*ipcRenderer\.invoke\(\s*CH\.collectReply\s*\)/.test(preloadJs),
      handlerInMain: fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8').includes('CHANNELS.collectReply'),
    };
    const chainOk = Object.values(collectChain).every(Boolean);
    add(
      'L6',
      '「采集回复」链路首尾相连（按钮→bridge→通道→preload→主进程）+ 4 套采集策略已就绪',
      chainOk && COLLECT_STRATEGIES.length >= 4,
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

      /*
       * L10：面板改为**只列文件**（2026-10-03）。
       * 原来这里断言"能渲染逐行 diff + 三类行样式"，那条路已经被否掉：
       * 差异一律内联渲染在左侧编辑器里（见 P 组），面板再画一份就成了重复呈现。
       */
      const listsFiles = /pv-file-row/.test(pvJs) && /pv-file-name/.test(pvJs) && /showDiffInEditor/.test(pvJs);
      const hasFileCss = /\.pv-file-name/.test(pvCss) && /\.pv-file-apply/.test(pvCss);
      const noInlineDiff = !/pv-line/.test(pvJs) && !/pv-hunk/.test(pvJs);
      add('L10', '预览面板：只罗列文件（不渲染逐行 diff）且有对应样式', listsFiles && hasFileCss && noInlineDiff, {
        listsFiles,
        hasFileCss,
        noInlineDiff,
      });

      // 面板通过独立 preload 暴露桥接口，且通道名与主进程一致
      const pvPreload = fs.readFileSync(path.join(__dirname, 'previewPreload.js'), 'utf8');
      const pvBridgeOk =
        /exposeInMainWorld\('previewBridge'/.test(pvPreload) &&
        pvPreload.includes("'return:apply'") &&
        pvPreload.includes("'preview:data'") &&
        pvPreload.includes("'ui:set-preview-panel'");
      add('L11', '预览面板：独立 preload 暴露 narrow bridge 且通道名正确', pvBridgeOk, {
        exposeInMainWorld: /exposeInMainWorld\('previewBridge'/.test(pvPreload),
      });
    } catch (err) {
      add('L8', '预览面板界面契约检查', false, `读取失败：${err instanceof Error ? err.message : String(err)}`);
    }

    /* ---- N) 网页区顶部工具条（webbar）契约 ----
     *
     * 为什么单列一组：网页/预览的显隐开关**只**存在于这个视图里。
     * 一旦它在 HTML/JS/preload 任一处对不上，用户就没有任何入口控制网页显隐，
     * 而这类问题在 tsc 与单测里都看不见（三个文件都不参与类型检查的相互引用）。
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

      // 图标按钮必须真的绑了事件，且样式定义了 .icon-btn 外观
      const wbBoundWeb = /el\.web\.addEventListener\(/.test(wbJs);
      const wbBoundPreview = /el\.preview\.addEventListener\(/.test(wbJs);
      const wbBoundRestore = /el\.restore\.addEventListener\(/.test(wbJs);
      const wbHasIconCss = /\.icon-btn/.test(wbCss) && /\.icon-btn\.active/.test(wbCss);
      add('N3', '网页区工具条：显隐按钮绑定了事件且有图标按钮样式', wbBoundWeb && wbBoundPreview && wbBoundRestore && wbHasIconCss, {
        boundWeb: wbBoundWeb,
        boundPreview: wbBoundPreview,
        boundRestore: wbBoundRestore,
        hasIconCss: wbHasIconCss,
      });

      // N5：网页隐藏后的**右边缘把手**必须存在（这是"能再展开"的唯一常驻入口）
      const hasHandleEl = /id="btn-restore"/.test(wbHtml) && /class="handle"/.test(wbHtml);
      const hasHandleCss =
        /\.webbar\.handle-mode/.test(wbCss) && /\.handle:hover/.test(wbCss) && /writing-mode:\s*vertical-rl/.test(wbCss);
      add('N5', '网页区工具条：具备右边缘把手形态（竖排 + hover 展开）', hasHandleEl && hasHandleCss, {
        hasHandleEl,
        hasHandleCss,
      });

      // N6：刚隐藏后要高亮提示 —— 否则 5px 窄条会被当成窗口边框忽略
      const hasHint = /just-hidden/.test(wbJs) && /just-hidden/.test(wbCss) && /HINT_MS/.test(wbJs);
      add('N6', '网页隐藏后有 3 秒高亮提示（just-hidden）', hasHint, { hasHint });

      // 独立 preload：窄接口 + 通道名与主进程一致
      const wbPreload = fs.readFileSync(path.join(__dirname, 'webbarPreload.js'), 'utf8');
      const wbBridgeOk =
        /exposeInMainWorld\('webbarBridge'/.test(wbPreload) &&
        wbPreload.includes("'ui:set-web-visible'") &&
        wbPreload.includes("'ui:set-preview-panel'") &&
        wbPreload.includes("'ui:chrome-state'");
      add('N4', '网页区工具条：独立 preload 暴露窄 bridge 且通道名正确', wbBridgeOk, {
        exposeInMainWorld: /exposeInMainWorld\('webbarBridge'/.test(wbPreload),
      });
    } catch (err) {
      add('N1', '网页区工具条界面契约检查', false, `读取失败：${err instanceof Error ? err.message : String(err)}`);
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
    const editorHead = /<div class="editor-head">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
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

    // O4：「复制提示词」按钮是药丸形且文案已更新（34px 圆形装不下五个字，必然折行）
    //
    // 判据不写死 17px/18px 这类具体数值 —— 调一次内边距或高度就会漂移。
    // 真正要保证的是**药丸的几何定义：圆角半径 ≥ 高度的一半**。
    const primaryRule = /\.prompt-bar button\.primary\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const btnH = Number(/height:\s*(\d+)px/.exec(primaryRule)?.[1] ?? 0);
    const radius = Number(/border-radius:\s*(\d+)px/.exec(primaryRule)?.[1] ?? 0);
    const pillStyle = btnH > 0 && radius >= btnH / 2;
    const copyBtnText = /id="btn-copy-prompt"[\s\S]{0,400}?>\s*([^<]+?)\s*</.exec(html)?.[1] ?? '';
    add('O4', '「复制提示词」为药丸形按钮且文案正确', pillStyle && copyBtnText === '复制提示词', {
      pillStyle,
      height: btnH || null,
      borderRadius: radius || null,
      buttonText: copyBtnText,
    });

    /*
     * O5：采集后**自动**进编辑器 diff —— 主进程里必须存在"采集即推 diffData"的调用。
     * 注意匹配编译产物：`CHANNELS` 在 tsc 输出里是 `contract_1.CHANNELS`，故只匹配尾部 `CHANNELS.diffData`。
     */
    const mainJs = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const autoDiff =
      /blocks\.find\(\(b\) => b\.applicable\)/.test(mainJs) &&
      /firstApplicable/.test(mainJs) &&
      /\.send\(\s*(?:contract_1\.)?CHANNELS\.diffData/.test(mainJs);
    add('O5', '采集成功后自动把第一个可应用变更送进编辑器 diff（无需手动点按钮）', autoDiff, {
      findsApplicable: /blocks\.find\(\(b\) => b\.applicable\)/.test(mainJs),
      hasFirstApplicable: /firstApplicable/.test(mainJs),
      sendsDiffData: /\.send\(\s*(?:contract_1\.)?CHANNELS\.diffData/.test(mainJs),
    });

    /*
     * O6：网页隐藏后**必须还能回来**（本项目已犯过一次这个错）。
     *
     * 早期实现把显隐开关放进网页区顶部工具条，网页隐藏时工具条跟着隐藏 ——
     * 用户点完就再也回不来。因此断言两条：
     *  1. 工具条视图在网页隐藏时**仍然 setVisible(true)**（变成右边缘把手）；
     *  2. 隐藏分支里 webBarBounds 的宽度**不为 0**（否则把手没有落脚处）。
     */
    const notAlwaysVisible = /webBarView\.setVisible\(webVisible\)/.test(mainJs);
    const alwaysVisible = /webBarView\.setVisible\(true\)/.test(mainJs);
    const handleBounds = /webBarBounds:\s*\{\s*x:\s*width - HANDLE_BAR_WIDTH/.test(mainJs);
    add('O6', '网页隐藏后工具条仍可见且把手几何有效（能再展开）', alwaysVisible && handleBounds && !notAlwaysVisible, {
      alwaysVisible,
      handleBounds,
      stillConditional: notAlwaysVisible,
    });

    // O7：View 菜单必须有「AI 网页」勾选项作为**兜底入口**（菜单永远不会被隐藏）
    const menuHasWebItem = /label:\s*'AI 网页'/.test(mainJs) && /type:\s*'checkbox'/.test(mainJs);
    const menuHasShortcut = /CmdOrCtrl\+Shift\+A/.test(mainJs);
    add('O7', 'View 菜单提供「AI 网页」勾选项与快捷键（兜底入口）', menuHasWebItem && menuHasShortcut, {
      menuHasWebItem,
      menuHasShortcut,
    });

    /* ---------------- P 组：内联 diff（差异与原文件整合显示）----------------
     *
     * 用户要求（2026-10-03）：diff **不要**左右并排成两个板块，而要整合在原文件上显示。
     * 这组断言把该形态固化下来，防止将来有人"顺手改回"DiffEditor：
     *  - P1 不再有第二个 Monaco 宿主（`monaco-diff` / `createDiffEditor` 全部消失）
     *  - P2 内联标记确实画在**同一个**编辑器上（decorations + view zone）
     *  - P3 预览期只读，且退出后恢复可编辑
     *  - P4 预览前校验编辑器内容与 original 一致（防止标记画在错误位置上）
     *  - P5 右下角面板不再渲染逐行 diff
     *  - P6 两个视图之间有高亮同步通道（跨进程，靠主进程转发）
     */
    const previewJs = fs.readFileSync(path.join(rendererDir, 'preview.js'), 'utf8');
    const previewPreloadJs = fs.readFileSync(path.join(__dirname, 'previewPreload.js'), 'utf8');
    const noSecondHost = !/id="monaco-diff"/.test(html) && !/createDiffEditor/.test(js);
    add('P1', '不再使用第二个 Monaco 宿主（无 monaco-diff / createDiffEditor）', noSecondHost, {
      hasMonacoDiffHost: /id="monaco-diff"/.test(html),
      hasCreateDiffEditor: /createDiffEditor/.test(js),
    });

    const inlineMechanism =
      /createDecorationsCollection/.test(js) &&
      /changeViewZones/.test(js) &&
      /inline-deleted/.test(js) &&
      /inline-added/.test(js);
    add('P2', '差异以行内标记叠加在原编辑器上（decoration + view zone）', inlineMechanism, {
      usesDecorations: /createDecorationsCollection/.test(js),
      usesViewZones: /changeViewZones/.test(js),
      marksDeleted: /inline-deleted/.test(js),
      marksAdded: /inline-added/.test(js),
    });

    const readOnlyWhenPreview = /updateOptions\(\{\s*readOnly:\s*true\s*\}\)/.test(js);
    const restoredOnExit = /updateOptions\(\{\s*readOnly:\s*false\s*\}\)/.test(js);
    add('P3', '预览期只读、退出后恢复可编辑', readOnlyWhenPreview && restoredOnExit, {
      readOnlyWhenPreview,
      restoredOnExit,
    });

    // 标记画在编辑器内容上，因此必须先确认内容就是 original，否则宁可不画
    const guardsContent = /model\.getValue\(\) !== original/.test(js);
    add('P4', '画标记前校验编辑器内容与 original 一致（防止标记错位）', guardsContent, {
      guardsContent,
    });

    const noHunkInPanel = !/renderHunk/.test(previewJs) && !/pv-hunk/.test(previewJs);
    add('P5', '右下角面板只列文件、不再渲染逐行 diff', noHunkInPanel, {
      stillRendersHunks: /renderHunk/.test(previewJs),
      stillHasHunkCss: /pv-hunk/.test(previewJs),
    });

    const highlightSync =
      /onActiveDiff/.test(previewJs) &&
      /activeDiff/.test(previewPreloadJs) &&
      /CHANNELS\.activeDiff/.test(mainJs);
    add('P6', '编辑器与右下角面板之间有高亮同步通道（跨进程经主进程转发）', highlightSync, {
      panelListens: /onActiveDiff/.test(previewJs),
      preloadExposes: /activeDiff/.test(previewPreloadJs),
      mainForwards: /CHANNELS\.activeDiff/.test(mainJs),
    });

    /* ---------------- Q 组：应用后刷新 / 全部应用 / 选区浮层 / 输入框观感 ----------------
     *
     * Q1 是本轮修的一个**真实缺陷**：落盘在主进程、编辑在另一个渲染进程，
     * `applyChange` 返回后没有任何广播，编辑器一直显示旧内容（用户实测：
     * "应用后没有及时刷新文件，只有关闭文件重新打开才会显示应用后的代码"）。
     * 这条断言防止将来把广播删掉、或只改一半（加了通道但没在 handler 里发）。
     */
    /*
     * 注意读的是**仓库里的 .ts 源码**，不是 __dirname 下的编译产物 ——
     * 自检运行时 __dirname 是 dist/main，那里只有 .js，没有 .ts。
     */
    const srcMainDir = path.join(__dirname, '..', '..', 'src', 'main');
    const mainTs = fs.readFileSync(path.join(srcMainDir, 'index.ts'), 'utf8');
    const preloadTs = fs.readFileSync(path.join(srcMainDir, 'preload.ts'), 'utf8');
    /* 通道名的权威定义在契约层，不在 index.ts */
    const contractTs = fs.readFileSync(path.join(srcMainDir, '..', 'shared', 'contract.ts'), 'utf8');
    const previewHtml = fs.readFileSync(path.join(rendererDir, 'preview.html'), 'utf8');
    // 网页区顶部工具条（webbar）：显隐开关的唯一常驻入口，单独读出来供 T1 断言
    const webbarHtml = fs.readFileSync(path.join(rendererDir, 'webbar.html'), 'utf8');
    const webbarJs = fs.readFileSync(path.join(rendererDir, 'webbar.js'), 'utf8');
    const hasFileChangedChannel = /fileChanged:\s*'fs:file-changed'/.test(contractTs);
    const notifiesOnApply = /notifyFileChanged\(filePath\)/.test(mainTs);
    const notifiesOnUndo = /notifyFileChanged\(result\.filePath\)/.test(mainTs);
    const editorListens = /onFileChanged/.test(js) && /onFileChanged/.test(preloadTs);
    add(
      'Q1',
      '落盘后广播 fileChanged、编辑器收到即重读（修复"应用后仍显示旧代码"）',
      hasFileChangedChannel && notifiesOnApply && notifiesOnUndo && editorListens,
      { hasFileChangedChannel, notifiesOnApply, notifiesOnUndo, editorListens },
    );

    /*
     * Q2：全部应用必须**顺序**执行 —— 每个变更单独做三向校验，
     * 校验基线是"读文件那一刻的原文"；并发会让两次写入基于同一份基线而互相覆盖。
     * 同时要求"单条失败不中断整体"（某个文件校验不过，其余仍应能应用）。
     */
    const appliesSequentially = /for \(let i = 0; i < blocks\.length; i \+= 1\)/.test(previewJs);
    const toleratesFailure = /failed\.push/.test(previewJs) && !/Promise\.all/.test(previewJs);
    const applyAllBound = /pv-apply-all/.test(previewJs) && /pv-apply-all/.test(previewHtml);
    add(
      'Q2',
      '「全部应用」存在且顺序执行、单条失败不中断（并发会破坏三向校验基线）',
      appliesSequentially && toleratesFailure && applyAllBound,
      { appliesSequentially, toleratesFailure, applyAllBound },
    );

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

    // R5：垂直方向的三处 flex 收缩许可。缺任一条，
    // 输入框撑高时编辑器不缩 → 底部被推出视口（用户实测"输入框底部有点溢出"）。
    const wrapAllowsShrink = /\.editor-wrap\s*\{[^}]*min-height:\s*0/.test(css);
    const promptBarAllowsShrink = /\.prompt-bar\s*\{[^}]*min-height:\s*0/.test(css);
    add(
      'R5',
      '编辑器容器与输入区允许在 flex 中收缩（输入框撑高不顶出视口）',
      wrapAllowsShrink && promptBarAllowsShrink,
      { wrapAllowsShrink, promptBarAllowsShrink },
    );

    // R6：**min-height: 0 必须配可收缩的 flex**。
    // 上一版写了 `flex: 0 0 auto` + `min-height: 0` —— 这是**无效组合**：
    // flex-shrink: 0 直接禁止收缩，min-height: 0 根本轮不到起作用，
    // 于是视口一紧张输入区就不缩，把底部边框顶出可视范围。
    // 现象很有欺骗性：「启动时底部溢出，拖一下窗口就恢复」——
    // 因为拖窗口触发了重排，而不是任何 JS 逻辑在起作用。
    const promptBarBlock = /\.prompt-bar\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    const promptBarShrinkable = /flex:\s*0\s+1\s+auto/.test(promptBarBlock);
    const promptBarNoHardZero = !/flex:\s*0\s+0\s+auto/.test(promptBarBlock);
    add(
      'R6',
      '输入区 flex 允许收缩（min-height:0 配flex-shrink:0 是无效组合）',
      promptBarShrinkable && promptBarNoHardZero,
      { promptBarShrinkable, promptBarNoHardZero },
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

    // T 组：显隐开关**只能有一套**，不允许出现功能重复的第二份入口。
    //
    // 背景（用户指出）：编辑器工具栏里有个「回程预览」文字按钮，网页区右上角
    // 又有一个分栏图标按钮，两者调的是**同一个** setPreviewPanel，
    // 连面板高度算法都逐行相同 —— 纯重复，且误导用户以为它们管的是两件事。
    // 已删掉工具栏那个，只保留网页区右上角的图标。
    //
    // 断言要点：预览开关在**编辑器页面里不应再出现**（连 DOM 都不能有）。
    const previewToggleInEditor = /btn-preview-toggle/.test(html) || /btnPreviewToggle/.test(js);
    // 网页区那个必须还在，且仍挂在 setPreviewPanel 上
    const previewToggleInWebbar = /btn-preview-toggle/.test(webbarHtml);
    const webbarWired = /setPreviewPanel/.test(webbarJs);
    add(
      'T1',
      '回程预览开关只有网页区右上角一处（编辑器里不再有重复按钮）',
      !previewToggleInEditor && previewToggleInWebbar && webbarWired,
      { previewToggleInEditor, previewToggleInWebbar, webbarWired },
    );

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
  const sampleReply = [
    '### src/demo.ts',
    '```ts',
    'export const demo = 1;',
    '```',
    '',
    '```py',
    '# other.py',
    'print("hi")',
    '```',
  ].join('\n');
  const parsed = parseModelReply(sampleReply);
  add('F1', '回程解析：标题式与注释式路径线索均被识别', parsed.blocks.length === 2 && parsed.blocks[0]?.filePath === 'src/demo.ts' && parsed.blocks[1]?.filePath === 'other.py', {
    sources: parsed.blocks.map((b) => `${b.filePath ?? '<null>'}:${b.pathSource}`),
  });
  add('F2', '回程解析：路径注释行已从代码中剥离', parsed.blocks[1]?.code === 'print("hi")', parsed.blocks[1]?.code);

  const spec = getFormatSpec('short');
  const specParsed = parseModelReply(['### 文件：src/x.ts', '```ts', 'const x = 1;', '```'].join('\n'));
  add('F3', '格式模板示例写法可被解析器识别（模板与解析器一致）', /### 文件：/.test(spec) && specParsed.blocks[0]?.filePath === 'src/x.ts', {
    specHead: spec.split('\n')[1],
    parsedPath: specParsed.blocks[0]?.filePath,
  });

  const appliedWhole = computeApply('old body', parsed.blocks[0]!, { kind: 'replace-whole-file' });
  add(
    'F4',
    '应用计算：整文件替换返回新文本与被替换内容（供撤销）',
    appliedWhole.ok && appliedWhole.text === 'export const demo = 1;' && appliedWhole.replaced === 'old body',
    appliedWhole.ok ? { text: appliedWhole.text, replaced: appliedWhole.replaced, mode: appliedWhole.mode } : appliedWhole
  );

  /* ---- J) 片段替换（带行号）与三向校验 ---- */
  const original = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
  const snippetBlock = parseModelReply(
    ['### 文件：src/a.ts', '### 范围：2-3', '```ts', 'NEW2', 'NEW3', '```'].join('\n')
  ).blocks[0]!;
  add('J1', '解析出片段替换的行区间', snippetBlock.range?.start === 2 && snippetBlock.range?.end === 3, snippetBlock.range);

  const okApply = computeApply(original, snippetBlock, {
    kind: 'replace-lines',
    start: 2,
    end: 3,
    expectedOriginal: 'line2\nline3',
    contextPrev: 'line1',
    contextNext: 'line4',
  });
  add('J2', '三向校验通过时按行替换', okApply.ok && okApply.text === ['line1', 'NEW2', 'NEW3', 'line4', 'line5'].join('\n'), okApply);

  const mismatch = computeApply(original, snippetBlock, {
    kind: 'replace-lines',
    start: 2,
    end: 3,
    expectedOriginal: 'OLD-DIFFERENT\nWHATEVER',
  });
  add('J3', '原内容不匹配时拒绝写入（防行号漂移改错地方）', !mismatch.ok && mismatch.reason === 'content-mismatch', mismatch);

  const outOfRange = computeApply(original, snippetBlock, {
    kind: 'replace-lines',
    start: 4,
    end: 99,
    expectedOriginal: 'line4\nline5',
  });
  add('J4', '区间越界时拒绝写入', !outOfRange.ok && outOfRange.reason === 'range-invalid', outOfRange);

  const ctxBad = computeApply(original, snippetBlock, {
    kind: 'replace-lines',
    start: 2,
    end: 3,
    expectedOriginal: 'line2\nline3',
    contextPrev: 'NOT-LINE1',
  });
  add('J5', '上下文不匹配时拒绝写入', !ctxBad.ok && ctxBad.reason === 'context-mismatch', ctxBad);

  const numbered = formatNumberedSnippet('alpha\nbeta\ngamma', 80);
  add('J6', '带行号片段格式化使用文件真实行号', numbered === ' 80| alpha\n 81| beta\n 82| gamma', numbered);
  add(
    'J7',
    '带行号片段可被剥离回纯文本（供写入前还原）',
    stripNumberedPrefix(numbered).text === 'alpha\nbeta\ngamma' && stripNumberedPrefix(numbered).startLine === 80,
    stripNumberedPrefix(numbered)
  );

  /* ---- M) 提示词片段组装：围栏自适应（防内容里的 ``` 提前闭合） ---- */
  const plainSnippet = buildSnippetText({ relPath: 'src/a.py', text: 'def f():\n    pass', startLine: 80 });
  add(
    'M1',
    '局部片段含路径行/行区间/语言标注/带行号内容',
    plainSnippet.text ===
      ['### 文件：src/a.py', '### 范围：80-81', '```python', ' 80| def f():', ' 81|     pass', '```'].join('\n'),
    plainSnippet.text
  );

  const nestedContent = '冒泡排序：\n```python\ndef bubble_sort(arr):\n    pass\n```';
  const nestedSnippet = buildSnippetText({ relPath: 'notes.md', text: nestedContent, startLine: 1 });
  add('M2', '内容含 ``` 时外层围栏自动加长为 ````（不提前闭合）', nestedSnippet.fence === '````' && nestedSnippet.text.includes('```python') && nestedSnippet.text.endsWith('\n````'), {
    fence: nestedSnippet.fence,
  });

  const whole = buildWholeFileText('src/a.ts', 'export const a = 1;');
  add(
    'M3',
    '整文件片段用「这个文件是」声明 + 围栏，且**不含 `### ` 标题行**（避免被回程解析器当作待应用代码块）',
    whole.text === ['这个文件是 src/a.ts', '', '```typescript', 'export const a = 1;', '```'].join('\n') && !/^### /m.test(whole.text),
    whole.text
  );

  const wholeNested = buildWholeFileText('notes.md', '# 标题\n\n```python\nprint(1)\n```');
  add('M4', '整文件片段同样按内容加长围栏', wholeNested.fence === '````' && wholeNested.text.includes('````markdown'), {
    fence: wholeNested.fence,
  });

  add('M5', '围栏长度取内容中最长反引号串 + 1（最少 3）', fenceFor('```\n`````\n```') === '``````' && fenceFor('用 `x` 调用') === '```', {
    longest: fenceFor('```\n`````\n```'),
    inline: fenceFor('用 `x` 调用'),
  });

  /* ---- K) 回程闭环：采集 → 解析 → 应用 → 撤销 ---- */
  // 用一个假的页面运行器验证采集器本身（不依赖真实站点）。
  // 注意：断言用**第一条策略的 id**，不要硬编码字符串 —— 策略改名时不会误报。
  const firstStrategyId = COLLECT_STRATEGIES[0]?.id ?? '';
  const fakeRunner = {
    evaluate: async (script: string): Promise<unknown> => {
      if (script === COLLECT_STRATEGIES[0]?.script) {
        return ['### 文件：src/greeting.ts\n```ts\nexport const hi = 1;\n```'];
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

  // 真实文件上的"应用 → 撤销"闭环（用样例目录里已有的 hello.ts）
  const rp = new ReturnPathService(input.fileService);
  const beforeAll = await input.fileService.readRawText('hello.ts');
  const originalText = beforeAll.ok ? beforeAll.text : '';
  add('K3a', '读取样例文件成功（闭环前置条件）', beforeAll.ok && originalText.length > 0, beforeAll.ok ? { chars: originalText.length } : beforeAll);

  const wholeBlock = parseModelReply(['### 文件：hello.ts', '```ts', 'export const hi = 2;', '```'].join('\n')).blocks[0]!;
  const applied = await rp.applyChange({ filePath: 'hello.ts', block: wholeBlock });
  add('K3', '整文件替换可应用并返回新文本', applied.ok && applied.after === 'export const hi = 2;', applied.ok ? { mode: applied.mode } : applied);

  const undone = await rp.undoLast();
  add('K4', '撤销按快照恢复原文', undone.ok && undone.filePath === 'hello.ts', undone);

  const afterUndo = await input.fileService.readRawText('hello.ts');
  add('K5', '撤销后文件内容确实回到应用前（逐字相同）', afterUndo.ok && afterUndo.text === originalText, afterUndo.ok ? { same: afterUndo.text === originalText } : afterUndo);

  // 片段替换：基线取自"读文件那一刻"，之后被改动则拒绝
  const firstLine = originalText.split(/\r\n|\r|\n/)[0] ?? '';
  const greetingSnippetBlock = parseModelReply(['### 文件：hello.ts', '### 范围：1-1', '```ts', 'export const hi = 99;', '```'].join('\n')).blocks[0]!;
  const snippetApplied = await rp.applyChange({ filePath: 'hello.ts', block: greetingSnippetBlock, expectedOriginal: firstLine });
  add('K6', '片段替换在基线一致时成功', snippetApplied.ok && snippetApplied.mode === 'replace-lines', snippetApplied.ok ? { mode: snippetApplied.mode } : snippetApplied);
  await rp.undoLast();

  const staleApplied = await rp.applyChange({ filePath: 'hello.ts', block: greetingSnippetBlock, expectedOriginal: '这行内容并不存在' });
  add('K7', '片段替换在基线不一致时拒绝写入（防行号漂移）', !staleApplied.ok && staleApplied.reason === 'content-mismatch', staleApplied);

  const afterReject = await input.fileService.readRawText('hello.ts');
  add('K8', '被拒绝的片段替换没有改动文件（拒绝即无副作用）', afterReject.ok && afterReject.text === originalText, afterReject.ok ? { same: afterReject.text === originalText } : afterReject);

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
    /## 用户需求/.test(assembled) && /## 工作环境/.test(assembled) && /## 目录结构/.test(assembled) && /【输出格式要求】/.test(assembled),
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
    const written = input.settings.update({ lastRoot: fixtures.root });
    add('G1', '设置可写入并读回（上次打开的目录）', written.lastRoot === fixtures.root, written);
    const reread = new SettingsStore(SELF_TEST_SETTINGS_FILE);
    add('G2', '设置可从磁盘重新加载（等价于重启后恢复）', reread.get().lastRoot === fixtures.root, reread.get());
    // 复原，避免自检污染设置
    input.settings.update({ lastRoot: before.lastRoot, editorWidth: before.editorWidth });
    const after = input.settings.get();
    add('G3', '自检结束后已复原原设置', after.lastRoot === before.lastRoot && after.editorWidth === before.editorWidth, after);

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
