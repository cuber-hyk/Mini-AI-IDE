/** 所有打开文档的离开确认与保存回执，不持有文本或文件系统能力。 */
import type { EditorState } from '../shared/contract';
const pathKey = (path: string) => path.replace(/\\/g, '/').toLowerCase();

export class EditorSession {
  private state: EditorState = { root: null, path: null, documents: [] };
  private sequence = 0;
  private pending: { id: number; root: string | null; path: string; finish: (ok: boolean) => void } | null = null;

  constructor(private readonly ask: (file: string) => Promise<'save' | 'discard' | 'cancel'>,
    private readonly request: (id: number, path: string) => void, private readonly timeout = 15_000) {}

  update(state: EditorState): void { this.state = { ...state, documents: state.documents.map(doc => ({ ...doc })) }; }
  get current(): EditorState { return { ...this.state, documents: this.state.documents.map(doc => ({ ...doc })) }; }
  get savingPath(): string | null { return this.pending?.path ?? null; }
  get hasDirty(): boolean { return this.state.documents.some(doc => doc.dirty); }
  isDirty(path: string): boolean { return this.state.documents.some(doc => pathKey(doc.path) === pathKey(path) && doc.dirty); }
  reset(): void { this.pending?.finish(false); this.state = { root: null, path: null, documents: [] }; }

  reply(id: number, ok: boolean): boolean {
    if (!this.pending || this.pending.id !== id) return false;
    const document = this.state.documents.find(doc => doc.path === this.pending?.path);
    this.pending.finish(ok && this.state.root === this.pending.root && Boolean(document && !document.dirty));
    return true;
  }

  async canLeave(path?: string, directory = false): Promise<boolean> {
    const before = this.current;
    const matches = (target: string) => !path || pathKey(target) === pathKey(path) ||
      (directory && pathKey(target).startsWith(pathKey(path) + '/'));
    const approved = new Set<string>();
    for (const document of before.documents.filter(doc => doc.dirty && matches(doc.path))) {
      const choice = await this.ask(document.path);
      if (this.state.root !== before.root || !this.state.documents.some(doc => doc.path === document.path)) return false;
      if (choice === 'cancel') return false;
      if (choice === 'save') {
        if (this.pending) return false;
        const saved = await new Promise<boolean>((resolve) => {
          const id = ++this.sequence;
          const timer = setTimeout(() => this.pending?.id === id && this.pending.finish(false), this.timeout);
          this.pending = { id, root: before.root, path: document.path, finish: (ok) => {
            clearTimeout(timer); this.pending = null; resolve(ok);
          } };
          this.request(id, document.path);
        });
        if (!saved) return false;
      }
      approved.add(document.path);
    }
    // 确认期间新产生的脏文档也必须经过确认；放弃不提前清空任何草稿。
    return this.state.root === before.root && this.state.documents.every(doc => !matches(doc.path) || !doc.dirty || approved.has(doc.path));
  }
}
