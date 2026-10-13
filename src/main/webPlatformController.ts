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

  constructor(private readonly options: Options) { this.watchLoads('deepseek', options.deepseek); }
  get state(): WebPlatformState {
    const { switchBlockedReason: _previous, error: _error, reloading: _reloading, ...state } = this.current;
    const switchBlockedReason = this.options.switchBlock?.();
    return { ...state, ...(this.loadErrors[state.platform] ? { error: this.loadErrors[state.platform] } : {}),
      ...(this.reloading.has(state.platform) ? { reloading: true as const } : {}), ...(switchBlockedReason ? { switchBlockedReason } : {}) };
  }

  private watchLoads(platform: WebPlatform, view: WebContentsView): void {
    const web = view.webContents;
    const start = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (!this.disposed && mainFrame && !inPlace) this.failedLoads.delete(platform);
    };
    const failed = (_event: unknown, code: number, description: string, _url: string, mainFrame: boolean) => {
      if (this.disposed || !mainFrame) return;
      this.failedLoads.add(platform);
      if (code === -3) return;
      const name = platform === 'deepseek' ? 'DeepSeek' : 'ChatGPT';
      const errorCode = /^ERR_[A-Z0-9_]{1,56}$/.test(description) ? description : 'ERR_FAILED';
      const numericCode = Number.isInteger(code) && code < 0 && code >= -1000 ? code : -2;
      this.loadErrors[platform] = `${name} 页面加载失败（${errorCode} / ${numericCode}），请重新加载`;
      process.stderr.write(`[web:${platform}] 加载失败 ${numericCode} ${errorCode}\n`);
      if (this.current.platform === platform) this.broadcast();
    };
    const finished = () => {
      if (this.disposed || this.failedLoads.has(platform)) return;
      const hadError = !!this.loadErrors[platform]; delete this.loadErrors[platform];
      process.stdout.write(`[web:${platform}] 官网加载完成\n`);
      if (hadError && this.current.platform === platform) this.broadcast();
    };
    const stopped = () => {
      if (!this.disposed && this.reloading.delete(platform) && this.current.platform === platform) this.broadcast();
    };
    web.on('did-start-navigation', start); web.on('did-fail-load', failed);
    web.on('did-finish-load', finished); web.on('did-stop-loading', stopped);
    this.loadCleanup.push(() => {
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

  private async reloadFailed(): Promise<WebPlatformState> {
    this.requireLive();
    const previous = this.state; const platform = previous.platform;
    if (previous.switching || previous.reloading) throw new Error('正在重新加载，请稍候');
    if (previous.switchBlockedReason) throw new Error(previous.switchBlockedReason);
    if (!previous.error) throw new Error('当前官网没有加载失败，不需重新加载');
    const web = this.getView(platform).webContents;
    const officialPage = () => {
      if (web.isDestroyed()) return false;
      try {
        const url = new URL(web.getURL());
        return url.origin === new URL(WEB_PLATFORMS[platform].url).origin && !url.username && !url.password;
      } catch { return false; }
    };
    if (!officialPage()) throw new Error('当前页面不属于该官网，未重新加载');
    this.current = { ...previous, switching: true }; this.broadcast();
    try {
      await this.options.prepareSwitch(); this.requireLive();
      const blocked = this.options.switchBlock?.();
      if (blocked) throw new Error(blocked);
      if (!officialPage() || !this.loadErrors[platform]) throw new Error('页面或加载状态已变化，未重新加载');
      this.reloading.add(platform);
      web.reload();
      await this.publish({ platform, switching: false });
    } catch (error) {
      this.reloading.delete(platform);
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
    this.current = { ...previous, switching: true };
    // 先广播切换中，使调用者与其他 IPC 同步观察到门禁准备期。
    this.broadcast();
    try {
      await this.options.prepareSwitch();
      this.requireLive();
      if (platform === 'chatgpt' && !this.chatgpt) {
        this.chatgpt = this.options.createChatGPT();
        this.watchLoads('chatgpt', this.chatgpt);
        this.chatgpt.webContents.on('did-create-window', popup => {
          if (this.disposed) { if (!popup.isDestroyed()) popup.close(); return; }
          this.popups.add(popup); popup.once('closed', () => this.popups.delete(popup));
        });
      }
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
