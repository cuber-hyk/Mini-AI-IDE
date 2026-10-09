/** 更新窗口只承载本地更新界面；关闭隐藏窗口，下载由应用级 updater 继续持有。 */
import { BrowserWindow, screen, type BaseWindow, type WebContents } from 'electron';
import * as path from 'node:path';
import { CHANNELS } from '../shared/contract';
import type { ApplicationUpdateState } from '../shared/applicationUpdate';

export class ApplicationUpdateWindow {
  private window: BrowserWindow | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;
  private hasRelease = false;

  constructor(private readonly parent: BaseWindow, private readonly getState: () => ApplicationUpdateState,
    private readonly closed: () => void) {}

  get contents(): WebContents | null { return this.window && !this.window.isDestroyed() ? this.window.webContents : null; }
  get visible(): boolean { return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible()); }

  private fit(center: boolean): void {
    if (!this.window || this.window.isDestroyed()) return;
    const parent = this.parent.getBounds();
    const area = screen.getDisplayMatching(parent).workArea;
    this.hasRelease = Boolean(this.getState().release);
    const width = Math.min(460, area.width - 24);
    const height = Math.min(this.hasRelease ? 540 : 360, area.height - 24);
    const previous = this.window.getBounds();
    const x = center ? parent.x + (parent.width - width) / 2 : previous.x;
    const y = center ? parent.y + (parent.height - height) / 2 : previous.y + (previous.height - height) / 2;
    this.window.setBounds({ x: Math.round(Math.max(area.x + 12, Math.min(x, area.x + area.width - width - 12))),
      y: Math.round(Math.max(area.y + 12, Math.min(y, area.y + area.height - height - 12))), width, height });
  }

  async open(): Promise<void> {
    if (this.disposed || this.parent.isDestroyed()) return;
    if (!this.window || this.window.isDestroyed()) {
      const window = new BrowserWindow({ parent: this.parent, modal: false, title: '软件更新', show: false,
        width: 460, height: 360, frame: false, resizable: false, minimizable: false, maximizable: false,
        backgroundColor: '#1c1c1c', autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'updatePreload.js'), contextIsolation: true,
          nodeIntegration: false, sandbox: true, webSecurity: true, partition: 'persist:editor-ui' } });
      this.window = window;
      window.setMenu(null);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.on('close', event => { if (!this.disposed && !this.parent.isDestroyed()) { event.preventDefault(); this.hide(true); } });
      window.on('closed', () => { if (this.window === window) { this.window = null; this.loading = null; } });
      this.loading = window.loadFile(path.join(__dirname, '..', 'renderer', 'update.html'));
    }
    const window = this.window;
    try { await this.loading; }
    catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
    if (this.disposed || this.parent.isDestroyed() || window.isDestroyed()) return;
    this.fit(true);
    this.publish(this.getState());
    window.show(); window.focus();
  }

  hide(restoreFocus = false): void {
    if (!this.window || this.window.isDestroyed()) return;
    const wasVisible = this.window.isVisible();
    this.window.hide();
    if (restoreFocus && wasVisible && !this.parent.isDestroyed()) { this.parent.focus(); this.closed(); }
  }

  publish(state: ApplicationUpdateState): void {
    const contents = this.contents;
    if (!contents || contents.isDestroyed()) return;
    if (Boolean(state.release) !== this.hasRelease) this.fit(false);
    contents.send(CHANNELS.updateState, state);
  }

  dispose(): void {
    this.disposed = true;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null; this.loading = null;
  }
}
