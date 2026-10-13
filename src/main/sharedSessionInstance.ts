/** 同一应用名与登录资料目录仅允许一个实例；第二次启动只激活已有窗口。 */
import type { App, BaseWindow } from 'electron';

type InstanceApp = Pick<App, 'on' | 'removeListener' | 'requestSingleInstanceLock'>;
type InstanceWindow = Pick<BaseWindow, 'isDestroyed' | 'isMinimized' | 'restore' | 'show' | 'focus'>;

export class SharedSessionInstance {
  private acquired: boolean | undefined;
  private window: InstanceWindow | undefined;
  private pending = false;
  private readonly secondInstance = () => {
    if (!this.window) { this.pending = true; return; }
    this.activate();
  };

  constructor(private readonly app: InstanceApp) {}

  acquire(): boolean {
    if (this.acquired !== undefined) return this.acquired;
    this.app.on('second-instance', this.secondInstance);
    try { this.acquired = this.app.requestSingleInstanceLock(); }
    catch (error) { this.app.removeListener('second-instance', this.secondInstance); throw error; }
    if (!this.acquired) {
      this.app.removeListener('second-instance', this.secondInstance);
      this.pending = false;
    }
    return this.acquired;
  }

  setWindow(window: InstanceWindow): void {
    this.window = window;
    if (this.acquired && this.pending) { this.pending = false; this.activate(); }
  }

  private activate(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}
