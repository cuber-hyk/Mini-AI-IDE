/** 工具 owner 与 Electron 外壳的接线；不向网页提供任何桥或本地路径能力。 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { App, IpcMain, WebContents } from 'electron';
import { CHANNELS } from '../../shared/contract';
import { parseToolBatch, type ToolRequest, type ToolState, type ToolCollectionState } from '../../shared/toolProtocol';
import { TOOL_JSON_RESEND_INSTRUCTION } from '../../shared/toolJsonDiagnostic';
import { sessionKeyOf } from '../consumptionStore';
import { ComposerDraftBackup } from '../composerDraftBackup';
import type { FileService } from '../fileService';
import type { ReturnPathService } from '../returnPathService';
import type { WorkspaceController } from '../workspaceController';
import { SkillService } from '../skills';
import { ToolFiles, resolveToolPath } from './files';
import { AiTempDirectory } from './aiTempDirectory';
import { JsonDraft } from './jsonDraft';
import { ManualToolJson } from './manualToolJson';
import { ToolProcesses } from './processes';
import { ToolStore } from './store';
import { ToolHarness, type ToolSelection } from './harness';
import { ChangeReviewOwner, type ChangeReviewState } from './changeReview';
import { ToolChanges, checkBatchChanges, checkResolvedBatchChanges, projectAliases } from './changes';
import { AutoCollector } from './autoCollector';
import type { AutoReply } from './autoCollector';
import { ReplyMonitor, readAutoReply } from './replyObservation';
import { ReplyChangeWatcher } from './replyChangeWatcher';
import { ResultClipboard, formatToolResults } from './resultClipboard';
import { AutoContinuation } from './autoContinuation';
import { ToolAttachments } from './attachments';
import { ToolResultReturn } from './resultReturn';
import { WebResultSender } from './webResultSender';
import { traceCollection, traceScope, traceText } from './collectionTrace';
import type { PromptAttachmentData } from '../../shared/localPrompt';
import { webPlatformOf } from '../../shared/webConversation';
export { readAutoReply } from './replyObservation';

interface Options {
  ipc: Pick<IpcMain, 'handle'>; editor: WebContents; web: WebContents; files: FileService;
  returnPath: ReturnPathService; workspace: WorkspaceController; storePath: string; disabled: boolean;
  ask: (title: string, detail: string, buttons: string[], checkboxLabel?: string) => Promise<{ response: number; checkboxChecked: boolean }>;
  notifyFile: (relative: string, change: 'updated' | 'created' | 'deleted', discard: boolean) => void;
  copy: (text: string) => void;
  review?: WebContents;
  notifyReview?: (state: ChangeReviewState) => void;
  settingsChanged?: () => void;
  notifyState?: (state: ToolState) => void;
  sender?: Pick<WebResultSender, 'send' | 'cancel' | 'dispose'>;
  allowLocalFixture?: boolean;
  skills?: SkillService;
  interactionBusy?: () => boolean;
  ledgerSession?: (web: WebContents, session: string) => string;
}
const READ_TOOLS = new Set(['get_project_info', 'list_directory', 'search_files', 'read_file', 'search_text']);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, target: string) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };

/** 只识别完整字面路径；展开、转义、拼接或嵌套 shell 不猜测，只允许当次批准。 */
function scriptReferences(command: string): { paths: string[]; reliable: boolean } {
  const paths: string[] = []; let reliable = !/[$`*?\[\]{}()]|\\\s|\\['"]/.test(command);
  const tokens = [...command.matchAll(/'[^']*'|"[^"]*"|[^\s'"|&;()<>]+/g)];
  let end = 0;
  for (const token of tokens) {
    const start = token.index!;
    if (/[^\s|&;()<>]/.test(command.slice(end, start)) || (start === end && end > 0)) reliable = false;
    end = start + token[0].length;
    const value = /^['"]/.test(token[0]) ? token[0].slice(1, -1) : token[0];
    if (value.includes('=')) reliable = false;
    if (/^(?:\+|-join|-f|-c|\/c|-command|-encodedcommand|eval|invoke-expression|iex)$/i.test(value)) reliable = false;
    if (/\.(?:[cm]?js|[cm]?ts|ps1|sh|py)$/i.test(value)) {
      if (/^[~-]|=/.test(value) || /^[^/\\]+:/.test(value) && !/^[a-z]:[/\\]/i.test(value)) reliable = false;
      else paths.push(value);
    } else if (/\.(?:[cm]?js|[cm]?ts|ps1|sh|py)\b/i.test(value)) reliable = false;
  }
  if (/[^\s|&;()<>]/.test(command.slice(end))) reliable = false;
  return { paths, reliable };
}

/** 主进程保持存活，等所属命令停止完成再退出，避免清理刚启动就被 app.quit 中断。 */
export function registerToolShutdown(application: Pick<App, 'on' | 'quit'>, approve: () => Promise<boolean>, dispose: () => Promise<void>, failed: (error: unknown) => void): void {
  let pending = false; let approved = false;
  application.on('before-quit', event => {
    if (approved) return;
    event.preventDefault(); if (pending) return; pending = true;
    void (async () => {
      let allowed: boolean;
      try { allowed = await approve(); }
      catch (error) { pending = false; failed(error); return; }
      if (!allowed) { pending = false; return; }
      await dispose().catch(failed);
      approved = true; application.quit();
    })();
  });
}

/** 授权绑定实际目标与命令/项目脚本，而不是可变的友好名字。 */
export async function describeTool(root: string, request: ToolRequest): Promise<{ external: boolean; fingerprint: string; canRemember: boolean }> {
  if (request.tool === 'load_skill') return { external: false, fingerprint: hash(JSON.stringify(request)), canRemember: false };
  const actualRoot = await resolveToolPath(root, '.');
  const targets: string[] = [];
  if (READ_TOOLS.has(request.tool) && request.tool !== 'get_project_info') targets.push(await resolveToolPath(root, request.args.path as string | undefined));
  if (request.tool === 'get_ai_temp_dir') targets.push(await resolveToolPath(root, path.join('.mini-ai-ide', 'ai-temp', request.args.task_id as string)));
  if (request.tool === 'attach_file') targets.push(await resolveToolPath(root, request.args.path as string));
  if (request.tool === 'run_command') targets.push(await resolveToolPath(root, request.args.cwd as string | undefined));
  if (request.tool === 'apply_changes') for (const c of request.args.changes as Array<{ path: string }>) targets.push(await resolveToolPath(root, c.path));
  const parts = [actualRoot, JSON.stringify(request.args), request.tool, ...targets];
  if (request.tool === 'attach_file') {
    const stat = await fs.stat(targets[0]!);
    parts.push(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
  }
  let canRemember = true;
  if (request.tool === 'run_command') {
    // package scripts、锁文件和命令中明确引用的本地脚本改变后，精确规则失效。
    const cwd = targets[0]!;
    const direct = scriptReferences(String(request.args.command)); canRemember = direct.reliable;
    const referenced = direct.paths.map(name => ({ directory: cwd, name }));
    // npm 等可向上查找 package.json；指纹涵盖工作目录到项目根的配置。
    for (let directory = cwd; inside(actualRoot, directory); directory = path.dirname(directory)) {
      for (const name of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
        const p = await resolveToolPath(directory, name);
        if (!inside(actualRoot, p)) { parts.push(p, 'external-config'); canRemember = false; continue; }
        try {
          const stat = await fs.stat(p); if (stat.size > 2_000_000) throw new Error('执行配置过大，不能保存该命令授权');
          const text = await fs.readFile(p, 'utf8'); parts.push(p, hash(text));
          if (name === 'package.json') {
            let pkg: { scripts?: Record<string, unknown> };
            try { pkg = JSON.parse(text); } catch { canRemember = false; continue; }
            if (!pkg || typeof pkg !== 'object' || pkg.scripts !== undefined && (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts))) { canRemember = false; continue; }
            for (const script of Object.values(pkg.scripts ?? {})) {
              if (typeof script !== 'string') { canRemember = false; continue; }
              const parsed = scriptReferences(script); canRemember &&= parsed.reliable;
              referenced.push(...parsed.paths.map(name => ({ directory, name })));
            }
          }
        } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; parts.push(p, 'missing'); }
      }
      if (directory === actualRoot) break;
    }
    if (!inside(actualRoot, cwd) || referenced.length > 100) canRemember = false;
    const resolved = new Set<string>();
    for (const { directory, name } of referenced.slice(0, 100)) {
      const p = await resolveToolPath(directory, name);
      if (resolved.has(p)) continue; resolved.add(p);
      // 未授权外部脚本不能在权限检查时读取；其存在使此规则仅当次有效。
      if (!inside(actualRoot, p)) { parts.push('external-script', p); canRemember = false; continue; }
      try { const stat = await fs.stat(p); if (stat.size > 2_000_000) throw new Error('脚本过大，不能保存该命令授权'); parts.push(p, hash(await fs.readFile(p))); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; parts.push(p, 'missing'); }
    }
  }
  return { external: targets.some(p => !inside(actualRoot, p)), fingerprint: hash(parts.join('\0')), canRemember };
}

export async function createToolIntegration(options: Options) {
  let web = options.web;
  const store = new ToolStore(options.storePath);
  try { await store.ready(); }
  catch (error) {
    // 工具状态失败只停用工具；ready 仍拒绝，所有写操作继续受原门槛保护。
    process.stderr.write(`[tools] 工具记录加载失败，工具已停用：${error instanceof Error ? error.message : String(error)}\n`);
  }
  const fileTools = new ToolFiles();
  const aiTempDirectory = new AiTempDirectory();
  const jsonDraft = new JsonDraft();
  const skills = options.skills ?? new SkillService();
  let disposed = false; let revision = 0; let webActive = true;
  let automaticSuspended = false;
  let harness: ToolHarness;
  let continuation: AutoContinuation | undefined;
  let resultReturn: ToolResultReturn | undefined;
  let watcherHealth: ToolCollectionState = { phase: 'off', message: '自动采集已关闭' };
  let collectorHealth: ToolCollectionState = { phase: 'watching', reason: 'baseline', message: '自动采集等待新回复' };
  const collectionState = (): ToolCollectionState => ({ ...(watcherHealth.phase === 'watching' && !(watcherHealth.reason === 'source-state-lost' && collectorHealth.reason === 'baseline') ? collectorHealth : watcherHealth) });
  let activeSelection: ToolSelection | null = null;
  const draftScope = () => JSON.stringify([options.files.getRoot(), sessionKeyOf(web.getURL()), webPlatformOf(web.getURL()), revision]);
  const recoveryValid = () => {
    const origin = activeSelection?.recovered;
    return !origin || jsonDraft.matchesRecovery(options.files.getRoot(), sessionKeyOf(web.getURL()), draftScope(), origin);
  };
  const selectionRevisions = new WeakMap<ToolSelection, number>();
  const selectionNavigations = new WeakMap<ToolSelection, number>();
  let navigationRevision = 0;
  const navigating = (event: { isMainFrame: boolean }) => { if (event.isMainFrame) navigationRevision++; };
  const inPage = (_event: unknown, _url: string, main: boolean) => { if (main) navigationRevision++; };
  const destroyed = () => { navigationRevision++; };
  const bindNavigationGuard = () => { web.on('did-start-navigation', navigating); web.on('did-navigate-in-page', inPage); web.on('destroyed', destroyed); };
  const unbindNavigationGuard = () => { web.removeListener('did-start-navigation', navigating); web.removeListener('did-navigate-in-page', inPage); web.removeListener('destroyed', destroyed); };
  bindNavigationGuard();
  const toolAttachments = new ToolAttachments();
  const draftBackup = new ComposerDraftBackup();
  const createSender = (target: typeof web) => new WebResultSender(target, { backupDraft: (text, session) => draftBackup.save(options.files.getRoot() ?? '', session, text) });
  let sender = options.sender ?? createSender(web);
  let localPromptTransport: Promise<unknown> | undefined;
  let retainedCopy: { root: string | null; results: ToolState['results']; batchError?: ToolState['batchError']; source?: 'manual' } | null = null;
  const review = new ChangeReviewOwner(options.notifyReview);
  const reviewTokens = new WeakMap<ToolSelection, number>();
  const clipboard = new ResultClipboard(options.copy);
  const processes = new ToolProcesses(() => {
    if (!disposed && harness) harness.refreshProcesses();
  });
  const displayState = (state: ToolState): ToolState => {
    if (!retainedCopy || retainedCopy.root !== options.files.getRoot() || state.results.length || state.batchError || state.busy) return state;
    return { ...state, results: structuredClone(retainedCopy.results), ...(retainedCopy.batchError ? { batchError: { ...retainedCopy.batchError } } : {}), ...(retainedCopy.source ? { source: retainedCopy.source } : {}), message: '已切换官网平台；上一批结果保留，仅供复制' };
  };
  const broadcast = (state: ToolState) => {
    if (disposed) return;
    const notification = clipboard.notification(state, harness.getDiagnostic());
    const current: ToolState = { ...displayState(state), canUndo: changes.canUndo, hasRunningProcesses: processes.hasRunning,
      ...(notification ? { clipboard: notification } : {}), ...(continuation ? { continuation: continuation.getState() } : {}),
      ...(resultReturn ? { resultReturn: resultReturn.getState({ root: options.files.getRoot(), session: sessionKeyOf(web.getURL()), state, recoveryValid: recoveryValid() }) } : {}), collection: collectionState() };
    if (!options.editor.isDestroyed()) options.editor.send(CHANNELS.toolState, current);
    options.notifyState?.(current);
  };
  const publish = (state: ToolState) => {
    traceCollection('integration.publish', { busy: state.busy, completion: state.completion ? { id: state.completion.id, cancelled: state.completion.cancelled } : null,
      resultCount: state.results.length, resultStatuses: state.results.map(result => ({ id: result.request_id, status: result.status })), batchError: state.batchError ?? null,
      automatic: state.config.automatic, suspended: automaticSuspended });
    review.updateResults(state.results);
    auto.setEnabled(webActive && !options.disabled && !automaticSuspended && state.config.automatic);
    watcher.setEnabled(webActive && !options.disabled && !automaticSuspended && state.config.automatic);
    if (!disposed) clipboard.complete(state);
    continuation?.observe({ root: options.files.getRoot(), session: sessionKeyOf(web.getURL()), diagnostic: harness.getDiagnostic(), state: !webActive || options.disabled || automaticSuspended ? { ...state, config: { ...state.config, automatic: false } } : state });
    broadcast(state);
    options.settingsChanged?.();
  };
  const approveDirty = async (relative: string): Promise<boolean> => {
    const policy = harness.getState().config.dirtyPolicy;
    if (policy !== 'ask') return policy === 'continue';
    const choice = await options.ask('目标文件有未保存内容', `${relative}\n继续：采用 AI 基于磁盘原文生成的内容，替换未保存草稿。\n停止：保留磁盘文件和未保存草稿。`, ['继续应用 AI 修改', '停止修改'], '以后遇到相同情况采用本次选择');
    if (choice.checkboxChecked) await harness.configure({ dirtyPolicy: choice.response === 0 ? 'continue' : 'stop' });
    return choice.response === 0;
  };
  const changes = new ToolChanges(options.files, options.returnPath, rel => options.workspace.editor.isDirty(rel), approveDirty, options.notifyFile,
    () => options.workspace.editor.current.documents.map(d => d.path), (event, token) => review.record(token, event));
  let changeSession = sessionKeyOf(web.getURL());
  const synchronizeChangeSession = () => {
    const current = sessionKeyOf(web.getURL());
    if (current !== changeSession) { changes.reset(); jsonDraft.invalidate(); changeSession = current; }
  };
  const readOptions = { allowLocalFixture: options.allowLocalFixture === true };
  let monitor = new ReplyMonitor(web, readOptions);
  const collectReply = async (text: string, guard: () => boolean = () => true, manual = false): Promise<void> => {
    const parsed = parseToolBatch(text);
    const root = options.files.getRoot();
    const session = sessionKeyOf(web.getURL());
    const capturedRevision = revision;
    const current = () => guard() && webActive && !disposed && capturedRevision === revision &&
      root === options.files.getRoot() && session === sessionKeyOf(web.getURL());
    if (harness.getState().source === 'manual' && (harness.getState().busy || processes.hasRunning)) return;
    if (parsed.kind === 'repair') {
      if (manual) {
        const latest = await readAutoReply(web, readOptions);
        if (!current() || latest.url !== session || latest.completion !== 'complete' || latest.text !== text) {
          harness.report('当前补丁不是官网最新已完成回复，禁止执行历史补丁');
          return;
        }
      }
      if (!current()) return;
      const outcome = jsonDraft.apply(root, session, draftScope(), text, parsed.patch);
      if (outcome.kind === 'batch') await harness.collectRecovered(outcome.batch, outcome.origin);
      else harness.reportDiagnostic(text, outcome.error, 'repair');
      return;
    }
    if (!current()) return;
    if (parsed.kind === 'error' && parsed.jsonBody !== undefined) {
      const metadata = jsonDraft.capture(root, session, draftScope(), text, parsed.jsonBody);
      await harness.collect(text, metadata ? JsonDraft.instruction(metadata) : `草稿超过内存限制或当前无项目，无法局部修复。${TOOL_JSON_RESEND_INSTRUCTION}`);
      return;
    }
    if (parsed.kind === 'error' && parsed.repairAttempt) {
      const metadata = jsonDraft.current(root, session, draftScope());
      await harness.collect(text, metadata ? JsonDraft.instruction(metadata) : undefined);
      return;
    }
    jsonDraft.invalidate();
    await harness.collect(text);
  };
  const auto = new AutoCollector(() => monitor.read(), async (text, current, sourceKey, sourceSession) => {
    // 封存实际接纳的完成正文（包括已见生成后的 idle），节点复用不能继承执行资格。
    if (!webActive || disposed || !current()) return;
    const collectionRevision = revision;
    const collectionNavigation = navigationRevision;
    const root = options.files.getRoot(); const session = sessionKeyOf(web.getURL());
    if (sourceSession !== session) return;
    if (!sourceKey) { auto.sourceChanged(); return; }
    const accepted = await watcher.acknowledge(false, sourceKey);
    const allowed = webActive && !disposed && current() && revision === collectionRevision && navigationRevision === collectionNavigation && root === options.files.getRoot() && session === sessionKeyOf(web.getURL());
    if (!allowed) return;
    if (!accepted) {
      auto.sourceChanged();
      return;
    }
    traceCollection('integration.collect-check', { allowed, root: root ? traceText(root) : null, session: traceScope(session), text: traceText(text) });
    if (allowed) {
      await collectReply(text, current);
      traceCollection('integration.collect-returned', { root: root ? traceText(root) : null, session: traceScope(session), text: traceText(text) });
    }
  }, message => harness.report(message), health => {
    collectorHealth = health;
    traceCollection('integration.collection-health', { ...health });
    if (!disposed) broadcast(harness.getState());
  });
  const createWatcher = () => new ReplyChangeWatcher(web, userTurn => {
    if (!webActive || disposed) return Promise.resolve();
    traceCollection('integration.watcher-change', { userTurn, session: traceScope(web.getURL()) });
    if (userTurn) { continuation?.userTurn(); toolAttachments.reset(); resultReturn?.invalidate(); void sender.cancel('results'); }
    return auto.tick();
  }, (preserve = false, awaitHistory = false, generated = false) => {
    traceCollection('integration.watcher-baseline', { preserve, awaitHistory, generated, session: traceScope(web.getURL()) });
    continuation?.reset({ root: options.files.getRoot(), session: sessionKeyOf(web.getURL()) });
    if (generated) auto.observeGeneration(sessionKeyOf(web.getURL()));
    else if (preserve) auto.continueAt(sessionKeyOf(web.getURL())); else auto.reset(awaitHistory);
    synchronizeChangeSession(); harness.getState();
  }, message => harness.report(message), session => continuation?.reset({ root: options.files.getRoot(), session }), {
    ...readOptions, health: health => {
      watcherHealth = health;
      traceCollection('integration.watch-health', { ...health });
      if (!disposed) broadcast(harness.getState());
    },
  });
  let watcher = createWatcher();
  harness = new ToolHarness({ store, root: () => options.files.getRoot(), session: () => sessionKeyOf(web.getURL()),
    ledgerSession: session => options.ledgerSession?.(web, session) ?? session,
    current: selection => webActive && !disposed && selectionRevisions.get(selection) === revision &&
      (selection.source !== 'manual' || selectionNavigations.get(selection) === navigationRevision),
    selected: selection => {
      continuation?.reset({ root: options.files.getRoot(), session: sessionKeyOf(web.getURL()) });
      activeSelection = selection;
      if (selection) { retainedCopy = null; selectionRevisions.set(selection, revision); selectionNavigations.set(selection, navigationRevision); }
      toolAttachments.begin(selection); resultReturn?.begin(selection ? { kind: 'batch', selection } : null);
      synchronizeChangeSession();
      if (!selection) { review.clear(); return; }
      reviewTokens.set(selection, review.begin({ root: selection.root, session: selection.session,
        batchId: selection.batch.batch_id, contentKey: hash(JSON.stringify(selection.batch)) }, selection.batch));
    },
    diagnosed: diagnostic => { retainedCopy = null; resultReturn?.begin({ kind: 'diagnostic', diagnostic }); clipboard.diagnose(harness.getState(), diagnostic); },
    stopped: (selection, error) => review.stop(reviewTokens.get(selection), error),
    describe: async (root, request) => {
      if (!webActive || disposed || activeSelection && selectionRevisions.get(activeSelection) !== revision) throw new Error('当前网页平台不可执行工具');
      if (request.tool === 'attach_file' && activeSelection?.source === 'manual') throw new Error('手动 JSON 批次不向官网回传，附件未读取或上传');
      return describeTool(root, request);
    }, snapshotProcess: id => processes.snapshot(id), prepare: async (root, batch) => {
      if (!webActive || disposed) throw new Error('当前网页平台不可执行工具');
      checkBatchChanges(root, batch); await checkResolvedBatchChanges(root, batch);
    },
    authorize: async (root, request) => {
      const selectedRevision = revision;
      if (!webActive || disposed) throw new Error('当前网页平台不可批准工具');
      const targets = await describeTool(root, request);
      if (!webActive || disposed || revision !== selectedRevision) throw new Error('网页平台已切换，工具未批准');
      const platformName = webPlatformOf(web.getURL()) === 'chatgpt' ? 'ChatGPT' : 'DeepSeek';
      const choice = await options.ask('工具请求需要批准', `项目：${root}\n工具：${request.tool}\n${targets.external ? '包含项目外目标\n' : ''}${request.tool === 'attach_file' ? `批准后文件将作为附件上传到当前 ${platformName} 官网会话；自动继续关闭时等待手动发送。\n` : ''}${request.tool === 'run_command' ? '命令可访问当前账户的文件与网络；工作目录不构成沙箱。\n' : ''}实际参数：\n${JSON.stringify(request.args, null, 2)}`, targets.canRemember ? ['允许一次', '记住本项目的精确请求', '拒绝'] : ['允许一次', '拒绝']);
      if (!webActive || disposed || revision !== selectedRevision) throw new Error('网页平台已切换，工具未批准');
      return choice.response === 0 ? 'once' : targets.canRemember && choice.response === 1 ? 'remember' : 'deny';
    },
    execute: async (root, request, started, selection) => {
      if (!webActive || disposed || selectionRevisions.get(selection) !== revision) throw new Error('网页平台已切换，工具未启动');
      if (request.tool === 'attach_file') {
        if (selection.source === 'manual') throw new Error('手动 JSON 批次不向官网回传，附件未读取或上传');
        const selectedRevision = revision;
        return toolAttachments.stage(root, request.args.path as string, () => webActive && !disposed && revision === selectedRevision && activeSelection === selection && root === options.files.getRoot() && selection.session === sessionKeyOf(web.getURL()));
      }
      if (request.tool === 'load_skill') return skills.load(root, request.args.name as string);
      if (request.tool === 'get_ai_temp_dir') return aiTempDirectory.ensure(root, request.args.task_id as string);
      if (request.tool === 'apply_changes') return options.workspace.run(() => {
        if (!webActive || disposed || selectionRevisions.get(selection) !== revision || selection.session !== sessionKeyOf(web.getURL())) throw new Error('平台或会话已切换，未启动文件修改');
        return changes.execute(root, request, reviewTokens.get(selection));
      });
      if (['run_command', 'get_process_output', 'stop_process'].includes(request.tool)) return processes.execute(root, request.tool, request.args, started);
      return fileTools.execute(root, request.tool, request.args);
    }, changed: publish,
  });
  const getState = (): ToolState => {
    synchronizeChangeSession();
    const state = harness.getState();
    const notification = clipboard.notification(state, harness.getDiagnostic());
    return { ...displayState(state), canUndo: changes.canUndo, hasRunningProcesses: processes.hasRunning, ...(notification ? { clipboard: notification } : {}), ...(continuation ? { continuation: continuation.getState() } : {}), ...(resultReturn ? { resultReturn: resultReturn.getState({ root: options.files.getRoot(), session: sessionKeyOf(web.getURL()), state, recoveryValid: recoveryValid() }) } : {}), collection: collectionState() };
  };
  resultReturn = new ToolResultReturn({
    current: () => ({ root: options.files.getRoot(), session: sessionKeyOf(web.getURL()), state: harness.getState(), diagnostic: harness.getDiagnostic(), recoveryValid: recoveryValid() }),
    changed: () => broadcast(getState()),
    attachments: state => toolAttachments.resolve(state.results),
    send: (text, session, current, files) => webActive && !disposed && current()
      ? sender.send(text, session, 'results', () => webActive && !disposed && current(), files)
      : Promise.resolve({ ok: false, error: '当前网页平台不可发送工具结果' }),
    verify: async (_text, session, current, source) => {
      if (!webActive || disposed || !current()) return { ok: false, error: '当前网页平台不可发送工具结果' };
      // 新输出可先执行；回传先等本地主动需求的运输结束，再核验当前批次。
      // 前一需求失败由其调用方报告；这里只等待互斥释放，不推断成功。
      if (localPromptTransport) await localPromptTransport.catch(error => traceCollection('integration.local-prompt-wait-error', { error: error instanceof Error ? error.message : String(error) }));
      if (!webActive || disposed || !current()) return { ok: false, error: '本批发送已取消' };
      const reply = await readAutoReply(web, readOptions);
      if (!webActive || disposed || !current()) return { ok: false, error: '本批发送已取消' };
      if (reply.url !== session) return { ok: false, error: '网页会话已变化，未发送旧工具结果' };
      if (reply.completion !== 'complete') return { ok: false,
        error: reply.completion === 'generating' ? '网页仍在生成，未发送工具结果' : reply.completion === 'interrupted' ? '网页生成已中断，未发送工具结果' : '无法确认网页回复结束，未发送工具结果',
        ...(reply.completion !== 'interrupted' ? { retryable: true as const, transportStarted: false, stage: 'preflight' as const } : {}) };
      const parsed = parseToolBatch(reply.text);
      if (source.kind === 'diagnostic') {
        const matchesSource = reply.text === source.diagnostic.sourceText;
        const matchesError = parsed.kind === 'error' && source.diagnostic.sourceKind !== 'repair' &&
          source.diagnostic.error.error.startsWith(parsed.error);
        const matchesPatch = parsed.kind === 'repair' && source.diagnostic.sourceKind === 'repair';
        if (!matchesSource || !(matchesError || matchesPatch))
          return { ok: false, error: '网页最新回复已变化，未发送旧解析诊断' };
      } else if (source.selection.recovered) {
        const origin = source.selection.recovered;
        if (parsed.kind !== 'repair' || reply.text !== origin.patchSourceText ||
            hash(reply.text) !== origin.patchHash || hash(JSON.stringify(source.selection.batch)) !== origin.batchHash ||
            parsed.patch.draft_id !== origin.draft_id || parsed.patch.version + 1 !== origin.version ||
            origin.scope !== draftScope() || !harness.matchesRecovered(origin) ||
            !harness.matchesBatch(source.selection.batch) ||
            !jsonDraft.matchesRecovery(options.files.getRoot(), sessionKeyOf(web.getURL()), draftScope(), origin))
          return { ok: false, error: '恢复来源、官网最新补丁、修订版本或执行批次不一致，未发送旧工具结果' };
      } else if (parsed.kind !== 'batch' || !harness.matchesBatch(parsed.batch)) return { ok: false, error: '网页最新回复已变化，未发送旧工具结果' };
      return { ok: true };
    },
  });
  continuation = new AutoContinuation({
    current: () => ({ root: options.files.getRoot(), session: sessionKeyOf(web.getURL()), state: getState(), diagnostic: harness.getDiagnostic() }),
    cancelSend: () => sender.cancel('results'),
    changed: () => broadcast(getState()),
    send: async (text, session, current) => {
      return resultReturn!.send('automatic', () => {
        const state = harness.getState();
        return current() && webActive && !disposed && !options.disabled && !automaticSuspended && sessionKeyOf(web.getURL()) === session && formatToolResults(state.results, state.batchError) === text;
      });
    },
  });
  const channels: string[] = [];
  const manualToolJson = new ManualToolJson(() => {
    const state = harness.getState();
    const busy = state.busy || processes.hasRunning || !!localPromptTransport || options.interactionBusy?.() ||
      continuation?.getState().phase === 'sending' || continuation?.getState().phase === 'countdown' ||
      resultReturn?.getState({ root: options.files.getRoot(), session: sessionKeyOf(web.getURL()), state }).phase === 'sending';
    return { project: options.files.getRoot(),
      ...(options.disabled ? { error: '当前运行模式不支持手动执行工具 JSON' } : disposed || !webActive ? { error: '当前上下文正在切换或已经关闭，请稍后执行' } :
        store.getLoadError() ? { error: '工具记录不可用，未执行：' + store.getLoadError() } :
        busy ? { error: '工具、后台命令或发送正在处理，请等待当前操作结束' } : {}) };
  }, async batch => {
    jsonDraft.invalidate(); toolAttachments.reset(); resultReturn?.begin(null);
    continuation?.reset({ root: options.files.getRoot(), session: sessionKeyOf(web.getURL()) });
    await harness.collectManual(batch);
  }, (sourceText, error) => {
    jsonDraft.invalidate(); toolAttachments.reset(); resultReturn?.begin(null);
    continuation?.reset({ root: options.files.getRoot(), session: sessionKeyOf(web.getURL()) });
    harness.reportManualDiagnostic(sourceText, error);
  });
  const register = (channel: string, action: (...args: unknown[]) => unknown, count: number) => {
    options.ipc.handle(channel, (event, ...args: unknown[]) => {
      if (event.sender !== options.editor || event.senderFrame !== options.editor.mainFrame) throw new Error('工具控制仅供本地编辑器主 frame 使用');
      if (args.length !== count) throw new Error('工具控制参数数量无效');
      return action(...args);
    }); channels.push(channel);
  };
  register(CHANNELS.getToolState, getState, 0);
  register(CHANNELS.executeToolJson, text => manualToolJson.run(text), 1);
  register(CHANNELS.sendToolResults, () => resultReturn!.send('manual', () => webActive && !disposed && !options.disabled), 0);
  const configure = async (config: unknown) => {
    if (config && typeof config === 'object' && (config as { automatic?: unknown }).automatic === true && !harness.getState().config.automatic) await sender.cancel('results');
    if (config && typeof config === 'object' && !Array.isArray(config) && (config as { automatic?: unknown }).automatic === false) {
      // 关闭先取消计时与等待发送，不等配置写盘，也不取消本地正在执行的工具。
      automaticSuspended = true; publish(harness.getState());
    }
    await harness.configure(config);
    if (config && typeof config === 'object' && (config as { automatic?: unknown }).automatic === true) automaticSuspended = false;
    publish(harness.getState()); return getState();
  };
  register(CHANNELS.setToolConfig, configure, 1);
  register(CHANNELS.copyToolResults, () => {
    const visible = displayState(harness.getState());
    const results = visible.results;
    const batchError = visible.batchError;
    if (!results.length && !batchError) return { ok: false, error: '没有本项目当前会话的工具批次可复制' };
    options.copy(formatToolResults(results, batchError)); return { ok: true };
  }, 0);
  register(CHANNELS.cancelTools, async () => { revision++; jsonDraft.invalidate(); toolAttachments.reset(); resultReturn?.begin(null); harness.cancel(); await sender.cancel('results'); await processes.dispose(); return getState(); }, 0);
  register(CHANNELS.stopToolCommand, async target => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('命令目标无效');
    const fields = target as Record<string, unknown>;
    if (Object.keys(fields).length !== 3 || typeof fields.batch_id !== 'string' || typeof fields.request_id !== 'string' || typeof fields.process_id !== 'string') throw new Error('命令目标无效');
    const processId = harness.getRunningCommand(fields.batch_id, fields.request_id);
    if (!processId || processId !== fields.process_id) throw new Error('该命令已结束或不属于当前项目、会话和批次');
    harness.markUserInterrupted();
    await processes.execute(options.files.getRoot()!, 'stop_process', { process_id: processId });
    harness.refreshProcesses();
    return getState();
  }, 1);
  const undo = async () => { synchronizeChangeSession(); const result = await options.workspace.run(() => changes.undo()); publish(harness.getState()); return result; };
  register(CHANNELS.undoToolChange, undo, 0);
  if (options.review) {
    for (const [channel, action] of [
      [CHANNELS.getReviewState, () => { harness.getState(); return review.getState(); }],
      [CHANNELS.undoReviewChange, undo],
    ] as const) {
      options.ipc.handle(channel, (event, ...args: unknown[]) => {
        if (event.sender !== options.review || event.senderFrame !== options.review!.mainFrame || args.length) throw new Error('变更查看仅供本地变更视图主 frame 使用');
        return action();
      });
      channels.push(channel);
    }
  }
  publish(getState());
  return {
    channels, getState, approveDirty, configure,
    async setWebActive(active: boolean): Promise<void> {
      if (webActive === active || disposed) return;
      webActive = active; revision++; jsonDraft.invalidate();
      auto.setEnabled(false); watcher.setEnabled(false);
      toolAttachments.reset(); resultReturn?.invalidate();
      continuation?.reset({ root: options.files.getRoot(), session: sessionKeyOf(web.getURL()) });
      auto.reset(true);
      publish(harness.getState());
      if (!active) await sender.cancel('results');
    },
    async bindWeb(next: WebContents, nextSender?: Options['sender']): Promise<void> {
      if (next === web || disposed) return;
      if (webActive) throw new Error('绑定官网前必须暂停采集与发送');
      const state = displayState(harness.getState());
      if (state.busy || processes.hasRunning) throw new Error('工具正在执行，不能绑定其他官网');
      if (state.results.length || state.batchError) retainedCopy = { root: options.files.getRoot(), results: structuredClone(state.results), ...(state.batchError ? { batchError: { ...state.batchError } } : {}), ...(state.source ? { source: state.source } : {}) };
      revision++; jsonDraft.invalidate();
      await watcher.dispose();
      await sender.dispose();
      if (disposed) return;
      unbindNavigationGuard(); web = next; sender = nextSender ?? createSender(web); bindNavigationGuard();
      harness.resetSource();
      monitor = new ReplyMonitor(web, readOptions); watcher = createWatcher();
      auto.reset(true); changes.reset(); changeSession = sessionKeyOf(web.getURL());
      toolAttachments.reset(); resultReturn?.invalidate();
      continuation?.reset({ root: options.files.getRoot(), session: changeSession });
      publish(harness.getState());
    },
    clearRules: () => harness.clearRules(),
    /** 本地发送与输出采集独立；发送器自身核验地址和一次点击。 */
    async sendLocalPrompt(text: string, session: string, submissionCurrent: () => boolean, attachments: readonly PromptAttachmentData[] = []) {
      if (!webActive || !submissionCurrent() || disposed || session !== sessionKeyOf(web.getURL())) return { ok: false, error: '项目、平台、会话或发送选项已变化' };
      const selectedRevision = revision;
      const current = () => webActive && !disposed && revision === selectedRevision && submissionCurrent();
      jsonDraft.invalidate(); toolAttachments.reset(); resultReturn?.invalidate();
      traceCollection('integration.local-prompt-start', { session: traceScope(session), text: traceText(text), attachmentCount: attachments.length, attachmentBytes: attachments.reduce((sum, item) => sum + item.size, 0) });
      // 首页首发的地址分配先于正文挂载且生成控件无可读标签；发送前打短期标记，watcher 交接时据此保留新轮基线，失败退回既有判据。
      try { await watcher.markLocalSubmit(); } catch (error) { traceCollection('integration.local-submit-mark-error', { error: error instanceof Error ? error.message : String(error) }); /* 页面忙时由既有回复/生成判据兜底 */ }
      if (!current()) return { ok: false, error: '网页平台或发送选项已变化，需求未发送' };
      const transport = sender.send(text, session, 'prompt', current, attachments);
      localPromptTransport = transport;
      try {
        const result = await transport;
        traceCollection('integration.local-prompt-result', { session: traceScope(session), ok: result.ok, error: result.ok ? null : result.error ?? null });
        return result;
      } finally { if (localPromptTransport === transport) localPromptTransport = undefined; }
    },
    invalidate: (relative: string, isDirectory: boolean) => { changes.invalidate(relative, isDirectory); publish(harness.getState()); },
    getReviewState: () => { harness.getState(); return review.getState(); },
    async prepareDirty(relative: string): Promise<{ allowed: boolean; discard: boolean; aliases: string[] }> {
      const root = options.files.getRoot(); if (!root) return { allowed: false, discard: false, aliases: [] };
      const aliases = await projectAliases(root, relative, options.workspace.editor.current.documents.map(d => d.path));
      const dirty = aliases.filter(p => options.workspace.editor.isDirty(p));
      for (const alias of dirty) if (!await approveDirty(alias)) return { allowed: false, discard: false, aliases };
      return { allowed: true, discard: dirty.length > 0, aliases };
    },
    async accept(text: string, completion: AutoReply['completion']): Promise<boolean> {
      if (!webActive || disposed) { harness.report('当前网页平台不支持工具采集'); return true; }
      if (store.getLoadError()) { publish(harness.getState()); return true; }
      const parsed = parseToolBatch(text);
      const root = options.files.getRoot(); const session = sessionKeyOf(web.getURL()); const currentRevision = revision;
      const current = () => webActive && !disposed && currentRevision === revision && !web.isDestroyed() && root === options.files.getRoot() && session === sessionKeyOf(web.getURL());
      if (completion === 'generating') { harness.report('AI 仍在生成回复，工具批次未执行；请等待回复结束'); return true; }
      if (completion === 'interrupted') { harness.report('AI 回复已中断，等待继续生成；当前工具批次未执行'); return true; }
      if ((parsed.kind === 'batch' || parsed.kind === 'repair') && completion !== 'complete') {
        const choice = await options.ask('确认手动采集', '网页没有提供可识别的结束状态。请确认 AI 已停止生成，再采集当前工具批次。', ['确认已结束并采集', '取消']);
        if (!current()) { harness.report('采集期间项目、平台或会话已切换，请重新采集'); return true; }
        if (choice.response !== 0) { harness.report('未确认回复结束，工具未执行'); return true; }
        const latest = await readAutoReply(web, readOptions);
        if (!current()) { harness.report('采集期间项目、平台或会话已切换，请重新采集'); return true; }
        if (latest.text !== text || latest.completion === 'generating' || latest.completion === 'interrupted') { harness.report('确认期间回复仍在变化或中断，请等生成结束后重新采集'); return true; }
      }
      await watcher.acknowledge(true);
      if (!current()) {
        harness.report('采集期间项目或会话已切换，请重新采集'); return true;
      }
      auto.acknowledge(sessionKeyOf(web.getURL()), text);
      void collectReply(text, current, true); return true;
    },
    reset(): void { retainedCopy = null; revision++; jsonDraft.invalidate(); toolAttachments.reset(); resultReturn?.begin(null); continuation?.reset({ root: options.files.getRoot(), session: sessionKeyOf(web.getURL()) }); harness.cancel(); watcher.reset(); changes.reset(); },
    async dispose(): Promise<void> { unbindNavigationGuard(); disposed = true; revision++; jsonDraft.invalidate(); toolAttachments.reset(); resultReturn?.begin(null); continuation?.dispose(); await sender.dispose(); auto.dispose(); await watcher.dispose(); harness.cancel(); await processes.dispose(); },
  };
}
