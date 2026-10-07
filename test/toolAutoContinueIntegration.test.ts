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

const batch = (id: string, tool: string, args: unknown) => '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: id, requests: [{ id: 'request', tool, args }] }) + '\n```';
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < deadline, '协作链路应完成'); await delay(5); } }
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-continue-')); const files = new FileService(); files.setRoot(root);
  const handlers = new Map<string, any>(); const editor: any = { mainFrame: {}, isDestroyed: () => false, send() {} };
  let reply = ''; let completion = 'complete'; let session = 'https://chat.deepseek.com/a/chat/continue';
  let wait: ((value: unknown) => void) | undefined;
  let read: () => Promise<unknown> = async () => ({ replies: [reply], completion });
  const web: any = Object.assign(new EventEmitter(), { getURL: () => session, isDestroyed: () => false,
    executeJavaScript: () => read(),
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
      const script = scripts[0]!.code;
      if (script.includes('new Promise(resolve')) return new Promise(resolve => { wait = resolve; });
      if (script.includes('preserve')) return { preserve: false, turn: 0 };
      if (script.includes('return { turn:')) return { turn: 0 };
      return true;
    },
  });
  const sent: string[] = []; let action = async (_text: string) => ({ ok: true }); let cancellations = 0;
  const system = await createToolIntegration({ files, web, editor,
    ipc: { handle(channel: string, fn: any) { handlers.set(channel, fn); } } as any,
    workspace: { editor: { isDirty: () => false, current: { documents: [] } }, run: (fn: any) => fn() } as any,
    returnPath: new ReturnPathService(files), storePath: path.join(root, 'tools.json'), disabled: false,
    ask: async () => ({ response: 0, checkboxChecked: false }), notifyFile() {}, copy() {},
    sender: { async send(text, expected) { assert.equal(expected, session); sent.push(text); return action(text); }, async cancel() { cancellations++; }, async dispose() {} },
  });
  t.after(async () => { await system.dispose(); wait?.(false); await fs.rm(root, { recursive: true, force: true }); });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)({ sender: editor, senderFrame: editor.mainFrame }, ...args);
  return { root, system, sent, call, get cancellations() { return cancellations; },
    setAction(fn: typeof action) { action = fn; },
    setReply(text: string, phase = 'complete') { reply = text; completion = phase; },
    setRead(fn: typeof read) { read = fn; },
    async notify(text: string, turn = 0) { reply = text; await until(() => !!wait); const next = wait; wait = undefined; next!({ turn }); },
    switchSession() { session += '-new'; web.emit('did-navigate-in-page', {}, session, true); },
  };
}
it('自动发回读取和修改工具结果，下一轮由变化监听采集，普通对话等待用户', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.txt'), 'A');
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  f.setAction(async () => {
    await f.notify(f.sent.length === 1 ? batch('edit', 'apply_changes', { changes: [{ path: 'a.txt', operation: 'replace', edits: [{ old_string: 'A', new_string: 'C' }] }] }) : '需要你选择后续需求');
    return { ok: true };
  });
  const first = batch('read', 'read_file', { path: 'a.txt' }); f.setReply(first);
  await f.system.accept(first, 'complete');
  await until(() => f.sent.length === 2 && !f.system.getState().busy && f.system.getState().results.length === 0);
  assert.equal(JSON.parse(f.sent[0]!).tool_results[0].tool, 'read_file');
  assert.equal(JSON.parse(f.sent[1]!).tool_results[0].tool, 'apply_changes');
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'C');
  assert.equal(f.system.getState().continuation!.phase, 'waiting_user');
  await delay(30); assert.equal(f.sent.length, 2);
});
it('发送 unknown 后迟到回复不能自动执行，真人发起新轮可以恢复', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const first = batch('first', 'get_project_info', {}); f.setReply(first);
  f.setAction(async () => ({ ok: false, uncertain: true, error: '发送无法确认' }));
  await f.system.accept(first, 'complete'); await until(() => f.system.getState().continuation?.phase === 'paused');
  const late = batch('late', 'apply_changes', { changes: [{ path: 'late.txt', operation: 'create', content: 'must not execute' }] });
  await f.notify(late); await delay(30); assert.equal(f.sent.length, 1); await assert.rejects(fs.stat(path.join(f.root, 'late.txt')));
  assert.equal(f.system.getState().results[0]!.batch_id, 'first');
  f.setAction(async () => ({ ok: true })); await f.notify(batch('real-user', 'get_project_info', {}), 1);
  await until(() => f.sent.length === 2); assert.equal(JSON.parse(f.sent[1]!).tool_results[0].batch_id, 'real-user');
});
it('下一回复先到达但发送确认尚未结束，必须确认成功才执行，unknown 时丢弃资格', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  let finish!: (value: any) => void;
  f.setAction(() => new Promise(resolve => { finish = resolve; }));
  const first = batch('waiting', 'get_project_info', {}); f.setReply(first); await f.system.accept(first, 'complete');
  await until(() => f.system.getState().continuation?.phase === 'sending');
  await f.notify(batch('fast-unconfirmed', 'apply_changes', { changes: [{ path: 'unconfirmed.txt', operation: 'create', content: 'no write' }] }));
  await delay(30); await assert.rejects(fs.stat(path.join(f.root, 'unconfirmed.txt')));
  finish({ ok: false, uncertain: true, error: 'unknown' }); await until(() => f.system.getState().continuation?.phase === 'paused');
  await delay(30); assert.equal(f.sent.length, 1); await assert.rejects(fs.stat(path.join(f.root, 'unconfirmed.txt')));
});
it('关闭立即取消发送倒计时，工具实际结果与磁盘修改保留，重新开启不发送旧批', async t => {
  const f = await fixture(t);
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 1 });
  const body = batch('create', 'apply_changes', { changes: [{ path: 'created.txt', operation: 'create', content: 'stay' }] }); f.setReply(body);
  await f.system.accept(body, 'complete'); await until(() => f.system.getState().continuation?.phase === 'countdown');
  await f.call(CHANNELS.setToolConfig, { automatic: false });
  assert.equal(f.system.getState().continuation!.phase, 'off'); assert.equal(await fs.readFile(path.join(f.root, 'created.txt'), 'utf8'), 'stay');
  await f.call(CHANNELS.setToolConfig, { automatic: true, sendIntervalSeconds: 0 }); await delay(30); assert.equal(f.sent.length, 0);
});
it('发送前网页读取等待期间关闭再开启，不会让旧任务迟到发送', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const body = batch('delayed', 'get_project_info', {}); f.setReply(body);
  let entered = false; let finish!: (reply: unknown) => void;
  f.setRead(() => { entered = true; return new Promise(resolve => { finish = resolve; }); });
  await f.system.accept(body, 'complete'); await until(() => entered && f.system.getState().continuation?.phase === 'sending');
  await f.call(CHANNELS.setToolConfig, { automatic: false }); await f.call(CHANNELS.setToolConfig, { automatic: true });
  finish({ replies: [body], completion: 'complete' }); await delay(30);
  assert.equal(f.sent.length, 0); assert.notEqual(f.system.getState().continuation?.phase, 'waiting_reply');
});
it('网页最新回复被改为同 ID 不同参数时不发送旧结果，项目与会话变化也取消', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const body = batch('same', 'get_project_info', {}); f.setReply(body);
  f.setReply(batch('same', 'read_file', { path: 'other.txt' })); await f.system.accept(body, 'complete');
  await until(() => !f.system.getState().busy && f.system.getState().continuation?.phase === 'paused'); assert.equal(f.sent.length, 0);
  await f.call(CHANNELS.setToolConfig, { sendIntervalSeconds: 1 }); const fresh = batch('fresh', 'get_project_info', {}); f.setReply(fresh);
  await f.system.accept(fresh, 'complete'); await until(() => f.system.getState().continuation?.phase === 'countdown');
  f.switchSession(); await until(() => f.system.getState().results.length === 0); await delay(30); assert.equal(f.sent.length, 0);
});
