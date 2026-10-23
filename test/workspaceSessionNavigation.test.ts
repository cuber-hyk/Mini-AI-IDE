import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebPlatformController } from '../src/main/webPlatformController';
import { WorkspaceSessions } from '../src/main/workspaceSessions';
import { WorkspaceSessionStore } from '../src/main/workspaceSessionStore';
import { DeepSeekAccountStore } from '../src/main/deepseekAccounts';
import { DeepSeekAccountViews } from '../src/main/deepseekAccountViews';
import { workspaceConversationUrl, type WorkspaceConversation } from '../src/shared/workspaceSessions';
import { CHANNELS } from '../src/shared/contract';

class Page extends EventEmitter {
  mainFrame = { send() {} }; url: string; title = '会话';
  loads: string[] = []; dead = false;
  delay: Promise<void> | undefined;
  constructor(url = 'https://chat.deepseek.com/') { super(); this.url = url; }
  isDestroyed() { return this.dead; } getURL() { return this.url; } getTitle() { return this.title; }
  send() {} close() { this.dead = true; }
  async loadURL(url: string) {
    this.loads.push(url);
    this.emit('did-start-navigation', {}, url, false, true);
    await this.delay;
    this.url = url;
    this.emit('did-navigate', {}, url);
    this.emit('did-finish-load');
  }
  async executeJavaScriptInIsolatedWorld() { return true; }
}

test('组合真实平台与会话 owner：跨平台和跨账号准备广播不作废目标，首次只导航绑定地址', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-session-navigation-'));
  const roots = [path.join(directory, 'A'), path.join(directory, 'B')]; let root: string | null = roots[0]!;
  const accounts = new DeepSeekAccountStore(path.join(directory, 'accounts.json')); accounts.add('工作账号');
  const deepseek = { webContents: new Page() }; const chatgpt = { webContents: new Page('https://chatgpt.com/') };
  const extra = { webContents: new Page() };
  const views = new DeepSeekAccountViews(deepseek as any, () => extra as any);
  const editor = new Page(); const bar = new Page(); let activeWeb = deepseek.webContents; let toolsActive = true;
  const handlers = new Map(); const ipc = { handle(name: string, callback: any) { handlers.set(name, callback); }, removeHandler(name: string) { handlers.delete(name); } };
  let owner: WorkspaceSessions | undefined;
  let prepareGate: Promise<void> | undefined;
  const platforms = new WebPlatformController({ ipc: ipc as any, editor: editor as any, webbar: bar as any, deepseek: deepseek as any,
    accountStore: accounts, accountViews: views, createChatGPT: () => chatgpt as any,
    prepareSwitch: async () => { toolsActive = false; await prepareGate; }, applyView() {},
    changed: async state => { activeWeb = platforms.getView(state.platform).webContents as any; toolsActive = !state.switching && owner?.canRun !== false; },
    stateChanged: () => owner?.platformChanged(), contentReady: async () => true,
  });
  platforms.register();
  const file = path.join(directory, 'sessions.json'); const store = new WorkspaceSessionStore(file);
  const targets: WorkspaceConversation[] = [
    { platform: 'chatgpt', accountId: 'default', conversationId: 'chatgpt-bound' },
    { platform: 'deepseek', accountId: 'account-1', conversationId: 'work-bound' },
  ];
  const entries = targets.map(target => store.bind(roots[1]!, target, target.conversationId));
  const originalIdentity: WorkspaceConversation = { platform: 'deepseek', accountId: 'default', conversationId: 'original' };
  const originalEntry = store.bind(roots[0]!, originalIdentity, '原项目');
  deepseek.webContents.url = workspaceConversationUrl(originalIdentity);
  owner = new WorkspaceSessions({ ipc: ipc as any, editor: editor as any, file,
    workspace: { workspace: { getState: () => ({ root, workspaceRoots: roots }) },
      openSessionWorkspace: async (target: string, _silent: boolean, current: () => boolean) => {
        if (!current()) return { ok: false, root }; root = target; owner!.workspaceChanged(); return { ok: true, root };
      } } as any,
    source: () => ({ web: activeWeb as any, platform: platforms.state.platform, accountId: platforms.state.platform === 'deepseek' ? views.selectedId : 'default' }),
    available: () => !platforms.state.switching && !platforms.state.error,
    accountName: (_platform, id) => id, switchBlock: () => undefined,
    navigate: (identity, current) => platforms.navigateConversation(identity, current),
    setActive: async active => { toolsActive = active; },
  });
  owner.register();
  t.after(() => { owner!.dispose(); platforms.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const [index, target] of targets.entries()) {
    const state = await owner.open(entries[index]!.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.error, undefined); assert.equal(state.selectedId, entries[index]!.id);
    assert.equal(activeWeb.getURL(), workspaceConversationUrl(target)); assert.equal(root, roots[1]);
    assert.equal(owner.canRun, true); assert.equal(toolsActive, true);
  }
  assert.deepEqual(chatgpt.webContents.loads, ['https://chatgpt.com/c/chatgpt-bound']);
  assert.deepEqual(extra.webContents.loads, ['https://chat.deepseek.com/a/chat/s/work-bound']);
  assert.deepEqual(deepseek.webContents.loads, []);

  let release!: () => void;
  chatgpt.webContents.delay = new Promise(resolve => { release = resolve; });
  let finished = false;
  const obsolete = owner.open(entries[0]!.id).then(() => { finished = true; });
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(platforms.state.platform, 'chatgpt'); assert.equal(owner.state.busy, true);
  await handlers.get(CHANNELS.setWebPlatform)({ sender: bar, senderFrame: bar.mainFrame }, 'deepseek');
  await handlers.get(CHANNELS.setDeepSeekAccount)({ sender: bar, senderFrame: bar.mainFrame }, 'default');
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, true, '旧后台加载未结束，也必须释放过期会话操作');
  assert.equal(root, roots[0]); assert.equal(owner.state.selectedId, originalEntry.id);
  assert.equal(owner.canRun, true); assert.equal(toolsActive, true);
  release(); await obsolete;
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(root, roots[0]); assert.equal(owner.state.selectedId, originalEntry.id, '旧后台加载完成不能污染当前选择');

  let rejectOld!: (error: Error) => void;
  chatgpt.webContents.delay = new Promise((_resolve, reject) => { rejectOld = reject; });
  const lateFailure = owner.open(entries[0]!.id);
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  await handlers.get(CHANNELS.setWebPlatform)({ sender: bar, senderFrame: bar.mainFrame }, 'deepseek');
  await lateFailure;
  let releasePrepare!: () => void;
  prepareGate = new Promise(resolve => { releasePrepare = resolve; });
  const newerSwitch = handlers.get(CHANNELS.setDeepSeekAccount)({ sender: bar, senderFrame: bar.mainFrame }, 'account-1');
  assert.equal(platforms.state.platform, 'deepseek'); assert.equal(platforms.state.switching, true);
  rejectOld(new Error('旧后台加载失败'));
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(platforms.state.platform, 'deepseek'); assert.equal(platforms.state.switching, true, '旧网络失败不能释放新操作的准备锁');
  releasePrepare(); await newerSwitch;
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(platforms.state.platform, 'deepseek'); assert.equal(views.selectedId, 'account-1');
  assert.equal(owner.state.selectedId, entries[1]!.id); assert.equal(owner.canRun, true);
});
