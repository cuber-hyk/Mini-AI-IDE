/** 本地加载反馈：无 preload、无 IPC；几何与可见性仍由工作区布局 owner 管理。 */
import { WebContentsView } from 'electron';
import path from 'node:path';
import type { WebPlatform } from '../shared/webPlatform';

export class WebLoadingView {
  readonly view = new WebContentsView({ webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    partition: 'web-loading-ui',
  } });
  private readonly contents = this.view.webContents;
  private platform: WebPlatform = 'deepseek';
  private loaded = false;

  constructor() {
    this.view.setBackgroundColor('#151517');
    this.contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.contents.on('will-navigate', event => event.preventDefault());
  }

  async load(): Promise<void> {
    await this.contents.loadFile(path.join(__dirname, '../renderer/webLoading.html'));
    this.loaded = true;
    this.setPlatform(this.platform);
  }

  setPlatform(platform: WebPlatform): void {
    this.platform = platform;
    if (!this.loaded || this.contents.isDestroyed()) return;
    const label = platform === 'chatgpt' ? 'ChatGPT' : 'DeepSeek';
    void this.contents.executeJavaScript(`document.getElementById('platform').textContent = ${JSON.stringify(label)}; void 0;`).catch(() => {});
  }

  dispose(): void {
    if (!this.contents.isDestroyed()) this.contents.close();
  }
}
