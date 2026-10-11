/** 两个平台的本地生命周期；官网无 IPC、回复采集或发送能力。 */
import type { BrowserWindow, IpcMain, WebContents, WebContentsView } from 'electron';
import { CHANNELS } from '../shared/contract';
import { WEB_PLATFORMS, type WebPlatform, type WebPlatformState } from '../shared/webPlatform';

interface Options {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  webbar: WebContents;
  editor: WebContents;
  deepseek: WebContentsView;
  createChatGPT: () => WebContentsView;
  prepareSwitch: () => Promise<void>;
  applyView: (view: WebContentsView) => void;
  changed?: (state: WebPlatformState) => void | Promise<void>;
}

export class WebPlatformController {
  private current: WebPlatformState = { platform: 'deepseek', switching: false };
  private chatgpt: WebContentsView | null = null;
  private readonly popups = new Set<BrowserWindow>();
  private disposed = false;
  private registered = false;
  private chatgptError: string | undefined;
  private chatgptStarted = false;

  constructor(private readonly options: Options) {}
  get state(): WebPlatformState { return { ...this.current }; }
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
    return [CHANNELS.getWebPlatform, CHANNELS.setWebPlatform];
  }

  private broadcast(): void {
    for (const owner of [this.options.webbar, this.options.editor]) {
      if (!owner.isDestroyed()) owner.mainFrame.send(CHANNELS.webPlatformState, this.state);
    }
  }

  private async publish(state: WebPlatformState): Promise<void> {
    await this.options.changed?.({ ...state });
    this.requireLive();
    this.current = state;
    this.broadcast();
  }

  private requireLive(): void { if (this.disposed) throw new Error('平台入口已关闭'); }

  private async switchTo(platform: WebPlatform): Promise<WebPlatformState> {
    this.requireLive();
    if (this.current.switching) throw new Error('正在切换平台，请稍后重试');
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
        this.chatgpt.webContents.on('did-finish-load', () => {
          if (this.disposed) return;
          this.chatgptError = undefined;
          if (this.current.platform === 'chatgpt' && this.current.error) {
            const { error: _error, ...state } = this.current;
            this.current = state; this.broadcast();
          }
        });
        this.chatgpt.webContents.on('did-create-window', popup => {
          if (this.disposed) { if (!popup.isDestroyed()) popup.close(); return; }
          this.popups.add(popup); popup.once('closed', () => this.popups.delete(popup));
        });
      }
      this.options.applyView(platform === 'deepseek' ? this.options.deepseek : this.chatgpt!);
      await this.publish({ platform, switching: false, ...(platform === 'chatgpt' && this.chatgptError ? { error: this.chatgptError } : {}) });
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
      void this.chatgpt!.webContents.loadURL(WEB_PLATFORMS.chatgpt.url).catch(() => {
        if (this.disposed) return;
        this.chatgptError = 'ChatGPT 页面加载失败，请手动重试或切回 DeepSeek';
        if (this.current.platform === 'chatgpt') { this.current = { ...this.current, error: this.chatgptError }; this.broadcast(); }
      });
    }
    return this.state;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.registered) {
      this.options.ipc.removeHandler(CHANNELS.getWebPlatform);
      this.options.ipc.removeHandler(CHANNELS.setWebPlatform);
    }
    for (const popup of this.popups) if (!popup.isDestroyed()) popup.close();
    this.popups.clear();
    if (this.chatgpt && !this.chatgpt.webContents.isDestroyed()) this.chatgpt.webContents.close();
    this.chatgpt = null;
  }
}
