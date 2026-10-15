/** 真实磁盘工具账本测量；只使用独立临时目录，不执行协议里的工具。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ToolStore, type LedgerEntry } from '../src/main/tools/store';
import type { ToolBatch } from '../src/shared/toolProtocol';

interface Measurement {
  operation: string;
  elapsedMs: number;
  cloneCalls: number;
  cloneMs: number;
  writeCalls: number;
  writeBytes: number;
}

const option = (name: string, fallback: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const sampleCount = Number(option('samples', '3'));
const sizes = option('sizes', '100,1000,10000').split(',').map(Number);
assert(Number.isInteger(sampleCount) && sampleCount >= 3 && sampleCount <= 20, 'samples 必须是 3–20 的整数');
assert(sizes.length > 0 && sizes.every(size => Number.isInteger(size) && size > 0 && size <= 10_000), 'sizes 必须在 1–10000 批之间');
const output = path.resolve(option('output', path.join(os.tmpdir(), 'mini-tool-store-measure.json')));
const sourcePath = path.resolve('src/main/tools/store.ts');
const digest = (contents: string) => createHash('sha256').update(contents).digest('hex');
const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

async function main(): Promise<void> {
  const sourceHash = digest(await fs.readFile(sourcePath, 'utf8'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-store-measure-'));
  const originalClone = globalThis.structuredClone;
  const originalWriteFile = fs.writeFile;
  let active: Measurement | undefined;
  const measured = async <T>(operation: string, action: () => Promise<T>): Promise<{ metric: Measurement; result: T }> => {
    assert.equal(active, undefined, '测量不得重叠');
    const metric: Measurement = { operation, elapsedMs: 0, cloneCalls: 0, cloneMs: 0, writeCalls: 0, writeBytes: 0 };
    active = metric;
    const started = performance.now();
    try {
      const result = await action();
      metric.elapsedMs = performance.now() - started;
      return { metric, result };
    } finally { active = undefined; }
  };
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    const frame = active;
    if (!frame) return originalClone(value, options);
    const started = performance.now();
    try { return originalClone(value, options); }
    finally { frame.cloneCalls++; frame.cloneMs += performance.now() - started; }
  }) as typeof structuredClone;
  fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
    if (active && typeof args[0] === 'string' && path.dirname(path.resolve(args[0])) === temporary) {
      assert.equal(typeof args[1], 'string', 'ToolStore 写盘应为真实 JSON 字符串');
      active.writeCalls++;
      active.writeBytes += Buffer.byteLength(args[1] as string, 'utf8');
    }
    return originalWriteFile(...args);
  }) as typeof fs.writeFile;

  const samples: Array<{ batches: number; requestsPerBatch: number; sample: number; fileBytes: number; operations: Measurement[]; restartVerified: boolean }> = [];
  try {
    const root = path.join(temporary, 'project');
    const session = 'offline-store-measurement';
    const batchFor = (index: number): ToolBatch => ({
      protocol_version: 1,
      batch_id: `measure-${String(index).padStart(5, '0')}`,
      requests: Array.from({ length: 10 }, (_, request) => ({ id: `read-${request}`, tool: 'read_file', args: { path: `fixture-${request}.txt` } })),
    });
    // 先通过真实公开入口获得 scope、合法配置与请求元数据，再派生规模化只含元数据的夹具。
    const seedPath = path.join(temporary, 'seed.json');
    const seedStore = new ToolStore(seedPath);
    await seedStore.ready();
    const targetBatch = batchFor(0);
    const seed = await seedStore.reserve(root, session, targetBatch);
    assert.equal(seed.kind, 'new');
    if (seed.kind !== 'new') throw new Error('种子预留失败');
    const seedEntry = seed.entry;
    const config = seedStore.getConfig();
    const conflict: ToolBatch = { ...targetBatch, requests: targetBatch.requests.map((request, index) => index ? request : { ...request, args: { path: 'different.txt' } }) };

    for (const batches of sizes) {
      const ledger: LedgerEntry[] = Array.from({ length: batches }, (_, index) => {
        const batch = batchFor(index);
        return { ...seedEntry, batch_id: batch.batch_id, hash: digest(JSON.stringify(batch)), requests: seedEntry.requests.map(request => ({ ...request })) };
      });
      const fixture = JSON.stringify({ version: 1, config, rules: [], ledger });
      for (let sample = 1; sample <= sampleCount; sample++) {
        const filePath = path.join(temporary, `store-${batches}-${sample}.json`);
        await fs.writeFile(filePath, fixture, { encoding: 'utf8', flag: 'wx' });
        const operations: Measurement[] = [];
        const loaded = await measured('load', async () => { const store = new ToolStore(filePath); await store.ready(); return store; });
        operations.push(loaded.metric);
        const store = loaded.result;
        const record = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
          const result = await measured(operation, action);
          operations.push(result.metric);
          return result.result;
        };
        await record('status-changed', () => store.updateResult(seedEntry.scope, targetBatch.batch_id, 'read-0', 'done'));
        await record('status-same', () => store.updateResult(seedEntry.scope, targetBatch.batch_id, 'read-0', 'done'));
        assert.equal((await record('reserve-duplicate', () => store.reserve(root, session, targetBatch))).kind, 'duplicate');
        assert.equal((await record('reserve-conflict', () => store.reserve(root, session, conflict))).kind, 'conflict');
        assert.equal((await record('configure-changed', () => store.configure({ automatic: true }))).automatic, true);
        assert.equal((await record('configure-same', () => store.configure({ automatic: true }))).automatic, true);

        // 校验放在计时/计数之外；不能把冲突或重复伪装成真实状态变化。
        const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
        assert.equal(persisted.ledger.length, batches);
        assert.equal(persisted.ledger[0].requests[0].status, 'done');
        assert.equal(persisted.ledger[0].hash, seedEntry.hash);
        assert.deepEqual(persisted.ledger.slice(1), ledger.slice(1));
        const restarted = new ToolStore(filePath);
        await restarted.ready();
        assert.equal(restarted.getConfig().automatic, true);
        const duplicate = await restarted.reserve(root, session, targetBatch);
        assert.equal(duplicate.kind, 'duplicate');
        if (duplicate.kind === 'duplicate') assert.equal(duplicate.entry.requests[0]!.status, 'done');
        assert.equal((await restarted.reserve(root, session, conflict)).kind, 'conflict');
        samples.push({ batches, requestsPerBatch: 10, sample, fileBytes: Buffer.byteLength(fixture), operations, restartVerified: true });
        console.log(JSON.stringify({ batches, sample, elapsedMs: Object.fromEntries(operations.map(metric => [metric.operation, Number(metric.elapsedMs.toFixed(3))])) }));
      }
    }
    assert.equal(digest(await fs.readFile(sourcePath, 'utf8')), sourceHash, '测量期间生产源码发生变化，拒绝混合样本');
    const summary = sizes.map(batches => ({ batches, operations: samples[0]!.operations.map(({ operation }) => {
      const metrics = samples.filter(sample => sample.batches === batches).map(sample => sample.operations.find(metric => metric.operation === operation)!);
      return { operation, medianMs: median(metrics.map(metric => metric.elapsedMs)), medianCloneMs: median(metrics.map(metric => metric.cloneMs)), cloneCalls: metrics.map(metric => metric.cloneCalls), writeCalls: metrics.map(metric => metric.writeCalls), writeBytes: metrics.map(metric => metric.writeBytes) };
    }) }));
    const report = { recordedAt: new Date().toISOString(), node: process.version, platform: process.platform, sourcePath, sourceSha256: sourceHash, sampleCount, scope: 'real-disk-synthetic-metadata', limits: '每个样本使用新文件；加载包含读取/JSON解析/校验，真实变更保留全量JSON序列化和原子写盘。目标为首条记录，未测末尾查找最坏情况；临时数据不含真实命令或输出，仅窄包装本进程structuredClone与本夹具路径fs.writeFile。操作顺序固定且串行；磁盘缓存及进程预热未隔离，不代表现场体感。重启校验在计数之外，输出保留原始样本；没有单测耗时阈值。', samples, summary };
    await fs.writeFile(output, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ output, sourceSha256: sourceHash, sampleCount, batches: sizes, verified: samples.length }));
  } finally {
    active = undefined;
    globalThis.structuredClone = originalClone;
    fs.writeFile = originalWriteFile;
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), '拒绝清理非临时父目录');
    assert(path.basename(resolved).startsWith('mini-tool-store-measure-'), '拒绝清理其他任务目录');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
