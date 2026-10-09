import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createToolIntegration, describeTool } from '../src/main/tools/integration';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { CHANNELS } from '../src/shared/contract';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-attachment-integration-'));
  const content = Buffer.from('real file bytes');
  await fs.writeFile(path.join(root, 'figure.png'), content); await fs.writeFile(path.join(root, 'paper.pdf'), content);
  const handlers = new Map<string, Function>(); const sent: { args: any[]; bytes: Buffer[] }[] = []; const approvals: string[] = [];
  let response = 0; let url = 'https://chat.deepseek.com/a/chat/attachments'; let reply = ''; let completion = 'complete';
  let waiter: ((value: unknown) => void) | undefined;
  const editor: any = { mainFrame: {}, isDestroyed: () => false, send() {} }; const event = { sender: editor, senderFrame: editor.mainFrame };
  const files = new FileService(); files.setRoot(root);
  const web: any = Object.assign(new EventEmitter(), { getURL: () => url, isDestroyed: () => false,
    executeJavaScript: async () => ({ replies: [reply], completion }), executeJavaScriptInIsolatedWorld: async (_world: number, entries: { code: string }[]) => {
      const code = entries[0]!.code;
      if (code.includes('previous.waiter = resolve')) return new Promise(resolve => { waiter = resolve; });
      if (code.includes('previous.dispose();')) { waiter?.(false); waiter = undefined; }
      return true;
    } });
  const system = await createToolIntegration({ ipc: { handle: (channel: string, handler: Function) => handlers.set(channel, handler) } as any,
    editor, web, files, returnPath: new ReturnPathService(files), workspace: { editor: { isDirty: () => false }, run: (fn: any) => fn() } as any,
    storePath: path.join(root, 'state.json'), disabled: false,
    ask: async (_title, detail) => { approvals.push(detail); return { response, checkboxChecked: false }; }, notifyFile() {}, copy() {},
    sender: { async send(...args: any[]) {
      const bytes: Buffer[] = [];
      for (const file of args[4] ?? []) { const chunks = []; for await (const chunk of file.stream()) chunks.push(chunk); bytes.push(Buffer.concat(chunks)); }
      sent.push({ args, bytes }); return { ok: true };
    }, async cancel() {}, async dispose() {} } as any });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  const batch = (id: string) => '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: id,
    requests: [{ id: 'image', tool: 'attach_file', args: { path: 'figure.png' } }, { id: 'pdf', tool: 'attach_file', args: { path: 'paper.pdf' } }] }) + '\n```';
  const wait = async (check: () => boolean) => {
    for (let n = 0; n < 200 && !check(); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(check(), true, '工具状态应在有界时间内就绪');
  };
  return { system, files, root, content, sent, approvals, handlers, editor, invoke, batch, wait,
    setResponse(value: number) { response = value; }, setURL(value: string) { url = value; }, setReply(value: string) { reply = value; }, setCompletion(value: string) { completion = value; },
    async accept(id: string) { reply = batch(id); await system.accept(reply, 'complete'); await wait(() => !system.getState().busy); },
    async dispose() { await system.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); } };
}

it('ask 下项目内图片/PDF也审批上传，关闭自动继续只暂存，手动发送整批正文与真实字节一次', async () => {
  const f = await fixture();
  try {
    await f.accept('manual'); assert.equal(f.approvals.length, 2); assert.match(f.approvals[0]!, /上传到当前 DeepSeek/);
    assert.equal(f.sent.length, 0); assert.equal(f.system.getState().resultReturn?.canSend, true);
    const results = f.system.getState().results; assert.ok(results.every(result => result.status === 'done'));
    assert.deepEqual(Object.keys(results[0]!.data as object).sort(), ['id', 'mediaType', 'name', 'size']);
    assert.equal((await f.invoke(CHANNELS.sendToolResults)).ok, true);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.args[2], 'results'); assert.equal(typeof f.sent[0]!.args[3], 'function');
    assert.deepEqual(f.sent[0]!.bytes, [f.content, f.content]); assert.equal(JSON.parse(f.sent[0]!.args[0]).tool_results.length, 2);
    assert.equal((await f.invoke(CHANNELS.sendToolResults)).ok, false); assert.equal(f.sent.length, 1);
    assert.throws(() => f.handlers.get(CHANNELS.sendToolResults)!({ sender: {}, senderFrame: {} }), /编辑器主 frame/);
    assert.throws(() => f.invoke(CHANNELS.sendToolResults, { path: 'secret' }), /参数数量/);
  } finally { await f.dispose(); }
});

it('automatic full 在真实批次完成后自动回传文件，不允许手动或历史重放', async () => {
  const f = await fixture();
  try {
    await f.invoke(CHANNELS.setToolConfig, { automatic: true, permission: 'full', sendIntervalSeconds: 0 });
    await f.accept('automatic'); await f.wait(() => f.sent.length === 1);
    assert.equal(f.approvals.length, 0); assert.deepEqual(f.sent[0]!.bytes, [f.content, f.content]);
    assert.equal((await f.invoke(CHANNELS.sendToolResults)).ok, false);
    await f.invoke(CHANNELS.setToolConfig, { automatic: false });
    await f.accept('automatic'); assert.equal((await f.invoke(CHANNELS.sendToolResults)).ok, false);
    assert.equal(f.sent.length, 1);
  } finally { await f.dispose(); }
});

it('ask/rules 审批拒绝不暂存、不上传，取消和切会话不回传旧批', async () => {
  for (const scenario of ['deny', 'rules', 'cancel', 'session', 'root', 'reply', 'generating', 'changed'] as const) {
    const f = await fixture();
    try {
      if (scenario === 'deny' || scenario === 'rules') f.setResponse(2);
      if (scenario === 'rules') await f.invoke(CHANNELS.setToolConfig, { permission: 'rules' });
      await f.accept(scenario);
      if (scenario === 'deny' || scenario === 'rules') assert.ok(f.system.getState().results.every(result => result.status === 'permission_denied'));
      if (scenario === 'cancel') await f.invoke(CHANNELS.cancelTools);
      if (scenario === 'session') f.setURL('https://chat.deepseek.com/a/chat/other');
      if (scenario === 'root') f.files.clearRoot();
      if (scenario === 'reply') f.setReply(f.batch('different'));
      if (scenario === 'generating') f.setCompletion('generating');
      if (scenario === 'changed') await fs.writeFile(path.join(f.root, 'figure.png'), 'other content');
      assert.equal((await f.invoke(CHANNELS.sendToolResults)).ok, false, scenario); assert.equal(f.sent.length, 0);
    } finally { await f.dispose(); }
  }
});

it('附件授权指纹绑定真实文件身份，替换同路径内容后旧精确规则失效', async () => {
  const f = await fixture();
  try {
    const request = { id: 'file', tool: 'attach_file' as const, args: { path: 'figure.png' } };
    const before = await describeTool(f.root, request); assert.equal(before.external, false);
    await fs.writeFile(path.join(f.root, 'figure.png'), 'new bytes');
    assert.notEqual((await describeTool(f.root, request)).fingerprint, before.fingerprint);
  } finally { await f.dispose(); }
});
