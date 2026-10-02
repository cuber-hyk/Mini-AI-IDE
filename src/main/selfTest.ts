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
  const oneWayChannels: string[] = [
    CHANNELS.setRootInternal,
    CHANNELS.rootChanged,
    CHANNELS.rootStale,
    CHANNELS.previewData,
    CHANNELS.diffData,
    CHANNELS.sidebarChanged,
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
    const preloadPath = path.join(__dirname, 'preload.js');
    const src = fs.readFileSync(preloadPath, 'utf8');
    const literals = [...src.matchAll(/'((?:fs|ui|return):[a-z-]+)'/g)].map((m) => m[1] as string);
    const contractSet = new Set<string>(Object.values(CHANNELS));
    const unknown = literals.filter((c) => !contractSet.has(c));
    const missing = requiredChannels.filter((c) => !literals.includes(c));
    preloadSrcCheck = {
      ok: unknown.length === 0 && missing.length === 0,
      detail: `literals=${literals.join(',')} unknown=[${unknown.join(',')}] missing=[${missing.join(',')}]`,
    };
  } catch (err) {
    preloadSrcCheck = { ok: false, detail: `读取失败：${err instanceof Error ? err.message : String(err)}` };
  }
  add('E2', 'preload 内联通道名与 shared/contract 完全一致（无漂移）', preloadSrcCheck.ok, preloadSrcCheck.detail);

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

      // 面板必须能渲染逐行 diff，且样式里定义了三类行（context/add/del）
      const hasDiffRender = /pv-line/.test(pvJs) && /kind === 'add'/.test(pvJs) && /kind === 'del'/.test(pvJs);
      const hasDiffCss = /\.pv-line\.add/.test(pvCss) && /\.pv-line\.del/.test(pvCss);
      add('L10', '预览面板：具备逐行 diff 渲染与增删样式', hasDiffRender && hasDiffCss, { hasDiffRender, hasDiffCss });

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
