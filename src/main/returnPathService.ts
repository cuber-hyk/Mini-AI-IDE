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
import type { FileService } from './fileService';

/**
 * 服务层的输入形状（**已解析**：路径、代码、区间、校验基线都由主进程备好）。
 *
 * 与 `ApplyChangeInput`（IPC 入口，只含 collectionId/index/filePath）分开，
 * 是为了让"渲染进程能决定什么"最小化：它只能指定"哪个批次、第几块、写到哪个路径"，
 * 代码本体与校验基线一律由主进程掌握。
 */
export interface ResolvedApplyInput {
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
  relPath: string;
  before: string;
  after: string;
  at: string;
  mode: string;
}

const MAX_SNAPSHOTS = 20;

export class ReturnPathService {
  private readonly snapshots: Snapshot[] = [];

  constructor(private readonly files: FileService) {}

  /** 最近一次可撤销的快照（供 UI 显示"可撤销 N 次"） */
  get undoCount(): number {
    return this.snapshots.length;
  }

  /**
   * 应用一个变更。
   * 步骤：读原文 → 计算新区间（含三向校验）→ 写回 → 存快照。
   * 校验失败时不写任何内容。
   */
  async applyChange(input: ResolvedApplyInput): Promise<ApplyChangeResult> {
    const read = await this.files.readRawText(input.filePath);
    if (!read.ok) return { ok: false, error: read.error };

    const before = read.text;
    const block: ParsedCodeBlock = input.block;
    const range = block.range;

    let mode: ApplyMode;
    if (range) {
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

    const written = await this.files.writeFile(input.filePath, computed.text);
    if (!written.ok) return { ok: false, error: written.error };

    this.snapshots.push({
      relPath: input.filePath,
      before,
      after: computed.text,
      at: new Date().toISOString(),
      mode: computed.mode,
    });
    while (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();

    return { ok: true, filePath: input.filePath, mode: computed.mode, before, after: computed.text };
  }

  /** 撤销最近一次应用 */
  async undoLast(): Promise<UndoResult> {
    const snap = this.snapshots.pop();
    if (!snap) return { ok: false, error: '没有可撤销的变更' };

    const written = await this.files.writeFile(snap.relPath, snap.before);
    if (!written.ok) {
      // 撤销失败则把快照放回，避免丢失撤销机会
      this.snapshots.push(snap);
      return { ok: false, error: `撤销失败：${written.error ?? '未知错误'}` };
    }
    return { ok: true, filePath: snap.relPath };
  }

  /** 供测试/诊断：当前快照摘要（不含文件内容） */
  describeSnapshots(): Array<{ relPath: string; at: string; mode: string; bytes: number }> {
    return this.snapshots.map((s) => ({ relPath: s.relPath, at: s.at, mode: s.mode, bytes: s.before.length }));
  }
}
