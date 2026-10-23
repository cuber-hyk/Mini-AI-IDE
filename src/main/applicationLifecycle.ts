/** 窗口关闭、托盘与显式退出的单一生命周期 owner。 */
import { Menu, Tray, nativeImage, type App, type BaseWindow, type WebContents } from 'electron';
import * as path from 'node:path';
import type { CloseBehavior } from './settings';

/** 未保存确认和清理都成功后才重入 quit；失败允许用户重试。 */
export function registerToolShutdown(application: Pick<App, 'on' | 'quit'>, approve: () => Promise<boolean>, dispose: () => Promise<void>, failed: (error: unknown) => void): void {
  let pending = false; let approved = false;
  application.on('before-quit', event => {
    if (approved) return;
    event.preventDefault(); if (pending) return; pending = true;
    void (async () => {
      try {
        if (!await approve()) { pending = false; return; }
        await dispose();
        approved = true; application.quit();
      } catch (error) { pending = false; failed(error); }
    })();
  });
}

type LifecycleWindow = Pick<BaseWindow, 'on' | 'isDestroyed' | 'isMinimized' | 'restore' | 'show' | 'hide' | 'focus' | 'setEnabled'>;

/** close 是异步请求；真实 destroyed 才表示渲染资源释放，不能紧接着 quit。 */
export async function closeApplicationContents(contents: readonly Pick<WebContents, 'isDestroyed' | 'once' | 'removeListener' | 'close'>[], timeout = 5000): Promise<void> {
  const results = await Promise.allSettled(contents.map(web => {
    if (web.isDestroyed()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const destroyed = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { web.removeListener('destroyed', destroyed); reject(new Error('关闭网页视图超时，请重试退出')); }, timeout);
      web.once('destroyed', destroyed);
      try { web.close({ waitForBeforeUnload: false }); }
      catch (error) { clearTimeout(timer); web.removeListener('destroyed', destroyed); reject(error); }
    });
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
interface LifecycleOptions {
  closeBehavior(): CloseBehavior;
  approve(): Promise<boolean>;
  cleanup(): Promise<void>;
  hideAuxiliary(): void;
  failed(error: unknown): void;
  createTray(show: () => void, quit: () => void): Pick<Tray, 'destroy'>;
}

export class ApplicationLifecycle {
  private tray: Pick<Tray, 'destroy'> | null = null;
  private quitting = false;
  private readyToClose = false;

  constructor(application: Pick<App, 'on' | 'quit'>, private readonly window: LifecycleWindow, private readonly options: LifecycleOptions) {
    registerToolShutdown(application, async () => {
      this.quitting = true;
      if (!await options.approve()) { this.quitting = false; return false; }
      if (!window.isDestroyed()) window.setEnabled(false);
      return true;
    }, async () => {
      await options.cleanup();
      this.readyToClose = true;
      this.tray?.destroy(); this.tray = null;
    }, error => {
      this.quitting = false;
      if (!window.isDestroyed()) { window.setEnabled(true); this.show(); }
      options.failed(error);
    });
    window.on('close', event => {
      if (this.readyToClose) return;
      event.preventDefault();
      if (this.quitting) return;
      if (options.closeBehavior() === 'tray') {
        try {
          this.tray ??= options.createTray(() => this.show(), () => application.quit());
          options.hideAuxiliary(); window.hide();
        } catch (error) { options.failed(error); }
      } else application.quit();
    });
    window.on('closed', () => { this.tray?.destroy(); this.tray = null; });
  }

  show(): void {
    if (this.window.isDestroyed()) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show(); this.window.focus();
  }
}

export function createApplicationTray(show: () => void, quit: () => void): Tray {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/icon.ico'));
  if (icon.isEmpty()) throw new Error('托盘图标加载失败，窗口仍保持打开');
  const tray = new Tray(icon);
  tray.setToolTip('Mini-AI-IDE');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '显示窗口', click: show }, { type: 'separator' }, { label: '退出', click: quit }]));
  tray.on('click', show); tray.on('double-click', show);
  return tray;
}
