import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createToolIntegration } from '../src/main/tools/integration';
import { ToolStore } from '../src/main/tools/store';
import { ToolHarness } from '../src/main/tools/harness';
import { ToolAttachments } from '../src/main/tools/attachments';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { CHANNELS } from '../src/shared/contract';

const json = (id: string, tool = 'get_project_info', args: unknown = {}) => JSON.stringify({ protocol_version: 1, batch_id: id, requests: [{ id: 'request', tool, args }] });
const fenced = (text: string) => '```mini-ai-tools\n' + text + '\n```';
async function until(check: () => boolean) { const deadline = Date.now() + 10_000; while (!check()) { assert.ok(Date.now() < deadline, '手动批次必须在有界时间内处理'); await delay(5); } }
async function fixture(t: TestContext, url = 'about:blank', badStore = false, disabled = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-json-')); const files = new FileService(); files.setRoot(root);
  const storePath = path.join(root, 'tools.json'); if (badStore) await fs.writeFile(storePath, 'broken');
  let reply = ''; let reads = 0; let waiter: ((v: unknown) => void) | undefined; let interactionBusy = false;
  let ask: () => Promise<{ response: number; checkboxChecked: boolean }> = async () => ({ response: 0, checkboxChecked: false });
  let send: () => Promise<{ ok: boolean }> = async () => ({ ok: true });
  const copies: string[] = []; const sent: string[] = []; const handlers = new Map<string, any>();
  const editor: any = { mainFrame: {}, send() {}, isDestroyed: () => false };
  const web: any = Object.assign(new EventEmitter(), { getURL: () => url, isDestroyed: () => false,
    async executeJavaScript() { reads++; return { replies: [reply], completion: 'complete' }; },
    async executeJavaScriptInIsolatedWorld(_world: number, entries: { code: string }[]) {
      const code = entries[0]!.code;
      if (code.includes('const completion =') || code.includes('const replies =')) return web.executeJavaScript();
      if (code.includes('previous.waiter = resolve')) return new Promise(resolve => { waiter = resolve; });
      if (code.includes('previous.dispose();')) { waiter?.(false); waiter = undefined; return true; }
      if (code.includes('return { turn:')) return { turn: 0 };
      return { hasReplies: Boolean(reply) };
    } });
  const system = await createToolIntegration({ files, editor, web, ipc: { handle(c: string, fn: any) { handlers.set(c, fn); } } as any,
    workspace: { editor: { isDirty: () => false, current: { documents: [] } }, run: (fn: any) => fn() } as any,
    returnPath: new ReturnPathService(files), storePath, disabled, ask: () => ask(), notifyFile() {}, copy(text) { copies.push(text); }, interactionBusy: () => interactionBusy,
    sender: { async send(text, _session, _kind, current) { assert.equal(current(), true); sent.push(text); return send(); }, async cancel() {}, async dispose() {} },
  });
  t.after(async () => { await system.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)({ sender: editor, senderFrame: editor.mainFrame }, ...args);
  return { root, files, system, web, editor, handlers, call, copies, sent, storePath, get reads() { return reads; },
    setAsk(fn: typeof ask) { ask = fn; }, setSend(fn: typeof send) { send = fn; }, setBusy(value: boolean) { interactionBusy = value; }, setReply(text: string) { reply = text; },
    async preview(text: string) { return call(CHANNELS.previewToolJson, text); },
    async execute(text: string) { const p = await call(CHANNELS.previewToolJson, text); assert.equal(p.ok, true, p.error); return call(CHANNELS.executeToolJson, p.token); },
  };
}

it('手动批次在网页损坏或未知地址时按当前权限真实执行，预览不采集 DOM，结果仅复制', async t => {
  const f = await fixture(t); const p = await f.preview(json('manual-info')); assert.equal(p.ok, true); assert.equal(f.reads, 0); assert.equal(f.system.getState().results.length, 0);
  assert.equal((await f.call(CHANNELS.executeToolJson, p.token)).ok, true);
  assert.equal(f.system.getState().source, 'manual'); assert.equal(f.system.getState().results[0]?.status, 'done'); assert.equal(f.reads, 0);
  assert.equal((await f.call(CHANNELS.copyToolResults)).ok, true); assert.match(f.copies.at(-1)!, /manual-info/);
  assert.equal((await f.call(CHANNELS.sendToolResults)).ok, false); assert.equal(f.sent.length, 0);
});

it('automatic 开启、关闭重开及发送间隔改变后，手动结果仍永久无回传；后续网页新批可回传', async t => {
  const f = await fixture(t, 'https://chat.deepseek.com/a/chat/manual');
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 }); await delay(20);
  await f.execute(json('manual-auto')); assert.equal(f.system.getState().config.automatic, true);
  await f.call(CHANNELS.setToolConfig, { automatic: false }); await f.call(CHANNELS.setToolConfig, { automatic: true });
  await f.call(CHANNELS.setToolConfig, { sendIntervalSeconds: 1 }); await f.call(CHANNELS.setToolConfig, { sendIntervalSeconds: 0 });
  await delay(30); assert.equal(f.sent.length, 0); assert.equal(f.system.getState().source, 'manual');
  const text = fenced(json('web-next')); f.setReply(text); await f.system.accept(text, 'complete'); await until(() => f.sent.length === 1);
  assert.equal(f.system.getState().source, undefined); assert.match(f.sent[0]!, /web-next/);
});

it('手动批次权限拒绝与整批校验失败均保留真实结果，automatic 不回传', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { automatic: true, permission: 'ask', sendIntervalSeconds: 0 });
  f.setAsk(async () => ({ response: 2, checkboxChecked: false }));
  await f.execute(json('manual-denied', 'apply_changes', { changes: [{ path: 'denied.txt', operation: 'create', content: 'not allowed' }] }));
  assert.equal(f.system.getState().results[0]?.status, 'permission_denied'); await assert.rejects(fs.stat(path.join(f.root, 'denied.txt')), { code: 'ENOENT' });
  const conflict = JSON.stringify({ protocol_version: 1, batch_id: 'manual-validation', requests: [{ id: 'a', tool: 'apply_changes', args: { changes: [{ path: 'same.txt', operation: 'create', content: 'one' }, { path: 'same.txt', operation: 'create', content: 'two' }] } }] });
  await f.execute(conflict); assert.equal(f.system.getState().completion?.validation_failed, true); assert.equal(f.system.getState().source, 'manual');
  await delay(30); assert.deepEqual(f.sent, []); assert.equal((await f.call(CHANNELS.copyToolResults)).ok, true);
});

it('手动 attach_file 在描述和读取之前明确拒绝，不能通过手动发送上传', async t => {
  const f = await fixture(t); const stage = t.mock.method(ToolAttachments.prototype, 'stage', async () => { assert.fail('手动附件不得进入读取'); });
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  await f.execute(json('manual-attachment', 'attach_file', { path: 'absent-private.docx' }));
  assert.equal(f.system.getState().results[0]?.status, 'failed'); assert.match(f.system.getState().results[0]?.error ?? '', /手动 JSON.*附件未读取或上传/);
  assert.equal(stage.mock.callCount(), 0); assert.equal((await f.call(CHANNELS.sendToolResults)).ok, false); assert.deepEqual(f.sent, []);
});

it('复用网页同批转为手动来源；手动同批重采集和持久重启恢复均不能重放或取得发送资格', async t => {
  const f = await fixture(t, 'https://chat.deepseek.com/a/chat/manual'); await f.call(CHANNELS.setToolConfig, { permission: 'full' });
  const text = json('same-id', 'apply_changes', { changes: [{ path: 'once.txt', operation: 'create', content: 'one' }] });
  await f.system.accept(fenced(text), 'complete'); await until(() => !f.system.getState().busy && f.system.getState().results[0]?.status === 'done');
  await f.execute(text); assert.equal(f.system.getState().source, 'manual'); assert.equal(f.system.getState().restored, true);
  const store = new ToolStore(f.storePath); await store.ready(); assert.equal(store.getEntries()[0]?.source, 'manual');
  const reopened = new ToolHarness({ store, root: () => f.root, session: () => 'https://chat.deepseek.com/a/chat/manual',
    async execute() { assert.fail('重启恢复不能再次执行工具'); }, async describe() { return { external: false, fingerprint: 'same' }; }, async authorize() { return 'once'; }, changed() {} });
  await reopened.collect(fenced(text)); assert.equal(reopened.getState().source, 'manual'); assert.equal(reopened.getState().restored, true);
  await f.call(CHANNELS.setToolConfig, { automatic: true, sendIntervalSeconds: 0 }); f.setReply(fenced(text)); await f.system.accept(fenced(text), 'complete');
  await until(() => !f.system.getState().busy); assert.equal(f.system.getState().source, 'manual'); assert.equal((await f.call(CHANNELS.sendToolResults)).ok, false);
  assert.equal(await fs.readFile(path.join(f.root, 'once.txt'), 'utf8'), 'one'); await delay(30); assert.deepEqual(f.sent, []);
  const different = json('same-id', 'apply_changes', { changes: [{ path: 'twice.txt', operation: 'create', content: 'two' }] });
  assert.equal((await f.execute(different)).ok, false); await assert.rejects(fs.stat(path.join(f.root, 'twice.txt')), { code: 'ENOENT' });
});

it('失败预览不覆盖既有结果或诊断，网页和子 frame 无权调用手动 JSON IPC', async t => {
  const f = await fixture(t); await f.execute(json('preserved')); const before = f.system.getState().results;
  assert.equal((await f.preview('{broken')).ok, false); assert.deepEqual(f.system.getState().results, before);
  await f.system.accept(fenced('{invalid'), 'complete'); await until(() => Boolean(f.system.getState().batchError));
  const diagnostic = f.system.getState().batchError;
  assert.equal((await f.preview('not a request')).ok, false); assert.deepEqual(f.system.getState().batchError, diagnostic);
  for (const channel of [CHANNELS.previewToolJson, CHANNELS.executeToolJson]) {
    assert.throws(() => f.handlers.get(channel)({ sender: f.web, senderFrame: f.editor.mainFrame }, json('foreign')), /主 frame/);
    assert.throws(() => f.handlers.get(channel)({ sender: f.editor, senderFrame: {} }, json('child')), /主 frame/);
    assert.throws(() => f.call(channel), /参数数量/);
  }
});

it('项目切换来回、网页导航来回与忙状态令牌失效，不能利用相同最终作用域绕过确认', async t => {
  const f = await fixture(t); const p = await f.preview(json('aba-root'));
  f.system.reset(); f.files.setRoot(path.dirname(f.root)); f.system.reset(); f.files.setRoot(f.root); assert.equal((await f.call(CHANNELS.executeToolJson, p.token)).ok, false);
  const next = await f.preview(json('aba-web')); f.web.emit('did-navigate-in-page', {}, 'https://chatgpt.com/c/away', true); f.web.emit('did-navigate-in-page', {}, 'about:blank', true);
  assert.equal((await f.call(CHANNELS.executeToolJson, next.token)).ok, false);
  const busy = await f.preview(json('busy')); f.setBusy(true); assert.equal((await f.preview(json('blocked'))).ok, false); assert.equal((await f.call(CHANNELS.executeToolJson, busy.token)).ok, false);
  f.setBusy(false); assert.equal(f.system.getState().results.length, 0);
});

it('等待工具授权时拒绝新导入；授权完成后可执行新手动批，旧令牌不复活', async t => {
  const f = await fixture(t); let release!: () => void;
  f.setAsk(() => new Promise(resolve => { release = () => resolve({ response: 0, checkboxChecked: false }); }));
  const p = await f.preview(json('pending', 'apply_changes', { changes: [{ path: 'approved.txt', operation: 'create', content: 'approved' }] }));
  const running = f.call(CHANNELS.executeToolJson, p.token); await until(() => Boolean(release));
  assert.equal((await f.preview(json('busy-import'))).ok, false); release(); assert.equal((await running).ok, true);
  assert.equal((await f.call(CHANNELS.executeToolJson, p.token)).ok, false); assert.equal((await f.execute(json('next-manual'))).ok, true);
});

it('工具记录损坏或持久预约失败不执行副作用，错误明确返回', async t => {
  const corrupt = await fixture(t, 'about:blank', true); assert.equal((await corrupt.preview(json('broken-store'))).ok, false);
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full' }); const p = await f.preview(json('save-failed', 'apply_changes', { changes: [{ path: 'never.txt', operation: 'create', content: 'must not exist' }] }));
  await fs.rm(f.storePath); await fs.mkdir(f.storePath);
  assert.equal((await f.call(CHANNELS.executeToolJson, p.token)).ok, false); await assert.rejects(fs.stat(path.join(f.root, 'never.txt')), { code: 'ENOENT' }); assert.deepEqual(f.sent, []);
});

it('持久记录中的未知来源导致加载失败，不能默认为网页自动来源', async t => {
  const f = await fixture(t); await f.execute(json('source-whitelist'));
  const data = JSON.parse(await fs.readFile(f.storePath, 'utf8')); data.ledger[0].source = 'unknown'; await fs.writeFile(f.storePath, JSON.stringify(data));
  const reopened = new ToolStore(f.storePath); await assert.rejects(reopened.ready(), /格式无效/);
});

it('自检或探针禁用工具的新入口不能借助手动 JSON 绕过', async t => {
  const f = await fixture(t, 'about:blank', false, true);
  const p = await f.preview(json('disabled')); assert.equal(p.ok, false); assert.match(p.error, /当前运行模式/);
  assert.equal((await f.call(CHANNELS.executeToolJson, 'invented-token')).ok, false); assert.equal(f.system.getState().results.length, 0); assert.equal(f.reads, 0);
});

it('网页回传倒计时与本地主动运输期间拒绝导入，空闲后才可重新预览', async t => {
  const f = await fixture(t, 'https://chat.deepseek.com/a/chat/manual');
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 300 }); await delay(20);
  const text = fenced(json('web-countdown')); f.setReply(text); await f.system.accept(text, 'complete'); await until(() => f.system.getState().continuation?.phase === 'countdown');
  assert.equal((await f.preview(json('during-countdown'))).ok, false);
  await f.call(CHANNELS.setToolConfig, { automatic: false }); const p = await f.preview(json('before-send')); assert.equal(p.ok, true);
  let release!: () => void; f.setSend(() => new Promise(resolve => { release = () => resolve({ ok: true }); }));
  const sending = f.system.sendLocalPrompt('需求', 'https://chat.deepseek.com/a/chat/manual', () => true); await until(() => Boolean(release));
  assert.equal((await f.call(CHANNELS.executeToolJson, p.token)).ok, false); assert.equal((await f.preview(json('during-send'))).ok, false);
  release(); await sending; assert.equal((await f.preview(json('after-send'))).ok, true);
});

it('手动后台命令真实存活期间拒绝新批，身份核验停止后可继续，结果始终不回传', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  await f.execute(json('manual-process', 'run_command', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', shell: process.platform === 'win32' ? 'powershell' : 'bash', background: true, timeout_ms: 60000 }));
  assert.equal(f.system.getState().hasRunningProcesses, true); assert.equal((await f.preview(json('background-busy'))).ok, false);
  const processId = (f.system.getState().results[0]!.data as any).process_id;
  await f.call(CHANNELS.stopToolCommand, { batch_id: 'manual-process', request_id: 'request', process_id: processId });
  await until(() => !f.system.getState().hasRunningProcesses); assert.equal(f.system.getState().source, 'manual');
  assert.equal((await f.preview(json('after-background'))).ok, true); await delay(30); assert.deepEqual(f.sent, []);
});
