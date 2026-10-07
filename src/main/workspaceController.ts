/** 目录和条目操作的串行入口、原生确认及编辑缓冲保护。 */
import { clipboard, dialog, ipcMain, shell, type BaseWindow, type WebContents } from 'electron';
import { CHANNELS, type EditorState, type EntryChangedEvent, type RootInfo } from '../shared/contract';
import { EditorSession } from './editorSession';
import { FileManagementService } from './fileManagement';
import type { FileService } from './fileService';
import type { WorkspaceService } from './workspaceService';

export class WorkspaceController {
  private tail: Promise<unknown> = Promise.resolve();
  readonly editor: EditorSession;
  private readonly entries: FileManagementService;

  constructor(private readonly window: BaseWindow, private readonly view: WebContents,
    private readonly files: FileService, readonly workspace: WorkspaceService,
    private readonly changed: (state: RootInfo) => void,
    private readonly entryChanged: (event: EntryChangedEvent) => void,
    private readonly hasRecords: () => boolean) {
    this.entries = new FileManagementService(files, (absolute) => shell.trashItem(absolute));
    this.editor = new EditorSession(async (file) => {
      const result = await dialog.showMessageBox(this.window, { type: 'question', title: '未保存的修改',
        message: `保存 ${file} 的修改吗？`, buttons: ['保存', '放弃', '取消'], defaultId: 0, cancelId: 2, noLink: true });
      return result.response === 0 ? 'save' : result.response === 1 ? 'discard' : 'cancel';
    }, (id, path) => this.view.send(CHANNELS.editorRequest, { id, kind: 'save', path }));
  }

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async chooseRoot(): Promise<RootInfo> {
    return this.run(async () => {
      const selected = await dialog.showOpenDialog(this.window, { properties: ['openDirectory'], title: '选择要打开的目录' });
      if (selected.canceled || !selected.filePaths[0]) return { ...this.workspace.getState(), ok: false, canceled: true };
      return this.changeRoot(selected.filePaths[0]);
    });
  }

  openRecent(index: number): Promise<RootInfo> {
    // 请求入队时捕获条目，前一个打开操作可能会重新排序最近列表。
    const root = this.workspace.getState().recentRoots[index];
    return this.run(async () => {
      if (!Number.isInteger(index) || !root) return { ...this.workspace.getState(), ok: false, error: '最近目录条目无效' };
      return this.changeRoot(root);
    });
  }

  closeRoot(): Promise<RootInfo> { return this.run(() => this.changeRoot(null)); }

  openWorkspace(index: number): Promise<RootInfo> {
    const root = this.workspace.getState().workspaceRoots[index];
    return this.run(() => {
      if (!Number.isInteger(index) || !root || !this.workspace.getState().workspaceRoots.includes(root)) {
        return { ...this.workspace.getState(), ok: false, error: '工作区条目无效，请刷新后重试' };
      }
      return this.changeRoot(root);
    });
  }

  removeWorkspace(index: number): Promise<RootInfo> {
    const root = this.workspace.getState().workspaceRoots[index];
    return this.run(async () => {
      const before = this.workspace.getState();
      if (!Number.isInteger(index) || !root || !before.workspaceRoots.includes(root)) {
        return { ...before, ok: false, error: '工作区条目无效，请刷新后重试' };
      }
      if (root.toLowerCase() === before.root?.toLowerCase()) return this.changeRoot(null, root);
      const result = this.workspace.remove(root);
      if (result.ok) this.changed(result);
      return result;
    });
  }

  private async changeRoot(root: string | null, removeRoot?: string): Promise<RootInfo> {
    const before = this.workspace.getState();
    if (root !== before.root) {
      if (!await this.editor.canLeave()) return { ...before, ok: false, canceled: true };
      if (this.hasRecords()) {
        const response = await dialog.showMessageBox(this.window, { type: 'question', title: '切换目录',
          message: '切换目录将清空当前变更预览和 AI 撤销记录。已保存的文件内容保留。',
          buttons: ['继续', '取消'], defaultId: 1, cancelId: 1, noLink: true });
        if (response.response !== 0) return { ...before, ok: false, canceled: true };
      }
    }
    const result = removeRoot !== undefined ? this.workspace.remove(removeRoot)
      : root === null ? this.workspace.close() : this.workspace.open(root);
    if (result.ok) {
      if (before.revision !== result.revision) this.editor.reset();
      this.changed(result);
    }
    return result;
  }

  write(relPath: string, text: string) {
    const operation = () => this.files.writeFile(relPath, text);
    // 保存回执是离开确认的前提；不能排在正在等待回执的切换操作后面。
    if (this.editor.savingPath === relPath) return operation();
    const revision = this.workspace.getState().revision;
    return this.run(() => revision === this.workspace.getState().revision ? operation() : { ok: false, error: '目录已切换，请重新保存' });
  }

  register(): string[] {
    const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        if (event.sender.id !== this.view.id || event.senderFrame !== this.view.mainFrame) return { ok: false, error: '此操作仅供本地编辑器主页面使用' };
        return fn(...args);
      });
    };
    handle(CHANNELS.getRecentRoots, () => this.workspace.getState().recentRoots);
    handle(CHANNELS.openRecentRoot, (index) => typeof index === 'number' ? this.openRecent(index) : { ok: false, error: '参数不合法' });
    handle(CHANNELS.openWorkspace, (index) => typeof index === 'number' ? this.openWorkspace(index) : { ok: false, error: '参数不合法' });
    handle(CHANNELS.removeWorkspace, (index) => typeof index === 'number' ? this.removeWorkspace(index) : { ok: false, error: '参数不合法' });
    handle(CHANNELS.closeRoot, () => this.closeRoot());
    handle(CHANNELS.confirmLeave, (path, root) => {
      if (path !== undefined && (typeof path !== 'string' || root !== this.files.getRoot())) return { ok: false };
      return this.run(async () => ({ ok: root !== undefined && root !== this.files.getRoot() ? false : await this.editor.canLeave(path as string | undefined) }));
    });
    handle(CHANNELS.editorReply, (id, ok) => ({ ok: typeof id === 'number' && this.editor.reply(id, ok === true) }));
    ipcMain.on(CHANNELS.editorState, (event, raw: unknown) => {
      if (event.sender.id !== this.view.id || event.senderFrame !== this.view.mainFrame || !raw || typeof raw !== 'object') return;
      const state = raw as EditorState;
      if (state.root !== this.files.getRoot() || (state.path !== null && typeof state.path !== 'string') || !Array.isArray(state.documents)) return;
      if (!state.documents.every(doc => doc && typeof doc.path === 'string' && typeof doc.dirty === 'boolean')) return;
      this.editor.update(state);
    });
    handle(CHANNELS.createEntry, (parent, name, isDirectory, root) => {
      if (root !== this.files.getRoot()) return { ok: false, error: '目录已切换，请重新操作' };
      if (typeof parent !== 'string' || typeof name !== 'string' || typeof isDirectory !== 'boolean') return { ok: false, error: '参数不合法' };
      return this.atRevision(() => this.entries.create(parent, name, isDirectory));
    });
    handle(CHANNELS.renameEntry, (relative, name, root) => {
      if (root !== this.files.getRoot()) return { ok: false, error: '目录已切换，请重新操作' };
      if (typeof relative !== 'string' || typeof name !== 'string') return { ok: false, error: '参数不合法' };
      return this.atRevision(async () => {
        const result = await this.entries.rename(relative, name);
        if (result.ok && result.oldRelPath && result.relPath && result.oldRelPath !== result.relPath) this.entryChanged({
          kind: 'renamed', oldRelPath: result.oldRelPath, relPath: result.relPath, isDirectory: result.isDirectory === true,
          revision: this.workspace.getState().revision });
        return result;
      });
    });
    handle(CHANNELS.trashEntry, (relative, root) => {
      if (root !== this.files.getRoot()) return { ok: false, error: '目录已切换，请重新操作' };
      if (typeof relative !== 'string') return { ok: false, error: '参数不合法' };
      return this.atRevision(async () => {
        const source = await this.files.resolveSafePath(relative);
        if (!source.ok) return source;
        if (!source.relative) return { ok: false, error: '不能删除根目录' };
        const normalized = source.relative.replace(/\\/g, '/');
        if (!await this.editor.canLeave(normalized, true)) return { ok: false, error: '已取消删除' };
        const response = await dialog.showMessageBox(this.window, { type: 'question', title: '移入回收站',
          message: `将“${normalized}”移入回收站？`, detail: '若目标是文件夹，其内部内容也会一起移入回收站。相关 AI 变更和撤销记录将失效。',
          buttons: ['移入回收站', '取消'], defaultId: 1, cancelId: 1, noLink: true });
        if (response.response !== 0) return { ok: false, error: '已取消删除' };
        const result = await this.entries.trash(normalized);
        if (result.ok && result.oldRelPath) this.entryChanged({ kind: 'deleted', oldRelPath: result.oldRelPath,
          isDirectory: result.isDirectory === true, revision: this.workspace.getState().revision });
        return result;
      });
    });
    handle(CHANNELS.deleteEntry, (relative, root) => {
      if (root !== this.files.getRoot()) return { ok: false, error: '目录已切换，请重新操作' };
      if (typeof relative !== 'string') return { ok: false, error: '参数不合法' };
      return this.atRevision(async () => {
        const source = await this.entries.inspect(relative);
        if (!source.ok) return source;
        if (!source.relative) return { ok: false, error: '不能永久删除根目录' };
        const normalized = source.relative.replace(/\\/g, '/');
        if (!await this.editor.canLeave(normalized, true)) return { ok: false, error: '已取消永久删除' };
        const response = await dialog.showMessageBox(this.window, { type: 'warning', title: '永久删除',
          message: `永久删除“${normalized}”？`, detail: `${source.absolute}\n${source.isDirectory ? '文件夹及其全部内容将被永久删除。' : '文件将被永久删除。'}不会进入回收站，无法通过回收站恢复。相关 AI 变更和撤销记录将失效。`,
          buttons: ['永久删除', '取消'], defaultId: 1, cancelId: 1, noLink: true });
        if (response.response !== 0) return { ok: false, error: '已取消永久删除' };
        if (!this.files.isCurrentRoot(source.rootRevision)) return { ok: false, error: '目录已切换，请重新操作' };
        const result = await this.entries.delete(normalized, source.identity);
        if (result.ok && result.oldRelPath) this.entryChanged({ kind: 'deleted', oldRelPath: result.oldRelPath,
          isDirectory: result.isDirectory === true, revision: this.workspace.getState().revision });
        return result;
      });
    });
    handle(CHANNELS.revealEntry, (relative, root) => {
      if (root !== this.files.getRoot()) return { ok: false, error: '目录已切换，请重新操作' };
      if (typeof relative !== 'string') return { ok: false, error: '参数不合法' };
      return this.atRevision(async () => {
        const source = await this.entries.inspect(relative);
        if (!source.ok) return source;
        try { shell.showItemInFolder(source.absolute); return { ok: true }; }
        catch (error) { return { ok: false, error: `无法在资源管理器中显示：${String(error)}` }; }
      });
    });
    handle(CHANNELS.copyEntryPath, (relative, relativeOnly, root) => {
      if (root !== this.files.getRoot()) return { ok: false, error: '目录已切换，请重新操作' };
      if (typeof relative !== 'string' || typeof relativeOnly !== 'boolean') return { ok: false, error: '参数不合法' };
      return this.atRevision(async () => {
        const source = await this.entries.inspect(relative);
        if (!source.ok) return source;
        try { clipboard.writeText(relativeOnly ? source.relative.replace(/\\/g, '/') || '.' : source.absolute); return { ok: true }; }
        catch (error) { return { ok: false, error: `复制路径失败：${String(error)}` }; }
      });
    });
    return [CHANNELS.getRecentRoots, CHANNELS.openRecentRoot, CHANNELS.openWorkspace, CHANNELS.removeWorkspace, CHANNELS.closeRoot, CHANNELS.confirmLeave,
      CHANNELS.editorReply, CHANNELS.createEntry, CHANNELS.renameEntry, CHANNELS.trashEntry,
      CHANNELS.deleteEntry, CHANNELS.revealEntry, CHANNELS.copyEntryPath];
  }

  private atRevision<T extends { ok: boolean; error?: string }>(operation: () => Promise<T>) {
    const revision = this.workspace.getState().revision;
    return this.run<T | { ok: false; error: string }>(() => revision === this.workspace.getState().revision ? operation() : { ok: false, error: '目录已切换，请重新操作' });
  }
}
