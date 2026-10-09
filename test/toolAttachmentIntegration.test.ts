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
  const handlers = new Map<string, Function>(); const sent: { args: any[]; bytes: Buffer[] }[] = []; const approvals: string[] = []; const copies: string[] = [];
  let response = 0; let url = 'https://chat.deepseek.com/a/chat/attachments'; let reply = ''; let completion = 'complete';
  let waiter: ((value: unknown) => void) | undefined;
  let beforeRead: (() => Promise<void>) | undefined;
  const editor: any = { mainFrame: {}, isDestroyed: () => false, send() {} }; const event = { sender: editor, senderFrame: editor.mainFrame };
  const files = new FileService(); files.setRoot(root);
  const web: any = Object.assign(new EventEmitter(), { getURL: () => url, isDestroyed: () => false,
    executeJavaScript: async () => { await beforeRead?.(); return { replies: [reply], completion }; }, executeJavaScriptInIsolatedWorld: async (_world: number, entries: { code: string }[]) => {
      const code = entries[0]!.code;
      if (code.includes('previous.waiter = resolve')) return new Promise(resolve => { waiter = resolve; });
      if (code.includes('previous.dispose();')) { waiter?.(false); waiter = undefined; }
      return true;
    } });
  const system = await createToolIntegration({ ipc: { handle: (channel: string, handler: Function) => handlers.set(channel, handler) } as any,
    editor, web, files, returnPath: new ReturnPathService(files), workspace: { editor: { isDirty: () => false }, run: (fn: any) => fn() } as any,
    storePath: path.join(root, 'state.json'), disabled: false,
    ask: async (_title, detail) => { approvals.push(detail); return { response, checkboxChecked: false }; }, notifyFile() {}, copy(text) { copies.push(text); },
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
  return { system, files, root, content, sent, approvals, copies, handlers, editor, invoke, batch, wait,
    setResponse(value: number) { response = value; }, setURL(value: string) { url = value; }, setReply(value: string) { reply = value; }, setCompletion(value: string) { completion = value; },
    setBeforeRead(value: () => Promise<void>) { beforeRead = value; },
    navigate(value: string) { url = value; web.emit('did-navigate-in-page', {}, url, true); },
    async accept(id: string) { reply = batch(id); await system.accept(reply, 'complete'); await wait(() => !system.getState().busy); },
    async acceptText(text: string) { reply = text; await system.accept(reply, 'complete'); },
    async dispose() { await system.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); } };
}

it('解析失败无 selection/completion 时自动回传与复制字节一致的完整诊断，不携带附件', async () => {
  const f = await fixture();
  try {
    await f.invoke(CHANNELS.setToolConfig, { automatic: true, sendIntervalSeconds: 0 });
    await f.acceptText('```mini-ai-tools\n{\n  "protocol_version": 1,\n  "requests": [}\n```');
    assert.equal(f.system.getState().completion, undefined);
    assert.deepEqual(f.system.getState().results, []);
    assert.equal((await f.invoke(CHANNELS.copyToolResults)).ok, true);
    await f.wait(() => f.sent.length === 1);
    assert.equal(f.sent[0]!.args[0], f.copies[0]);
    assert.match(JSON.parse(f.sent[0]!.args[0]).batch_error.error, /行|line/);
    assert.deepEqual(f.sent[0]!.args[4], []); assert.deepEqual(f.sent[0]!.bytes, []);
    assert.equal(f.approvals.length, 0);
  } finally { await f.dispose(); }
});

const badReply = (round: number) => `第 ${round} 轮\n\`\`\`mini-ai-tools\n{}\n\`\`\``;

it('不同回复即使诊断相同也最多连续回传五次，第六次及重复广播保持暂停', async () => {
  const f = await fixture();
  try {
    await f.invoke(CHANNELS.setToolConfig, { automatic: true, sendIntervalSeconds: 0 });
    let error = '';
    for (let round = 1; round <= 5; round++) {
      await f.acceptText(badReply(round));
      await f.wait(() => f.system.getState().continuation?.phase === 'waiting_reply');
      if (round === 1) error = f.system.getState().batchError!.error;
      assert.equal(f.system.getState().batchError!.error, error, '相同诊断不能吞掉新回复');
      assert.equal(f.sent.length, round);
      await f.acceptText(badReply(round));
      await f.invoke(CHANNELS.setToolConfig, { sendIntervalSeconds: 0 });
      assert.equal(f.system.getState().continuation?.phase, 'waiting_reply'); assert.equal(f.sent.length, round);
    }
    await f.acceptText(badReply(6));
    assert.equal(f.system.getState().continuation?.phase, 'paused');
    assert.match(f.system.getState().continuation!.message, /连续 5 次/);
    await f.acceptText(badReply(6));
    await f.invoke(CHANNELS.setToolConfig, { sendIntervalSeconds: 0 });
    assert.equal(f.system.getState().continuation?.phase, 'paused'); assert.equal(f.sent.length, 5);
    f.navigate('https://chat.deepseek.com/a/chat/attachments?view=1#same-session');
    await f.acceptText(badReply(7)); assert.equal(f.system.getState().continuation?.phase, 'paused', '同会话 query/hash 不恢复额度');
    await f.invoke(CHANNELS.setToolConfig, { automatic: false });
    await f.invoke(CHANNELS.setToolConfig, { automatic: true });
    await f.acceptText(badReply(8)); assert.equal(f.system.getState().continuation?.phase, 'paused'); assert.equal(f.sent.length, 5);
  } finally { await f.dispose(); }
});

it('正常结果成功发送或实际切换项目/会话后恢复诊断回传额度', async () => {
  for (const scenario of ['normal', 'session', 'root'] as const) {
    const f = await fixture();
    try {
      await f.invoke(CHANNELS.setToolConfig, { automatic: true, permission: 'full', sendIntervalSeconds: 0 });
      for (let round = 1; round <= 5; round++) { await f.acceptText(badReply(round)); await f.wait(() => f.system.getState().continuation?.phase === 'waiting_reply'); }
      await f.acceptText(badReply(6)); assert.equal(f.system.getState().continuation?.phase, 'paused');
      if (scenario === 'normal') { await f.accept('normal-reset'); await f.wait(() => f.system.getState().continuation?.phase === 'waiting_reply'); }
      if (scenario === 'session') f.setURL('https://chat.deepseek.com/a/chat/new-session');
      if (scenario === 'root') { const root = path.join(f.root, 'second-project'); await fs.mkdir(root); f.files.setRoot(root); f.system.reset(); }
      await f.acceptText(badReply(7)); await f.wait(() => f.system.getState().continuation?.phase === 'waiting_reply');
      assert.equal(f.sent.length, scenario === 'normal' ? 7 : 6, scenario);
    } finally { await f.dispose(); }
  }
});

it('官网会话快速 A→B→A 且没有中间结果广播时也恢复诊断额度', async () => {
  for (const disabled of [false, true]) {
    const f = await fixture();
    try {
      await f.invoke(CHANNELS.setToolConfig, { automatic: true, sendIntervalSeconds: 0 });
      for (let round = 1; round <= 5; round++) { await f.acceptText(badReply(round)); await f.wait(() => f.system.getState().continuation?.phase === 'waiting_reply'); }
      await f.acceptText(badReply(6)); assert.equal(f.system.getState().continuation?.phase, 'paused');
      if (disabled) await f.invoke(CHANNELS.setToolConfig, { automatic: false });
      f.navigate('https://chat.deepseek.com/a/chat/other');
      f.navigate('https://chat.deepseek.com/a/chat/attachments');
      if (disabled) assert.equal(f.system.getState().continuation?.phase, 'off', '关闭期间导航保持 off');
      if (disabled) await f.invoke(CHANNELS.setToolConfig, { automatic: true });
      await f.acceptText(badReply(7)); await f.wait(() => f.system.getState().continuation?.phase === 'waiting_reply');
      assert.equal(f.sent.length, 6, disabled ? '关闭期间往返也重置额度' : '开启期间往返重置额度');
    } finally { await f.dispose(); }
  }
});

it('诊断回传复核要求官网原文匹配且回复完成，不能借相同报错发送旧回执', async () => {
  for (const scenario of ['same-error', 'normal-reply', 'generating', 'interrupted', 'unknown'] as const) {
    const f = await fixture();
    try {
      await f.invoke(CHANNELS.setToolConfig, { automatic: true, sendIntervalSeconds: 0 });
      await f.acceptText(badReply(1));
      if (scenario === 'same-error') f.setReply(badReply(2));
      else if (scenario === 'normal-reply') f.setReply(f.batch('different'));
      else f.setCompletion(scenario);
      await f.wait(() => f.system.getState().continuation?.phase === 'paused');
      assert.equal(f.sent.length, 0, scenario);
      await f.invoke(CHANNELS.setToolConfig, { sendIntervalSeconds: 0 });
      assert.equal(f.system.getState().continuation?.phase, 'paused');
    } finally { await f.dispose(); }
  }
});

it('诊断官网复核等待期间停止、关闭开关、切 scope 或本地主动新轮均取消旧回执', async () => {
  for (const scenario of ['cancel', 'toggle', 'session', 'root', 'new-turn'] as const) {
    const f = await fixture(); let finish!: () => void;
    try {
      await f.invoke(CHANNELS.setToolConfig, { automatic: true, sendIntervalSeconds: 0 });
      await f.acceptText(badReply(1));
      f.setBeforeRead(() => new Promise<void>(resolve => { finish = resolve; }));
      await f.wait(() => typeof finish === 'function' && f.system.getState().continuation?.phase === 'sending');
      if (scenario === 'cancel') await f.invoke(CHANNELS.cancelTools);
      if (scenario === 'toggle') await f.invoke(CHANNELS.setToolConfig, { automatic: false });
      if (scenario === 'session') f.setURL('https://chat.deepseek.com/a/chat/other');
      if (scenario === 'root') f.files.clearRoot();
      if (scenario === 'new-turn') await f.system.sendLocalPrompt('new demand', 'https://chat.deepseek.com/a/chat/attachments', () => true);
      finish();
      await f.wait(() => f.system.getState().continuation?.phase !== 'sending');
      assert.equal(f.sent.filter(item => item.args[2] === 'results').length, 0, scenario);
    } finally { finish?.(); await f.dispose(); }
  }
});

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
