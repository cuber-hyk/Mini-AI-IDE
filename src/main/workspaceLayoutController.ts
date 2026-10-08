/** 本地外壳与原生网页／差异视图的几何接线，不持有文件或网页写入能力。 */
import { ipcMain, type BaseWindow, type WebContentsView } from 'electron';
import { CHANNELS } from '../shared/contract';
import type { SettingsStore } from './settings';
import { computeLayout, WORKSPACE_DEFAULT_WIDTH, FILE_DEFAULT_WIDTH, TREE_DEFAULT_WIDTH, type WorkspaceLayoutOptions } from './windowLayout';

export class WorkspaceLayoutController {
  private options: WorkspaceLayoutOptions;
  private temporaryFileWidth: number | null = null;
  layout: ReturnType<typeof computeLayout>;

  constructor(private readonly win: BaseWindow,
    private readonly views: { editor: WebContentsView; web: WebContentsView; webbar: WebContentsView; preview: WebContentsView },
    private readonly settings: SettingsStore, private readonly changed: () => void) {
    this.options = { ...(settings.get().workspaceLayout ?? {}), previewVisible: false };
    const [width, height] = win.getContentSize();
    this.layout = computeLayout(width!, height!, this.options);
  }

  get state() {
    const layout = this.layout;
    return {
      layout,
      fileVisible: this.options.fileVisible !== false,
      fileMaximized: this.options.fileMaximized === true,
      previewVisible: this.options.previewVisible === true && this.options.fileVisible !== false,
      previewWidth: layout.contentBounds.width,
      previewMaxWidth: Math.max(layout.contentBounds.width,
        layout.editorBounds.width - layout.workspaceBounds.width - 360 - layout.treeBounds.width),
    };
  }

  apply(): void {
    if (this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    this.layout = computeLayout(width!, height!, this.options);
    const layout = this.layout;
    this.views.editor.setBounds(layout.editorBounds);
    this.views.webbar.setBounds(layout.webBarBounds);
    this.views.webbar.setVisible(layout.webBarBounds.width > 0);
    this.views.web.setBounds(layout.webBounds);
    this.views.web.setVisible(layout.webBounds.width > 0 && layout.webBounds.height > 0);
    this.views.preview.setBounds(layout.previewBounds);
    this.views.preview.setVisible(this.state.previewVisible && layout.previewBounds.width > 0 && layout.previewBounds.height > 0);
    for (const view of [this.views.editor, this.views.webbar, this.views.preview]) {
      if (!view.webContents.isDestroyed()) view.webContents.send(CHANNELS.chromeState, this.state);
    }
  }

  update(patch: WorkspaceLayoutOptions, persist = true) {
    if (this.win.isDestroyed()) return this.state;
    if (patch.previewVisible === false && this.temporaryFileWidth !== null) {
      this.options.fileWidth = this.temporaryFileWidth;
      this.temporaryFileWidth = null;
    }
    if (patch.fileVisible === false) this.options.fileMaximized = false;
    const widths = { ...patch };
    for (const key of ['workspaceWidth', 'fileWidth', 'treeWidth'] as const) {
      if (widths[key] !== undefined) widths[key] = Math.max(1, widths[key]!);
    }
    this.options = { ...this.options, ...widths };
    this.apply();
    if (persist) {
      const { workspaceWidth, workspaceVisible, fileWidth, fileVisible, treeWidth, treeVisible } = this.layout;
      this.settings.update({ workspaceLayout: {
        workspaceWidth: workspaceVisible ? workspaceWidth : this.options.workspaceWidth ?? WORKSPACE_DEFAULT_WIDTH,
        workspaceVisible,
        fileWidth: this.temporaryFileWidth ?? (fileVisible && !this.options.fileMaximized ? fileWidth : this.options.fileWidth ?? FILE_DEFAULT_WIDTH),
        fileVisible,
        treeWidth: treeVisible && treeWidth > 0 ? treeWidth : this.options.treeWidth ?? TREE_DEFAULT_WIDTH,
        treeVisible: this.options.treeVisible !== false,
      } });
    }
    this.changed();
    return this.state;
  }

  setPreview(width: number, temporary = false) {
    // 全屏已占满文件区，预览不能再改正常宽度或临时恢复基线。
    if (width > 0 && this.options.fileMaximized) {
      this.update({ previewVisible: true, fileVisible: true }, false);
      return { width: this.layout.contentBounds.width, visible: this.state.previewVisible };
    }
    if (width <= 0) {
      if (this.temporaryFileWidth !== null) this.options.fileWidth = this.temporaryFileWidth;
      this.temporaryFileWidth = null;
      this.update({ previewVisible: false }, false);
    } else {
      const current = this.layout.contentBounds.width;
      // 原预览窄桥仍以正文宽度表达调整，文件工作区总宽需要包含最右目录。
      if (temporary && this.temporaryFileWidth === null) this.temporaryFileWidth = this.layout.fileBounds.width;
      this.update({ previewVisible: true, fileVisible: true,
        fileWidth: Math.max(260, width || current) + this.layout.treeBounds.width }, !temporary);
    }
    return { width: this.layout.contentBounds.width, visible: this.state.previewVisible };
  }

  register(): string[] {
    const trusted = (event: Electron.IpcMainInvokeEvent, localOnly = false) => {
      const allowed = localOnly ? [this.views.editor] : [this.views.editor, this.views.preview];
      if (!allowed.some(view => event.sender === view.webContents && event.senderFrame === view.webContents.mainFrame))
        throw new Error('布局操作仅供本地界面主 frame 使用');
    };
    ipcMain.handle(CHANNELS.restoreFileWorkspace, event => {
      if (event.sender !== this.views.webbar.webContents || event.senderFrame !== this.views.webbar.webContents.mainFrame)
        throw new Error('恢复文件区仅供本地官网顶栏主 frame');
      return this.update({ fileVisible: true });
    });
    ipcMain.handle(CHANNELS.toggleWorkspace, event => {
      if (event.sender !== this.views.webbar.webContents || event.senderFrame !== this.views.webbar.webContents.mainFrame)
        throw new Error('切换工作区仅供本地官网顶栏主 frame');
      return this.update({ workspaceVisible: !this.layout.workspaceVisible });
    });
    ipcMain.handle(CHANNELS.setWorkspaceLayout, (event, raw: unknown) => {
      trusted(event, true);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('布局参数无效');
      const patch: Record<string, number | boolean> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (['workspaceWidth', 'fileWidth', 'treeWidth', 'dockHeight'].includes(key)) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10000) throw new Error('布局宽高无效');
        } else if (['workspaceVisible', 'fileVisible', 'treeVisible', 'previewVisible', 'fileMaximized'].includes(key)) {
          if (typeof value !== 'boolean') throw new Error('布局显隐无效');
        } else throw new Error('未知布局参数');
        patch[key] = value as number | boolean;
      }
      return this.update(patch, Object.keys(patch).some(key => !['dockHeight', 'previewVisible', 'fileMaximized'].includes(key)));
    });
    ipcMain.handle(CHANNELS.setSplit, (event, width: unknown) => {
      trusted(event, true);
      if (typeof width !== 'number' || !Number.isFinite(width)) throw new Error('分栏宽度无效');
      this.update({ fileWidth: width }); return { editorWidth: this.layout.fileBounds.width };
    });
    ipcMain.handle(CHANNELS.setSidebarVisible, (event, visible: unknown) => {
      trusted(event, true); this.update({ treeVisible: visible !== false });
      this.views.editor.webContents.send(CHANNELS.sidebarChanged, { visible: this.layout.treeVisible, width: this.layout.treeWidth });
      return { visible: this.layout.treeVisible };
    });
    ipcMain.handle(CHANNELS.setSidebarWidth, (event, width: unknown) => {
      trusted(event, true);
      if (typeof width !== 'number' || !Number.isFinite(width)) throw new Error('目录宽度无效');
      this.update({ treeWidth: width }); return { width: this.layout.treeWidth };
    });
    ipcMain.handle(CHANNELS.setPreviewPanel, (event, width: unknown, temporary: unknown = false) => {
      trusted(event);
      if (typeof width !== 'number' || !Number.isFinite(width) || typeof temporary !== 'boolean') throw new Error('差异宽度参数无效');
      return this.setPreview(width, temporary);
    });
    return [CHANNELS.restoreFileWorkspace, CHANNELS.toggleWorkspace, CHANNELS.setWorkspaceLayout, CHANNELS.setSplit, CHANNELS.setSidebarVisible, CHANNELS.setSidebarWidth, CHANNELS.setPreviewPanel];
  }
}
