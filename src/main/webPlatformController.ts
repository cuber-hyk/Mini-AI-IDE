/** 两个平台的本地生命周期；官网无 IPC、回复采集或发送能力。 */
import type { BrowserWindow, IpcMain, WebContents, WebContentsView } from 'electron';
import { CHANNELS } from '../shared/contract';
import { WEB_PLATFORMS, type WebPlatform, type WebPlatformState, type WebPlatformSwitchBlock } from '../shared/webPlatform';

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
  private readonly loadErrors: Partial<Record<WebPlatform, string>> = {};
  private readonly failedLoads = new Set<WebPlatform>();
  private readonly reloading = new Set<WebPlatform>();
  private readonly loadCleanup: Array<() => void> = [];
  private chatgptStarted = false;
  private lastSwitchBlockedReason: WebPlatformSwitchBlock | undefined;
  private readonly loading = new Set<WebPlatform>(['deepseek']);
  private readonly resumeReadiness = new Map<WebPlatform, () => void>();
  private deepseekStarted = false;
  private initialRecoveryAvailable = false;
  private initialNavigationSeen = false;
  private initialRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly navigationRevisions = new Map<WebPlatform, number>();

  constructor(private readonly options: Options) {
    this.watchLoads('deepseek', options.deepseek);
    options.loadingChanged?.('deepseek', true);
  }
  get state(): WebPlatformState {
    const { switchBlockedReason: _previous, error: _error, reloading: _reloading, ...state } = this.current;
    const switchBlockedReason = this.options.switchBlock?.();
    return { ...state, ...(this.loadErrors[state.platform] ? { error: this.loadErrors[state.platform] } : {}),
      ...(this.reloading.has(state.platform) ? { reloading: true as const } : {}), ...(switchBlockedReason ? { switchBlockedReason } : {}) };
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
    this.reloading.delete('deepseek');
    if (this.failedLoads.has('deepseek')) this.loading.delete('deepseek');
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
      if (this.current.platform === platform) this.options.loadingChanged?.(platform, this.loading.has(platform));
    };
    const ready = async (revision: number): Promise<void> => {
      timer = undefined;
      if (this.current.platform !== platform || checkingRevision === revision || !this.loading.has(platform)) return;
      checkingRevision = revision;
      let visibleContent = false;
      try { visibleContent = await (this.options.contentReady ?? webContentReady)(web); } catch { /* 导航或销毁中的读取不表示已渲染。 */ }
      if (checkingRevision === revision) checkingRevision = undefined;
      if (this.disposed || web.isDestroyed() || revision !== generation || this.failedLoads.has(platform)) return;
      // 未知布局最多观察 10 秒；网络文档已完成后不无限遮挡用户可手动操作的页面。
      if (visibleContent || Date.now() >= deadline) { clear(); this.loading.delete(platform); present(); }
      else if (this.current.platform === platform) { timer = setTimeout(() => { void ready(revision); }, 250); timer.unref?.(); }
    };
    this.resumeReadiness.set(platform, () => { if (finishedDocument && !timer) void ready(generation); });
    const start = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (this.disposed || !mainFrame) return;
      this.navigationRevisions.set(platform, (this.navigationRevisions.get(platform) ?? 0) + 1);
      if (platform === 'deepseek') {
        if (this.initialRecoveryTimer !== undefined) this.cancelInitialRecovery();
        if (this.initialRecoveryAvailable) {
          if (this.initialNavigationSeen || _url !== WEB_PLATFORMS.deepseek.url) this.initialRecoveryAvailable = false;
          this.initialNavigationSeen = true;
        }
      }
      if (!inPlace) {
        clear();
        finishedDocument = false; this.failedLoads.delete(platform); this.loading.add(platform); present();
      }
    };
    const failed = (_event: unknown, code: number, description: string, url: string, mainFrame: boolean) => {
      if (this.disposed || !mainFrame) return;
      const recoverInitial = platform === 'deepseek' && this.initialRecoveryAvailable && code === -100 && description === 'ERR_CONNECTION_CLOSED' &&
        url === WEB_PLATFORMS.deepseek.url && this.current.platform === 'deepseek' && !this.current.switching && !this.options.switchBlock?.();
      if (platform === 'deepseek') this.cancelInitialRecovery();
      this.failedLoads.add(platform);
      clear(); this.loading.delete(platform); if (!recoverInitial) present();
      if (code === -3) return;
      const name = platform === 'deepseek' ? 'DeepSeek' : 'ChatGPT';
      const errorCode = /^ERR_[A-Z0-9_]{1,56}$/.test(description) ? description : 'ERR_FAILED';
      const numericCode = Number.isInteger(code) && code < 0 && code >= -1000 ? code : -2;
      this.loadErrors[platform] = `${name} 页面加载失败（${errorCode} / ${numericCode}），请重新加载`;
      process.stderr.write(`[web:${platform}] 加载失败 ${numericCode} ${errorCode}\n`);
      if (recoverInitial) {
        const revision = generation;
        this.reloading.add(platform); this.loading.add(platform);
        this.initialRecoveryTimer = setTimeout(() => {
          if (this.disposed || web.isDestroyed() || revision !== generation || this.current.platform !== 'deepseek' ||
            this.current.switching || this.options.switchBlock?.() || web.getURL() !== WEB_PLATFORMS.deepseek.url) {
            this.cancelInitialRecovery(); return;
          }
          this.initialRecoveryTimer = undefined;
          process.stdout.write('[web:deepseek] 首次连接关闭，自动恢复一次\n');
          void this.reloadFailed(true).catch(() => { if (!this.disposed) process.stderr.write('[web:deepseek] 首次自动恢复已停止，保留手动重载\n'); });
        }, 1000);
        this.initialRecoveryTimer.unref?.();
      }
      if (this.current.platform === platform) this.broadcast();
    };
    const finished = () => {
      if (this.disposed || this.failedLoads.has(platform)) return;
      if (platform === 'deepseek') this.cancelInitialRecovery();
      const hadError = !!this.loadErrors[platform]; delete this.loadErrors[platform];
      clear(); finishedDocument = true; deadline = Date.now() + 10_000;
      deadlineTimer = setTimeout(() => { clear(); this.loading.delete(platform); present(); }, 10_000);
      deadlineTimer.unref?.();
      void ready(generation);
      process.stdout.write(`[web:${platform}] 官网加载完成\n`);
      if (hadError && this.current.platform === platform) this.broadcast();
    };
    const stopped = () => {
      if (!this.disposed && !(platform === 'deepseek' && this.initialRecoveryTimer !== undefined) && this.reloading.delete(platform) && this.current.platform === platform) this.broadcast();
    };
    web.on('did-start-navigation', start); web.on('did-fail-load', failed);
    web.on('did-finish-load', finished); web.on('did-stop-loading', stopped);
    this.loadCleanup.push(() => {
      clear();
      this.resumeReadiness.delete(platform);
      web.removeListener('did-start-navigation', start); web.removeListener('did-fail-load', failed);
      web.removeListener('did-finish-load', finished); web.removeListener('did-stop-loading', stopped);
    });
  }
  refreshSwitchAvailability(): void {
    if (this.disposed || this.options.switchBlock?.() === this.lastSwitchBlockedReason) return;
    this.broadcast(true);
  }
  getView(platform: WebPlatform): WebContentsView {
    if (platform === 'deepseek') return this.options.deepseek;
    if (!this.chatgpt) throw new Error('ChatGPT 视图尚未创建');
    return this.chatgpt;
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
    return [CHANNELS.getWebPlatform, CHANNELS.setWebPlatform, CHANNELS.reloadWebPlatform];
  }

  private broadcast(topbarOnly = false): void {
    const state = this.state;
    if (!topbarOnly) this.options.loadingChanged?.(state.platform, this.loading.has(state.platform));
    this.resumeReadiness.get(state.platform)?.();
    this.lastSwitchBlockedReason = state.switchBlockedReason;
    for (const owner of topbarOnly ? [this.options.webbar] : [this.options.webbar, this.options.editor]) {
      if (!owner.isDestroyed()) owner.mainFrame.send(CHANNELS.webPlatformState, state);
    }
  }

  private async publish(state: WebPlatformState): Promise<void> {
    await this.options.changed?.({ ...state, ...(this.loadErrors[state.platform] ? { error: this.loadErrors[state.platform] } : {}) });
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
    const web = this.getView(platform).webContents;
    const navigationRevision = this.navigationRevisions.get(platform);
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
      if (!officialPage() || !this.loadErrors[platform] || navigationRevision !== this.navigationRevisions.get(platform)) throw new Error('页面或加载状态已变化，未重新加载');
      this.reloading.add(platform);
      web.reload();
      await this.publish({ platform, switching: false });
    } catch (error) {
      this.reloading.delete(platform);
      if (initialRecovery && this.failedLoads.has(platform)) this.loading.delete(platform);
      if (!this.disposed) await this.publish(previous);
      throw error;
    }
    return this.state;
  }

  private async switchTo(platform: WebPlatform): Promise<WebPlatformState> {
    this.requireLive();
    if (this.current.switching) throw new Error('正在切换平台，请稍后重试');
    const blocked = this.state.switchBlockedReason;
    if (blocked) throw new Error(blocked);
    if (this.current.platform === platform) throw new Error('当前已是该平台');
    const previous = this.state;
    this.cancelInitialRecovery();
    this.current = { ...previous, switching: true };
    // 先广播切换中，使调用者与其他 IPC 同步观察到门禁准备期。
    this.broadcast();
    try {
      await this.options.prepareSwitch();
      this.requireLive();
      if (platform === 'chatgpt' && !this.chatgpt) {
        this.loading.add('chatgpt');
        this.chatgpt = this.options.createChatGPT();
        this.watchLoads('chatgpt', this.chatgpt);
        this.chatgpt.webContents.on('did-create-window', popup => {
          if (this.disposed) { if (!popup.isDestroyed()) popup.close(); return; }
          this.popups.add(popup); popup.once('closed', () => this.popups.delete(popup));
        });
      }
      this.options.loadingChanged?.(platform, this.loading.has(platform));
      this.options.applyView(platform === 'deepseek' ? this.options.deepseek : this.chatgpt!);
      await this.publish({ platform, switching: false });
    } catch (error) {
      if (!this.disposed) {
        this.options.applyView(previous.platform === 'deepseek' ? this.options.deepseek : this.chatgpt!);
        await this.publish(previous);
      }
      throw error;
    }
    if (platform === 'chatgpt' && !this.chatgptStarted) {
      this.chatgptStarted = true;
      // 网络加载不占切换锁，慢页面也能立即切回 DeepSeek。
      void this.chatgpt!.webContents.loadURL(WEB_PLATFORMS.chatgpt.url).catch(() => { /* 主frame加载失败由watchLoads记录，错误页完成不代表成功。 */ });
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
    }
    this.loadCleanup.forEach(remove => remove()); this.loadCleanup.length = 0;
    for (const popup of this.popups) if (!popup.isDestroyed()) popup.close();
    this.popups.clear();
    if (this.chatgpt && !this.chatgpt.webContents.isDestroyed()) this.chatgpt.webContents.close();
    this.chatgpt = null;
  }
}
