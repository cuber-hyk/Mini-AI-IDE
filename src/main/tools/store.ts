import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TOOL_NAMES, ToolBatch, ToolConfig, ToolResult } from '../../shared/toolProtocol';

export type RuleAction = 'allow' | 'ask' | 'deny';
interface Rule { root: string; fingerprint: string; action: RuleAction }
export interface LedgerEntry {
  scope: string;
  batch_id: string;
  hash: string;
  at: number;
  requests: Array<Pick<ToolResult, 'request_id' | 'tool' | 'status'>>;
}
interface StoreData { version: 1; config: ToolConfig; rules: Rule[]; ledger: LedgerEntry[] }
export type Reservation = { kind: 'new' | 'duplicate'; entry: LedgerEntry } | { kind: 'conflict' };
const DEFAULT_CONFIG: ToolConfig = { permission: 'ask', automatic: false, dirtyPolicy: 'ask', completionSound: false, autoCopyResults: true, sendIntervalSeconds: 3 };
const STATUSES: ToolResult['status'][] = ['running', 'pending_permission', 'done', 'failed', 'permission_denied', 'cancelled', 'skipped_dependency', 'unknown'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const rootKey = (root: string) => hash(path.resolve(root).toLowerCase());
const scopeKey = (root: string, session: string) => hash(`${rootKey(root)}\0${session}`);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value);
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clone = <T>(value: T): T => structuredClone(value);

/** 只保留配置、规则指纹和执行元数据；命令、文件正文和输出均不落盘。 */
export class ToolStore {
  private data: StoreData = { version: 1, config: { ...DEFAULT_CONFIG }, rules: [], ledger: [] };
  private readonly loading: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private loadError: string | null = null;

  constructor(private readonly filePath: string) {
    this.loading = this.load().then(() => { this.loaded = true; }, error => {
      this.loadError = error instanceof Error ? error.message : String(error);
      throw error;
    });
    // 错误仍由 ready/每个写操作抛出；避免异步构造阶段的未处理拒绝。
    void this.loading.catch(() => undefined);
  }

  async ready(): Promise<void> { await this.loading; }
  isReady(): boolean { return this.loaded; }
  getLoadError(): string | null { return this.loadError; }
  getConfig(): ToolConfig { return { ...this.data.config }; }
  getRules(root: string): Array<{ fingerprint: string; action: RuleAction }> {
    return this.data.rules.filter(r => r.root === rootKey(root)).map(r => ({ fingerprint: r.fingerprint, action: r.action }));
  }
  getHistory(): ToolResult[] {
    return this.data.ledger.flatMap(e => e.requests.map(r => ({ ...r, batch_id: e.batch_id }))).slice(-200);
  }
  getEntries(): LedgerEntry[] { return clone(this.data.ledger); }

  async configure(patch: unknown): Promise<ToolConfig> {
    if (!record(patch) || Object.keys(patch).some(k => !['permission', 'automatic', 'dirtyPolicy', 'completionSound', 'autoCopyResults', 'sendIntervalSeconds'].includes(k))) throw new Error('工具设置包含未定义字段');
    if ('permission' in patch && !['ask', 'rules', 'full'].includes(String(patch.permission))) throw new Error('权限模式无效');
    if ('automatic' in patch && typeof patch.automatic !== 'boolean') throw new Error('自动采集设置必须为布尔值');
    if ('completionSound' in patch && typeof patch.completionSound !== 'boolean') throw new Error('完成音效设置必须为布尔值');
    if ('autoCopyResults' in patch && typeof patch.autoCopyResults !== 'boolean') throw new Error('自动复制设置必须为布尔值');
    if ('sendIntervalSeconds' in patch && (typeof patch.sendIntervalSeconds !== 'number' || !Number.isInteger(patch.sendIntervalSeconds) || patch.sendIntervalSeconds < 0 || patch.sendIntervalSeconds > 300)) throw new Error('自动发送间隔必须是 0–300 秒的整数');
    if ('dirtyPolicy' in patch && !['ask', 'continue', 'stop'].includes(String(patch.dirtyPolicy))) throw new Error('未保存内容策略无效');
    return this.mutate(data => {
      data.config = { ...data.config, ...patch } as ToolConfig;
      return { ...data.config };
    });
  }

  async addRule(root: string, fingerprint: string, action: RuleAction): Promise<void> {
    if (!fingerprint || fingerprint.length > 1000 || !['allow', 'ask', 'deny'].includes(action)) throw new Error('权限规则无效');
    await this.mutate(data => {
      const key = rootKey(root);
      data.rules = data.rules.filter(r => r.root !== key || r.fingerprint !== fingerprint);
      data.rules.push({ root: key, fingerprint, action });
      if (data.rules.length > 5000) throw new Error('权限规则达到上限，请清除旧规则');
    });
  }

  async clearRules(root?: string): Promise<void> {
    await this.mutate(data => { data.rules = root === undefined ? [] : data.rules.filter(rule => rule.root !== rootKey(root)); });
  }

  async reserve(root: string, session: string, batch: ToolBatch): Promise<Reservation> {
    const scope = scopeKey(root, session);
    const contentHash = hash(JSON.stringify(batch));
    return this.mutate(data => {
      const existing = data.ledger.find(e => e.scope === scope && e.batch_id === batch.batch_id);
      if (existing) return existing.hash === contentHash ? { kind: 'duplicate', entry: clone(existing) } : { kind: 'conflict' };
      // 不淘汰去重记录，否则旧网页回复在重启后可能再次产生副作用。
      if (data.ledger.length >= 10_000) throw new Error('工具去重记录达到上限，需要人工归档记录；本次未执行');
      const entry: LedgerEntry = {
        scope, batch_id: batch.batch_id, hash: contentHash, at: Date.now(),
        requests: batch.requests.map(r => ({ request_id: r.id, tool: r.tool, status: 'unknown' })),
      };
      data.ledger.push(entry);
      return { kind: 'new', entry: clone(entry) };
    });
  }

  async updateResult(scope: string, batchId: string, requestId: string, status: ToolResult['status']): Promise<void> {
    await this.mutate(data => {
      const request = data.ledger.find(e => e.scope === scope && e.batch_id === batchId)?.requests.find(r => r.request_id === requestId);
      if (!request) throw new Error('执行记录不存在，无法确认工具状态');
      request.status = status;
    });
  }

  private async mutate<T>(change: (data: StoreData) => T): Promise<T> {
    const run = this.queue.then(async () => {
      await this.ready();
      const next = clone(this.data);
      const result = change(next);
      await this.save(next);
      this.data = next;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<void> {
    let contents: string;
    try { contents = await fs.readFile(this.filePath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`工具状态无法读取：${error instanceof Error ? error.message : String(error)}`);
    }
    let value: unknown;
    try { value = JSON.parse(contents); } catch { throw new Error('工具状态文件损坏；停止执行，未重置权限或去重记录'); }
    if (!this.validData(value)) throw new Error('工具状态文件格式无效；停止执行，未重置权限或去重记录');
    this.data = { ...value, config: { ...DEFAULT_CONFIG, ...value.config } };
    let interrupted = false;
    for (const entry of this.data.ledger) for (const result of entry.requests) {
      if (result.status === 'running' || result.status === 'pending_permission') { result.status = 'unknown'; interrupted = true; }
    }
    if (interrupted) await this.save(this.data);
  }

  private validData(value: unknown): value is StoreData {
    if (!record(value) || value.version !== 1 || !record(value.config) || !Array.isArray(value.rules) || !Array.isArray(value.ledger)) return false;
    const c = value.config;
    if (!['ask', 'rules', 'full'].includes(String(c.permission)) || typeof c.automatic !== 'boolean' || !['ask', 'continue', 'stop'].includes(String(c.dirtyPolicy))) return false;
    if (c.completionSound !== undefined && typeof c.completionSound !== 'boolean') return false;
    if (c.autoCopyResults !== undefined && typeof c.autoCopyResults !== 'boolean') return false;
    if (c.sendIntervalSeconds !== undefined && (typeof c.sendIntervalSeconds !== 'number' || !Number.isInteger(c.sendIntervalSeconds) || c.sendIntervalSeconds < 0 || c.sendIntervalSeconds > 300)) return false;
    if (value.rules.length > 5000 || value.rules.some(r => !record(r) || !validHash(r.root) || typeof r.fingerprint !== 'string' || !r.fingerprint || r.fingerprint.length > 1000 || !['allow', 'ask', 'deny'].includes(String(r.action)))) return false;
    const scopes = new Set<string>();
    return value.ledger.length <= 10_000 && value.ledger.every(e => {
      if (!record(e) || !validHash(e.scope) || !validId(e.batch_id) || !validHash(e.hash) || typeof e.at !== 'number' || !Number.isFinite(e.at) || !Array.isArray(e.requests) || e.requests.length < 1 || e.requests.length > 50) return false;
      const key = `${e.scope}\0${e.batch_id}`;
      if (scopes.has(key)) return false;
      scopes.add(key);
      const ids = new Set<string>();
      return e.requests.every(r => {
        if (!record(r) || !validId(r.request_id) || ids.has(r.request_id) || !TOOL_NAMES.includes(r.tool as typeof TOOL_NAMES[number]) || !STATUSES.includes(r.status as ToolResult['status'])) return false;
        ids.add(r.request_id);
        return true;
      });
    });
  }

  private async save(data: StoreData): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.filePath);
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }
}
