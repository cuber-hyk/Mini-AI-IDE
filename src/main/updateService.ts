/** 应用更新的用户确认、下载和安装状态；不接触编辑器或网页。 */
export interface ReleaseInfo { version: string; notes: string }
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'confirming' | 'installing' | 'error';
export interface UpdateState { status: UpdateStatus; release: ReleaseInfo | null; percent: number; busy: boolean }
export interface UpdateBackend {
  check(): Promise<ReleaseInfo | null>;
  download(): Promise<void>;
  install(): Promise<void>;
  quit(): void;
  dispose(): void;
}
export interface UpdatePresenter {
  available(info: ReleaseInfo): Promise<boolean>;
  downloaded(info: ReleaseInfo): Promise<boolean>;
  current(): Promise<void>;
  error(message: string): Promise<void>;
  unsupported(reason: string): Promise<void>;
}

export function updateDisabledReason(environment: { packaged: boolean; platform: string; disabled: boolean; portable: boolean; installed: boolean }): string | null {
  if (environment.disabled) return '当前诊断或测试模式不检查更新。';
  if (!environment.packaged) return '开发模式不检查更新，请使用 Windows 安装版。';
  if (environment.platform !== 'win32') return '应用内更新目前仅支持 Windows 安装版。';
  if (environment.portable) return '免安装版暂不支持应用内更新，请安装 Windows 安装版以使用此功能。';
  if (!environment.installed) return '当前程序未检测到 NSIS 安装信息，请使用 Windows 安装版。';
  return null;
}

/** 远程发布说明只作为原生对话框中的文本，不执行 HTML 或远程资源。 */
export function releaseNotesText(notes: string | Array<{ version: string; note: string | null }> | null | undefined): string {
  const value = Array.isArray(notes) ? notes.map(item => `${item.version}\n${item.note ?? ''}`).join('\n\n') : notes ?? '';
  return value.replace(/<[^>]*>/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[`*_]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 4_000);
}

export class UpdateService {
  private state: UpdateState = { status: 'idle', release: null, percent: 0, busy: false };
  private disposed = false;
  private started = false;

  constructor(private readonly backend: UpdateBackend, private readonly presenter: UpdatePresenter,
    private readonly approveInstall: () => Promise<boolean>, private readonly changed: (state: UpdateState) => void,
    readonly disabledReason: string | null) {}

  get current(): UpdateState { return { ...this.state, release: this.state.release ? { ...this.state.release } : null }; }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (!this.disabledReason) void this.check(false);
  }

  async check(manual = true): Promise<void> {
    if (this.state.status === 'ready' || this.state.status === 'installing') return;
    await this.run(async () => {
      if (this.disabledReason) { if (manual) await this.presenter.unsupported(this.disabledReason); return; }
      this.set({ status: 'checking', release: null, percent: 0 });
      const release = await this.backend.check();
      if (this.disposed) return;
      this.set({ status: release ? 'available' : 'idle', release });
      if (!release) { if (manual) await this.presenter.current(); return; }
      if (await this.presenter.available(release) && !this.disposed) await this.downloadRelease();
    }, !manual);
  }

  async download(): Promise<void> {
    if (!this.state.release || !['available', 'error'].includes(this.state.status) || this.disabledReason) return;
    await this.run(() => this.downloadRelease());
  }

  async install(): Promise<void> {
    if (this.state.status !== 'ready' || this.disabledReason) return;
    await this.run(() => this.installRelease());
  }

  progress(percent: number): void {
    if (this.disposed || this.state.status !== 'downloading' || !Number.isFinite(percent)) return;
    const integer = Math.floor(Math.max(0, Math.min(100, percent)));
    if (integer !== this.state.percent) this.set({ percent: integer });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.backend.dispose();
  }

  private async downloadRelease(): Promise<void> {
    const release = this.state.release;
    if (!release || this.disposed) return;
    this.set({ status: 'downloading', percent: 0 });
    await this.backend.download();
    if (this.disposed) return;
    this.set({ status: 'ready', percent: 0 });
    if (await this.presenter.downloaded(release) && !this.disposed) await this.installRelease();
  }

  private async installRelease(): Promise<void> {
    if (this.disposed || this.state.status !== 'ready') return;
    this.set({ status: 'confirming' });
    try {
      const approved = await this.approveInstall();
      if (this.disposed) return;
      if (!approved) { this.set({ status: 'ready' }); return; }
      await this.backend.install();
      if (this.disposed) return;
      this.set({ status: 'installing' });
      this.backend.quit();
    } catch (error) {
      if (this.disposed) return;
      this.set({ status: 'error', release: null, percent: 0 });
      await this.presenter.error(this.installErrorText(error));
    }
  }

  private async run(operation: () => Promise<void>, silent = false): Promise<void> {
    if (this.disposed || this.state.busy) return;
    this.set({ busy: true });
    try { await operation(); }
    catch (error) {
      if (!this.disposed) {
        const downloadFailed = this.state.status === 'downloading';
        this.set({ status: 'error', percent: 0 });
        // 启动查询失败保持安静；用户确认后的下载失败必须明确提示。
        if (!silent || downloadFailed) await this.presenter.error(this.errorText(error)).catch(() => undefined);
      }
    } finally { if (!this.disposed) this.set({ busy: false }); }
  }

  private set(next: Partial<UpdateState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...next };
    this.changed(this.current);
  }

  private errorText(error: unknown): string {
    return `更新操作失败，请检查网络后重试。\n${releaseNotesText(error instanceof Error ? error.message : String(error)).slice(0, 600)}`;
  }

  private installErrorText(error: unknown): string {
    return `安装未能启动。请从帮助菜单重新检查更新，再下载并安装。\n${releaseNotesText(error instanceof Error ? error.message : String(error)).slice(0, 600)}`;
  }
}
