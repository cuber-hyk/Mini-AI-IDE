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

const text = (id: string, changes: unknown[]) => '```mini-ai-tools\n' + JSON.stringify({
  protocol_version: 1, batch_id: id, requests: [{ id: 'edit', tool: 'apply_changes', args: { changes } }],
}) + '\n```';
async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) { assert.ok(Date.now() < deadline, '工具应完成'); await delay(10); }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-review-integration-'));
  const files = new FileService(); files.setRoot(root);
  const handlers = new Map<string, (...args: any[]) => any>();
  const editor: any = { mainFrame: {}, isDestroyed: () => false, send() {} };
  const review: any = { mainFrame: {}, isDestroyed: () => false, send() {} };
  let session = 'https://chat.deepseek.com/a/chat/review';
  let approve: () => Promise<{ response: number; checkboxChecked: boolean }> = async () => ({ response: 0, checkboxChecked: false });
  const web: any = Object.assign(new EventEmitter(), { getURL: () => session, isDestroyed: () => false });
  const returns = new ReturnPathService(files);
  let runWorkspace = (fn: () => Promise<unknown>) => fn();
  const system = await createToolIntegration({ files, web, editor, review,
    ipc: { handle(channel: string, fn: any) { handlers.set(channel, fn); } } as any,
    workspace: { editor: { isDirty: () => false, current: { documents: [] } }, run: (fn: any) => runWorkspace(fn) } as any,
    returnPath: returns, storePath: path.join(root, 'ledger.json'), disabled: true,
    ask: () => approve(), notifyFile() {}, copy() {},
  });
  t.after(async () => { await system.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: editor, senderFrame: editor.mainFrame }, ...args);
  const reviewCall = (channel: string) => handlers.get(channel)!({ sender: review, senderFrame: review.mainFrame });
  await call(CHANNELS.setToolConfig, { permission: 'full' });
  return { root, system, call, reviewCall, handlers, editor, review, web, returns,
    ask(fn: typeof approve) { approve = fn; }, switchSession() { session += '-other'; },
    setWorkspaceRun(fn: typeof runWorkspace) { runWorkspace = fn; },
    async execute(body: string) { await system.accept(body, 'complete'); await until(() => !system.getState().busy); },
  };
}

it('实际修改在右侧保留执行前后快照，外部继续编辑和重复采集不污染；撤销走原工具', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'note.txt'), 'before\n');
  const body = text('replace', [{ path: 'note.txt', operation: 'replace', edits: [{ old_string: 'before', new_string: 'after' }] }]);
  await f.execute(body);
  const initial = f.reviewCall(CHANNELS.getReviewState);
  assert.equal(initial.records[0].status, 'applied');
  assert.equal(initial.records[0].before, 'before\n'); assert.equal(initial.records[0].after, 'after\n');
  assert.equal(initial.records[0].diff.added, 1); assert.equal(initial.records[0].diff.removed, 1);
  await fs.writeFile(path.join(f.root, 'note.txt'), 'manual\n');
  await f.execute(body);
  assert.deepEqual(f.reviewCall(CHANNELS.getReviewState), initial);
  assert.equal((await f.reviewCall(CHANNELS.undoReviewChange)).ok, false, '后续外部修改不能被旧撤销覆盖');
  assert.equal(await fs.readFile(path.join(f.root, 'note.txt'), 'utf8'), 'manual\n');
  await fs.writeFile(path.join(f.root, 'note.txt'), 'after\n');
  assert.equal((await f.reviewCall(CHANNELS.undoReviewChange)).ok, true);
  assert.equal(f.system.getReviewState().records[0]!.status, 'undone');
  assert.equal(await fs.readFile(path.join(f.root, 'note.txt'), 'utf8'), 'before\n');
});

it('权限拒绝时仍返回未执行文件状态，右侧桥拒绝网页和子frame；会话切换释放快照', async t => {
  const f = await fixture(t);
  await f.execute(text('create', [{ path: 'created.txt', operation: 'create', content: 'actual' }]));
  assert.equal(f.system.getReviewState().records[0]!.before, '');
  f.switchSession();
  assert.deepEqual(f.reviewCall(CHANNELS.getReviewState).records, []);
  f.ask(async () => ({ response: 2, checkboxChecked: false }));
  await f.call(CHANNELS.setToolConfig, { permission: 'ask' });
  await f.execute(text('denied', [{ path: 'denied.txt', operation: 'create', content: 'no' }]));
  const denied = f.system.getReviewState().records[0]!;
  assert.notEqual(denied.status, 'applied'); assert.equal(denied.before, undefined); assert.equal(denied.after, undefined);
  await assert.rejects(fs.stat(path.join(f.root, 'denied.txt')));
  for (const channel of [CHANNELS.getReviewState, CHANNELS.undoReviewChange]) {
    assert.throws(() => f.handlers.get(channel)!({ sender: f.web, senderFrame: {} }), /本地变更视图/);
    assert.throws(() => f.handlers.get(channel)!({ sender: f.review, senderFrame: {} }), /本地变更视图/);
    assert.throws(() => f.handlers.get(channel)!({ sender: f.review, senderFrame: f.review.mainFrame }, 'extra'), /本地变更视图/);
  }
});

it('批次 ID 被不同内容复用时明确未执行，不永远等待或覆盖去重账本', async t => {
  const f = await fixture(t);
  const original = text('same-id', [{ path: 'original.txt', operation: 'create', content: 'original' }]);
  await f.execute(original);
  await f.execute(text('same-id', [{ path: 'rejected.txt', operation: 'create', content: 'no' }]));
  const rejected = f.system.getReviewState();
  assert.equal(rejected.records[0]!.status, 'skipped');
  assert.match(rejected.records[0]!.error!, /ID.*复用/);
  assert.equal(rejected.records[0]!.before, undefined);
  assert.equal(rejected.scope!.contentKey.length, 64);
  await assert.rejects(fs.stat(path.join(f.root, 'rejected.txt')));
  await f.execute(original);
  assert.equal(f.system.getState().results[0]!.status, 'done', '拒绝的新内容不能改写原成功账本');
  assert.equal(await fs.readFile(path.join(f.root, 'original.txt'), 'utf8'), 'original');
});
it('切换会话后旧修改迟到落盘不进入新会话撤销记录', async t => {
  const f = await fixture(t); const apply = f.returns.applyChange.bind(f.returns);
  let entered = false; let resume!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  f.returns.applyChange = async (...args) => { entered = true; await paused; return apply(...args); };
  await f.system.accept(text('late', [{ path: 'late.txt', operation: 'create', content: 'actual old write' }]), 'complete');
  await until(() => entered); f.switchSession(); f.system.getState(); resume();
  await until(() => !f.system.getState().busy);
  assert.equal(f.system.getState().canUndo, false);
  assert.equal((await f.reviewCall(CHANNELS.undoReviewChange)).ok, false);
  assert.equal((await f.call(CHANNELS.undoToolChange)).ok, false);
  assert.equal(await fs.readFile(path.join(f.root, 'late.txt'), 'utf8'), 'actual old write');
  assert.deepEqual(f.system.getReviewState().records, []);
});
it('文件修改在工作区队列中等待时切换会话，出队后拒绝旧未启动请求', async t => {
  const f = await fixture(t); let queued = false; let resume!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  f.setWorkspaceRun(async fn => { queued = true; await paused; return fn(); });
  await f.system.accept(text('queued', [{ path: 'queued.txt', operation: 'create', content: 'no write' }]), 'complete');
  await until(() => queued); f.switchSession(); f.system.getState(); resume();
  await until(() => !f.system.getState().busy);
  await assert.rejects(fs.stat(path.join(f.root, 'queued.txt')));
  assert.equal(f.system.getState().canUndo, false);
  assert.deepEqual(f.system.getReviewState().records, []);
});
it('会话切换后不能通过任一撤销入口修改上一会话文件', async t => {
  const f = await fixture(t);
  await f.execute(text('session-before', [{ path: 'session.txt', operation: 'create', content: 'stay' }]));
  f.switchSession();
  assert.equal((await f.reviewCall(CHANNELS.undoReviewChange)).ok, false);
  assert.equal((await f.call(CHANNELS.undoToolChange)).ok, false);
  assert.equal(f.system.getState().canUndo, false);
  assert.equal(await fs.readFile(path.join(f.root, 'session.txt'), 'utf8'), 'stay');
  assert.deepEqual(f.system.getReviewState().records, []);
});
it('迟到的旧批次实际写入不进入当前批次查看，普通讨论或无效请求清空旧记录', async t => {
  const f = await fixture(t);
  await f.call(CHANNELS.setToolConfig, { permission: 'ask' });
  let asked = false;
  let allow!: () => void;
  const waiting = new Promise<void>(resolve => { allow = resolve; });
  f.ask(async () => { asked = true; await waiting; return { response: 0, checkboxChecked: false }; });
  await f.system.accept(text('old', [{ path: 'old.txt', operation: 'create', content: 'old' }]), 'complete');
  await until(() => asked);
  await f.system.accept(text('new', [{ path: 'new.txt', operation: 'create', content: 'new' }]), 'complete');
  allow(); await until(() => !f.system.getState().busy);
  assert.equal(await fs.readFile(path.join(f.root, 'old.txt'), 'utf8'), 'old');
  const state = f.system.getReviewState();
  assert.equal(state.scope!.batchId, 'new'); assert.deepEqual(state.records.map(r => r.path), ['new.txt']);
  assert.equal(state.records[0]!.status, 'applied');
  await f.execute('普通讨论'); assert.deepEqual(f.system.getReviewState().records, []);
  await f.execute('```mini-ai-tools\n{"bad":\n```'); assert.deepEqual(f.system.getReviewState().records, []);
});
