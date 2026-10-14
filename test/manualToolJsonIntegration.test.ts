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
import { sessionKeyOf } from '../src/main/consumptionStore';
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
    async execute(text: string) { return call(CHANNELS.executeToolJson, text); },
  };
}

it('手动批次在网页损坏或未知地址时按当前权限真实执行，不采集 DOM，结果仅复制', async t => {
  const f = await fixture(t);
  assert.equal((await f.execute(json('manual-info'))).ok, true);
  assert.equal(f.system.getState().source, 'manual'); assert.equal(f.system.getState().results[0]?.status, 'done'); assert.equal(f.reads, 0);
  assert.equal(f.copies.length, 1); assert.equal(f.system.getState().clipboard?.ok, true);
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
  assert.equal(f.copies.length, 1); assert.equal(JSON.parse(f.copies[0]!).tool_results[0].status, 'permission_denied');
  assert.equal(f.system.getState().results[0]?.status, 'permission_denied'); await assert.rejects(fs.stat(path.join(f.root, 'denied.txt')), { code: 'ENOENT' });
  const conflict = JSON.stringify({ protocol_version: 1, batch_id: 'manual-validation', requests: [{ id: 'a', tool: 'apply_changes', args: { changes: [{ path: 'same.txt', operation: 'create', content: 'one' }, { path: 'same.txt', operation: 'create', content: 'two' }] } }] });
  await f.execute(conflict); assert.equal(f.copies.length, 2); assert.equal(JSON.parse(f.copies[1]!).tool_results[0].status, 'failed'); assert.equal(f.system.getState().completion?.validation_failed, true); assert.equal(f.system.getState().source, 'manual');
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

it('手动格式错误进入真实诊断并复制同源回执，网页和子 frame 无权调用执行 IPC', async t => {
  const f = await fixture(t); await f.execute(json('previous'));
  const count = f.copies.length;
  assert.deepEqual(await f.execute('{broken'), { ok: true });
  const state = f.system.getState(); assert.equal(state.source, 'manual'); assert.equal(state.completion, undefined); assert.deepEqual(state.results, []);
  assert.ok(state.batchError); assert.equal(state.clipboard?.ok, true); assert.equal(f.copies.length, count + 1);
  const receipt = JSON.parse(f.copies.at(-1)!); assert.deepEqual(receipt.tool_results, []); assert.deepEqual(receipt.batch_error, state.batchError);
  f.system.getState(); f.system.getState(); assert.equal(f.copies.length, count + 1);
  assert.equal((await f.call(CHANNELS.copyToolResults)).ok, true); assert.equal(f.copies.at(-1), f.copies.at(-2));
  const channel = CHANNELS.executeToolJson;
  assert.throws(() => f.handlers.get(channel)({ sender: f.web, senderFrame: f.editor.mainFrame }, json('foreign')), /主 frame/);
  assert.throws(() => f.handlers.get(channel)({ sender: f.editor, senderFrame: {} }, json('child')), /主 frame/);
  assert.throws(() => f.call(channel), /参数数量/);
});

it('等待工具授权时拒绝新批次或解析诊断，授权完成后可执行新手动批', async t => {
  const f = await fixture(t); let release!: () => void;
  f.setAsk(() => new Promise(resolve => { release = () => resolve({ response: 0, checkboxChecked: false }); }));
  const running = f.execute(json('pending', 'apply_changes', { changes: [{ path: 'approved.txt', operation: 'create', content: 'approved' }] }));
  await until(() => Boolean(release)); const before = f.system.getState().results;
  assert.equal((await f.execute(json('busy-import'))).ok, false); assert.equal((await f.execute('{broken')).ok, false);
  assert.deepEqual(f.system.getState().results, before); assert.equal(f.copies.length, 0);
  release(); assert.equal((await running).ok, true); assert.equal(f.copies.length, 1);
  await f.execute(json('pending', 'apply_changes', { changes: [{ path: 'approved.txt', operation: 'create', content: 'approved' }] }));
  assert.equal(f.copies.length, 1, '重复历史不复制或执行'); assert.equal((await f.execute(json('next-manual'))).ok, true);
});

it('审批期间项目或平台切换再回来也不能启动原命令或复制取消回执', async t => {
  for (const kind of ['project', 'platform'] as const) {
    const f = await fixture(t); let release!: () => void;
    f.setAsk(() => new Promise(resolve => { release = () => resolve({ response: 0, checkboxChecked: false }); }));
    const running = f.execute(json('aba-' + kind, 'apply_changes', { changes: [{ path: 'never.txt', operation: 'create', content: 'never' }] }));
    await until(() => Boolean(release));
    if (kind === 'project') { f.system.reset(); f.files.setRoot(path.dirname(f.root)); f.system.reset(); f.files.setRoot(f.root); }
    else { await f.system.setWebActive(false); await f.system.setWebActive(true); }
    release(); await running;
    await assert.rejects(fs.stat(path.join(f.root, 'never.txt')), { code: 'ENOENT' });
    assert.equal(f.copies.length, 0); assert.equal(f.sent.length, 0);
  }
});

it('工具记录损坏或持久预约失败不执行副作用，错误明确返回', async t => {
  const corrupt = await fixture(t, 'about:blank', true); assert.equal((await corrupt.execute(json('broken-store'))).ok, false);
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full' });
  await fs.rm(f.storePath); await fs.mkdir(f.storePath);
  assert.equal((await f.execute(json('save-failed', 'apply_changes', { changes: [{ path: 'never.txt', operation: 'create', content: 'must not exist' }] }))).ok, false);
  await assert.rejects(fs.stat(path.join(f.root, 'never.txt')), { code: 'ENOENT' }); assert.deepEqual(f.sent, []); assert.equal(f.copies.length, 0);
});

it('持久记录中的未知来源导致加载失败，不能默认为网页自动来源', async t => {
  const f = await fixture(t); await f.execute(json('source-whitelist'));
  const data = JSON.parse(await fs.readFile(f.storePath, 'utf8')); data.ledger[0].source = 'unknown'; await fs.writeFile(f.storePath, JSON.stringify(data));
  const reopened = new ToolStore(f.storePath); await assert.rejects(reopened.ready(), /格式无效/);
});

it('自检或探针禁用工具的新入口不能借助手动 JSON 绕过', async t => {
  const f = await fixture(t, 'about:blank', false, true);
  const p = await f.execute(json('disabled')); assert.equal(p.ok, false); assert.match(p.error, /当前运行模式/);
  assert.equal((await f.call(CHANNELS.executeToolJson, 'invented-token')).ok, false); assert.equal(f.system.getState().results.length, 0); assert.equal(f.reads, 0);
});

it('网页回传倒计时与本地主动运输期间拒绝导入，空闲后才可重新提交', async t => {
  const f = await fixture(t, 'https://chat.deepseek.com/a/chat/manual');
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 300 }); await delay(20);
  const text = fenced(json('web-countdown')); f.setReply(text); await f.system.accept(text, 'complete'); await until(() => f.system.getState().continuation?.phase === 'countdown');
  assert.equal((await f.execute(json('during-countdown'))).ok, false);
  await f.call(CHANNELS.setToolConfig, { automatic: false });
  let release!: () => void; f.setSend(() => new Promise(resolve => { release = () => resolve({ ok: true }); }));
  const sending = f.system.sendLocalPrompt('需求', 'https://chat.deepseek.com/a/chat/manual', () => true); await until(() => Boolean(release));
  assert.equal((await f.execute(json('during-send'))).ok, false); assert.equal((await f.execute(json('during-send'))).ok, false);
  release(); await sending; assert.equal((await f.execute(json('after-send'))).ok, true);
});

it('手动后台命令真实存活期间拒绝新批，身份核验停止后可继续，结果始终不回传', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  await f.execute(json('manual-process', 'run_command', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', shell: process.platform === 'win32' ? 'powershell' : 'bash', background: true, timeout_ms: 60000 }));
  assert.equal(f.copies.length, 0, '后台启动不复制'); assert.equal(f.system.getState().hasRunningProcesses, true); assert.equal((await f.execute(json('background-busy'))).ok, false);
  const processId = (f.system.getState().results[0]!.data as any).process_id;
  await f.call(CHANNELS.stopToolCommand, { batch_id: 'manual-process', request_id: 'request', process_id: processId });
  await until(() => !f.system.getState().hasRunningProcesses); assert.equal(f.system.getState().source, 'manual');
  assert.equal(f.copies.length, 1, '真实停止清理后复制一次'); assert.equal((await f.execute(json('after-background'))).ok, true); await delay(30); assert.deepEqual(f.sent, []);
});

it('手动解析错误即使 automatic 开启也仅复制一次，关闭复制不追补，后续官网诊断正常回传', async t => {
  const f = await fixture(t, 'https://chat.deepseek.com/a/chat/manual');
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 }); await delay(20);
  assert.deepEqual(await f.execute('{broken'), { ok: true });
  assert.equal(f.copies.length, 1); assert.equal(f.system.getState().clipboard?.ok, true); assert.equal(f.system.getState().source, 'manual');
  await delay(30); assert.deepEqual(f.sent, []); assert.equal((await f.call(CHANNELS.sendToolResults)).ok, false);
  await f.call(CHANNELS.setToolConfig, { automatic: false }); await f.call(CHANNELS.setToolConfig, { automatic: true }); await delay(20);
  assert.deepEqual(f.sent, []); assert.equal(f.copies.length, 1);
  await f.call(CHANNELS.setToolConfig, { autoCopyResults: false }); await f.execute('{different');
  assert.equal(f.copies.length, 1); assert.equal(f.system.getState().clipboard, undefined);
  await f.execute(json('copy-off')); assert.equal(f.copies.length, 1);
  await f.call(CHANNELS.setToolConfig, { autoCopyResults: true }); assert.equal(f.copies.length, 1);
  await f.execute('{different'); assert.equal(f.copies.length, 2, '新用户提交同样错误有独立回执');
  const webError = fenced('{new-invalid'); f.setReply(webError); await f.system.accept(webError, 'complete');
  await until(() => f.sent.length === 1); assert.equal(f.system.getState().source, undefined);
  assert.equal(f.system.getState().clipboard, undefined, '官网诊断不可继承手动复制通知');
  assert.equal(f.copies.length, 2, '官网解析诊断不扩大现有自动复制资格');
});

it('无项目、交互忙和非法 IPC 正文拒绝不覆盖旧回执或复制通知', async t => {
  const f = await fixture(t); await f.execute(json('preserved'));
  const before = f.system.getState().results; const count = f.copies.length;
  f.setBusy(true); assert.equal((await f.execute('{broken')).ok, false); assert.deepEqual(f.system.getState().results, before);
  f.setBusy(false);
  for (const raw of [null, {}, '\0', 'x'.repeat(200001)]) {
    assert.equal((await f.call(CHANNELS.executeToolJson, raw)).ok, false); assert.deepEqual(f.system.getState().results, before);
  }
  assert.equal(f.copies.length, count); t.mock.method(f.files, 'getRoot', () => null);
  assert.equal((await f.execute('{broken')).ok, false); assert.equal(f.copies.length, count);
});

it('旧版本无 source 字段的预约可恢复为手动来源，仍不重放执行或复制历史', async t => {
  const f = await fixture(t); await f.execute(json('legacy-source'));
  const data = JSON.parse(await fs.readFile(f.storePath, 'utf8')); delete data.ledger[0].source;
  await fs.writeFile(f.storePath, JSON.stringify(data));
  const store = new ToolStore(f.storePath); await store.ready(); let calls = 0;
  const harness = new ToolHarness({ store, root: () => f.root, session: () => sessionKeyOf(f.web.getURL()), execute: async () => { calls++; return {}; },
    describe: async () => ({ external: false, fingerprint: 'x' }), authorize: async () => 'once', changed() {} });
  await harness.collectManual(JSON.parse(json('legacy-source')));
  assert.equal(calls, 0); assert.equal(harness.state.source, 'manual'); assert.equal(harness.state.restored, true); assert.equal(harness.state.completion, undefined);
  assert.equal(store.getEntries()[0]!.source, 'manual');
});

it('审批中同平台主 frame 完整导航与页面内导航 A→B→A 仍撤销未启动的手动请求', async t => {
  for (const kind of ['full', 'in-page'] as const) {
    const f = await fixture(t, 'https://chat.deepseek.com/a/chat/one'); let release!: () => void;
    f.setAsk(() => new Promise(resolve => { release = () => resolve({ response: 0, checkboxChecked: false }); }));
    const running = f.execute(json('navigation-' + kind, 'apply_changes', { changes: [{ path: 'never-nav.txt', operation: 'create', content: 'never' }] }));
    await until(() => Boolean(release));
    const urls = ['https://chat.deepseek.com/a/chat/two', 'https://chat.deepseek.com/a/chat/one'];
    for (const url of urls) {
      if (kind === 'full') f.web.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
      else f.web.emit('did-navigate-in-page', {}, url, true);
    }
    release(); await running;
    await assert.rejects(fs.stat(path.join(f.root, 'never-nav.txt')), { code: 'ENOENT' });
    assert.equal(f.system.getState().results[0]?.status, 'cancelled'); assert.equal(f.copies.length, 0); assert.equal(f.sent.length, 0);
  }
});

it('子 frame 导航不撤销当前手动审批，完成批次查询不因主 frame 导航重复复制', async t => {
  const f = await fixture(t, 'https://chat.deepseek.com/a/chat/one'); let release!: () => void;
  f.setAsk(() => new Promise(resolve => { release = () => resolve({ response: 0, checkboxChecked: false }); }));
  const running = f.execute(json('child-navigation', 'apply_changes', { changes: [{ path: 'approved-nav.txt', operation: 'create', content: 'approved' }] }));
  await until(() => Boolean(release));
  f.web.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  f.web.emit('did-navigate-in-page', {}, 'https://chat.deepseek.com/child', false);
  release(); await running;
  assert.equal(await fs.readFile(path.join(f.root, 'approved-nav.txt'), 'utf8'), 'approved'); assert.equal(f.copies.length, 1);
  f.web.emit('did-navigate-in-page', {}, 'https://chat.deepseek.com/a/chat/other', true);
  f.web.emit('did-navigate-in-page', {}, 'https://chat.deepseek.com/a/chat/one', true);
  f.system.getState(); assert.equal(f.copies.length, 1); assert.equal(f.system.getState().results[0]?.status, 'done');
});
