import type { WebContents, WebContentsView } from 'electron';
import { deepseekAccountPartition, DEFAULT_DEEPSEEK_ACCOUNT_ID } from '../shared/deepseekAccounts';

/** 每个已注册账号复用自己的原生视图；认证存储只归 Chromium session。 */
export class DeepSeekAccountViews {
  private readonly views = new Map<string, WebContentsView>();
  private activeId = DEFAULT_DEEPSEEK_ACCOUNT_ID;
  constructor(defaultView: WebContentsView, private readonly create: (partition: string) => WebContentsView) {
    this.views.set(DEFAULT_DEEPSEEK_ACCOUNT_ID, defaultView);
  }
  get selectedId(): string { return this.activeId; }
  get current(): WebContentsView { return this.views.get(this.activeId)!; }
  get(id: string): WebContentsView | undefined { return this.views.get(id); }
  idOf(web: WebContents): string | undefined {
    for (const [id, view] of this.views) if (view.webContents === web) return id;
    return undefined;
  }
  ensure(id: string): WebContentsView {
    const partition = deepseekAccountPartition(id);
    let view = this.views.get(id);
    if (!view) { view = this.create(partition); this.views.set(id, view); }
    return view;
  }
  select(id: string): void {
    if (!this.views.has(id)) throw new Error('账号视图尚未创建');
    this.activeId = id;
  }
  dispose(): void {
    for (const [id, view] of this.views) {
      if (id !== DEFAULT_DEEPSEEK_ACCOUNT_ID && !view.webContents.isDestroyed()) view.webContents.close();
    }
    this.views.clear();
  }
}
