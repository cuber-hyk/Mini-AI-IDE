/** 工具修改复用既有回程引擎；外部授权目标使用独立 FileService，不能扩大编辑器 IPC 的根目录。 */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { ToolBatch, ToolRequest } from '../../shared/toolProtocol';
import type { ParsedCodeBlock, TextEdit } from '../../shared/returnPath';
import { FileService } from '../fileService';
import { ReturnPathService } from '../returnPathService';
import { resolveToolPath } from './files';
import type { ToolChangeEvent } from './changeReview';

interface Change { path: string; operation: 'create' | 'replace' | 'overwrite'; content?: string; edits?: { old_string: string; new_string: string }[] }
function block(change: Change, target: string): ParsedCodeBlock {
  const edits: TextEdit[] | undefined = change.edits?.map(e => ({ oldText: e.old_string, newText: e.new_string }));
  return { code: change.content ?? '', language: '', filePath: target, pathSource: 'preceding-heading', range: null,
    operation: change.operation, ...(edits ? { edits } : {}), strippedPathLine: null, start: 0, end: 0 };
}
const inside = (root: string, target: string) => { const p = path.relative(root, target); return p === '' || (!p.startsWith('..' + path.sep) && p !== '..' && !path.isAbsolute(p)); };

export async function projectAliases(root: string, target: string, documents: string[]): Promise<string[]> {
  const absolute = await resolveToolPath(root, target); const realRoot = await resolveToolPath(root, '.');
  if (!inside(realRoot, absolute)) return [];
  const aliases = new Set<string>([path.relative(realRoot, absolute).replace(/\\/g, '/')]);
  const requested = path.resolve(root, target);
  if (inside(root, requested)) aliases.add(path.relative(root, requested).replace(/\\/g, '/'));
  for (const document of documents) if ((await resolveToolPath(root, document)).toLowerCase() === absolute.toLowerCase()) aliases.add(document);
  return [...aliases];
}

/** 无文件访问的整批结构检查，在任何权限/执行前完成。 */
export function checkBatchChanges(root: string, batch: ToolBatch): void {
  const seen = new Map<string, Change[]>();
  const requests = new Map<string, string>();
  for (const req of batch.requests) {
    if (req.tool !== 'apply_changes') continue;
    for (const c of req.args.changes as Change[]) {
      const key = path.resolve(root, c.path).toLowerCase(); const previous = seen.get(key) ?? [];
      if (requests.has(key) && requests.get(key) !== req.id) throw new Error('同文件修改必须合并到一个 apply_changes 请求，整批不执行');
      requests.set(key, req.id);
      if (previous.length && (c.operation !== 'replace' || previous.some(p => p.operation !== 'replace'))) throw new Error('同一文件重复新建、覆盖或混合修改，整批不执行');
      const searches = previous.flatMap(p => p.edits ?? []).map(e => e.old_string);
      if (c.edits?.some(e => searches.some(old => old.includes(e.old_string) || e.old_string.includes(old)))) throw new Error('同文件原文请求重复或包含关系冲突，整批不执行');
      previous.push(c); seen.set(key, previous);
    }
  }
}

/** 仅解析路径元数据，不读取正文；别名不能绕过同批唯一目标。 */
export async function checkResolvedBatchChanges(root: string, batch: ToolBatch): Promise<void> {
  const requests: ToolRequest[] = [];
  for (const request of batch.requests) {
    if (request.tool !== 'apply_changes') { requests.push(request); continue; }
    const changes: Change[] = [];
    for (const c of request.args.changes as Change[]) changes.push({ ...c, path: await resolveToolPath(root, c.path) });
    requests.push({ ...request, args: { changes } });
  }
  checkBatchChanges(root, { ...batch, requests });
}

export class ToolChanges {
  private generation = 0;
  private journal: Array<{ service: ReturnPathService; root: string; relative: string; aliases: string[]; project: boolean; source: { collectionId: string; index: number }; review: ToolChangeEvent; reviewToken?: number }> = [];
  private external = new Map<string, ReturnPathService>();
  constructor(private readonly files: FileService, private readonly projectChanges: ReturnPathService,
    private readonly dirty: (relative: string) => boolean,
    private readonly allowDirty: (relative: string) => Promise<boolean>,
    private readonly notify: (relative: string, change: 'updated' | 'created' | 'deleted', discard: boolean) => void,
    private readonly documents: () => string[] = () => [],
    private readonly onReview: (event: ToolChangeEvent, token?: number) => void = () => {}) {}
  get canUndo(): boolean { return this.journal.length > 0; }
  reset(): void { this.generation++; this.journal = []; this.external.clear(); }
  invalidate(relative: string, isDirectory: boolean): void {
    const key = relative.replace(/\\/g, '/').toLowerCase();
    this.journal = this.journal.filter(item => !item.project || !item.aliases.some(alias => {
      const candidate = alias.replace(/\\/g, '/').toLowerCase();
      return candidate === key || (isDirectory && candidate.startsWith(key + '/'));
    }));
  }

  async execute(root: string, request: ToolRequest, reviewToken?: number): Promise<unknown> {
    if (this.files.getRoot() !== root) throw new Error('目录已切换');
    const generation = this.generation;
    const reviews: ToolChangeEvent[] = (request.args.changes as Change[]).map((change, index) => ({
      id: request.id + ':' + index, requestId: request.id, path: change.path, operation: change.operation, status: 'pending',
    }));
    const terminal = new Set<string>(); let currentIndex = 0;
    const publish = (index: number, update: Partial<ToolChangeEvent>) => {
      const review = { ...reviews[index]!, ...update };
      if (review.status !== 'pending') terminal.add(review.id);
      this.onReview(review, reviewToken); return review;
    };
    reviews.forEach((review) => this.onReview(review, reviewToken));
    const stopRemaining = (error: string) => reviews.forEach((review, index) => {
      if (!terminal.has(review.id)) publish(index, { status: index === currentIndex ? 'failed' : 'skipped', error });
    });
    try {
      const items: Array<{ change: Change; service: ReturnPathService; block: ParsedCodeBlock; relative: string; aliases: string[]; project: boolean; discard: boolean }> = [];
      for (const change of request.args.changes as Change[]) {
        currentIndex = items.length;
        const absolute = await resolveToolPath(root, change.path);
        const realRoot = await resolveToolPath(root, '.');
        const project = inside(realRoot, absolute);
        const relative = project ? path.relative(realRoot, absolute).replace(/\\/g, '/') : path.basename(absolute);
        let service = this.projectChanges;
        if (!project) {
          let parent = path.dirname(absolute);
          for (;;) {
            try { if (!(await fs.stat(parent)).isDirectory()) throw new Error('外部目标父级不是目录'); break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(parent) === parent) throw error; parent = path.dirname(parent); }
          }
          service = this.external.get(parent)!;
          if (!service) { const files = new FileService(); files.setRoot(parent); service = new ReturnPathService(files); this.external.set(parent, service); }
          const externalRelative = path.relative(parent, absolute).replace(/\\/g, '/');
          items.push({ change, service, block: block(change, externalRelative), relative: externalRelative, aliases: [], project: false, discard: false });
          continue;
        }
        const aliases = project ? await projectAliases(root, change.path, this.documents()) : [];
        items.push({ change, service, block: block(change, relative), relative, aliases, project, discard: false });
      }
      for (const service of new Set(items.map(i => i.service))) await service.prepareBatch(items.filter(i => i.service === service).map(i => i.block));
      // 本请求先全部校验与确认，再产生任何写盘；不同请求保留已执行事实。
      for (const item of items) {
        currentIndex = items.indexOf(item);
        const prepared = await item.service.prepareChange(item.block, item.relative);
        if (!prepared.ok) throw new Error(prepared.error);
        for (const alias of item.aliases.filter(p => this.dirty(p))) {
          if (!await this.allowDirty(alias)) throw new Error('用户停止修改，未保存内容与磁盘均保留'); item.discard = true;
        }
      }
      const outcomes: unknown[] = [];
      for (const item of items) {
        currentIndex = items.indexOf(item);
        if (this.files.getRoot() !== root) throw new Error('目录已切换，停止剩余修改');
        // 确认期间产生新草稿的目标也必须经过处理。
        if (!item.discard) for (const alias of item.aliases.filter(p => this.dirty(p))) {
          if (!await this.allowDirty(alias)) throw new Error('用户停止修改'); item.discard = true;
        }
        const source = { collectionId: 'tool-' + randomUUID(), index: 0 };
        const outcome = await item.service.applyChange({ source, filePath: item.relative, block: item.block });
        const { before: _before, after: _after, ...summary } = outcome;
        outcomes.push({ path: item.change.path, ...summary });
        if (!outcome.ok) { stopRemaining(outcome.error || '修改失败'); return { status: 'failed', outcomes, error: outcome.error }; }
        const review = publish(currentIndex, { status: 'applied', before: outcome.before!, after: outcome.after! });
        if (generation === this.generation) this.journal.push({ service: item.service, root, relative: item.relative, aliases: item.aliases, project: item.project, source, review, ...(reviewToken === undefined ? {} : { reviewToken }) });
        if (this.journal.length > 20) this.journal.shift();
        for (const alias of item.aliases) this.notify(alias, outcome.created ? 'created' : 'updated', item.discard);
      }
      return { status: 'done', outcomes };
    } catch (error) { stopRemaining(error instanceof Error ? error.message : String(error)); throw error; }
  }

  async undo(): Promise<{ ok: boolean; error?: string }> {
    const last = this.journal.at(-1);
    if (!last) return { ok: false, error: '没有工具修改可撤销' };
    if (this.files.getRoot() !== last.root) return { ok: false, error: '目录已切换' };
    if (last.aliases.some(p => this.dirty(p))) return { ok: false, error: '请先处理目标文件未保存内容再撤销' };
    const result = await last.service.undoLast(last.source);
    if (result.ok) {
      this.journal.pop(); this.onReview({ ...last.review, status: 'undone' }, last.reviewToken);
      for (const alias of last.aliases) this.notify(alias, result.deleted ? 'deleted' : 'updated', false);
    }
    return result;
  }
}
