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
import type { PromptAttachmentData } from '../src/shared/localPrompt';

const batch = (id: string, tool = 'get_project_info', args: unknown = {}) => '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: id, requests: [{ id: 'request', tool, args }] }) + '\n```';
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'ChatGPT 工具闭环应在有界时间内完成'); await delay(5); }
}

function page(url: string) {
  let reply = ''; let completion = 'complete'; let waiter: ((value: unknown) => void) | undefined;
  let sourceAvailable = true;
  let beforeRead = async () => {}; let reads = 0;
  const read = async () => { reads++; const snapshot = { replies: [reply], completion, signature: completion + ':' + reply + ':' + sourceAvailable,
    ...(sourceAvailable ? { source: 'new', sourceKey: 'fixture|' + completion + ':' + reply } : {}) }; await beforeRead(); return snapshot; };
  const web: any = Object.assign(new EventEmitter(), {
    getURL: () => url, isDestroyed: () => false,
    executeJavaScript: read,
    async executeJavaScriptInIsolatedWorld(world: number, scripts: { code: string }[]) {
      const code = scripts[0]!.code;
      if (code.includes(CHATGPT_OBSERVATION_SCRIPT) || code.includes('const replies =')) { assert.equal(world, 1004); return read(); }
      if (code.includes('const accepted = expected')) return sourceAvailable ? { turn: 0, accepted: true } : false;
      if (code.includes('previous.waiter = resolve')) return new Promise(resolve => { waiter = resolve; });
      if (code.includes('previous.dispose();')) { waiter?.(false); waiter = undefined; return true; }
      if (code.includes('return { turn:')) return { turn: 0 };
      return { hasReplies: Boolean(reply) };
    },
  });
  return { web, get reads() { return reads; }, setReply(text: string) { reply = text; }, setCompletion(value: string) { completion = value; },
    setSourceAvailable(value: boolean) { sourceAvailable = value; },
    setRead(fn: typeof beforeRead) { beforeRead = fn; }, async ready() { await until(() => Boolean(waiter)); },
    async notify(text: string) { reply = text; await until(() => Boolean(waiter)); const notify = waiter!; waiter = undefined; notify({ turn: 0 }); },
  };
}

async function fixture(t: TestContext, initial = 'chatgpt') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-tools-')); const files = new FileService(); files.setRoot(root);
  const gpt = page('https://chatgpt.com/c/test-id'); const deepseek = page('https://chat.deepseek.com/a/chat/platform');
  const copies: string[] = []; const sent: { text: string; session: string; attachments: number; contents: string[] }[] = [];
  const approvalDetails: string[] = []; let response = 0; let approvals = 0; let beforeApproval = async () => {};
  const sender = () => ({
    async send(text: string, session: string, _kind: unknown, current: () => boolean, attachments?: readonly PromptAttachmentData[]) {
      assert.equal(current(), true, '失效运输不得进入发送器');
      const contents: string[] = [];
      for (const file of attachments ?? []) {
        const chunks: Uint8Array[] = []; for await (const chunk of file.stream()) chunks.push(chunk);
        contents.push(Buffer.concat(chunks).toString('utf8'));
      }
      sent.push({ text, session, attachments: attachments?.length ?? 0, contents }); return { ok: true };
    }, async cancel() {}, async dispose() {},
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  const editor: any = { mainFrame: {}, isDestroyed: () => false, send() {} };
  const system = await createToolIntegration({ files, web: initial === 'chatgpt' ? gpt.web : deepseek.web, editor,
    ipc: { handle(channel: string, fn: any) { handlers.set(channel, fn); } } as any,
    workspace: { editor: { isDirty: () => false, current: { documents: [] } }, run: (fn: any) => fn() } as any,
    returnPath: new ReturnPathService(files), storePath: path.join(root, 'tools.json'), disabled: false,
    ask: async (_title, detail) => { approvals++; approvalDetails.push(detail); await beforeApproval(); return { response, checkboxChecked: false }; },
    notifyFile() {}, copy(text) { copies.push(text); }, sender: sender(),
  });
  t.after(async () => { await system.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, system, gpt, deepseek, sent, copies, approvalDetails, get approvals() { return approvals; }, deny() { response = 2; }, remember() { response = 1; },
    setApprovalWait(wait: () => Promise<void>) { beforeApproval = wait; },
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: editor, senderFrame: editor.mainFrame }, ...args),
    async switchTo(next: ReturnType<typeof page>) { await system.setWebActive(false); await system.bindWeb(next.web, sender()); await system.setWebActive(true); await next.ready(); },
  };
}

it('同文档来源状态丢失的完整回复不能自动执行，恢复后只接纳明确的新来源', async t => {
  const f = await fixture(t);
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 }); await f.gpt.ready();
  f.gpt.setSourceAvailable(false);
  await f.gpt.notify(batch('source-lost-history', 'apply_changes', { changes: [{ path: 'history-must-not-run.txt', operation: 'create', content: 'unwitnessed history' }] }));
  await until(() => f.system.getState().collection?.reason === 'source_changed');
  assert.equal(f.system.getState().collection?.phase, 'paused');
  assert.deepEqual(f.system.getState().results, []); assert.equal(f.approvals, 0);
  assert.deepEqual(f.sent, []); assert.deepEqual(f.copies, []);
  await assert.rejects(fs.access(path.join(f.root, 'history-must-not-run.txt')), { code: 'ENOENT' });
  f.gpt.setSourceAvailable(true);
  await f.gpt.notify(batch('after-source-recovery', 'apply_changes', { changes: [{ path: 'fresh-after-recovery.txt', operation: 'create', content: 'new witnessed reply' }] }));
  await until(() => f.sent.length === 1);
  assert.equal(await fs.readFile(path.join(f.root, 'fresh-after-recovery.txt'), 'utf8'), 'new witnessed reply');
  await assert.rejects(fs.access(path.join(f.root, 'history-must-not-run.txt')), { code: 'ENOENT' });
  assert.equal(JSON.parse(f.sent[0]!.text).tool_results[0].batch_id, 'after-source-recovery');
});

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

it('ChatGPT 批次图片和文档逐项批准，真实字节整批回传一次且正文与复制一致', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'figure.png'), 'real-image-bytes'); await fs.writeFile(path.join(f.root, 'paper.pdf'), 'real-document-bytes');
  await f.call(CHANNELS.setToolConfig, { permission: 'ask', automatic: true, sendIntervalSeconds: 0 }); await f.gpt.ready();
  const text = '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: 'gpt-attachments', requests: [
    { id: 'image', tool: 'attach_file', args: { path: 'figure.png' } }, { id: 'document', tool: 'attach_file', args: { path: 'paper.pdf' } },
  ] }) + '\n```';
  await f.gpt.notify(text); await until(() => f.sent.length === 1);
  assert.equal(f.approvals, 2); assert.ok(f.approvalDetails.every(detail => detail.includes('上传到当前 ChatGPT')));
  assert.ok(f.approvalDetails.every(detail => !detail.includes('DeepSeek')));
  assert.ok(f.system.getState().results.every(result => result.status === 'done'));
  assert.deepEqual(f.sent[0]!.contents, ['real-image-bytes', 'real-document-bytes']); assert.equal(f.sent[0]!.attachments, 2);
  assert.equal(f.sent[0]!.text, f.copies[0]);
  assert.deepEqual(Object.keys(JSON.parse(f.sent[0]!.text).tool_results[0].data).sort(), ['id', 'mediaType', 'name', 'size']);
  await f.gpt.notify(text); await f.gpt.ready(); await delay(30);
  assert.equal(f.sent.length, 1); assert.equal(f.approvals, 2); assert.equal((await f.call(CHANNELS.sendToolResults)).ok, false);
});

it('ChatGPT 附件被拒绝时不暂存或读取字节，纯拒绝回执无附件', async t => {
  const f = await fixture(t); f.deny(); await fs.writeFile(path.join(f.root, 'private.docx'), 'private-document');
  const staged = t.mock.method(ToolAttachments.prototype, 'stage', async () => { assert.fail('拒绝附件不得暂存读取'); });
  await f.call(CHANNELS.setToolConfig, { permission: 'ask', automatic: true, sendIntervalSeconds: 0 }); await f.gpt.ready();
  await f.gpt.notify(batch('gpt-attachment-denied', 'attach_file', { path: 'private.docx' })); await until(() => f.sent.length === 1);
  assert.equal(f.approvals, 1); assert.equal(staged.mock.callCount(), 0);
  assert.equal(f.system.getState().results[0]?.status, 'permission_denied');
  assert.equal(f.sent[0]!.attachments, 0); assert.deepEqual(f.sent[0]!.contents, []); assert.equal(f.copies.length, 0);
});

it('ChatGPT 附件精确规则复用真实文件身份，文件改变后必须重新批准', async t => {
  const f = await fixture(t); f.remember(); const file = path.join(f.root, 'remembered.pdf'); await fs.writeFile(file, 'first');
  await f.call(CHANNELS.setToolConfig, { permission: 'rules', automatic: true, sendIntervalSeconds: 0 }); await f.gpt.ready();
  await f.gpt.notify(batch('gpt-rule-first', 'attach_file', { path: 'remembered.pdf' })); await until(() => f.sent.length === 1);
  await f.gpt.notify(batch('gpt-rule-reused', 'attach_file', { path: 'remembered.pdf' })); await until(() => f.sent.length === 2);
  assert.equal(f.approvals, 1); assert.deepEqual(f.sent.map(item => item.contents), [['first'], ['first']]);
  await fs.writeFile(file, 'changed-document'); f.deny();
  await f.gpt.notify(batch('gpt-rule-changed', 'attach_file', { path: 'remembered.pdf' })); await until(() => f.sent.length === 3);
  assert.equal(f.approvals, 2); assert.equal(f.system.getState().results[0]?.status, 'permission_denied'); assert.equal(f.sent[2]!.attachments, 0);
});

it('ChatGPT automatic 关闭时附件只暂存，由用户手动发送当前整批一次', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'manual-send.docx'), 'manual-send-bytes');
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: false, sendIntervalSeconds: 0 });
  const text = batch('gpt-attachment-manual-send', 'attach_file', { path: 'manual-send.docx' }); f.gpt.setReply(text);
  await f.system.accept(text, 'complete'); await until(() => !f.system.getState().busy && f.system.getState().results[0]?.status === 'done');
  assert.equal(f.sent.length, 0); assert.equal(f.approvals, 0);
  assert.equal((await f.call(CHANNELS.sendToolResults)).ok, true); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0]!.contents, ['manual-send-bytes']); assert.equal(f.sent[0]!.text, f.copies[0]);
  assert.equal((await f.call(CHANNELS.sendToolResults)).ok, false);
});

it('ChatGPT 手动 JSON 来源的 attach_file 不读取、暂存或上传，即使 automatic 开启', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'manual-json.pdf'), 'must-not-upload');
  const staged = t.mock.method(ToolAttachments.prototype, 'stage', async () => { assert.fail('手动 JSON 附件不得读取'); });
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 }); await f.gpt.ready();
  assert.equal((await f.call(CHANNELS.executeToolJson, batch('gpt-manual-json', 'attach_file', { path: 'manual-json.pdf' }))).ok, true);
  assert.equal(f.system.getState().source, 'manual'); assert.equal(f.system.getState().results[0]?.status, 'failed');
  assert.match(f.system.getState().results[0]?.error ?? '', /手动 JSON.*附件未读取或上传/);
  assert.equal(staged.mock.callCount(), 0); assert.equal(f.approvals, 0); assert.equal(f.sent.length, 0);
  assert.equal((await f.call(CHANNELS.sendToolResults)).ok, false);
});

it('ChatGPT 附件审批中禁止绑定其他平台，网页失活再恢复不能复活旧批准', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'pending.pdf'), 'approval-pending');
  const stage = ToolAttachments.prototype.stage;
  const staged = t.mock.method(ToolAttachments.prototype, 'stage', stage);
  let release!: () => void;
  f.setApprovalWait(() => new Promise<void>(resolve => { release = resolve; }));
  await f.call(CHANNELS.setToolConfig, { permission: 'ask', automatic: true, sendIntervalSeconds: 0 }); await f.gpt.ready();
  await f.gpt.notify(batch('gpt-attachment-before-switch', 'attach_file', { path: 'pending.pdf' })); await until(() => Boolean(release));
  await f.system.setWebActive(false);
  await assert.rejects(f.system.bindWeb(f.deepseek.web), /工具正在执行/);
  await f.system.setWebActive(true); release();
  await until(() => !f.system.getState().busy);
  assert.equal(staged.mock.callCount(), 0); assert.equal(f.sent.length, 0); assert.equal((await f.call(CHANNELS.sendToolResults)).ok, false);
  f.setApprovalWait(async () => {});
  await f.gpt.notify(batch('gpt-attachment-after-switch', 'attach_file', { path: 'pending.pdf' })); await until(() => f.sent.length === 1);
  assert.equal(f.approvals, 2); assert.deepEqual(f.sent[0]!.contents, ['approval-pending']);
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
