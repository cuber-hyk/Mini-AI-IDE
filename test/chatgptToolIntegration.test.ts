import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createToolIntegration } from '../src/main/tools/integration';
import { ToolAttachments } from '../src/main/tools/attachments';
import { CHATGPT_OBSERVATION_SCRIPT } from '../src/main/chatgptPage';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { CHANNELS } from '../src/shared/contract';

const batch = (id: string, tool = 'get_project_info', args: unknown = {}) => '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: id, requests: [{ id: 'request', tool, args }] }) + '\n```';
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'ChatGPT 工具闭环应在有界时间内完成'); await delay(5); }
}

function page(url: string) {
  let reply = ''; let completion = 'complete'; let waiter: ((value: unknown) => void) | undefined;
  let beforeRead = async () => {}; let reads = 0;
  const read = async () => { reads++; const snapshot = { replies: [reply], completion, signature: completion + ':' + reply }; await beforeRead(); return snapshot; };
  const web: any = Object.assign(new EventEmitter(), {
    getURL: () => url, isDestroyed: () => false,
    executeJavaScript: read,
    async executeJavaScriptInIsolatedWorld(world: number, scripts: { code: string }[]) {
      const code = scripts[0]!.code;
      if (code.includes(CHATGPT_OBSERVATION_SCRIPT) || code.includes('const replies =')) { assert.equal(world, 1004); return read(); }
      if (code.includes('previous.waiter = resolve')) return new Promise(resolve => { waiter = resolve; });
      if (code.includes('previous.dispose();')) { waiter?.(false); waiter = undefined; return true; }
      if (code.includes('return { turn:')) return { turn: 0 };
      return { hasReplies: Boolean(reply) };
    },
  });
  return { web, get reads() { return reads; }, setReply(text: string) { reply = text; }, setCompletion(value: string) { completion = value; },
    setRead(fn: typeof beforeRead) { beforeRead = fn; }, async ready() { await until(() => Boolean(waiter)); },
    async notify(text: string) { reply = text; await until(() => Boolean(waiter)); const notify = waiter!; waiter = undefined; notify({ turn: 0 }); },
  };
}

async function fixture(t: TestContext, initial = 'chatgpt') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-tools-')); const files = new FileService(); files.setRoot(root);
  const gpt = page('https://chatgpt.com/c/test-id'); const deepseek = page('https://chat.deepseek.com/a/chat/platform');
  const copies: string[] = []; const sent: { text: string; session: string; attachments: number }[] = [];
  let approved = true; let approvals = 0;
  const sender = () => ({
    async send(text: string, session: string, _kind: unknown, current: () => boolean, attachments?: readonly unknown[]) {
      assert.equal(current(), true, '失效运输不得进入发送器'); sent.push({ text, session, attachments: attachments?.length ?? 0 }); return { ok: true };
    }, async cancel() {}, async dispose() {},
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  const editor: any = { mainFrame: {}, isDestroyed: () => false, send() {} };
  const system = await createToolIntegration({ files, web: initial === 'chatgpt' ? gpt.web : deepseek.web, editor,
    ipc: { handle(channel: string, fn: any) { handlers.set(channel, fn); } } as any,
    workspace: { editor: { isDirty: () => false, current: { documents: [] } }, run: (fn: any) => fn() } as any,
    returnPath: new ReturnPathService(files), storePath: path.join(root, 'tools.json'), disabled: false,
    ask: async () => { approvals++; return { response: approved ? 0 : 2, checkboxChecked: false }; },
    notifyFile() {}, copy(text) { copies.push(text); }, sender: sender(),
  });
  t.after(async () => { await system.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, system, gpt, deepseek, sent, copies, get approvals() { return approvals; }, deny() { approved = false; },
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: editor, senderFrame: editor.mainFrame }, ...args),
    async switchTo(next: ReturnType<typeof page>) { await system.setWebActive(false); await system.bindWeb(next.web, sender()); await system.setWebActive(true); await next.ready(); },
  };
}

it('ChatGPT 新完成回复按权限修改本地文件，整批结果只回传一次且与复制一致', async t => {
  const f = await fixture(t);
  await f.call(CHANNELS.setToolConfig, { permission: 'ask', automatic: true, sendIntervalSeconds: 0 }); await f.gpt.ready();
  await f.gpt.notify(batch('gpt-write', 'apply_changes', { changes: [{ path: 'created.txt', operation: 'create', content: 'verified ChatGPT tool result' }] }));
  await until(() => f.sent.length === 1);
  assert.equal(f.approvals, 1); assert.equal(await fs.readFile(path.join(f.root, 'created.txt'), 'utf8'), 'verified ChatGPT tool result');
  assert.equal(f.system.getState().results[0]?.status, 'done'); assert.equal(f.sent[0]!.session, 'https://chatgpt.com/c/test-id');
  assert.equal(f.sent[0]!.text, f.copies[0]); assert.equal(f.sent[0]!.attachments, 0);
  await f.gpt.notify(batch('gpt-write', 'apply_changes', { changes: [{ path: 'created.txt', operation: 'create', content: 'verified ChatGPT tool result' }] }));
  await f.gpt.ready(); await delay(30); assert.equal(f.sent.length, 1); assert.equal(f.approvals, 1); assert.equal(f.copies.length, 1);
});

it('ChatGPT 自动执行仍遵守拒绝权限，拒绝回执不会产生文件副作用', async t => {
  const f = await fixture(t); f.deny();
  await f.call(CHANNELS.setToolConfig, { permission: 'ask', automatic: true, sendIntervalSeconds: 0 }); await f.gpt.ready();
  await f.gpt.notify(batch('gpt-denied', 'apply_changes', { changes: [{ path: 'forbidden.txt', operation: 'create', content: 'must not exist' }] }));
  await until(() => f.sent.length === 1);
  await assert.rejects(fs.stat(path.join(f.root, 'forbidden.txt')), { code: 'ENOENT' });
  assert.equal(f.system.getState().results[0]?.status, 'permission_denied'); assert.equal(f.copies.length, 0);
  assert.equal(JSON.parse(f.sent[0]!.text).tool_results[0].status, 'permission_denied');
});

it('ChatGPT attach_file 明确失败，文件不进入暂存读取与上传', async t => {
  const f = await fixture(t); const staged = t.mock.method(ToolAttachments.prototype, 'stage', async () => { throw new Error('不应读取附件'); });
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 }); await f.gpt.ready();
  await f.gpt.notify(batch('gpt-attachment', 'attach_file', { path: 'private-document.docx' }));
  await until(() => f.system.getState().results[0]?.status === 'failed' && !f.system.getState().busy);
  const result = f.system.getState().results[0]!;
  assert.match(result.error ?? '', /ChatGPT.*纯文本.*附件未读取或上传/); assert.equal(result.data, undefined);
  assert.equal(staged.mock.callCount(), 0); assert.equal(f.approvals, 0);
  assert.equal((await f.call(CHANNELS.copyToolResults)).ok, true); assert.match(f.copies.at(-1)!, /附件未读取或上传/);
  await delay(30); assert.equal(f.sent.length, 0, '未执行附件不能成为自动回传结果');
});

it('切到 ChatGPT 保留 DeepSeek 结果供复制，旧结果不补发，新 ChatGPT 批次正常回传', async t => {
  const f = await fixture(t, 'deepseek');
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 300 }); await f.deepseek.ready();
  await f.deepseek.notify(batch('deepseek-old')); await until(() => f.system.getState().continuation?.phase === 'countdown');
  await f.switchTo(f.gpt);
  assert.equal(f.system.getState().results[0]?.batch_id, 'deepseek-old'); assert.equal((await f.call(CHANNELS.copyToolResults)).ok, true);
  assert.match(f.copies.at(-1)!, /deepseek-old/); assert.equal((await f.call(CHANNELS.sendToolResults)).ok, false);
  await f.call(CHANNELS.setToolConfig, { sendIntervalSeconds: 0 }); await delay(30); assert.equal(f.sent.length, 0);
  await f.gpt.notify(batch('chatgpt-fresh')); await until(() => f.sent.length === 1);
  assert.equal(JSON.parse(f.sent[0]!.text).tool_results[0].batch_id, 'chatgpt-fresh'); assert.equal(f.sent[0]!.session, 'https://chatgpt.com/c/test-id');
});

it('切平台前尚未返回的 DeepSeek 读取不能在 ChatGPT 活动时执行', async t => {
  const f = await fixture(t, 'deepseek');
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 }); await f.deepseek.ready();
  let release!: () => void; f.deepseek.setRead(() => new Promise<void>(resolve => { release = resolve; }));
  await f.deepseek.notify(batch('late-old-page', 'apply_changes', { changes: [{ path: 'late.txt', operation: 'create', content: 'must not exist' }] }));
  await until(() => Boolean(release)); await f.switchTo(f.gpt); f.deepseek.setRead(async () => {}); release();
  await delay(30); await assert.rejects(fs.stat(path.join(f.root, 'late.txt')), { code: 'ENOENT' }); assert.equal(f.sent.length, 0);
  await f.gpt.notify(batch('after-late-read')); await until(() => f.sent.length === 1);
  assert.equal(JSON.parse(f.sent[0]!.text).tool_results[0].batch_id, 'after-late-read');
});

it('ChatGPT 用户手动中断命令撤销本批自动回传，真实输出仍自动复制，下一批可继续', async t => {
  const f = await fixture(t);
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 }); await f.gpt.ready();
  await f.gpt.notify(batch('gpt-stopped', 'run_command', {
    command: process.platform === 'win32' ? "Write-Output 'before-user-stop'; Set-Content -LiteralPath 'started.txt' -Value ready; Start-Sleep -Seconds 30" : 'printf before-user-stop; touch started.txt; sleep 30',
    shell: process.platform === 'win32' ? 'powershell' : 'bash', timeout_ms: 60_000,
  }));
  await until(async () => { try { await fs.access(path.join(f.root, 'started.txt')); return true; } catch { return false; } });
  const processId = (f.system.getState().results[0]!.data as any).process_id;
  await f.call(CHANNELS.stopToolCommand, { batch_id: 'gpt-stopped', request_id: 'request', process_id: processId });
  await until(() => !f.system.getState().busy && f.copies.length === 1);
  assert.equal(f.sent.length, 0); assert.equal(f.system.getState().userInterrupted, true);
  const stopped = JSON.parse(f.copies[0]!).tool_results[0]; assert.equal(stopped.data.status, 'stopped'); assert.equal(stopped.data.cleanup_pending, false); assert.match(stopped.data.stdout, /before-user-stop/);
  await f.call(CHANNELS.setToolConfig, { automatic: false }); await f.call(CHANNELS.setToolConfig, { automatic: true }); await f.gpt.ready();
  await delay(30); assert.equal(f.sent.length, 0, '重新开启不得补发用户中断的批次');
  await f.gpt.notify(batch('gpt-after-stop')); await until(() => f.sent.length === 1);
  assert.equal(JSON.parse(f.sent[0]!.text).tool_results[0].batch_id, 'gpt-after-stop');
});
