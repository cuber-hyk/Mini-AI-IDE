/** 两个平台的本地生命周期；官网无 IPC、回复采集或发送能力。 */
import type { BrowserWindow, IpcMain, WebContents, WebContentsView } from 'electron';
import { CHANNELS } from '../shared/contract';
import { WEB_PLATFORMS, type WebPlatform, type WebPlatformState, type WebPlatformSwitchBlock } from '../shared/webPlatform';
import type { DeepSeekAccountStore } from './deepseekAccounts';
import type { DeepSeekAccountViews } from './deepseekAccountViews';

interface Options {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  webbar: WebContents;
  editor: WebContents;
  deepseek: WebContentsView;
  createChatGPT: () => WebContentsView;
  prepareSwitch: () => Promise<void>;
  applyView: (view: WebContentsView) => void;
  changed?: (state: WebPlatformState) => void | Promise<void>;
  switchBlock?: () => WebPlatformSwitchBlock | undefined;
  loadingChanged?: (platform: WebPlatform, loading: boolean) => void;
  contentReady?: (web: WebContents) => Promise<boolean>;
  accountStore?: DeepSeekAccountStore;
  accountViews?: DeepSeekAccountViews;
}

/** 加载完成仍可能是 SPA 空壳；只读返回是否已有可见内容，不读取正文回主进程。 */
export async function webContentReady(web: WebContents): Promise<boolean> {
  return await web.executeJavaScriptInIsolatedWorld(1004, [{ code: `(() => {
    if (!document.body || !document.body.getClientRects().length) return false;
    return [...document.body.querySelectorAll('main,p,h1,h2,button,input,textarea,[role="textbox"]')].some(e => {
      const s = getComputedStyle(e);
      return e.getClientRects().length > 0 && s.display !== 'none' && s.visibility !== 'hidden' &&
        (e.matches('input,textarea,[role="textbox"]') || !!e.innerText?.trim());
    });
  })()` }]) === true;
}

export class WebPlatformController {
  private current: WebPlatformState = { platform: 'deepseek', switching: false };
  private chatgpt: WebContentsView | null = null;
  private readonly popups = new Set<BrowserWindow>();
  private disposed = false;
  private registered = false;
  private readonly loadErrors = new Map<WebContentsView, string>();
  private readonly failedLoads = new Set<WebContentsView>();
  private readonly reloading = new Set<WebContentsView>();
  private readonly loadCleanup: Array<() => void> = [];
  private readonly startedViews = new Set<WebContentsView>();
  private lastSwitchBlockedReason: WebPlatformSwitchBlock | undefined;
  private readonly loading = new Set<WebContentsView>();
  private readonly resumeReadiness = new Map<WebContentsView, () => void>();
  private deepseekStarted = false;
  private initialRecoveryAvailable = false;
  private initialNavigationSeen = false;
  private initialRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly navigationRevisions = new Map<WebContentsView, number>();

  constructor(private readonly options: Options) {
    if (Boolean(options.accountStore) !== Boolean(options.accountViews)) throw new Error('账号资料与视图必须同时配置');
    this.loading.add(options.deepseek); this.startedViews.add(options.deepseek);
    this.watchLoads('deepseek', options.deepseek);
    options.loadingChanged?.('deepseek', true);
  }
  get state(): WebPlatformState {
    const { switchBlockedReason: _previous, error: _error, reloading: _reloading, deepseekAccounts: _accounts, ...state } = this.current;
    const view = this.getView(state.platform);
    const switchBlockedReason = this.options.switchBlock?.();
    return { ...state, ...(this.loadErrors.has(view) ? { error: this.loadErrors.get(view)! } : {}),
      ...(this.reloading.has(view) ? { reloading: true as const } : {}), ...(switchBlockedReason ? { switchBlockedReason } : {}),
      ...(this.options.accountStore ? { deepseekAccounts: { activeId: this.options.accountViews!.selectedId, accounts: this.options.accountStore.accounts } } : {}) };
  }

  async loadInitialDeepSeek(url: string): Promise<void> {
    this.requireLive();
    if (this.deepseekStarted) throw new Error('DeepSeek 启动加载已发起');
    this.deepseekStarted = true;
    this.initialRecoveryAvailable = url === WEB_PLATFORMS.deepseek.url && this.current.platform === 'deepseek';
    await this.options.deepseek.webContents.loadURL(url).catch(() => { /* 主 frame 失败由统一导航监听记录。 */ });
  }

  private cancelInitialRecovery(): void {
    this.initialRecoveryAvailable = false;
    if (this.initialRecoveryTimer === undefined) return;
    clearTimeout(this.initialRecoveryTimer); this.initialRecoveryTimer = undefined;
    this.reloading.delete(this.options.deepseek);
    if (this.failedLoads.has(this.options.deepseek)) this.loading.delete(this.options.deepseek);
    if (!this.disposed && this.current.platform === 'deepseek') this.broadcast();
  }

  private watchLoads(platform: WebPlatform, view: WebContentsView): void {
    const web = view.webContents;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let checkingRevision: number | undefined;
    let finishedDocument = false;
    let deadline = 0;
    const clear = () => {
      generation++;
      if (timer) clearTimeout(timer); timer = undefined;
      if (deadlineTimer) clearTimeout(deadlineTimer); deadlineTimer = undefined;
    };
    const present = () => {
      if (this.isActive(platform, view)) this.options.loadingChanged?.(platform, this.loading.has(view));
    };
    const ready = async (revision: number): Promise<void> => {
      timer = undefined;
      if (!this.isActive(platform, view) || checkingRevision === revision || !this.loading.has(view)) return;
      checkingRevision = revision;
      let visibleContent = false;
      try { visibleContent = await (this.options.contentReady ?? webContentReady)(web); } catch { /* 导航或销毁中的读取不表示已渲染。 */ }
      if (checkingRevision === revision) checkingRevision = undefined;
      if (this.disposed || web.isDestroyed() || revision !== generation || this.failedLoads.has(view)) return;
      // 未知布局最多观察 10 秒；网络文档已完成后不无限遮挡用户可手动操作的页面。
      if (visibleContent || Date.now() >= deadline) { clear(); this.loading.delete(view); present(); }
      else if (this.isActive(platform, view)) { timer = setTimeout(() => { void ready(revision); }, 250); timer.unref?.(); }
    };
    this.resumeReadiness.set(view, () => { if (finishedDocument && !timer) void ready(generation); });
    const start = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (this.disposed || !mainFrame) return;
      this.navigationRevisions.set(view, (this.navigationRevisions.get(view) ?? 0) + 1);
      if (view === this.options.deepseek) {
        if (this.initialRecoveryTimer !== undefined) this.cancelInitialRecovery();
        if (this.initialRecoveryAvailable) {
          if (this.initialNavigationSeen || _url !== WEB_PLATFORMS.deepseek.url) this.initialRecoveryAvailable = false;
          this.initialNavigationSeen = true;
        }
      }
      if (!inPlace) {
        clear();
        finishedDocument = false; this.failedLoads.delete(view); this.loading.add(view); present();
      }
    };
    const failed = (_event: unknown, code: number, description: string, url: string, mainFrame: boolean) => {
      if (this.disposed || !mainFrame) return;
      const recoverInitial = view === this.options.deepseek && this.initialRecoveryAvailable && code === -100 && description === 'ERR_CONNECTION_CLOSED' &&
        url === WEB_PLATFORMS.deepseek.url && this.isActive(platform, view) && !this.current.switching && !this.options.switchBlock?.();
      if (view === this.options.deepseek) this.cancelInitialRecovery();
      this.failedLoads.add(view);
      clear(); this.loading.delete(view); if (!recoverInitial) present();
      if (code === -3) return;
      const name = platform === 'deepseek' ? 'DeepSeek' : 'ChatGPT';
      const errorCode = /^ERR_[A-Z0-9_]{1,56}$/.test(description) ? description : 'ERR_FAILED';
      const numericCode = Number.isInteger(code) && code < 0 && code >= -1000 ? code : -2;
      this.loadErrors.set(view, `${name} 页面加载失败（${errorCode} / ${numericCode}），请重新加载`);
      process.stderr.write(`[web:${platform}] 加载失败 ${numericCode} ${errorCode}\n`);
      if (recoverInitial) {
        const revision = generation;
        this.reloading.add(view); this.loading.add(view);
        this.initialRecoveryTimer = setTimeout(() => {
          if (this.disposed || web.isDestroyed() || revision !== generation || !this.isActive(platform, view) ||
            this.current.switching || this.options.switchBlock?.() || web.getURL() !== WEB_PLATFORMS.deepseek.url) {
            this.cancelInitialRecovery(); return;
          }
          this.initialRecoveryTimer = undefined;
          process.stdout.write('[web:deepseek] 首次连接关闭，自动恢复一次\n');
          void this.reloadFailed(true).catch(() => { if (!this.disposed) process.stderr.write('[web:deepseek] 首次自动恢复已停止，保留手动重载\n'); });
        }, 1000);
        this.initialRecoveryTimer.unref?.();
      }
      if (this.isActive(platform, view)) this.broadcast();
    };
    const finished = () => {
      if (this.disposed || this.failedLoads.has(view)) return;
      if (view === this.options.deepseek) this.cancelInitialRecovery();
      const hadError = this.loadErrors.delete(view);
      clear(); finishedDocument = true; deadline = Date.now() + 10_000;
      deadlineTimer = setTimeout(() => { clear(); this.loading.delete(view); present(); }, 10_000);
      deadlineTimer.unref?.();
      void ready(generation);
      process.stdout.write(`[web:${platform}] 官网加载完成\n`);
      if (hadError && this.isActive(platform, view)) this.broadcast();
    };
    const stopped = () => {
      if (!this.disposed && !(view === this.options.deepseek && this.initialRecoveryTimer !== undefined) && this.reloading.delete(view) && this.isActive(platform, view)) this.broadcast();
    };
    web.on('did-start-navigation', start); web.on('did-fail-load', failed);
    web.on('did-finish-load', finished); web.on('did-stop-loading', stopped);
    this.loadCleanup.push(() => {
      clear();
      this.resumeReadiness.delete(view);
      web.removeListener('did-start-navigation', start); web.removeListener('did-fail-load', failed);
      web.removeListener('did-finish-load', finished); web.removeListener('did-stop-loading', stopped);
    });
  }
  refreshSwitchAvailability(): void {
    if (this.disposed || this.options.switchBlock?.() === this.lastSwitchBlockedReason) return;
    this.broadcast(true);
  }
  getView(platform: WebPlatform): WebContentsView {
    if (platform === 'deepseek') return this.options.accountViews?.current ?? this.options.deepseek;
    if (!this.chatgpt) throw new Error('ChatGPT 视图尚未创建');
    return this.chatgpt;
  }

  private isActive(platform: WebPlatform, view: WebContentsView): boolean {
    return this.current.platform === platform && this.getView(platform) === view;
  }

  register(): string[] {
    if (this.disposed || this.registered) throw new Error('平台入口已关闭或注册');
    this.registered = true;
    this.options.ipc.handle(CHANNELS.getWebPlatform, (event, ...args: unknown[]) => {
      if (![this.options.webbar, this.options.editor].some(owner => event.sender === owner && event.senderFrame === owner.mainFrame))
        throw new Error('平台状态仅供本地顶栏和编辑器主 frame 使用');
      if (args.length) throw new Error('平台状态不接受参数');
      if (this.disposed) throw new Error('平台入口已关闭');
      return this.state;
    });
    this.options.ipc.handle(CHANNELS.setWebPlatform, (event, ...args: unknown[]) => {
      if (event.sender !== this.options.webbar || event.senderFrame !== this.options.webbar.mainFrame)
        throw new Error('平台切换仅供本地顶栏主 frame 使用');
      if (args.length !== 1 || args[0] !== 'deepseek' && args[0] !== 'chatgpt') throw new Error('平台参数无效');
      return this.switchTo(args[0]);
    });
    this.options.ipc.handle(CHANNELS.reloadWebPlatform, (event, ...args: unknown[]) => {
      if (event.sender !== this.options.webbar || event.senderFrame !== this.options.webbar.mainFrame)
        throw new Error('官网重载仅供本地顶栏主 frame 使用');
      if (args.length) throw new Error('官网重载不接受参数');
      return this.reloadFailed();
    });
    this.options.ipc.handle(CHANNELS.setDeepSeekAccount, (event, ...args: unknown[]) => {
      this.requireAccountCaller(event);
      if (args.length !== 1 || typeof args[0] !== 'string' || !this.options.accountStore!.accounts.some(account => account.id === args[0]))
        throw new Error('账号不存在');
      return this.switchTo('deepseek', args[0]);
    });
    this.options.ipc.handle(CHANNELS.addDeepSeekAccount, async (event, ...args: unknown[]) => {
      this.requireAccountCaller(event);
      if (args.length !== 1) throw new Error('添加账号仅接受备注名');
      this.requireSwitchable();
      const account = this.options.accountStore!.add(args[0]);
      try { return await this.switchTo('deepseek', account.id); }
      catch (error) { if (!this.disposed) this.broadcast(); throw error; }
    });
    return [CHANNELS.getWebPlatform, CHANNELS.setWebPlatform, CHANNELS.reloadWebPlatform, CHANNELS.setDeepSeekAccount, CHANNELS.addDeepSeekAccount];
  }

  private requireAccountCaller(event: { sender: WebContents; senderFrame: unknown }): void {
    this.requireLive();
    if (event.sender !== this.options.webbar || event.senderFrame !== this.options.webbar.mainFrame)
      throw new Error('账号操作仅供本地顶栏主 frame 使用');
    if (!this.options.accountStore || !this.options.accountViews) throw new Error('账号功能不可用');
    if (this.current.platform !== 'deepseek') throw new Error('请先切换到 DeepSeek');
  }

  private requireSwitchable(): void {
    this.requireLive();
    if (this.current.switching) throw new Error('正在切换平台或账号，请稍后重试');
    const blocked = this.options.switchBlock?.();
    if (blocked) throw new Error(blocked);
  }

  private broadcast(topbarOnly = false): void {
    const state = this.state;
    const view = this.getView(state.platform);
    if (!topbarOnly) this.options.loadingChanged?.(state.platform, this.loading.has(view));
    this.resumeReadiness.get(view)?.();
    this.lastSwitchBlockedReason = state.switchBlockedReason;
    for (const owner of topbarOnly ? [this.options.webbar] : [this.options.webbar, this.options.editor]) {
      if (!owner.isDestroyed()) owner.mainFrame.send(CHANNELS.webPlatformState, state);
    }
  }

  private async publish(state: WebPlatformState): Promise<void> {
    const view = this.getView(state.platform);
    await this.options.changed?.({ ...state, ...(this.loadErrors.has(view) ? { error: this.loadErrors.get(view)! } : {}) });
    this.requireLive();
    this.current = state;
    this.broadcast();
  }

  private requireLive(): void { if (this.disposed) throw new Error('平台入口已关闭'); }

  private async reloadFailed(initialRecovery = false): Promise<WebPlatformState> {
    this.requireLive();
    const previous = this.state; const platform = previous.platform;
    if (previous.switching || previous.reloading && !initialRecovery) throw new Error('正在重新加载，请稍候');
    if (previous.switchBlockedReason) throw new Error(previous.switchBlockedReason);
    if (!previous.error) throw new Error('当前官网没有加载失败，不需重新加载');
    const view = this.getView(platform); const web = view.webContents;
    const navigationRevision = this.navigationRevisions.get(view);
    const officialPage = () => {
      if (web.isDestroyed()) return false;
      try {
        const url = new URL(web.getURL());
        return url.origin === new URL(WEB_PLATFORMS[platform].url).origin && !url.username && !url.password &&
          (!initialRecovery || url.href === WEB_PLATFORMS.deepseek.url);
      } catch { return false; }
    };
    if (!officialPage()) throw new Error('当前页面不属于该官网，未重新加载');
    this.current = { ...previous, switching: true }; this.broadcast();
    try {
      await this.options.prepareSwitch(); this.requireLive();
      const blocked = this.options.switchBlock?.();
      if (blocked) throw new Error(blocked);
      if (!officialPage() || !this.loadErrors.has(view) || navigationRevision !== this.navigationRevisions.get(view)) throw new Error('页面或加载状态已变化，未重新加载');
      this.reloading.add(view);
      web.reload();
      await this.publish({ platform, switching: false });
    } catch (error) {
      this.reloading.delete(view);
      if (initialRecovery && this.failedLoads.has(view)) this.loading.delete(view);
      if (!this.disposed) await this.publish(previous);
      throw error;
    }
    return this.state;
  }

  private async switchTo(platform: WebPlatform, accountId?: string): Promise<WebPlatformState> {
    this.requireSwitchable();
    const previousAccount = this.options.accountViews?.selectedId;
    if (this.current.platform === platform && (accountId === undefined || accountId === previousAccount)) throw new Error('当前已是该平台或账号');
    const previous = this.state;
    const previousView = this.getView(previous.platform);
    this.cancelInitialRecovery();
    this.current = { ...previous, switching: true };
    // 先广播切换中，使调用者与其他 IPC 同步观察到门禁准备期。
    this.broadcast();
    try {
      await this.options.prepareSwitch();
      this.requireLive();
      const blocked = this.options.switchBlock?.();
      if (blocked) throw new Error(blocked);
      if (platform === 'chatgpt' && !this.chatgpt) {
        this.chatgpt = this.options.createChatGPT();
        this.loading.add(this.chatgpt);
        this.watchLoads('chatgpt', this.chatgpt);
        this.chatgpt.webContents.on('did-create-window', popup => {
          if (this.disposed) { if (!popup.isDestroyed()) popup.close(); return; }
          this.popups.add(popup); popup.once('closed', () => this.popups.delete(popup));
        });
      }
      if (accountId !== undefined) {
        const accounts = this.options.accountViews!;
        const existing = accounts.get(accountId);
        const view = accounts.ensure(accountId);
        if (!existing) { this.loading.add(view); this.watchLoads('deepseek', view); }
        accounts.select(accountId);
      }
      const view = this.getView(platform);
      this.options.loadingChanged?.(platform, this.loading.has(view));
      this.options.applyView(view);
      await this.publish({ platform, switching: false });
    } catch (error) {
      if (!this.disposed) {
        if (previousAccount !== undefined) this.options.accountViews!.select(previousAccount);
        this.options.applyView(previousView);
        await this.publish(previous);
      }
      throw error;
    }
    const view = this.getView(platform);
    if (!this.startedViews.has(view)) {
      this.startedViews.add(view);
      // 网络加载不占切换锁，慢页面也能立即切回 DeepSeek。
      void view.webContents.loadURL(WEB_PLATFORMS[platform].url).catch(() => { /* 主frame加载失败由watchLoads记录，错误页完成不代表成功。 */ });
    }
    return this.state;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelInitialRecovery();
    if (this.registered) {
      this.options.ipc.removeHandler(CHANNELS.getWebPlatform);
      this.options.ipc.removeHandler(CHANNELS.setWebPlatform);
      this.options.ipc.removeHandler(CHANNELS.reloadWebPlatform);
      this.options.ipc.removeHandler(CHANNELS.setDeepSeekAccount);
      this.options.ipc.removeHandler(CHANNELS.addDeepSeekAccount);
    }
    this.loadCleanup.forEach(remove => remove()); this.loadCleanup.length = 0;
    for (const popup of this.popups) if (!popup.isDestroyed()) popup.close();
    this.popups.clear();
    if (this.chatgpt && !this.chatgpt.webContents.isDestroyed()) this.chatgpt.webContents.close();
    this.chatgpt = null;
    this.options.accountViews?.dispose();
  }
}
