/**
 * 回程应用与撤销（主进程专用）
 *
 * 信任边界（ADR-0004 方案 A）：
 *  - **默认只预览，不落盘**：`applyChange` 必须由用户在预览里明确点"应用"才调用；
 *  - **写入可撤销**：每次落盘前把原文存进内存快照（按文件路径，保留最近若干次）；
 *  - **精确定位与预览基线**：只能应用已准备的结果，文件变化时拒绝；
 *  - 路径仍过白名单（由 FileService 保证）。
 *
 * 快照只放在内存里（不落盘）：应用是即时交互，重启后自然失效，
 * 避免把"可能包含隐私的旧文件内容"长期写到磁盘上。
 */
import * as path from 'node:path';
import type { ApplyChangeResult, UndoResult } from '../shared/contract';
import { computeApply, type EditLocation, type EditOperation, type ParsedCodeBlock } from '../shared/returnPath';
import type { CreatedDirectory, CreatedFileIdentity, FileService } from './fileService';

/**
 * 服务层的输入形状（**已解析**：路径、操作、原文与校验基线都由主进程备好）。
 *
 * 与 `ApplyChangeInput`（IPC 入口，只含 collectionId/index/filePath）分开，
 * 是为了让"渲染进程能决定什么"最小化：它只能指定"哪个批次、第几块、写到哪个路径"，
 * 代码本体与校验基线一律由主进程掌握。
 */
export interface ResolvedApplyInput {
  source?: { collectionId: string; index: number };
  filePath: string;
  block: ParsedCodeBlock;
}

interface Snapshot {
  root: string | null;
  source?: { collectionId: string; index: number };
  relPath: string;
  before: string;
  after: string;
  at: string;
  mode: string;
  block: ParsedCodeBlock;
  createdDirectories?: CreatedDirectory[];
  createdFileIdentity?: CreatedFileIdentity;
}

export type PreparedChange =
  | { ok: true; filePath: string; fileExists: boolean; before: string; after: string;
      mode: EditOperation; rootRevision: number; locations: EditLocation[] }
  | { ok: false; error: string; reason?: string; fileExists?: boolean };
type PreparedEdit = Extract<PreparedChange, { ok: true }>;

const MAX_SNAPSHOTS = 20;

export class ReturnPathService {
  private readonly snapshots: Snapshot[] = [];
  private readonly prepared = new Map<ParsedCodeBlock, Map<string, PreparedEdit>>();
  private readonly conflicts = new Map<ParsedCodeBlock, string>();
  private readonly applied = new Set<ParsedCodeBlock>();
  private readonly initialFailures = new Map<ParsedCodeBlock, Map<string, { error: string; reason: string }>>();
  private readonly batches = new Map<ParsedCodeBlock, readonly ParsedCodeBlock[]>();
  private readonly activeTargets = new Map<ParsedCodeBlock, PreparedEdit>();

  constructor(private readonly files: FileService) {}

  /** 最近一次可撤销的快照（供 UI 显示"可撤销 N 次"） */
  get undoCount(): number {
    return this.snapshots.length;
  }

  clear(): void { this.snapshots.length = 0; this.prepared.clear(); this.conflicts.clear(); this.applied.clear(); this.initialFailures.clear(); this.batches.clear(); this.activeTargets.clear(); }

  forget(blocks: readonly ParsedCodeBlock[]): void {
    blocks.forEach((block) => { this.prepared.delete(block); this.conflicts.delete(block); this.applied.delete(block); this.initialFailures.delete(block); this.batches.delete(block); this.activeTargets.delete(block); });
  }

  isApplied(block: ParsedCodeBlock): boolean { return this.applied.has(block); }

  getPrepared(block: ParsedCodeBlock, target: string): PreparedEdit | undefined {
    const root = this.files.getRoot();
    if (!root) return undefined;
    // FileService 已核对路径；这里仅将同文件的绝对／相对写法映射到已保存结果。
    const relative = path.relative(root, path.resolve(root, target)).replace(/\\/g, '/').toLowerCase();
    return this.prepared.get(block)?.get(relative);
  }

  invalidate(filePath: string, isDirectory: boolean): void {
    const target = filePath.replace(/\\/g, '/').toLowerCase();
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const candidate = this.snapshots[i]!.relPath.replace(/\\/g, '/').toLowerCase();
      if (candidate === target || (isDirectory && candidate.startsWith(target + '/'))) this.snapshots.splice(i, 1);
    }
  }

  /** 采集时统一定位，同文件相互冲突的操作不能部分落盘。 */
  async prepareBatch(blocks: readonly ParsedCodeBlock[]): Promise<PreparedChange[]> {
    blocks.forEach(block => this.batches.set(block, blocks));
    const results = await Promise.all(blocks.map((block) => this.prepareChange(block)));
    return results.map((result, index) => this.conflicts.has(blocks[index]!)
      ? { ok: false, reason: 'operation-conflict', error: this.conflicts.get(blocks[index]!)!,
          ...(result.ok ? { fileExists: result.fileExists } : {}) } : result);
  }

  /** 改路径也属于同一批次，不能绕过采集时的同文件冲突闸门。 */
  private checkConflicts(block: ParsedCodeBlock, target: PreparedEdit): string | undefined {
    this.activeTargets.set(block, target);
    for (const peer of this.batches.get(block) ?? []) {
      if (peer === block || this.applied.has(peer)) continue;
      const other = this.activeTargets.get(peer);
      if (!other || other.filePath.toLowerCase() !== target.filePath.toLowerCase()) continue;
      if (target.before !== other.before || target.mode !== 'replace' || other.mode !== 'replace' ||
        target.locations.some(a => other.locations.some(b => a.start < b.end && b.start < a.end))) {
        const error = '同文件操作重叠、重复新建或覆盖全文与其他操作冲突，请 AI 合并为一个明确操作';
        this.conflicts.set(block, error); this.conflicts.set(peer, error);
      }
    }
    return this.conflicts.get(block);
  }

  /** 预览与应用共用准备结果；第一次准备固定磁盘原文，后续读取只验证。 */
  async prepareChange(block: ParsedCodeBlock, target: string | null = block.filePath, capture = true): Promise<PreparedChange> {
    if (block.kind === 'other') return { ok: false, error: '其他内容仅供只读查看，不可作为文件应用', reason: 'read-only-content' };
    if (block.validationError) return { ok: false, error: block.validationError, reason: 'metadata-invalid' };
    if (!block.filePath || !target) return { ok: false, error: '缺少明确文件路径，请让 AI 补充对应代码块的文件标题', reason: 'path-missing' };
    if (!block.operation) return { ok: false, error: '缺少明确操作，请使用替换、新建或覆盖全文；旧行号格式不可应用', reason: 'operation-missing' };
    const conflict = this.conflicts.get(block);
    if (conflict) return { ok: false, error: conflict, reason: 'operation-conflict' };
    const read = await this.files.readRawText(target, true);
    if (!read.ok) return read;
    const filePath = read.relPath.replace(/\\/g, '/');
    const key = filePath.toLowerCase();
    const frozen = this.prepared.get(block)?.get(key);
    if (frozen && (frozen.rootRevision !== read.rootRevision || frozen.fileExists !== read.exists || frozen.before !== read.text)) {
      return { ok: false, fileExists: read.exists, reason: 'target-changed', error: '文件已在预览后变化，请重新采集核对；不会覆盖未展示的内容' };
    }
    const baseline: PreparedEdit = frozen ?? { ok: true, filePath, fileExists: read.exists, before: read.text,
      after: read.text, mode: block.operation, rootRevision: read.rootRevision, locations: [] };
    if (capture && !frozen) {
      let targets = this.prepared.get(block);
      if (!targets) { targets = new Map(); this.prepared.set(block, targets); }
      targets.set(key, baseline);
    }
    const existenceFailure = block.operation === 'create' && read.exists
      ? { reason: 'target-exists', error: '新建目标已存在，不会覆盖已有文件' }
      : block.operation !== 'create' && !read.exists
        ? { reason: 'target-missing', error: '替换或覆盖全文要求目标文件存在，请核对路径或明确使用新建操作' } : undefined;
    if (existenceFailure && capture && !frozen) {
      let failures = this.initialFailures.get(block);
      if (!failures) { failures = new Map(); this.initialFailures.set(block, failures); }
      failures.set(key, existenceFailure);
    }
    if (existenceFailure) {
      const conflict = capture ? this.checkConflicts(block, baseline) : undefined;
      return { ok: false, fileExists: read.exists, ...(conflict ? { reason: 'operation-conflict', error: conflict } : existenceFailure) };
    }
    const initialFailure = this.initialFailures.get(block)?.get(key);
    if (initialFailure) return { ok: false, fileExists: read.exists, ...initialFailure };
    const computed = computeApply(read.text, block);
    if (!computed.ok) {
      if (capture && !frozen) {
        let targets = this.prepared.get(block);
        if (!targets) { targets = new Map(); this.prepared.set(block, targets); }
        targets.set(key, baseline);
        let failures = this.initialFailures.get(block);
        if (!failures) { failures = new Map(); this.initialFailures.set(block, failures); }
        failures.set(key, { error: computed.detail, reason: computed.reason });
      }
      const conflict = capture ? this.checkConflicts(block, baseline) : undefined;
      return { ok: false, fileExists: read.exists, error: conflict ?? computed.detail, reason: conflict ? 'operation-conflict' : computed.reason };
    }
    if (computed.text.length > this.files.characterLimit) return { ok: false, fileExists: read.exists, error: '内容超出文件写入上限' };
    const result: PreparedEdit = { ok: true, filePath, fileExists: read.exists, before: read.text, after: computed.text,
      mode: computed.mode, rootRevision: read.rootRevision, locations: computed.locations };
    if (!capture) return result;
    let targets = this.prepared.get(block);
    if (!targets) { targets = new Map(); this.prepared.set(block, targets); }
    targets.set(key, result);
    const finalConflict = this.checkConflicts(block, result);
    if (finalConflict) return { ok: false, fileExists: read.exists, error: finalConflict, reason: 'operation-conflict' };
    return result;
  }

  /** 只接受已展示的准备结果；不在应用入口新建校验基线。 */
  async applyChange(input: ResolvedApplyInput): Promise<ApplyChangeResult> {
    if (this.applied.has(input.block)) return { ok: false, reason: 'already-applied', error: '此操作已应用，请勿重复应用' };
    const frozen = this.getPrepared(input.block, input.filePath);
    if (!frozen) {
      const invalid = await this.prepareChange(input.block, input.filePath, false);
      if (!invalid.ok) return { ok: false, error: invalid.error, ...(invalid.reason ? { reason: invalid.reason } : {}) };
      return { ok: false, reason: 'preview-missing', error: '目标尚未预览，请先核对目标的差异再应用' };
    }
    const root = this.files.getRoot();
    const read = await this.prepareChange(input.block, input.filePath);
    if (!read.ok) return { ok: false, error: read.error, ...(read.reason ? { reason: read.reason } : {}) };
    if (root !== this.files.getRoot() || !this.files.isCurrentRoot(read.rootRevision)) return { ok: false, error: '目录已切换，请重新采集' };
    const created = read.mode === 'create';
    let creation: { createdDirectories: CreatedDirectory[]; createdFileIdentity: CreatedFileIdentity } | undefined;
    if (created) {
      const written = await this.files.createFile(read.filePath, read.after, read.rootRevision);
      if (!written.ok) return { ok: false, error: written.error };
      creation = { createdDirectories: written.createdDirectories, createdFileIdentity: written.createdFileIdentity };
    } else {
      const written = await this.files.writeFile(read.filePath, read.after, read.before);
      if (!written.ok) return { ok: false, error: written.error, reason: 'target-changed' };
    }
    this.snapshots.push({ root, ...(input.source ? { source: { ...input.source } } : {}), block: input.block,
      relPath: read.filePath, before: read.before, after: read.after, at: new Date().toISOString(), mode: read.mode,
      ...(creation ?? {}) });
    while (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
    this.applied.add(input.block);
    this.updateKnownFile(read.filePath, read.before, read.after, true);
    return { ok: true, filePath: read.filePath, mode: read.mode, before: read.before, after: read.after, ...(created ? { created: true } : {}) };
  }

  /** 仅 IDE 成功写入／撤销可推进已知基线；外部变化永远不能推进。 */
  private updateKnownFile(filePath: string, before: string, after: string, exists: boolean): void {
    const key = filePath.toLowerCase();
    for (const [block, targets] of this.prepared) {
      const previous = targets.get(key);
      if (!previous || this.applied.has(block) || previous.before !== before) continue;
      const computed = computeApply(after, block);
      // 即使剩余 SEARCH 失效也保存新的已知原文，下一次准备明确报告定位失败。
      if (computed.ok) targets.set(key, { ...previous, fileExists: exists, before: after, after: computed.text, locations: computed.locations });
      else targets.set(key, { ...previous, fileExists: exists, before: after, after, locations: [] });
      if (this.activeTargets.get(block)?.filePath.toLowerCase() === key) this.activeTargets.set(block, targets.get(key)!);
    }
  }

  /** 撤销最近一次应用 */
  async undoLast(expectedSource?: { collectionId: string; index: number }): Promise<UndoResult> {
    const latest = this.snapshots.at(-1);
    if (expectedSource && (!latest?.source || latest.source.collectionId !== expectedSource.collectionId || latest.source.index !== expectedSource.index)) return { ok: false, error: '最新变更不属于此工具记录，请先处理其后的修改' };
    const snap = this.snapshots.pop();
    if (!snap) return { ok: false, error: '没有可撤销的变更' };
    if (snap.root !== this.files.getRoot()) return { ok: false, error: '撤销记录属于其他目录，已失效' };

    const current = await this.files.readRawText(snap.relPath);
    if (!current.ok || current.text !== snap.after) {
      this.snapshots.push(snap);
      return { ok: false, error: '文件已在应用后修改，不能用旧记录覆盖当前内容' };
    }

    if (snap.createdDirectories !== undefined) {
      if (!snap.createdFileIdentity) { this.snapshots.push(snap); return { ok: false, error: '新增快照缺少文件身份，不能撤销' }; }
      const removed = await this.files.removeCreatedFile(snap.relPath, snap.after, snap.createdDirectories, snap.createdFileIdentity);
      if (!removed.ok) { this.snapshots.push(snap); return { ok: false, error: removed.error || '撤销新建失败' }; }
      this.applied.delete(snap.block); this.prepared.delete(snap.block);
      this.updateKnownFile(snap.relPath, snap.after, '', false);
      return { ok: true, filePath: snap.relPath, deleted: true, ...snap.source, ...(removed.error ? { warning: removed.error } : {}) };
    }

    const written = await this.files.writeFile(snap.relPath, snap.before, snap.after);
    if (!written.ok) {
      // 撤销失败则把快照放回，避免丢失撤销机会
      this.snapshots.push(snap);
      return { ok: false, error: `撤销失败：${written.error ?? '未知错误'}` };
    }
    this.applied.delete(snap.block);
    const restored = this.prepared.get(snap.block)?.get(snap.relPath.toLowerCase());
    if (restored) restored.before = snap.after;
    this.updateKnownFile(snap.relPath, snap.after, snap.before, true);
    return { ok: true, filePath: snap.relPath, ...snap.source };
  }

  /** 供测试/诊断：当前快照摘要（不含文件内容） */
  describeSnapshots(): Array<{ relPath: string; at: string; mode: string; bytes: number }> {
    return this.snapshots.map((s) => ({ relPath: s.relPath, at: s.at, mode: s.mode, bytes: s.before.length }));
  }
}
