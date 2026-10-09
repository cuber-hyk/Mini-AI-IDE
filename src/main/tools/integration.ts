/** 工具 owner 与 Electron 外壳的接线；不向网页提供任何桥或本地路径能力。 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { App, IpcMain, WebContents } from 'electron';
import { CHANNELS } from '../../shared/contract';
import { parseToolBatch, type ToolRequest, type ToolState } from '../../shared/toolProtocol';
import { sessionKeyOf } from '../consumptionStore';
import type { FileService } from '../fileService';
import type { ReturnPathService } from '../returnPathService';
import type { WorkspaceController } from '../workspaceController';
import { SkillService } from '../skills';
import { ToolFiles, resolveToolPath } from './files';
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
import { WebResultSender } from './webResultSender';
import { traceCollection, traceScope, traceText } from './collectionTrace';
import type { PromptAttachmentData } from '../../shared/localPrompt';
export { readAutoReply } from './replyObservation';

interface Options {
  ipc: Pick<IpcMain, 'handle'>; editor: WebContents; web: WebContents; files: FileService;
  returnPath: ReturnPathService; workspace: WorkspaceController; storePath: string; disabled: boolean;
  ask: (title: string, detail: string, buttons: string[], checkboxLabel?: string) => Promise<{ response: number; checkboxChecked: boolean }>;
  notifyFile: (relative: string, change: 'updated' | 'created' | 'deleted', discard: boolean) => void;
  copy: (text: string) => void;
  review?: WebContents;
  notifyReview?: (state: ChangeReviewState) => void;
  sender?: Pick<WebResultSender, 'send' | 'cancel' | 'dispose'>;
  skills?: SkillService;
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
  if (request.tool === 'run_command') targets.push(await resolveToolPath(root, request.args.cwd as string | undefined));
  if (request.tool === 'apply_changes') for (const c of request.args.changes as Array<{ path: string }>) targets.push(await resolveToolPath(root, c.path));
  const parts = [actualRoot, JSON.stringify(request.args), request.tool, ...targets];
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
  const store = new ToolStore(options.storePath); await store.ready();
  const fileTools = new ToolFiles();
  const skills = options.skills ?? new SkillService();
  let disposed = false; let revision = 0;
  let automaticSuspended = false;
  let harness: ToolHarness;
  let continuation: AutoContinuation | undefined;
  const sender = options.sender ?? new WebResultSender(options.web);
  const review = new ChangeReviewOwner(options.notifyReview);
  const reviewTokens = new WeakMap<ToolSelection, number>();
  const clipboard = new ResultClipboard(options.copy);
  const processes = new ToolProcesses(() => {
    if (!disposed && harness) harness.refreshProcesses();
  });
  const publish = (state: ToolState) => {
    traceCollection('integration.publish', { busy: state.busy, completion: state.completion ? { id: state.completion.id, cancelled: state.completion.cancelled } : null,
      resultCount: state.results.length, resultStatuses: state.results.map(result => ({ id: result.request_id, status: result.status })), batchError: state.batchError ?? null,
      automatic: state.config.automatic, suspended: automaticSuspended });
    review.updateResults(state.results);
    auto.setEnabled(!options.disabled && !automaticSuspended && state.config.automatic);
    watcher.setEnabled(!options.disabled && !automaticSuspended && state.config.automatic);
    if (!disposed) clipboard.complete(state);
    continuation?.observe({ root: options.files.getRoot(), session: sessionKeyOf(options.web.getURL()), state: options.disabled || automaticSuspended ? { ...state, config: { ...state.config, automatic: false } } : state });
    if (!options.editor.isDestroyed()) options.editor.send(CHANNELS.toolState, { ...state, canUndo: changes.canUndo, hasRunningProcesses: processes.hasRunning, clipboard: clipboard.notification(state), continuation: continuation?.getState() });
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
  let changeSession = sessionKeyOf(options.web.getURL());
  const synchronizeChangeSession = () => {
    const current = sessionKeyOf(options.web.getURL());
    if (current !== changeSession) { changes.reset(); changeSession = current; }
  };
  const monitor = new ReplyMonitor(options.web);
  const auto = new AutoCollector(() => monitor.read(), async (text, current) => {
    const root = options.files.getRoot(); const session = sessionKeyOf(options.web.getURL());
    const allowed = current() && root === options.files.getRoot() && session === sessionKeyOf(options.web.getURL());
    traceCollection('integration.collect-check', { allowed, root: root ? traceText(root) : null, session: traceScope(session), text: traceText(text) });
    if (allowed) {
      await harness.collect(text);
      traceCollection('integration.collect-returned', { root: root ? traceText(root) : null, session: traceScope(session), text: traceText(text) });
    }
  }, message => harness.report(message));
  const watcher = new ReplyChangeWatcher(options.web, userTurn => {
    traceCollection('integration.watcher-change', { userTurn, session: traceScope(options.web.getURL()) });
    if (userTurn) continuation?.userTurn();
    return auto.tick();
  }, (preserve = false, awaitHistory = false, generated = false) => {
    traceCollection('integration.watcher-baseline', { preserve, awaitHistory, generated, session: traceScope(options.web.getURL()) });
    continuation?.reset();
    if (generated) auto.observeGeneration(sessionKeyOf(options.web.getURL()));
    else if (preserve) auto.continueAt(sessionKeyOf(options.web.getURL())); else auto.reset(awaitHistory);
    synchronizeChangeSession(); harness.getState();
  }, message => harness.report(message));
  harness = new ToolHarness({ store, root: () => options.files.getRoot(), session: () => sessionKeyOf(options.web.getURL()),
    selected: selection => {
      continuation?.reset();
      synchronizeChangeSession();
      if (!selection) { review.clear(); return; }
      reviewTokens.set(selection, review.begin({ root: selection.root, session: selection.session,
        batchId: selection.batch.batch_id, contentKey: hash(JSON.stringify(selection.batch)) }, selection.batch));
    },
    stopped: (selection, error) => review.stop(reviewTokens.get(selection), error),
    describe: describeTool, snapshotProcess: id => processes.snapshot(id), prepare: async (root, batch) => { checkBatchChanges(root, batch); await checkResolvedBatchChanges(root, batch); },
    authorize: async (root, request) => {
      const targets = await describeTool(root, request);
      const choice = await options.ask('工具请求需要批准', `项目：${root}\n工具：${request.tool}\n${targets.external ? '包含项目外目标\n' : ''}${request.tool === 'run_command' ? '命令可访问当前账户的文件与网络；工作目录不构成沙箱。\n' : ''}实际参数：\n${JSON.stringify(request.args, null, 2)}`, targets.canRemember ? ['允许一次', '记住本项目的精确请求', '拒绝'] : ['允许一次', '拒绝']);
      return choice.response === 0 ? 'once' : targets.canRemember && choice.response === 1 ? 'remember' : 'deny';
    },
    execute: async (root, request, started, selection) => {
      if (request.tool === 'load_skill') return skills.load(root, request.args.name as string);
      if (request.tool === 'apply_changes') return options.workspace.run(() => {
        if (selection.session !== sessionKeyOf(options.web.getURL())) throw new Error('会话已切换，未启动文件修改');
        return changes.execute(root, request, reviewTokens.get(selection));
      });
      if (['run_command', 'get_process_output', 'stop_process'].includes(request.tool)) return processes.execute(root, request.tool, request.args, started);
      return fileTools.execute(root, request.tool, request.args);
    }, changed: publish,
  });
  const getState = (): ToolState => {
    synchronizeChangeSession();
    const state = harness.getState();
    const notification = clipboard.notification(state);
    return { ...state, canUndo: changes.canUndo, hasRunningProcesses: processes.hasRunning, ...(notification ? { clipboard: notification } : {}), ...(continuation ? { continuation: continuation.getState() } : {}) };
  };
  continuation = new AutoContinuation({
    current: () => ({ root: options.files.getRoot(), session: sessionKeyOf(options.web.getURL()), state: getState() }),
    cancelSend: () => sender.cancel('results'),
    changed: () => { if (!disposed && !options.editor.isDestroyed()) options.editor.send(CHANNELS.toolState, getState()); },
    send: async (text, session, current) => {
      const state = harness.getState();
      const root = options.files.getRoot();
      const reply = await readAutoReply(options.web);
      if (!current()) return { ok: false, error: '本批自动发送已取消' };
      if (reply.url !== session || reply.completion !== 'complete') return { ok: false, error: '网页回复状态或会话已变化，请检查后手动发送' };
      const parsed = parseToolBatch(reply.text);
      if (parsed.kind !== 'batch' || !harness.matchesBatch(parsed.batch)) return { ok: false, error: '网页最新回复已变化，未发送旧工具结果' };
      const latest = harness.getState();
      if (!current() || automaticSuspended || !latest.config.automatic || latest.busy || latest.completion?.cancelled || latest.completion?.id !== state.completion?.id || formatToolResults(latest.results) !== text || root !== options.files.getRoot() || sessionKeyOf(options.web.getURL()) !== session) return { ok: false, error: '自动继续已关闭或项目、会话、批次已切换' };
      return sender.send(text, session);
    },
  });
  const channels: string[] = [];
  const register = (channel: string, action: (...args: unknown[]) => unknown, count: number) => {
    options.ipc.handle(channel, (event, ...args: unknown[]) => {
      if (event.sender !== options.editor || event.senderFrame !== options.editor.mainFrame) throw new Error('工具控制仅供本地编辑器主 frame 使用');
      if (args.length !== count) throw new Error('工具控制参数数量无效');
      return action(...args);
    }); channels.push(channel);
  };
  register(CHANNELS.getToolState, getState, 0);
  register(CHANNELS.setToolConfig, async config => {
    if (config && typeof config === 'object' && !Array.isArray(config) && (config as { automatic?: unknown }).automatic === false) {
      // 关闭先取消计时与等待发送，不等配置写盘，也不取消本地正在执行的工具。
      automaticSuspended = true; publish(harness.getState());
    }
    await harness.configure(config);
    if (config && typeof config === 'object' && (config as { automatic?: unknown }).automatic === true) automaticSuspended = false;
    publish(harness.getState()); return getState();
  }, 1);
  register(CHANNELS.copyToolResults, () => {
    const results = harness.getCopyResults();
    const batchError = harness.getState().batchError;
    if (!results.length && !batchError) return { ok: false, error: '没有本项目当前会话的工具批次可复制' };
    options.copy(formatToolResults(results, batchError)); return { ok: true };
  }, 0);
  register(CHANNELS.cancelTools, async () => { harness.cancel(); await processes.dispose(); return getState(); }, 0);
  register(CHANNELS.stopToolCommand, async target => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('命令目标无效');
    const fields = target as Record<string, unknown>;
    if (Object.keys(fields).length !== 3 || typeof fields.batch_id !== 'string' || typeof fields.request_id !== 'string' || typeof fields.process_id !== 'string') throw new Error('命令目标无效');
    const processId = harness.getRunningCommand(fields.batch_id, fields.request_id);
    if (!processId || processId !== fields.process_id) throw new Error('该命令已结束或不属于当前项目、会话和批次');
    await processes.execute(options.files.getRoot()!, 'stop_process', { process_id: processId });
    harness.refreshProcesses();
    return getState();
  }, 1);
  register(CHANNELS.clearToolRules, async () => { await harness.clearRules(); return getState(); }, 0);
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
    channels, getState, approveDirty,
    /** 本地发送与输出采集独立；发送器自身核验地址和一次点击。 */
    async sendLocalPrompt(text: string, session: string, submissionCurrent: () => boolean, attachments: readonly PromptAttachmentData[] = []) {
      if (!submissionCurrent() || disposed || session !== sessionKeyOf(options.web.getURL())) return { ok: false, error: '项目、会话或发送选项已变化' };
      traceCollection('integration.local-prompt-start', { session: traceScope(session), text: traceText(text), attachmentCount: attachments.length, attachmentBytes: attachments.reduce((sum, item) => sum + item.size, 0) });
      // 首页首发的地址分配先于正文挂载且生成控件无可读标签；发送前打短期标记，watcher 交接时据此保留新轮基线，失败退回既有判据。
      try { await watcher.markLocalSubmit(); } catch (error) { traceCollection('integration.local-submit-mark-error', { error: error instanceof Error ? error.message : String(error) }); /* 页面忙时由既有回复/生成判据兜底 */ }
      const result = await sender.send(text, session, 'prompt', submissionCurrent, attachments);
      traceCollection('integration.local-prompt-result', { session: traceScope(session), ok: result.ok, error: result.ok ? null : result.error ?? null });
      return result;
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
      const parsed = parseToolBatch(text);
      const root = options.files.getRoot(); const session = sessionKeyOf(options.web.getURL()); const currentRevision = revision;
      if (completion === 'generating') { harness.report('AI 仍在生成回复，工具批次未执行；请等待回复结束'); return true; }
      if (completion === 'interrupted') { harness.report('AI 回复已中断，等待继续生成；当前工具批次未执行'); return true; }
      if (parsed.kind === 'batch' && completion !== 'complete') {
        const choice = await options.ask('确认手动采集', '网页没有提供可识别的结束状态。请确认 AI 已停止生成，再采集当前工具批次。', ['确认已结束并采集', '取消']);
        if (choice.response !== 0) { harness.report('未确认回复结束，工具未执行'); return true; }
        const latest = await readAutoReply(options.web);
        if (latest.text !== text || latest.completion === 'generating' || latest.completion === 'interrupted') { harness.report('确认期间回复仍在变化或中断，请等生成结束后重新采集'); return true; }
      }
      await watcher.acknowledge(true);
      if (disposed || currentRevision !== revision || options.web.isDestroyed() || root !== options.files.getRoot() || session !== sessionKeyOf(options.web.getURL())) {
        harness.report('采集期间项目或会话已切换，请重新采集'); return true;
      }
      auto.acknowledge(sessionKeyOf(options.web.getURL()), text);
      void harness.collect(text); return true;
    },
    reset(): void { revision++; continuation?.reset(); harness.cancel(); watcher.reset(); changes.reset(); },
    async dispose(): Promise<void> { disposed = true; revision++; continuation?.dispose(); await sender.dispose(); auto.dispose(); await watcher.dispose(); harness.cancel(); await processes.dispose(); },
  };
}
