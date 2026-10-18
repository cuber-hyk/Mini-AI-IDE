import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createToolIntegration } from '../src/main/tools/integration';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { CHANNELS } from '../src/shared/contract';

const batch = (id: string, tool = 'get_project_info', args: unknown = {}) => '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: id, requests: [{ id: 'request', tool, args }] }) + '\n```';
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < deadline, '活动门禁应在有界时间内完成'); await delay(5); } }

async function fixture(t: any, disabled = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-platform-')); const files = new FileService(); files.setRoot(root);
  let reply = ''; let reads = 0; let waiter: ((value: unknown) => void) | undefined;
  let asking = async () => ({ response: 0, checkboxChecked: false });
  let beforeRead = async () => {}; let beforeMark = async () => {};
  let marks = 0; const sent: string[] = []; const copies: string[] = []; const cancelled: string[] = [];
  const handlers = new Map<string, any>(); const editor: any = { mainFrame: {}, isDestroyed: () => false, send() {} };
  const web: any = Object.assign(new EventEmitter(), { getURL: () => 'https://chat.deepseek.com/a/chat/platform', isDestroyed: () => false,
    executeJavaScript: async () => { reads++; await beforeRead(); return { replies: [reply], completion: 'complete', source: 'new', sourceKey: 'fixture|' + reply }; },
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
      const code = scripts[0]!.code;
      if (code.includes('const completion =')) return web.executeJavaScript(code);
      if (code.includes('const accepted = expected')) return { turn: 0, accepted: true };
      if (code.includes('previous.waiter = resolve')) return new Promise(resolve => { waiter = resolve; });
      if (code.includes('previous.dispose();')) { waiter?.(false); waiter = undefined; return true; }
      if (code.includes('previous.submitAt = Date.now();')) { marks++; await beforeMark(); return true; }
      if (code.includes('return { turn:')) return { turn: 0 };
      return { hasReplies: Boolean(reply) };
    } });
  const system = await createToolIntegration({ files, web, editor, disabled,
    ledgerSession: (current, session) => current === web ? session : JSON.stringify(['deepseek-account', 'account-1', session]),
    ipc: { handle(channel: string, fn: any) { handlers.set(channel, fn); } } as any,
    workspace: { editor: { isDirty: () => false, current: { documents: [] } }, run: (fn: any) => fn() } as any,
    returnPath: new ReturnPathService(files), storePath: path.join(root, 'tools.json'),
    ask: () => asking(), notifyFile() {}, copy(text) { copies.push(text); },
    sender: { async send(text, _session, _kind, current) { if (!current()) return { ok: false }; sent.push(text); return { ok: true }; }, async cancel(kind) { cancelled.push(kind); }, async dispose() {} },
  });
  t.after(async () => { await system.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, system, sent, copies, cancelled, web,
    otherWeb: () => Object.assign(new EventEmitter(), { getURL: web.getURL, isDestroyed: web.isDestroyed,
      executeJavaScript: web.executeJavaScript, executeJavaScriptInIsolatedWorld: web.executeJavaScriptInIsolatedWorld }),
    sender: { async send(text: string, _session: string, _kind: unknown, current: () => boolean) { if (!current()) return { ok: false }; sent.push(text); return { ok: true }; }, async cancel() {}, async dispose() {} },
    get reads() { return reads; }, get marks() { return marks; },
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)({ sender: editor, senderFrame: editor.mainFrame }, ...args),
    setReply(text: string) { reply = text; }, setAsk(fn: typeof asking) { asking = fn; }, setRead(fn: typeof beforeRead) { beforeRead = fn; }, setMark(fn: typeof beforeMark) { beforeMark = fn; },
    async ready() { await until(() => Boolean(waiter)); },
    async notify(text: string) { reply = text; await until(() => Boolean(waiter)); const notify = waiter; waiter = undefined; notify!({ turn: 0 }); },
  };
}

it('隐藏 DeepSeek 阻止手动采集、需求发送与自动监听，automatic 配置仍保留', async t => {
  const f = await fixture(t); await f.system.setWebActive(false);
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const text = batch('hidden', 'apply_changes', { changes: [{ path: 'hidden.txt', operation: 'create', content: 'must not exist' }] });
  f.setReply(text); await f.system.accept(text, 'complete');
  assert.equal(f.system.getState().config.automatic, true); assert.equal(f.system.getState().results.length, 0);
  assert.equal((await f.system.sendLocalPrompt('local prompt', 'https://chat.deepseek.com/a/chat/platform', () => true)).ok, false);
  assert.equal((await f.call(CHANNELS.sendToolResults)).ok, false);
  await delay(30); assert.equal(f.reads, 0); assert.deepEqual(f.sent, []);
  await assert.rejects(fs.stat(path.join(f.root, 'hidden.txt')), { code: 'ENOENT' });
});

it('不同账号相同URL和相同批次分别执行，切回默认账号仍按原账本去重', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full' });
  const text = batch('same-account-batch', 'apply_changes', { changes: [{ path: 'account.txt', operation: 'overwrite', content: 'executed' }] });
  await fs.writeFile(path.join(f.root, 'account.txt'), 'initial');
  f.setReply(text); await f.system.accept(text, 'complete'); await until(() => !f.system.getState().busy);
  assert.equal(await fs.readFile(path.join(f.root, 'account.txt'), 'utf8'), 'executed');
  await fs.writeFile(path.join(f.root, 'account.txt'), 'other account pending');
  await f.system.setWebActive(false); await f.system.bindWeb(f.otherWeb() as any, f.sender); await f.system.setWebActive(true);
  assert.equal((await f.call(CHANNELS.copyToolResults)).ok, true, '上一账号真实结果仍可复制');
  await f.system.accept(text, 'complete'); await until(() => !f.system.getState().busy);
  assert.equal(await fs.readFile(path.join(f.root, 'account.txt'), 'utf8'), 'executed', '相同网址不会把其他账号误判为已执行');
  await fs.writeFile(path.join(f.root, 'account.txt'), 'keep after return');
  await f.system.setWebActive(false); await f.system.bindWeb(f.web, f.sender); await f.system.setWebActive(true);
  await f.system.accept(text, 'complete'); await until(() => !f.system.getState().busy);
  assert.equal(await fs.readFile(path.join(f.root, 'account.txt'), 'utf8'), 'keep after return', '原账号账本保持防重放');
  const entries = JSON.parse(await fs.readFile(path.join(f.root, 'tools.json'), 'utf8')).ledger;
  assert.equal(entries.length, 2); assert.notEqual(entries[0].scope, entries[1].scope);
});

it('账号实际重绑撤回待发送和附件资格，切到相同URL也不补发上一账号结果', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 1 });
  await until(() => f.reads > 0); const text = batch('old-account'); f.setReply(text); await f.system.accept(text, 'complete');
  await until(() => f.system.getState().continuation?.phase === 'countdown');
  await f.system.setWebActive(false); await f.system.bindWeb(f.otherWeb() as any, f.sender); f.setReply(''); await f.system.setWebActive(true);
  assert.equal((await f.call(CHANNELS.sendToolResults)).ok, false);
  assert.equal((await f.call(CHANNELS.copyToolResults)).ok, true);
  await delay(1100); assert.deepEqual(f.sent, []);
  await f.call(CHANNELS.setToolConfig, { sendIntervalSeconds: 0 });
  await f.notify(batch('new-account')); await until(() => f.sent.length === 1);
  assert.match(f.sent[0]!, /new-account/); assert.doesNotMatch(f.sent[0]!, /old-account/);
});

it('切平台撤销倒计时并保留复制，返回 DeepSeek 不补发已完成的旧结果', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 1 });
  await until(() => f.reads > 0); const text = batch('finished'); f.setReply(text); await f.system.accept(text, 'complete');
  await until(() => f.system.getState().continuation?.phase === 'countdown'); const results = f.system.getState().results;
  const paused = f.system.setWebActive(false);
  assert.notEqual(f.system.getState().continuation?.phase, 'countdown'); await paused;
  assert.deepEqual(f.system.getState().results, results); assert.equal((await f.call(CHANNELS.copyToolResults)).ok, true); assert.ok(f.copies.at(-1)?.includes('finished'));
  await f.system.setWebActive(true); await f.call(CHANNELS.setToolConfig, { sendIntervalSeconds: 0 });
  await delay(60); assert.deepEqual(f.sent, []); assert.notEqual(f.system.getState().continuation?.phase, 'countdown');
  await f.notify(batch('fresh')); await until(() => f.sent.length === 1); assert.ok(f.sent[0]!.includes('fresh'));
});

it('隐藏期间的新回复在恢复时只成为历史基线，后续新回复才能执行', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 300 });
  await until(() => f.reads > 0); await f.system.setWebActive(false); f.setReply(batch('hidden-history'));
  await f.system.setWebActive(true); await until(() => f.reads > 1); await delay(15);
  assert.equal(f.system.getState().results.length, 0);
  await f.notify(batch('new-visible')); await until(() => f.system.getState().results[0]?.batch_id === 'new-visible' && !f.system.getState().busy);
});

it('手动确认等待期间切走再返回，迟到采集不读网页或执行工具', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full' });
  let release!: () => void; f.setAsk(() => new Promise(resolve => { release = () => resolve({ response: 0, checkboxChecked: false }); }));
  const accepting = f.system.accept(batch('stale-confirm'), 'unknown');
  await f.system.setWebActive(false); await f.system.setWebActive(true); release(); await accepting;
  assert.equal(f.reads, 0); assert.equal(f.system.getState().results.length, 0);
});

it('自动网页读取尚未返回时隐藏，迟到回复不得执行', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 300 });
  await f.ready(); let release!: () => void;
  f.setRead(() => new Promise<void>(resolve => { release = resolve; }));
  await f.notify(batch('late-read')); await until(() => Boolean(release));
  await f.system.setWebActive(false); release(); await delay(30);
  assert.equal(f.system.getState().results.length, 0); assert.deepEqual(f.sent, []);
});

it('本地主动发送标记等待期间平台撤销，运输不能启动', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { automatic: true }); await until(() => f.reads > 0);
  let release!: () => void; f.setMark(() => new Promise<void>(resolve => { release = resolve; }));
  const sending = f.system.sendLocalPrompt('pending prompt', 'https://chat.deepseek.com/a/chat/platform', () => true);
  await until(() => f.marks > 0); await f.system.setWebActive(false); await f.system.setWebActive(true); release();
  assert.equal((await sending).ok, false); assert.deepEqual(f.sent, []);
});

it('disabled 模式仍允许活动 DeepSeek 的既有手动采集测试语义', async t => {
  const f = await fixture(t, true); await f.call(CHANNELS.setToolConfig, { permission: 'full' });
  await f.system.accept(batch('disabled-manual'), 'complete'); await until(() => !f.system.getState().busy);
  assert.equal(f.system.getState().results[0]?.batch_id, 'disabled-manual');
});

it('工具授权跨 await 切走再恢复不能执行旧批次副作用', async t => {
  const f = await fixture(t); let release!: () => void;
  f.setAsk(() => new Promise(resolve => { release = () => resolve({ response: 0, checkboxChecked: false }); }));
  await f.system.accept(batch('late-approval', 'apply_changes', { changes: [{ path: 'late.txt', operation: 'create', content: 'stale effect' }] }), 'complete');
  await until(() => Boolean(release)); await f.system.setWebActive(false); await f.system.setWebActive(true); release();
  await until(() => !f.system.getState().busy);
  await assert.rejects(fs.stat(path.join(f.root, 'late.txt')), { code: 'ENOENT' }); assert.deepEqual(f.sent, []);
});

it('附件结果发送核验等待期间隐藏，正文附件均不运输，恢复后不重试', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'attachment.txt'), 'retained');
  await f.call(CHANNELS.setToolConfig, { permission: 'full' });
  const text = batch('manual-attachment', 'attach_file', { path: 'attachment.txt' }); f.setReply(text); await f.system.accept(text, 'complete');
  await until(() => !f.system.getState().busy); assert.equal(f.system.getState().resultReturn?.canSend, true);
  let release!: () => void; f.setRead(() => new Promise<void>(resolve => { release = resolve; }));
  const sending = f.call(CHANNELS.sendToolResults); await until(() => Boolean(release));
  await f.system.setWebActive(false); await f.system.setWebActive(true); release(); assert.equal((await sending).ok, false);
  assert.equal((await f.call(CHANNELS.sendToolResults)).ok, false); assert.deepEqual(f.sent, []);
  assert.equal((await f.call(CHANNELS.copyToolResults)).ok, true); assert.ok(f.copies.at(-1)?.includes('manual-attachment'));
});
