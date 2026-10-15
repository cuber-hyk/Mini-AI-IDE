import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolBatch } from '../src/shared/toolProtocol';
import { ToolStore } from '../src/main/tools/store';

const batch: ToolBatch = { protocol_version: 1, batch_id: 'one', requests: [{ id: 'run', tool: 'run_command', args: { command: 'SECRET_TOKEN=invisible', shell: 'powershell' } }] };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'tools.json');
  const store = new ToolStore(filePath);
  await store.ready();
  return { directory, filePath, store };
}

test('settings persist selected permission, automatic collection, unsaved policy and optional completion sound', async t => {
  const { filePath, store } = await fixture(t);
  assert.deepEqual(store.getConfig(), { permission: 'ask', automatic: false, dirtyPolicy: 'ask', completionSound: false, autoCopyResults: true, sendIntervalSeconds: 3 });
  await Promise.all([store.configure({ permission: 'full' }), store.configure({ automatic: true }), store.configure({ dirtyPolicy: 'continue' }), store.configure({ completionSound: true })]);
  const reopened = new ToolStore(filePath);
  await reopened.ready();
  assert.deepEqual(reopened.getConfig(), { permission: 'full', automatic: true, dirtyPolicy: 'continue', completionSound: true, autoCopyResults: true, sendIntervalSeconds: 3 });
  await reopened.configure({ completionSound: false });
  const muted = new ToolStore(filePath);
  await muted.ready();
  assert.equal(muted.getConfig().completionSound, false);
  await muted.configure({ autoCopyResults: false });
  const noCopy = new ToolStore(filePath); await noCopy.ready(); assert.equal(noCopy.getConfig().autoCopyResults, false);
});

test('invalid configuration cannot broaden or erase permissions', async t => {
  const { store } = await fixture(t);
  for (const patch of [null, { permission: 'admin' }, { permission: undefined }, { automatic: 'true' }, { dirtyPolicy: undefined }, { completionSound: 'true' }, { completionSound: 1 }, { completionSound: null }, { completionSound: undefined }, { autoCopyResults: 'true' }, { sendIntervalSeconds: -1 }, { sendIntervalSeconds: 301 }, { sendIntervalSeconds: 1.5 }, { sendIntervalSeconds: '3' }, { sendIntervalSeconds: undefined }, { root: 'C:/' }]) {
    await assert.rejects(store.configure(patch));
  }
  assert.equal(store.getConfig().permission, 'ask');
  assert.equal(store.getConfig().completionSound, false);
});

test('opening settings saved before sound was introduced defaults to silence and preserves permission, rules and deduplication', async t => {
  const { directory, filePath, store } = await fixture(t);
  await store.configure({ permission: 'full', automatic: true, dirtyPolicy: 'stop' });
  await store.addRule(directory, 'existing-script', 'deny');
  await store.reserve(directory, 'chat', batch);
  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
  delete saved.config.completionSound;
  delete saved.config.autoCopyResults;
  delete saved.config.sendIntervalSeconds;
  await fs.writeFile(filePath, JSON.stringify(saved));
  const reopened = new ToolStore(filePath);
  await reopened.ready();
  assert.deepEqual(reopened.getConfig(), { permission: 'full', automatic: true, dirtyPolicy: 'stop', completionSound: false, autoCopyResults: true, sendIntervalSeconds: 3 });
  assert.deepEqual(reopened.getRules(directory), [{ fingerprint: 'existing-script', action: 'deny' }]);
  assert.deepEqual(reopened.getEntries(), store.getEntries());
  assert.equal((await reopened.reserve(directory, 'chat', batch)).kind, 'duplicate');
});

test('发送间隔保存整数秒，不引入轮次数量设置，也不影响权限或去重记录', async t => {
  const { directory, filePath, store } = await fixture(t);
  await store.reserve(directory, 'chat', batch);
  await store.configure({ sendIntervalSeconds: 0 }); assert.equal(store.getConfig().sendIntervalSeconds, 0);
  await store.configure({ sendIntervalSeconds: 300 });
  const reopened = new ToolStore(filePath); await reopened.ready();
  assert.equal(reopened.getConfig().sendIntervalSeconds, 300); assert.deepEqual(reopened.getEntries(), store.getEntries());
  await assert.rejects(reopened.configure({ rounds: 10 }));
});

test('invalid persisted completion sound is rejected without resetting existing permission or ledger', async t => {
  const { directory, filePath, store } = await fixture(t);
  await store.configure({ permission: 'full' });
  await store.reserve(directory, 'chat', batch);
  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
  saved.config.completionSound = 'true';
  const invalid = JSON.stringify(saved);
  await fs.writeFile(filePath, invalid);
  const reopened = new ToolStore(filePath);
  await assert.rejects(reopened.ready(), /格式无效/);
  assert.equal(await fs.readFile(filePath, 'utf8'), invalid);
});

test('reservation persists before execution and never stores commands or stdout', async t => {
  const { directory, filePath, store } = await fixture(t);
  const reserved = await store.reserve(directory, 'chat1', batch);
  assert.equal(reserved.kind, 'new');
  assert.equal((await store.reserve(directory, 'chat1', batch)).kind, 'duplicate');
  assert.equal((await store.reserve(directory, 'chat1', { ...batch, requests: [{ ...batch.requests[0]!, args: { command: 'changed', shell: 'powershell' } }] })).kind, 'conflict');
  assert.equal((await store.reserve(directory, 'chat2', batch)).kind, 'new');
  assert.equal((await store.reserve(path.join(directory, 'other'), 'chat1', batch)).kind, 'new');
  const persisted = await fs.readFile(filePath, 'utf8');
  assert.ok(!persisted.includes('SECRET_TOKEN'));
  assert.ok(!persisted.includes(directory));
  assert.ok(!persisted.includes('chat1'));
});

test('restart retains dedup and reports interrupted execution as unknown instead of replaying it', async t => {
  const { directory, filePath, store } = await fixture(t);
  const reserved = await store.reserve(directory, 'chat', batch);
  assert.ok(reserved.kind === 'new');
  await store.updateResult(reserved.entry.scope, batch.batch_id, 'run', 'running');
  const reopened = new ToolStore(filePath);
  await reopened.ready();
  assert.equal(reopened.getHistory()[0]?.status, 'unknown');
  assert.equal((await reopened.reserve(directory, 'chat', batch)).kind, 'duplicate');
  assert.ok(!(await fs.readFile(filePath, 'utf8')).includes('"status":"running"'));
});

test('rules only apply to the same project and exact fingerprint and can be cleared', async t => {
  const { directory, filePath, store } = await fixture(t);
  await store.addRule(directory, 'script-hash-1', 'allow');
  await store.addRule(directory, 'script-hash-2', 'deny');
  await store.addRule(directory, 'script-hash-1', 'ask');
  const reopened = new ToolStore(filePath);
  await reopened.ready();
  assert.deepEqual(reopened.getRules(directory), [{ fingerprint: 'script-hash-2', action: 'deny' }, { fingerprint: 'script-hash-1', action: 'ask' }]);
  assert.deepEqual(reopened.getRules(path.join(directory, 'other')), []);
  await reopened.clearRules();
  assert.deepEqual(reopened.getRules(directory), []);
});

test('damaged state is preserved and rejected, never silently replaced by defaults', async t => {
  const { filePath } = await fixture(t);
  await fs.writeFile(filePath, '{broken');
  const store = new ToolStore(filePath);
  await assert.rejects(store.ready(), /损坏/);
  await assert.rejects(store.configure({ permission: 'full' }), /损坏/);
  assert.equal(await fs.readFile(filePath, 'utf8'), '{broken');
});

test('clearing a project rule preserves grants and denials belonging to other projects', async t => {
  const { directory, store } = await fixture(t);
  const other = path.join(directory, 'other');
  await store.addRule(directory, 'one', 'allow');
  await store.addRule(other, 'two', 'deny');
  await store.clearRules(directory);
  assert.deepEqual(store.getRules(directory), []);
  assert.deepEqual(store.getRules(other), [{ fingerprint: 'two', action: 'deny' }]);
});

test('failed atomic persistence does not mutate in-memory configuration', async t => {
  const { directory, store, filePath } = await fixture(t);
  await fs.mkdir(filePath);
  await assert.rejects(store.configure({ permission: 'full' }));
  assert.equal(store.getConfig().permission, 'ask');
  const names = await fs.readdir(directory);
  assert.deepEqual(names, ['tools.json']);
});

test('重复、冲突和相同状态只读取已持久化快照，不写盘或深拷贝整份账本', async t => {
  const { directory, store } = await fixture(t);
  const reserved = await store.reserve(directory, 'chat', batch);
  assert.equal(reserved.kind, 'new');
  if (reserved.kind !== 'new') return;
  let writes = 0; let ledgerCopies = 0;
  const originalWrite = fs.writeFile.bind(fs); const originalClone = structuredClone;
  t.mock.method(fs, 'writeFile', (...args: Parameters<typeof fs.writeFile>) => { writes++; return originalWrite(...args); });
  t.mock.method(globalThis, 'structuredClone', (value: unknown) => {
    if (value && typeof value === 'object' && 'ledger' in value) ledgerCopies++;
    return originalClone(value);
  });
  assert.equal((await store.reserve(directory, 'chat', batch)).kind, 'duplicate');
  assert.equal((await store.reserve(directory, 'chat', { ...batch, requests: [{ ...batch.requests[0]!, args: { command: 'different', shell: 'powershell' } }] })).kind, 'conflict');
  await store.updateResult(reserved.entry.scope, batch.batch_id, 'run', 'unknown');
  await store.configure(store.getConfig());
  await store.clearRules(directory);
  assert.equal(writes, 0);
  assert.equal(ledgerCopies, 0);
  await store.updateResult(reserved.entry.scope, batch.batch_id, 'run', 'done');
  assert.equal(writes, 1, '真实状态仍在返回前持久保存');
  assert.equal(ledgerCopies, 0, '一个请求变更不复制全部历史正文');
});

test('并发重复采集只持久化一次；手动来源提升须落盘并跨重启保留', async t => {
  const { directory, filePath, store } = await fixture(t);
  let writes = 0; const originalWrite = fs.writeFile.bind(fs);
  t.mock.method(fs, 'writeFile', (...args: Parameters<typeof fs.writeFile>) => { writes++; return originalWrite(...args); });
  const reservations = await Promise.all(Array.from({ length: 12 }, () => store.reserve(directory, 'chat', batch)));
  assert.equal(reservations.filter(value => value.kind === 'new').length, 1);
  assert.equal(writes, 1);
  const promoted = await store.reserve(directory, 'chat', batch, 'manual');
  assert.ok(promoted.kind === 'duplicate');
  assert.equal(promoted.entry.source, 'manual');
  await store.reserve(directory, 'chat', batch, 'manual');
  assert.equal(writes, 2, '来源只在首次提升时写盘');
  const reopened = new ToolStore(filePath); await reopened.ready();
  const duplicate = await reopened.reserve(directory, 'chat', batch);
  assert.ok(duplicate.kind === 'duplicate'); assert.equal(duplicate.entry.source, 'manual');
});

test('状态与来源保存失败不能修改共享历史，事务队列之后仍可保存', async t => {
  const { directory, filePath, store } = await fixture(t);
  const reserved = await store.reserve(directory, 'chat', batch);
  assert.ok(reserved.kind === 'new');
  const before = store.getEntries(); const persisted = await fs.readFile(filePath, 'utf8');
  const originalRename = fs.rename.bind(fs); let rejectRename = true;
  t.mock.method(fs, 'rename', (...args: Parameters<typeof fs.rename>) => {
    if (rejectRename) return Promise.reject(new Error('fixture atomic rename failure'));
    return originalRename(...args);
  });
  await assert.rejects(store.updateResult(reserved.entry.scope, batch.batch_id, 'run', 'done'), /atomic rename failure/);
  await assert.rejects(store.reserve(directory, 'chat', batch, 'manual'), /atomic rename failure/);
  await assert.rejects(store.reserve(directory, 'chat', { ...batch, batch_id: 'not-persisted' }), /atomic rename failure/);
  await assert.rejects(store.addRule(directory, 'not-persisted', 'allow'), /atomic rename failure/);
  assert.deepEqual(store.getEntries(), before);
  assert.deepEqual(store.getRules(directory), []);
  assert.equal(await fs.readFile(filePath, 'utf8'), persisted);
  assert.deepEqual(await fs.readdir(directory), ['tools.json']);
  rejectRename = false;
  await store.updateResult(reserved.entry.scope, batch.batch_id, 'run', 'done');
  const reopened = new ToolStore(filePath); await reopened.ready();
  assert.equal(reopened.getHistory()[0]?.status, 'done');
  assert.equal(reopened.getEntries()[0]?.source, undefined);
});

test('保存等待期间读取旧快照，调用方改写返回值不能污染后续去重与状态', async t => {
  const { directory, filePath, store } = await fixture(t);
  const reserved = await store.reserve(directory, 'chat', batch);
  assert.ok(reserved.kind === 'new');
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saving = new Promise<void>(resolve => { entered = resolve; });
  const originalRename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => { entered(); await gate; return originalRename(...args); });
  const update = store.updateResult(reserved.entry.scope, batch.batch_id, 'run', 'done');
  await saving;
  assert.equal(store.getHistory()[0]?.status, 'unknown');
  release(); await update;
  reserved.entry.requests[0]!.status = 'failed';
  const snapshot = store.getEntries(); snapshot[0]!.requests[0]!.status = 'failed'; snapshot[0]!.hash = '0'.repeat(64);
  const duplicate = await store.reserve(directory, 'chat', batch);
  assert.ok(duplicate.kind === 'duplicate'); assert.equal(duplicate.entry.requests[0]?.status, 'done');
  const reopened = new ToolStore(filePath); await reopened.ready(); assert.equal(reopened.getHistory()[0]?.status, 'done');
});

test('并发修改不同请求、配置和权限规则不会覆盖其他已提交事务', async t => {
  const { directory, filePath, store } = await fixture(t);
  const multiple: ToolBatch = { ...batch, requests: [...batch.requests, { id: 'second', tool: 'read_file', args: { path: 'example.txt' } }] };
  const reserved = await store.reserve(directory, 'chat', multiple); assert.ok(reserved.kind === 'new');
  await Promise.all([
    store.updateResult(reserved.entry.scope, batch.batch_id, 'run', 'done'),
    store.updateResult(reserved.entry.scope, batch.batch_id, 'second', 'failed'),
    store.configure({ permission: 'rules' }), store.addRule(directory, 'specific-command', 'deny'),
  ]);
  const reopened = new ToolStore(filePath); await reopened.ready();
  assert.deepEqual(reopened.getHistory().map(value => value.status), ['done', 'failed']);
  assert.equal(reopened.getConfig().permission, 'rules');
  assert.deepEqual(reopened.getRules(directory), [{ fingerprint: 'specific-command', action: 'deny' }]);
});

test('账本满额仍识别最旧批次且拒绝新请求，不淘汰旧记录或写盘', async t => {
  const { directory, filePath, store } = await fixture(t);
  await store.reserve(directory, 'chat', batch);
  const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const seed = data.ledger[0];
  data.ledger = [seed, ...Array.from({ length: 9999 }, (_, index) => ({ ...seed, batch_id: 'history-' + index }))];
  const full = JSON.stringify(data); await fs.writeFile(filePath, full);
  const reopened = new ToolStore(filePath); await reopened.ready();
  assert.equal((await reopened.reserve(directory, 'chat', batch)).kind, 'duplicate');
  await assert.rejects(reopened.reserve(directory, 'chat', { ...batch, batch_id: 'over-capacity' }), /达到上限/);
  assert.equal(reopened.getEntries().length, 10_000);
  assert.equal(await fs.readFile(filePath, 'utf8'), full);
});
