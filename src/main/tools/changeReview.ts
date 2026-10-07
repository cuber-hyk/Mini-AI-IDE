/** 仅在内存中保留当前工具批次的实际文件变更；不写入结果账本或剪贴板。 */
import { diffTexts, type DiffResult } from '../../shared/diff';
import type { ToolBatch, ToolResult } from '../../shared/toolProtocol';

export interface ChangeReviewScope { root: string; session: string; batchId: string; contentKey: string }
export interface ToolChangeEvent {
  id: string;
  requestId: string;
  path: string;
  operation: 'create' | 'replace' | 'overwrite';
  status: 'pending' | 'applied' | 'failed' | 'skipped' | 'undone';
  before?: string;
  after?: string;
  error?: string;
}
export interface ChangeReviewRecord extends ToolChangeEvent { diff?: DiffResult }
export interface ChangeReviewState { generation: number; scope: ChangeReviewScope | null; records: ChangeReviewRecord[] }

export class ChangeReviewOwner {
  private generation = 0;
  private scope: ChangeReviewScope | null = null;
  private records = new Map<string, ChangeReviewRecord>();
  constructor(private readonly publish: (state: ChangeReviewState) => void = () => {}) {}

  begin(scope: ChangeReviewScope, batch?: ToolBatch): number {
    if (this.scope && (Object.keys(scope) as Array<keyof ChangeReviewScope>).every(key => this.scope![key] === scope[key])) return this.generation;
    this.generation++; this.scope = { ...scope }; this.records.clear();
    for (const request of batch?.requests ?? []) {
      if (request.tool !== 'apply_changes') continue;
      (request.args.changes as Array<{ path: string; operation: ToolChangeEvent['operation'] }>).forEach((change, index) => {
        const id = request.id + ':' + index;
        this.records.set(id, { id, requestId: request.id, path: change.path, operation: change.operation, status: 'pending' });
      });
    }
    this.publish(this.getState());
    return this.generation;
  }
  clear(): void { this.generation++; this.scope = null; this.records.clear(); this.publish(this.getState()); }
  getState(): ChangeReviewState {
    return structuredClone({ generation: this.generation, scope: this.scope, records: [...this.records.values()] });
  }
  stop(token: number | undefined, error: string): void {
    if (!this.scope || token !== this.generation) return;
    for (const record of this.records.values()) if (record.status === 'pending') {
      record.status = 'skipped'; record.error = error;
    }
    this.publish(this.getState());
  }
  updateResults(results: readonly ToolResult[]): void {
    let changed = false;
    for (const result of results) {
      if (!this.scope || result.batch_id !== this.scope.batchId || result.tool !== 'apply_changes' || ['running', 'pending_permission'].includes(result.status)) continue;
      for (const record of this.records.values()) {
        if (record.requestId !== result.request_id || record.status !== 'pending') continue;
        record.status = result.status === 'failed' ? 'failed' : 'skipped';
        const reasons: Partial<Record<ToolResult['status'], string>> = {
          done: '此请求未产生当前执行快照，无法展示实际差异', failed: '修改请求失败，未执行此文件修改',
          permission_denied: '权限被拒绝，未修改文件', cancelled: '请求已取消，未修改文件',
          skipped_dependency: '前置请求未成功，未执行修改', unknown: '执行结果未知，没有可核验的文件快照',
        };
        record.error = result.error || reasons[result.status] || '没有可核验的文件变更';
        changed = true;
      }
    }
    if (changed) this.publish(this.getState());
  }
  record(token: number | undefined, event: ToolChangeEvent): void {
    if (!this.scope || token !== this.generation) return;
    const previous = this.records.get(event.id);
    // 撤销只能更新已经记录的真实修改，不凭空产生成功记录。
    if (event.status === 'undone' && previous?.status !== 'applied') return;
    const record: ChangeReviewRecord = event.status === 'undone' ? { ...previous, ...event } : { ...event };
    if (event.status === 'applied' && typeof event.before === 'string' && typeof event.after === 'string') {
      record.diff = diffTexts(event.before, event.after);
    }
    this.records.set(event.id, structuredClone(record)); this.publish(this.getState());
  }
}
