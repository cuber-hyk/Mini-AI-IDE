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
  stringifyCalls: number;
  stringifyMs: number;
  writeMs: number;
  renameMs: number;
}

const option = (name: string, fallback: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const sampleCount = Number(option('samples', '3'));
const sizes = option('sizes', '100,1000,10000').split(',').map(Number);
const requestCounts = option('requests', '10').split(',').map(Number);
const targets = option('targets', 'first').split(',');
assert(Number.isInteger(sampleCount) && sampleCount >= 3 && sampleCount <= 20, 'samples 必须是 3–20 的整数');
assert(sizes.length > 0 && sizes.every(size => Number.isInteger(size) && size > 0 && size <= 10_000), 'sizes 必须在 1–10000 批之间');
assert(requestCounts.length > 0 && requestCounts.every(count => Number.isInteger(count) && count >= 1 && count <= 50), 'requests 必须在 1–50 之间');
assert(targets.length > 0 && targets.every(target => ['first', 'last'].includes(target)), 'targets 仅支持 first,last');
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
  const measurementSourceHash = digest(await fs.readFile(__filename, 'utf8'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-store-measure-'));
  const originalClone = globalThis.structuredClone;
  const originalWriteFile = fs.writeFile;
  const originalRename = fs.rename;
  const originalStringify = JSON.stringify;
  let active: Measurement | undefined;
  const measured = async <T>(operation: string, action: () => Promise<T>): Promise<{ metric: Measurement; result: T }> => {
    assert.equal(active, undefined, '测量不得重叠');
    const metric: Measurement = { operation, elapsedMs: 0, cloneCalls: 0, cloneMs: 0, writeCalls: 0, writeBytes: 0, stringifyCalls: 0, stringifyMs: 0, writeMs: 0, renameMs: 0 };
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
    const frame = active && typeof args[0] === 'string' && path.dirname(path.resolve(args[0])) === temporary ? active : undefined;
    if (frame) {
      assert.equal(typeof args[1], 'string', 'ToolStore 写盘应为真实 JSON 字符串');
      frame.writeCalls++;
      frame.writeBytes += Buffer.byteLength(args[1] as string, 'utf8');
    }
    const started = performance.now();
    try { return await originalWriteFile(...args); }
    finally { if (frame) frame.writeMs += performance.now() - started; }
  }) as typeof fs.writeFile;
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    const frame = active && args.every(value => typeof value === 'string' && path.dirname(path.resolve(value)) === temporary) ? active : undefined;
    const started = performance.now();
    try { return await originalRename(...args); }
    finally { if (frame) frame.renameMs += performance.now() - started; }
  }) as typeof fs.rename;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const value: unknown = args[0];
    const frame = active && value && typeof value === 'object' && 'version' in value && value.version === 1 && 'ledger' in value && Array.isArray(value.ledger) ? active : undefined;
    const started = performance.now();
    try { return originalStringify(...args); }
    finally { if (frame) { frame.stringifyCalls++; frame.stringifyMs += performance.now() - started; } }
  }) as typeof JSON.stringify;

  const samples: Array<{ batches: number; requestsPerBatch: number; target: string; sample: number; fileBytes: number; operations: Measurement[]; restartVerified: boolean }> = [];
  try {
    const root = path.join(temporary, 'project');
    const session = 'offline-store-measurement';
    for (const requestsPerBatch of requestCounts) {
    const batchFor = (index: number): ToolBatch => ({
      protocol_version: 1,
      batch_id: `measure-${String(index).padStart(5, '0')}`,
      requests: Array.from({ length: requestsPerBatch }, (_, request) => ({ id: `read-${request}`, tool: 'read_file', args: { path: `fixture-${request}.txt` } })),
    });
    // 先通过真实公开入口获得 scope、合法配置与请求元数据，再派生规模化只含元数据的夹具。
    const seedPath = path.join(temporary, `seed-${requestsPerBatch}.json`);
    const seedStore = new ToolStore(seedPath);
    await seedStore.ready();
    const seed = await seedStore.reserve(root, session, batchFor(0));
    assert.equal(seed.kind, 'new');
    if (seed.kind !== 'new') throw new Error('种子预留失败');
    const seedEntry = seed.entry;
    const config = seedStore.getConfig();

    for (const batches of sizes) {
      const ledger: LedgerEntry[] = Array.from({ length: batches }, (_, index) => {
        const batch = batchFor(index);
        return { ...seedEntry, batch_id: batch.batch_id, hash: digest(JSON.stringify(batch)), requests: seedEntry.requests.map(request => ({ ...request })) };
      });
      const fixture = JSON.stringify({ version: 1, config, rules: [], ledger });
      for (let sample = 1; sample <= sampleCount; sample++) {
      for (const target of sample % 2 ? targets : [...targets].reverse()) {
        const targetIndex = target === 'last' ? batches - 1 : 0;
        const targetBatch = batchFor(targetIndex); const targetEntry = ledger[targetIndex]!;
        const conflict: ToolBatch = { ...targetBatch, requests: targetBatch.requests.map((request, index) => index ? request : { ...request, args: { path: 'different.txt' } }) };
        const filePath = path.join(temporary, `store-${batches}-${requestsPerBatch}-${target}-${sample}.json`);
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
        const persistedText = await fs.readFile(filePath, 'utf8');
        const persisted = JSON.parse(persistedText);
        assert.equal(persisted.ledger.length, batches);
        assert.equal(persisted.ledger[targetIndex].requests[0].status, 'done');
        assert.equal(persisted.ledger[targetIndex].hash, targetEntry.hash);
        assert.deepEqual(persisted.ledger.filter((_value: unknown, index: number) => index !== targetIndex), ledger.filter((_value, index) => index !== targetIndex));
        for (const operation of operations) {
          const changed = ['status-changed', 'configure-changed'].includes(operation.operation);
          assert.equal(operation.writeCalls, changed ? 1 : 0, operation.operation + '写入次数');
          assert.equal(operation.stringifyCalls, changed ? 1 : 0, operation.operation + '序列化次数');
          if (changed) assert.equal(operation.writeBytes, Buffer.byteLength(persistedText) + (operation.operation === 'status-changed' ? 1 : 0), '真实变更完整写盘；false到true仅少一字符');
        }
        const restarted = new ToolStore(filePath);
        await restarted.ready();
        assert.equal(restarted.getConfig().automatic, true);
        const duplicate = await restarted.reserve(root, session, targetBatch);
        assert.equal(duplicate.kind, 'duplicate');
        if (duplicate.kind === 'duplicate') assert.equal(duplicate.entry.requests[0]!.status, 'done');
        assert.equal((await restarted.reserve(root, session, conflict)).kind, 'conflict');
        samples.push({ batches, requestsPerBatch, target, sample, fileBytes: Buffer.byteLength(fixture), operations, restartVerified: true });
        console.log(JSON.stringify({ batches, requestsPerBatch, target, sample, elapsedMs: Object.fromEntries(operations.map(metric => [metric.operation, Number(metric.elapsedMs.toFixed(3))])) }));
      }
      }
    }
    }
    assert.equal(digest(await fs.readFile(sourcePath, 'utf8')), sourceHash, '测量期间生产源码发生变化，拒绝混合样本');
    const summary = sizes.flatMap(batches => requestCounts.flatMap(requestsPerBatch => targets.map(target => ({ batches, requestsPerBatch, target, operations: samples[0]!.operations.map(({ operation }) => {
      const metrics = samples.filter(sample => sample.batches === batches && sample.requestsPerBatch === requestsPerBatch && sample.target === target).map(sample => sample.operations.find(metric => metric.operation === operation)!);
      return { operation, medianMs: median(metrics.map(metric => metric.elapsedMs)), minMs: Math.min(...metrics.map(metric => metric.elapsedMs)), maxMs: Math.max(...metrics.map(metric => metric.elapsedMs)), medianCloneMs: median(metrics.map(metric => metric.cloneMs)), medianStringifyMs: median(metrics.map(metric => metric.stringifyMs)), medianWriteMs: median(metrics.map(metric => metric.writeMs)), medianRenameMs: median(metrics.map(metric => metric.renameMs)), cloneCalls: metrics.map(metric => metric.cloneCalls), writeCalls: metrics.map(metric => metric.writeCalls), writeBytes: metrics.map(metric => metric.writeBytes) };
    }) }))));
    assert.equal(digest(await fs.readFile(__filename, 'utf8')), measurementSourceHash, '测量脚本发生变化，拒绝混合样本');
    const report = { recordedAt: new Date().toISOString(), node: process.version, v8: process.versions.v8, electron: process.versions.electron ?? null, platform: process.platform, sourcePath, sourceSha256: sourceHash, measurementSourceSha256: measurementSourceHash, sampleCount, scope: 'real-disk-synthetic-metadata', limits: '每个样本使用新文件；加载包含读取/JSON解析/校验，真实变更保留全量JSON序列化和原子替换。目标首/末由参数指定，每样本轮换首尾测量次序；临时数据不含真实命令或输出，仅窄包装本进程structuredClone/合成StoreData的JSON.stringify与本夹具路径fs.writeFile/rename。操作仍固定串行；分项包装有开销，未测GUI/主进程帧率。磁盘缓存及预热未隔离，文件接口返回不代表冷盘或fsync持久化。重启校验在计数之外，保留原始样本和最小/中位/最大，各分项中位数不可直接相加，不用少量样本推导P95；没有单测耗时阈值。', samples, summary };
    await fs.writeFile(output, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ output, sourceSha256: sourceHash, sampleCount, batches: sizes, verified: samples.length }));
  } finally {
    active = undefined;
    globalThis.structuredClone = originalClone;
    fs.writeFile = originalWriteFile;
    fs.rename = originalRename;
    JSON.stringify = originalStringify;
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), '拒绝清理非临时父目录');
    assert(path.basename(resolved).startsWith('mini-tool-store-measure-'), '拒绝清理其他任务目录');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
