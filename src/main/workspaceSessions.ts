import type { IpcMain, WebContents } from 'electron';
import { CHANNELS } from '../shared/contract';
import { sameWorkspaceConversation, workspaceConversation, type WorkspaceConversation, type WorkspaceSessionsState } from '../shared/workspaceSessions';
import type { WebPlatform } from '../shared/webPlatform';
import type { WorkspaceController } from './workspaceController';
import { WorkspaceSessionStore } from './workspaceSessionStore';

interface Source { web: WebContents; platform: WebPlatform; accountId: string }
interface Options {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  editor: WebContents;
  file: string;
  workspace: Pick<WorkspaceController, 'workspace' | 'openSessionWorkspace'>;
  source: () => Source;
  available: () => boolean;
  accountName: (platform: WebPlatform, accountId: string) => string;
  switchBlock: () => string | undefined;
  navigate: (target: WorkspaceConversation, current: () => boolean) => Promise<void>;
  setActive: (active: boolean) => Promise<void>;
}
interface Transition { target: WorkspaceConversation; kind: 'open' | 'sync'; invalid: boolean; navigating: boolean; interrupt?: () => void }
const sameRoot = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();

/** 本地收藏与官网导航协调；不读网页正文/存储、不写 DOM，不创建隐式绑定。 */
export class WorkspaceSessions {
  private readonly store?: WorkspaceSessionStore;
  private readonly loadError?: string;
  private error: string | undefined;
  private revision = 0;
  private disposed = false;
  private registered = false;
  private observed?: Source;
  private wasAvailable?: boolean;
  private readonly cleanup: Array<() => void> = [];
  private transition: Transition | undefined;
  private navigationPending = false;
  private pendingNavigationUrl: string | undefined;
  private pendingSync = false;
  private activity?: boolean;
  private activityWork: Promise<void> = Promise.resolve();

  constructor(private readonly options: Options) {
    try { this.store = new WorkspaceSessionStore(options.file); }
    catch (error) { this.loadError = error instanceof Error ? error.message : '会话绑定读取失败，原文件保留'; }
  }

  private identity(source?: Source): WorkspaceConversation | null {
    if (this.observed?.web.isDestroyed()) return null;
    const target = source ?? this.options.source();
    return target.web.isDestroyed() ? null : workspaceConversation(target.platform, target.accountId, target.web.getURL());
  }
  private binding(identity = this.identity()) {
    return this.store?.sessions.find(session => sameWorkspaceConversation(session, identity));
  }
  get canRun(): boolean {
    if (this.disposed || this.observed?.web.isDestroyed()) return false;
    const binding = this.binding();
    return !this.disposed && !this.loadError && !this.transition && !this.navigationPending && !this.pendingSync && this.options.available() &&
      (!binding || sameRoot(this.options.workspace.workspace.getState().root, binding.root));
  }
  get state(): WorkspaceSessionsState {
    if (this.disposed) return { revision: this.revision, sessions: [], current: null, selectedId: null, canBind: false, busy: false };
    if (this.observed?.web.isDestroyed()) return { revision: this.revision,
      sessions: (this.store?.sessions ?? []).map(session => ({ ...session, accountName: this.options.accountName(session.platform, session.accountId) })),
      current: null, selectedId: null, canBind: false, busy: false, error: '官网视图已关闭，请重新打开应用' };
    const current = this.identity();
    const binding = this.binding(current);
    const workspace = this.options.workspace.workspace.getState();
    const mismatch = binding && !sameRoot(workspace.root, binding.root);
    const error = this.loadError ?? this.error ?? (mismatch ? '当前项目与网页会话不匹配，请选择对应会话后继续' : undefined);
    return { revision: this.revision,
      sessions: (this.store?.sessions ?? []).map(session => ({ ...session, accountName: this.options.accountName(session.platform, session.accountId) })),
      current, selectedId: binding && !mismatch && this.options.available() && !this.transition && !this.navigationPending && !this.pendingSync ? binding.id : null,
      canBind: Boolean(this.store && current && !binding && this.options.available() && !this.transition && !this.navigationPending && !this.pendingSync),
      busy: Boolean(this.transition), ...(error ? { error } : {}) };
  }
  private publish(): void {
    if (this.disposed) return;
    this.revision++;
    if (!this.options.editor.isDestroyed()) this.options.editor.send(CHANNELS.workspaceSessionsState, this.state);
  }
  private active(active: boolean): Promise<void> {
    if (this.activity === active) return this.activityWork;
    this.activity = active;
    // false 必须立即进入工具 owner 撤回；true 只在旧撤回完成后并再次核验当前作用域。
    const previous = this.activityWork;
    if (active) this.activityWork = previous.catch(() => {}).then(async () => { if (this.activity === true && this.canRun) await this.options.setActive(true); });
    else {
      // 先发布等待句柄再进入会同步广播工具状态的 owner，避免重入跳过当前撤回。
      let finish!: () => void, fail!: (error: unknown) => void;
      this.activityWork = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      void this.options.setActive(false).then(finish, fail);
    }
    return this.activityWork;
  }
  private updateActivity(): void {
    void this.active(this.canRun).catch(() => {
      if (!this.disposed) { this.error = '会话切换保护未完成，请重新选择会话'; this.publish(); }
    });
  }
  private invalidateTransition(): void {
    if (this.transition) { this.transition.invalid = true; this.transition.interrupt?.(); }
  }

  /** 平台活动视图或可用状态改变；仅监听活动页，后台账号和子 frame 不影响选中。 */
  platformChanged(): void {
    if (this.disposed) return;
    const source = this.options.source();
    const sourceChanged = !this.observed || source.web !== this.observed.web || source.platform !== this.observed.platform || source.accountId !== this.observed.accountId;
    const available = this.options.available();
    if (!sourceChanged && this.wasAvailable === available) { this.refreshAvailability(); return; }
    this.wasAvailable = available;
    if (sourceChanged) {
      this.cleanup.splice(0).forEach(remove => remove());
      this.observed = source;
      this.navigationPending = false;
      this.pendingNavigationUrl = undefined;
      const listen = (name: string, listener: (...args: any[]) => void) => {
        source.web.on(name as any, listener);
        this.cleanup.push(() => source.web.removeListener(name as any, listener));
      };
      listen('did-start-navigation', (event, url, _inPlace, main) => {
        if ((main ?? event.isMainFrame) !== true || source.web !== this.options.source().web) return;
        this.pendingNavigationUrl = url;
        if (this.transition && !(this.transition.kind === 'open' && this.transition.navigating &&
          sameWorkspaceConversation(this.transition.target, workspaceConversation(source.platform, source.accountId, url)))) this.invalidateTransition();
        // 页面开始导航即失去旧目标；官网点击不拦截、不回退。首页首发仍由原 owner 交接。
        const next = workspaceConversation(source.platform, source.accountId, url);
        const binding = this.binding(next);
        if (this.transition || binding || this.binding()) {
          this.navigationPending = true; void this.active(false).catch(() => {});
        }
        if (binding && !sameRoot(this.options.workspace.workspace.getState().root, binding.root)) {
          this.pendingSync = true; void this.active(false).catch(() => {});
        }
      });
      listen('did-navigate', () => { this.navigationPending = false; this.pendingNavigationUrl = undefined; this.observe(); });
      listen('did-navigate-in-page', (_event, _url, main) => { if (main) { this.navigationPending = false; this.pendingNavigationUrl = undefined; this.observe(); } });
      listen('did-fail-load', (_event, code, _description, url, main) => {
        if (!main || this.pendingNavigationUrl && url !== this.pendingNavigationUrl) return;
        this.pendingNavigationUrl = undefined;
        this.pendingSync = false; this.navigationPending = false; this.invalidateTransition();
        // 原生中断且没有后继导航时恢复当前真实页面的未来基线，不复活旧运输。
        if (code === -3) { this.observe(); return; }
        this.error = '网页会话加载失败，请在官网恢复后重新选择'; this.updateActivity(); this.publish();
      });
      // 销毁期间不得再经平台/工具状态间接读取已关闭的 webContents。
      listen('destroyed', () => { this.invalidateTransition(); this.pendingSync = false; this.navigationPending = false; this.publish(); });
    }
    if (!this.transition) this.observe();
    else {
      if (this.transition.kind === 'sync' && !sameWorkspaceConversation(this.transition.target, this.identity())) this.invalidateTransition();
      if (available && sourceChanged && this.transition.kind === 'open' && this.transition.navigating &&
        (source.platform !== this.transition.target.platform || source.accountId !== this.transition.target.accountId)) this.invalidateTransition();
      this.updateActivity(); this.publish();
    }
  }

  private observe(): void {
    if (this.disposed) return;
    if (this.transition) {
      if (!sameWorkspaceConversation(this.transition.target, this.identity())) this.invalidateTransition();
      this.publish(); return;
    }
    this.error = undefined;
    const binding = this.binding();
    this.pendingSync = Boolean(binding && !sameRoot(this.options.workspace.workspace.getState().root, binding.root));
    this.updateActivity(); this.publish();
    this.trySync();
  }

  /** 本地项目主动切换只更新匹配状态，不反向导航或自动切回原项目。 */
  workspaceChanged(): void {
    if (this.disposed) return;
    if (!this.transition) this.pendingSync = false;
    this.updateActivity(); this.publish();
  }
  refreshAvailability(): void {
    if (this.disposed) return;
    this.trySync();
  }
  private trySync(): void {
    if (!this.pendingSync || this.navigationPending || this.transition || !this.options.available() || this.options.switchBlock()) return;
    const binding = this.binding();
    if (!binding) { this.pendingSync = false; this.updateActivity(); this.publish(); return; }
    void this.syncProject(binding.root, binding);
  }
  private async syncProject(root: string, identity: WorkspaceConversation): Promise<void> {
    const transition: Transition = { target: identity, kind: 'sync', invalid: false, navigating: false };
    this.transition = transition; this.pendingSync = false; this.publish();
    const current = () => !this.disposed && this.transition === transition && !transition.invalid &&
      sameWorkspaceConversation(identity, this.identity()) && !this.options.switchBlock() && this.options.available();
    try {
      await this.active(false);
      if (!current()) return;
      const result = await this.options.workspace.openSessionWorkspace(root, true, current);
      if (!result.ok && current()) this.error = result.error ?? '自动保存未完成，保留原项目和草稿';
    } catch { if (current()) this.error = '项目同步失败，保留原项目和草稿'; }
    finally {
      if (this.transition === transition) {
        this.transition = undefined;
        if (transition.invalid) this.observe(); else { this.updateActivity(); this.publish(); }
      }
    }
  }

  async open(id: string): Promise<WorkspaceSessionsState> {
    const session = this.store?.sessions.find(item => item.id === id);
    if (!session) throw new Error('会话绑定已不存在');
    if (this.transition) throw new Error('正在切换会话，请稍候');
    const blocked = this.options.switchBlock(); if (blocked) throw new Error(blocked);
    const transition: Transition = { target: session, kind: 'open', invalid: false, navigating: false };
    this.transition = transition; this.pendingSync = false; this.error = undefined; this.publish();
    const current = () => !this.disposed && this.transition === transition && !transition.invalid;
    try {
      await this.active(false);
      if (!current()) throw new Error('会话选择已变化');
      const result = await this.options.workspace.openSessionWorkspace(session.root, false, current);
      if (!result.ok) throw new Error(result.error ?? '已取消本地项目切换');
      if (!current()) throw new Error('会话选择已变化');
      transition.navigating = true;
      const interrupted = new Promise<boolean>(resolve => { transition.interrupt = () => resolve(false); });
      // 旧后台页慢加载不能锁住后来已选择的活动页；原生加载仍由平台 owner 收尾。
      const navigated = await Promise.race([this.options.navigate(session, current).then(() => true), interrupted]);
      if (!navigated) throw new Error('会话选择已变化');
      if (!current() || !sameWorkspaceConversation(session, this.identity())) throw new Error('网页已变化，未确认会话切换');
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : '会话切换失败';
    } finally {
      if (this.transition === transition) {
        this.transition = undefined;
        if (transition.invalid) this.observe(); else { this.updateActivity(); this.publish(); }
      }
    }
    return this.state;
  }

  private bind(index: number): WorkspaceSessionsState {
    if (!this.store) throw new Error(this.loadError ?? '会话记录不可用');
    if (this.transition || !this.options.available()) throw new Error('网页正在切换或不可用');
    const root = this.options.workspace.workspace.getState().workspaceRoots[index];
    if (!Number.isInteger(index) || !root) throw new Error('请选择已注册的项目');
    const identity = this.identity(); if (!identity) throw new Error('当前网页尚不是可绑定的正式普通会话');
    const rawTitle = this.options.source().web.getTitle().replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
    const title = rawTitle && !/^(?:ChatGPT|DeepSeek)$/i.test(rawTitle)
      ? rawTitle.slice(0, 160) : `会话 ${identity.conversationId.slice(0, 12)}`;
    this.store.bind(root, identity, title);
    this.error = undefined; this.updateActivity(); this.publish();
    return this.state;
  }
  register(): string[] {
    if (this.registered || this.disposed) throw new Error('会话入口已注册或关闭');
    this.registered = true;
    const handle = (channel: string, count: number, operation: (...args: any[]) => unknown) => {
      this.options.ipc.handle(channel, async (event, ...args: unknown[]) => {
        if (event.sender !== this.options.editor || event.senderFrame !== this.options.editor.mainFrame) throw new Error('会话操作仅供本地编辑器主 frame 使用');
        if (args.length !== count || this.disposed) throw new Error('会话操作参数无效或入口已关闭');
        try { return await operation(...args); }
        catch (error) { this.error = error instanceof Error ? error.message : '会话操作失败'; this.publish(); return this.state; }
      });
    };
    handle(CHANNELS.getWorkspaceSessions, 0, () => this.state);
    handle(CHANNELS.bindWorkspaceSession, 1, index => { if (typeof index !== 'number') throw new Error('项目条目无效'); return this.bind(index); });
    handle(CHANNELS.openWorkspaceSession, 1, id => { if (typeof id !== 'string') throw new Error('会话条目无效'); return this.open(id); });
    handle(CHANNELS.unbindWorkspaceSession, 1, id => {
      if (typeof id !== 'string' || this.transition || !this.store) throw new Error('会话条目无效或正在切换');
      this.store.unbind(id); this.error = undefined; this.updateActivity(); this.publish(); return this.state;
    });
    this.platformChanged();
    return [CHANNELS.getWorkspaceSessions, CHANNELS.bindWorkspaceSession, CHANNELS.openWorkspaceSession, CHANNELS.unbindWorkspaceSession];
  }
  dispose(): void {
    this.disposed = true; this.invalidateTransition();
    this.cleanup.splice(0).forEach(remove => remove());
    if (this.registered) for (const channel of [CHANNELS.getWorkspaceSessions, CHANNELS.bindWorkspaceSession, CHANNELS.openWorkspaceSession, CHANNELS.unbindWorkspaceSession]) this.options.ipc.removeHandler(channel);
  }
}
