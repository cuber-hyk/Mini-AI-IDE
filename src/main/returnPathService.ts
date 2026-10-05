/**
 * 回程应用与撤销（主进程专用）
 *
 * 信任边界（ADR-0004 方案 A）：
 *  - **默认只预览，不落盘**：`applyChange` 必须由用户在预览里明确点"应用"才调用；
 *  - **写入可撤销**：每次落盘前把原文存进内存快照（按文件路径，保留最近若干次）；
 *  - **三向校验**：片段替换必须通过 computeApply 的校验，任何不符**直接拒绝**；
 *  - 路径仍过白名单（由 FileService 保证）。
 *
 * 快照只放在内存里（不落盘）：应用是即时交互，重启后自然失效，
 * 避免把"可能包含隐私的旧文件内容"长期写到磁盘上。
 */
import type { ApplyChangeResult, UndoResult } from '../shared/contract';
import { computeApply, type ApplyMode, type ParsedCodeBlock } from '../shared/returnPath';
import type { CreatedDirectory, CreatedFileIdentity, FileService } from './fileService';

/**
 * 服务层的输入形状（**已解析**：路径、代码、区间、校验基线都由主进程备好）。
 *
 * 与 `ApplyChangeInput`（IPC 入口，只含 collectionId/index/filePath）分开，
 * 是为了让"渲染进程能决定什么"最小化：它只能指定"哪个批次、第几块、写到哪个路径"，
 * 代码本体与校验基线一律由主进程掌握。
 */
export interface ResolvedApplyInput {
  /** 预览时的目标存在状态；改变时不能把新建静默转换成覆盖。 */
  expectedFileExists?: boolean;
  /** 变更列表的批次与片段身份，供撤销后只复位对应条目。 */
  source?: { collectionId: string; index: number };
  /** 目标文件（相对根目录） */
  filePath: string;
  /** 代码块（含代码本体与行区间） */
  block: ParsedCodeBlock;
  /** 片段替换的校验基线（复制那一刻该区间的原文） */
  expectedOriginal?: string;
  contextPrev?: string | null;
  contextNext?: string | null;
}

interface Snapshot {
  root: string | null;
  source?: { collectionId: string; index: number };
  relPath: string;
  before: string;
  after: string;
  at: string;
  mode: string;
  createdDirectories?: CreatedDirectory[];
  createdFileIdentity?: CreatedFileIdentity;
}

export type PreparedChange =
  | { ok: true; filePath: string; fileExists: boolean; before: string; after: string; mode: string; rootRevision: number }
  | { ok: false; error: string; reason?: string; fileExists?: boolean };

const MAX_SNAPSHOTS = 20;

export class ReturnPathService {
  private readonly snapshots: Snapshot[] = [];

  constructor(private readonly files: FileService) {}

  /** 最近一次可撤销的快照（供 UI 显示"可撤销 N 次"） */
  get undoCount(): number {
    return this.snapshots.length;
  }

  clear(): void { this.snapshots.length = 0; }

  invalidate(filePath: string, isDirectory: boolean): void {
    const target = filePath.replace(/\\/g, '/').toLowerCase();
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const candidate = this.snapshots[i]!.relPath.replace(/\\/g, '/').toLowerCase();
      if (candidate === target || (isDirectory && candidate.startsWith(target + '/'))) this.snapshots.splice(i, 1);
    }
  }

  /** 预览与应用共用目标准备；合法缺失文件只返回空原文，不创建任何内容。 */
  async prepareChange(block: ParsedCodeBlock, target: string | null = block.filePath): Promise<PreparedChange> {
    if (block.kind === 'other') return { ok: false, error: '其他内容仅供只读查看，不可作为文件应用', reason: 'read-only-content' };
    if (block.validationError) return { ok: false, error: block.validationError, reason: 'metadata-invalid' };
    if (!block.filePath || !target) return { ok: false, error: '缺少明确文件路径，请让 AI 补充对应代码块的文件标题', reason: 'path-missing' };
    const read = await this.files.readRawText(target, true);
    if (!read.ok) return read;
    if (read.exists && !block.range) return { ok: false, fileExists: true, error: '已有文件缺少原替换范围，请让 AI 补充范围；不会自动覆盖整文件', reason: 'range-missing' };
    const lines = read.text.split(/\r\n|\r|\n/);
    const mode: ApplyMode = read.exists && block.range ? {
      kind: 'replace-lines', start: block.range.start, end: block.range.end,
      expectedOriginal: lines.slice(block.range.start - 1, block.range.end).join('\n'),
      contextPrev: block.range.start - 2 >= 0 ? (lines[block.range.start - 2] ?? null) : null,
      contextNext: block.range.end < lines.length ? (lines[block.range.end] ?? null) : null,
    } : { kind: 'replace-whole-file' };
    const computed = computeApply(read.text, block, mode);
    if (!computed.ok) return { ok: false, fileExists: read.exists, error: computed.detail, reason: computed.reason };
    if (computed.text.length > this.files.characterLimit) return { ok: false, fileExists: read.exists, error: '内容超出文件写入上限' };
    return { ok: true, filePath: read.relPath.replace(/\\/g, '/'), fileExists: read.exists,
      before: read.text, after: computed.text, mode: read.exists ? computed.mode : 'create-file', rootRevision: read.rootRevision };
  }

  /**
   * 应用一个变更。
   * 步骤：读原文 → 计算新区间（含三向校验）→ 写回 → 存快照。
   * 校验失败时不写任何内容。
   */
  async applyChange(input: ResolvedApplyInput): Promise<ApplyChangeResult> {
    const root = this.files.getRoot();
    const read = await this.prepareChange(input.block, input.filePath);
    if (input.expectedFileExists !== undefined && read.fileExists !== undefined && input.expectedFileExists !== read.fileExists) return {
      ok: false, reason: 'target-changed', error: '目标文件的存在状态已在预览后改变，请重新核对；不会覆盖新出现的同名文件',
    };
    if (!read.ok) return { ok: false, error: read.error, ...(read.reason ? { reason: read.reason } : {}) };
    const filePath = read.filePath;

    const before = read.before;
    const block: ParsedCodeBlock = input.block;
    const range = block.range;

    let mode: ApplyMode;
    if (read.fileExists && range) {
      if (typeof input.expectedOriginal !== 'string') {
        return {
          ok: false,
          error: '片段替换缺少校验基线（复制时的原文），已拒绝写入（这是刻意的安全限制）',
          reason: 'content-mismatch',
        };
      }
      mode = {
        kind: 'replace-lines',
        start: range.start,
        end: range.end,
        expectedOriginal: input.expectedOriginal,
        contextPrev: input.contextPrev ?? null,
        contextNext: input.contextNext ?? null,
      };
    } else {
      mode = { kind: 'replace-whole-file' };
    }

    const computed = computeApply(before, block, mode);
    if (!computed.ok) {
      return { ok: false, error: computed.detail, reason: computed.reason };
    }

    if (root !== this.files.getRoot() || !this.files.isCurrentRoot(read.rootRevision)) return { ok: false, error: '目录已切换，请重新采集' };
    const created = !read.fileExists;
    let creation: { createdDirectories: CreatedDirectory[]; createdFileIdentity: CreatedFileIdentity } | undefined;
    if (created) {
      const written = await this.files.createFile(filePath, computed.text, read.rootRevision);
      if (!written.ok) return { ok: false, error: written.error };
      creation = { createdDirectories: written.createdDirectories, createdFileIdentity: written.createdFileIdentity };
    } else {
      const written = await this.files.writeFile(filePath, computed.text);
      if (!written.ok) return { ok: false, error: written.error };
    }

    this.snapshots.push({
      root,
      ...(input.source ? { source: { ...input.source } } : {}),
      relPath: filePath,
      before,
      after: computed.text,
      at: new Date().toISOString(),
      mode: created ? 'create-file' : computed.mode,
      ...(creation ?? {}),
    });
    while (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();

    return { ok: true, filePath, mode: created ? 'create-file' : computed.mode, before, after: computed.text, ...(created ? { created: true } : {}) };
  }

  /** 撤销最近一次应用 */
  async undoLast(): Promise<UndoResult> {
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
      return { ok: true, filePath: snap.relPath, deleted: true, ...snap.source, ...(removed.error ? { warning: removed.error } : {}) };
    }

    const written = await this.files.writeFile(snap.relPath, snap.before);
    if (!written.ok) {
      // 撤销失败则把快照放回，避免丢失撤销机会
      this.snapshots.push(snap);
      return { ok: false, error: `撤销失败：${written.error ?? '未知错误'}` };
    }
    return { ok: true, filePath: snap.relPath, ...snap.source };
  }

  /** 供测试/诊断：当前快照摘要（不含文件内容） */
  describeSnapshots(): Array<{ relPath: string; at: string; mode: string; bytes: number }> {
    return this.snapshots.map((s) => ({ relPath: s.relPath, at: s.at, mode: s.mode, bytes: s.before.length }));
  }
}
