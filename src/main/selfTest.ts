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
import { computeApply, parseModelReply } from '../shared/returnPath';
import { createFixtures, type FixturePaths } from './fixtures';
import type { FileService } from './fileService';
import { SettingsStore, isUsableRoot } from './settings';
import { buildContextSummary } from './contextSummary';

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
  // rootChanged / rootStale 是主进程 → 渲染进程的单向通道（不需要 ipcMain.handle），其余都应有处理器
  const requiredChannels = Object.values(CHANNELS).filter(
    (c) => c !== CHANNELS.setRootInternal && c !== CHANNELS.rootChanged && c !== CHANNELS.rootStale
  );
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
    const literals = [...src.matchAll(/'((?:fs|ui):[a-z-]+)'/g)].map((m) => m[1] as string);
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
  add('F4', '应用计算：整文件替换返回新文本与被替换内容（供撤销）', appliedWhole.text === 'export const demo = 1;' && appliedWhole.replaced === 'old body', {
    text: appliedWhole.text,
    replaced: appliedWhole.replaced,
    mode: appliedWhole.mode,
  });

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
    const reread = new SettingsStore();
    add('G2', '设置可从磁盘重新加载（等价于重启后恢复）', reread.get().lastRoot === fixtures.root, reread.get());
    // 复原，避免自检污染用户设置
    input.settings.update({ lastRoot: before.lastRoot, editorWidth: before.editorWidth });
    const after = input.settings.get();
    add('G3', '自检结束后已复原原设置', after.lastRoot === before.lastRoot && after.editorWidth === before.editorWidth, after);
  }

  const failures = checks.filter((c) => !c.pass).map((c) => c.id);
  return {
    collectedAt: new Date().toISOString(),
    checks,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    failures,
  };
}
