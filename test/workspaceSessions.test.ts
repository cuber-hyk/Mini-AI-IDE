import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CHANNELS } from '../src/shared/contract';
import { workspaceConversationUrl, type WorkspaceConversation } from '../src/shared/workspaceSessions';
import { WorkspaceSessionStore } from '../src/main/workspaceSessionStore';
import { WorkspaceSessions } from '../src/main/workspaceSessions';

const one: WorkspaceConversation = { platform: 'deepseek', accountId: 'default', conversationId: 'one' };
const two: WorkspaceConversation = { platform: 'deepseek', accountId: 'default', conversationId: 'two' };
const three: WorkspaceConversation = { platform: 'deepseek', accountId: 'default', conversationId: 'three' };
const flush = async () => { for (let index = 0; index < 6; index++) await new Promise<void>(resolve => setImmediate(resolve)); };

class Page extends EventEmitter {
  url = workspaceConversationUrl(one);
  title = '当前会话';
  destroyed = false;
  mainFrame = {};
  sent: Array<{ channel: string; value: any }> = [];
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isDestroyed() { return this.destroyed; }
  send(channel: string, value: any) { this.sent.push({ channel, value }); }
  visit(url: string, main = true) {
    this.emit('did-start-navigation', {}, url, true, main);
    if (main) this.url = url;
    this.emit('did-navigate-in-page', {}, url, main);
  }
}

function fixture(t: { after: (fn: () => void) => void }, bindings: Array<{ identity: WorkspaceConversation; project: number }> = [], initial = one, damaged = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-workspace-session-owner-'));
  const file = path.join(directory, 'sessions.json');
  const roots = [path.join(directory, 'project-a'), path.join(directory, 'project-b'), path.join(directory, 'project-c')];
  const stored = new WorkspaceSessionStore(file);
  const entries = bindings.map(binding => stored.bind(roots[binding.project]!, binding.identity, binding.identity.conversationId));
  const broken = '{broken-original';
  if (damaged) fs.writeFileSync(file, broken);
  let root = roots[0]!;
  let available = true;
  let block: string | undefined;
  let failure: string | undefined;
  let waitSave: (() => Promise<void>) | undefined;
  const web = new Page(); web.url = workspaceConversationUrl(initial);
  const editor = new Page();
  let source = { web, platform: initial.platform, accountId: initial.accountId };
  let failDestroyedSource = false;
  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<any>>();
  const events: Array<{ kind: string; value: any }> = [];
  const opens: Array<{ root: string; automatic: boolean; current: () => boolean }> = [];
  const owner = new WorkspaceSessions({
    ipc: {
      handle: (channel: string, callback: any) => { handlers.set(channel, callback); },
      removeHandler: (channel: string) => { handlers.delete(channel); },
    } as any,
    editor: editor as any, file,
    workspace: {
      workspace: { getState: () => ({ root, workspaceRoots: roots, recentRoots: roots, revision: 0 }) },
      openSessionWorkspace: async (target: string, automatic: boolean, current: () => boolean) => {
        opens.push({ root: target, automatic, current }); events.push({ kind: 'save', value: { root: target, automatic } });
        await waitSave?.();
        if (!current()) return { ok: false, root, error: '切换已失效' };
        if (failure) return { ok: false, root, error: failure };
        root = target; events.push({ kind: 'workspace', value: target });
        return { ok: true, root };
      },
    } as any,
    source: () => { if (failDestroyedSource && source.web.isDestroyed()) throw new Error('原生对象已销毁，不可读取状态'); return source as any; },
    available: () => available,
    accountName: (platform, accountId) => `${platform}-${accountId}`,
    switchBlock: () => block,
    navigate: async (target, current) => {
      if (!current()) return;
      events.push({ kind: 'navigate', value: target });
      source.web.visit(workspaceConversationUrl(target));
    },
    setActive: async active => { events.push({ kind: 'active', value: active }); },
  });
  owner.register();
  t.after(() => { owner.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return {
    owner, web, editor, file, roots, entries, events, opens, handlers, broken,
    get root() { return root; },
    setRoot(value: string) { root = value; },
    setBlock(value?: string) { block = value; },
    setFailure(value?: string) { failure = value; },
    failDestroyedSource() { failDestroyedSource = true; },
    setAvailable(value: boolean) { available = value; owner.platformChanged(); },
    delaySave(wait?: () => Promise<void>) { waitSave = wait; },
    changeSource(page: Page, identity = one) { source = { web: page, platform: identity.platform, accountId: identity.accountId }; owner.platformChanged(); },
    call: (channel: string, ...args: any[]) => handlers.get(channel)!({ sender: editor, senderFrame: editor.mainFrame }, ...args),
  };
}

test('启动、导航与标题变化都不创建绑定；用户显式绑定才持久化', async t => {
  const f = fixture(t);
  await flush();
  assert.equal(f.owner.state.canBind, true);
  assert.deepEqual(f.owner.state.sessions, []);
  assert.equal(fs.existsSync(f.file), false);
  f.web.title = '变更后的标题'; f.web.emit('page-title-updated', {}, f.web.title);
  f.web.visit(workspaceConversationUrl(two)); await flush();
  assert.deepEqual(f.owner.state.sessions, []);
  assert.equal(fs.existsSync(f.file), false);
  const state = await f.call(CHANNELS.bindWorkspaceSession, 0);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].title, '变更后的标题');
  assert.equal(state.selectedId, state.sessions[0].id);
  assert.equal(new WorkspaceSessionStore(f.file).sessions[0]!.conversationId, 'two');
  f.web.title = '再次改标题'; f.web.emit('page-title-updated', {}, f.web.title);
  assert.equal(f.owner.state.sessions[0]!.title, '变更后的标题');
});

test('活动原生页销毁回调不再读取平台或工具状态，应用退出不会抛同步异常', async t => {
  const f = fixture(t, [{ identity: one, project: 0 }]); await flush();
  f.failDestroyedSource(); f.web.destroyed = true;
  assert.doesNotThrow(() => f.web.emit('destroyed'));
  assert.equal(f.owner.canRun, false); assert.equal(f.owner.state.current, null);
  assert.equal(f.owner.state.selectedId, null); assert.match(f.owner.state.error!, /视图已关闭/);
  await flush(); assert.equal(f.owner.state.busy, false);
});

test('已绑定页导航被中断且无后继导航时恢复真实当前页，旧中断不能解除新导航等待', async t => {
  const f = fixture(t, [{ identity: one, project: 0 }]); await flush();
  const target = workspaceConversationUrl(two);
  f.web.emit('did-start-navigation', {}, target, false, true);
  assert.equal(f.owner.canRun, false); assert.equal(f.owner.state.selectedId, null);
  f.web.emit('did-fail-load', {}, -3, 'ERR_ABORTED', target, true); await flush();
  assert.equal(f.owner.canRun, true); assert.equal(f.owner.state.selectedId, f.entries[0]!.id);
  f.web.emit('did-start-navigation', {}, target, false, true);
  const newer = workspaceConversationUrl(three);
  f.web.emit('did-start-navigation', {}, newer, false, true);
  f.web.emit('did-fail-load', {}, -3, 'ERR_ABORTED', target, true); await flush();
  assert.equal(f.owner.canRun, false); assert.equal(f.owner.state.selectedId, null);
  f.web.visit(newer); await flush(); assert.equal(f.owner.canRun, true);
});

test('IPC 仅编辑器主 frame 可用，参数不接收 URL、对象、额外参数或未注册项目', async t => {
  const f = fixture(t);
  const operation = f.handlers.get(CHANNELS.bindWorkspaceSession)!;
  await assert.rejects(operation({ sender: f.web, senderFrame: f.web.mainFrame }, 0), /主 frame/);
  await assert.rejects(operation({ sender: f.editor, senderFrame: {} }, 0), /主 frame/);
  await assert.rejects(f.call(CHANNELS.bindWorkspaceSession, 0, 'https://evil.test'), /参数无效/);
  await assert.rejects(f.call(CHANNELS.getWorkspaceSessions, 'extra'), /参数无效/);
  for (const index of ['https://chatgpt.com/c/id', { root: f.roots[0] }, -1, 0.5, 99]) {
    const state = await f.call(CHANNELS.bindWorkspaceSession, index);
    assert.ok(state.error);
    assert.equal(state.sessions.length, 0);
  }
  assert.equal(fs.existsSync(f.file), false);
});

test('同项目网页会话切换同步选中，不切目录且不自动绑定未关联会话', async t => {
  const f = fixture(t, [{ identity: one, project: 0 }, { identity: two, project: 0 }]);
  await flush();
  assert.equal(f.owner.state.selectedId, f.entries[0]!.id);
  f.web.visit(workspaceConversationUrl(two)); await flush();
  assert.equal(f.owner.state.selectedId, f.entries[1]!.id);
  assert.equal(f.opens.length, 0);
  f.web.visit(workspaceConversationUrl(three)); await flush();
  assert.equal(f.owner.state.selectedId, null);
  assert.equal(f.owner.state.canBind, true);
  assert.equal(f.owner.canRun, true);
  assert.equal(f.root, f.roots[0]);
  assert.equal(f.owner.state.sessions.length, 2);
});

test('官网跨项目先撤回工具，静默自动保存成功后再恢复并选中', async t => {
  const f = fixture(t, [{ identity: two, project: 1 }]);
  await flush(); f.events.length = 0;
  f.web.visit(workspaceConversationUrl(two));
  assert.equal(f.owner.canRun, false);
  assert.deepEqual(f.events[0], { kind: 'active', value: false });
  await flush();
  assert.equal(f.opens.length, 1);
  assert.equal(f.opens[0]!.automatic, true);
  assert.equal(f.root, f.roots[1]);
  assert.equal(f.owner.state.selectedId, f.entries[0]!.id);
  assert.equal(f.owner.canRun, true);
  assert.deepEqual(f.events.map(event => event.kind), ['active', 'save', 'workspace', 'active']);
  assert.equal(f.events.at(-1)!.value, true);
});

test('自动保存失败保留当前项目和网页，错误可见且禁止错误项目运行', async t => {
  const f = fixture(t, [{ identity: two, project: 1 }]);
  await flush(); f.events.length = 0; f.setFailure('文件被占用，无法保存');
  f.web.visit(workspaceConversationUrl(two)); await flush();
  assert.equal(f.root, f.roots[0]);
  assert.equal(f.web.url, workspaceConversationUrl(two));
  assert.match(f.owner.state.error!, /无法保存/);
  assert.equal(f.owner.state.selectedId, null);
  assert.equal(f.owner.canRun, false);
  assert.equal(f.events.some(event => event.kind === 'active' && event.value === true), false);
  assert.equal(f.events.some(event => event.kind === 'navigate'), false);
});

test('用户主动切本地项目不回切网页，也不自动切回已绑定项目', async t => {
  const f = fixture(t, [{ identity: one, project: 0 }]);
  await flush(); f.events.length = 0;
  f.setRoot(f.roots[1]!); f.owner.workspaceChanged(); await flush();
  f.owner.refreshAvailability(); await flush();
  assert.equal(f.root, f.roots[1]);
  assert.equal(f.web.url, workspaceConversationUrl(one));
  assert.equal(f.owner.state.selectedId, null);
  assert.equal(f.owner.canRun, false);
  assert.equal(f.opens.length, 0);
  assert.equal(f.events.some(event => event.kind === 'navigate'), false);
});

test('快速连续网页导航令迟到保存失效，最终只切到最新会话项目', async t => {
  const f = fixture(t, [{ identity: two, project: 1 }, { identity: three, project: 2 }]);
  await flush();
  let release!: () => void;
  f.delaySave(() => new Promise<void>(resolve => { release = resolve; }));
  f.web.visit(workspaceConversationUrl(two)); await flush();
  assert.equal(f.opens.length, 1);
  f.web.visit(workspaceConversationUrl(three));
  assert.equal(f.opens[0]!.current(), false);
  f.delaySave(); release(); await flush();
  assert.equal(f.root, f.roots[2]);
  assert.equal(f.owner.state.selectedId, f.entries[1]!.id);
  assert.equal(f.events.some(event => event.kind === 'workspace' && event.value === f.roots[1]), false);
  assert.equal(f.opens.length, 2);
  assert.equal(f.owner.canRun, true);
});

test('本地打开先做目录保护再导航，保护失败时不改变网页', async t => {
  const f = fixture(t, [{ identity: two, project: 1 }]);
  await flush(); f.events.length = 0;
  f.setFailure('保留编辑内容');
  let state = await f.call(CHANNELS.openWorkspaceSession, f.entries[0]!.id);
  assert.match(state.error!, /保留编辑内容/);
  assert.equal(f.opens[0]!.automatic, false);
  assert.equal(f.web.url, workspaceConversationUrl(one));
  assert.equal(f.events.some(event => event.kind === 'navigate'), false);
  f.setFailure(); f.events.length = 0;
  state = await f.call(CHANNELS.openWorkspaceSession, f.entries[0]!.id); await flush();
  assert.equal(f.root, f.roots[1]);
  assert.equal(f.web.url, workspaceConversationUrl(two));
  assert.equal(state.selectedId, f.entries[0]!.id);
  const kinds = f.events.map(event => event.kind);
  assert.ok(kinds.indexOf('save') < kinds.indexOf('navigate'));
  assert.ok(kinds.indexOf('workspace') < kinds.indexOf('navigate'));
});

test('忙时拒绝本地打开，官网跨项目保持待同步并在工具结束后完成', async t => {
  const f = fixture(t, [{ identity: two, project: 1 }]);
  await flush(); f.setBlock('工具正在执行，完成后可切换');
  const state = await f.call(CHANNELS.openWorkspaceSession, f.entries[0]!.id);
  assert.match(state.error!, /工具正在执行/);
  assert.equal(f.opens.length, 0);
  assert.equal(f.web.url, workspaceConversationUrl(one));
  f.web.visit(workspaceConversationUrl(two)); await flush();
  assert.equal(f.root, f.roots[0]);
  assert.equal(f.owner.canRun, false);
  assert.equal(f.opens.length, 0);
  f.setBlock(); f.owner.refreshAvailability(); await flush();
  assert.equal(f.root, f.roots[1]);
  assert.equal(f.opens[0]!.automatic, true);
  assert.equal(f.owner.state.selectedId, f.entries[0]!.id);
});

test('后台旧视图、旧账号和子 frame 导航不能改变活动选中或项目', async t => {
  const f = fixture(t, [{ identity: one, project: 0 }, { identity: two, project: 1 }]);
  await flush();
  f.web.visit(workspaceConversationUrl(two), false); await flush();
  assert.equal(f.owner.state.selectedId, f.entries[0]!.id);
  assert.equal(f.opens.length, 0);
  const active = new Page();
  f.changeSource(active); await flush();
  f.web.visit(workspaceConversationUrl(two)); f.web.emit('did-navigate', {}, f.web.url); await flush();
  assert.equal(f.owner.state.selectedId, f.entries[0]!.id);
  assert.equal(f.root, f.roots[0]);
  assert.equal(f.opens.length, 0);
  f.changeSource(active, { ...one, accountId: 'account-1' }); await flush();
  assert.equal(f.owner.state.selectedId, null);
  assert.equal(f.owner.state.canBind, true);
});

test('解除绑定只移除本地记录，不导航或切目录', async t => {
  const f = fixture(t, [{ identity: one, project: 0 }, { identity: two, project: 1 }]);
  await flush(); f.events.length = 0;
  const state = await f.call(CHANNELS.unbindWorkspaceSession, f.entries[0]!.id);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].id, f.entries[1]!.id);
  assert.equal(state.selectedId, null);
  assert.equal(state.canBind, true);
  assert.equal(f.web.url, workspaceConversationUrl(one));
  assert.equal(f.opens.length, 0);
  assert.equal(f.events.some(event => event.kind === 'navigate'), false);
  assert.equal(new WorkspaceSessionStore(f.file).sessions.length, 1);
});

test('销毁后迟到保存不能切目录、恢复工具或发布状态，IPC 与监听释放', async t => {
  const f = fixture(t, [{ identity: two, project: 1 }]);
  await flush();
  let release!: () => void;
  f.delaySave(() => new Promise<void>(resolve => { release = resolve; }));
  f.web.visit(workspaceConversationUrl(two)); await flush();
  assert.equal(f.owner.state.busy, true);
  f.owner.dispose();
  const sent = f.editor.sent.length;
  f.events.length = 0;
  release(); await flush();
  assert.equal(f.root, f.roots[0]);
  assert.equal(f.owner.canRun, false);
  assert.equal(f.editor.sent.length, sent);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.web.listenerCount('did-navigate-in-page'), 0);
  assert.equal(f.events.some(event => event.kind === 'active' && event.value === true), false);
});

test('损坏绑定文件保留原文并禁用执行、绑定和会话操作', async t => {
  const f = fixture(t, [], one, true);
  await flush();
  assert.match(f.owner.state.error!, /原文件保留/);
  assert.equal(f.owner.state.canBind, false);
  assert.equal(f.owner.canRun, false);
  const state = await f.call(CHANNELS.bindWorkspaceSession, 0);
  assert.match(state.error!, /原文件保留/);
  assert.equal(state.sessions.length, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.broken);
  f.web.visit(workspaceConversationUrl(two)); await flush();
  assert.equal(f.opens.length, 0);
  assert.equal(f.owner.canRun, false);
});
