/** 工具设置使用原生子窗口覆盖官网视图，不改变工作区几何。 */
import { BrowserWindow, screen, type BaseWindow, type Rectangle, type WebContents } from 'electron';
import * as path from 'node:path';
import { CHANNELS } from '../shared/contract';
import type { ToolSettingsState, ToolSettingsVisibility } from '../shared/toolSettings';

export function toolSettingsBounds(anchor: Rectangle, parent: Rectangle, area: Rectangle): Rectangle {
  const left = Math.max(parent.x, area.x), top = Math.max(parent.y, area.y);
  const right = Math.min(parent.x + parent.width, area.x + area.width), bottom = Math.min(parent.y + parent.height, area.y + area.height);
  const padding = Math.max(0, Math.min(12, (right - left - 1) / 2, (bottom - top - 1) / 2));
  const width = Math.max(1, Math.min(370, right - left - padding * 2));
  const height = Math.max(1, Math.min(600, bottom - top - padding * 2));
  return { x: Math.round(Math.max(left + padding, Math.min(anchor.x + anchor.width - width, right - width - padding))),
    y: Math.round(Math.max(top + padding, Math.min(anchor.y - height - 8, bottom - height - padding))),
    width: Math.floor(width), height: Math.floor(height) };
}

export class ToolSettingsWindow {
  private window: BrowserWindow | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;
  private generation = 0;
  private root: string | null = null;
  private lastState = '';
  private readonly parentChanged = () => this.hide(false);

  constructor(private readonly parent: BaseWindow, private readonly getState: () => ToolSettingsState,
    private readonly getRoot: () => string | null, private readonly visibility: (state: ToolSettingsVisibility) => void) {
    parent.on('move', this.parentChanged); parent.on('resize', this.parentChanged); parent.on('minimize', this.parentChanged);
  }
  get contents(): WebContents | null { return this.window && !this.window.isDestroyed() ? this.window.webContents : null; }
  get current(): boolean { return !!this.window && !this.window.isDestroyed() && this.window.isVisible() && this.root === this.getRoot(); }

  async open(anchor: Rectangle): Promise<void> {
    if (this.disposed || this.parent.isDestroyed()) return;
    const generation = ++this.generation; const root = this.getRoot();
    if (!this.window || this.window.isDestroyed()) {
      const window = new BrowserWindow({ parent: this.parent, modal: false, title: '工具与提示词', show: false,
        width: 370, height: 600, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
        skipTaskbar: true, backgroundColor: '#1c1c1c', autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'toolSettingsPreload.js'), contextIsolation: true,
          nodeIntegration: false, sandbox: true, webSecurity: true, partition: 'persist:editor-ui' } });
      this.window = window; window.setMenu(null);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.on('blur', () => this.hide(false));
      window.on('close', event => { if (!this.disposed && !this.parent.isDestroyed()) { event.preventDefault(); this.hide(true); } });
      window.on('closed', () => { if (this.window === window) { this.window = null; this.loading = null; this.lastState = ''; } });
      this.loading = window.loadFile(path.join(__dirname, '..', 'renderer', 'toolSettings.html'));
    }
    const window = this.window;
    try { await this.loading; }
    catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
    if (this.disposed || this.parent.isDestroyed() || window.isDestroyed() || generation !== this.generation || root !== this.getRoot()) return;
    this.root = root;
    const parent = this.parent.getContentBounds();
    window.setBounds(toolSettingsBounds(anchor, parent, screen.getDisplayMatching(parent).workArea));
    this.publish(true); window.show(); window.focus(); this.visibility({ open: true, restoreFocus: false });
  }

  hide(restoreFocus: boolean): void {
    this.generation++;
    if (!this.window || this.window.isDestroyed()) return;
    const wasVisible = this.window.isVisible(); this.window.hide();
    if (!wasVisible || this.parent.isDestroyed()) return;
    if (restoreFocus) this.parent.focus();
    this.visibility({ open: false, restoreFocus });
  }

  publish(force = false): void {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible() && this.root !== this.getRoot()) this.hide(false);
    const contents = this.contents; if (!contents || contents.isDestroyed()) return;
    const state = this.getState(); const key = JSON.stringify(state);
    if (!force && key === this.lastState) return;
    this.lastState = key; contents.send(CHANNELS.toolSettingsState, state);
  }

  dispose(): void {
    this.disposed = true; this.generation++;
    this.parent.removeListener('move', this.parentChanged); this.parent.removeListener('resize', this.parentChanged); this.parent.removeListener('minimize', this.parentChanged);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null; this.loading = null;
  }
}
