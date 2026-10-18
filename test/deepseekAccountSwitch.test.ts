import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { IpcMainInvokeEvent, WebContents, WebContentsView } from 'electron';
import { DeepSeekAccountStore } from '../src/main/deepseekAccounts';
import { DeepSeekAccountViews } from '../src/main/deepseekAccountViews';
import { WebPlatformController } from '../src/main/webPlatformController';
import { CHANNELS } from '../src/shared/contract';
import { WEB_PLATFORMS, type WebPlatformState } from '../src/shared/webPlatform';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function contents(url = WEB_PLATFORMS.deepseek.url as string) {
  let dead = false;
  let currentUrl = url;
  const urls: string[] = [];
  const sent: WebPlatformState[] = [];
  const value = Object.assign(new EventEmitter(), {
    mainFrame: { send(_channel: string, state: WebPlatformState) { sent.push(state); } },
    isDestroyed: () => dead,
    close() { dead = true; },
    getURL: () => currentUrl,
    reload() { value.emit('did-start-navigation', {}, currentUrl, false, true); },
    async loadURL(next: string) {
      currentUrl = next; urls.push(next);
      value.emit('did-start-navigation', {}, next, false, true);
    },
  });
  const view = { webContents: value } as unknown as WebContentsView;
  return { value, view, urls, sent };
}

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-deepseek-switch-'));
  const store = new DeepSeekAccountStore(path.join(directory, 'accounts.json'));
  const webbar = contents(); const editor = contents(); const original = contents(); const chatgpt = contents(WEB_PLATFORMS.chatgpt.url);
  const created = new Map<string, ReturnType<typeof contents>>();
  const handlers = new Map<string, Function>();
  const applied: WebContentsView[] = [];
  const changes: Array<{ state: WebPlatformState; web: WebContents }> = [];
  const loading: Array<{ platform: string; loading: boolean }> = [];
  let prepare = async () => {};
  let bind = async (_state: WebPlatformState) => {};
  let apply = (_view: WebContentsView) => {};
  let createFailure = false;
  let creations = 0;
  let blocked: WebPlatformState['switchBlockedReason'];
  let reads = 0;
  const accounts = new DeepSeekAccountViews(original.view, partition => {
    creations++;
    if (createFailure) throw new Error('账号视图创建失败');
    const web = contents(); created.set(partition, web); return web.view;
  });
  let controller!: WebPlatformController;
  controller = new WebPlatformController({
    ipc: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
    webbar: webbar.value as unknown as WebContents, editor: editor.value as unknown as WebContents,
    deepseek: original.view, createChatGPT: () => chatgpt.view,
    accountStore: store, accountViews: accounts,
    prepareSwitch: () => prepare(),
    applyView(view) { applied.push(view); apply(view); },
    async changed(state) { changes.push({ state, web: controller.getView(state.platform).webContents }); await bind(state); },
    switchBlock: () => blocked,
    loadingChanged(platform, active) { loading.push({ platform, loading: active }); },
    async contentReady() { reads++; return true; },
  });
  controller.register();
  t.after(() => { controller.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const event = (sender = webbar.value) => ({ sender, senderFrame: sender.mainFrame }) as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, input = event(), ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!(input, ...args));
  return {
    store, accounts, controller, webbar, editor, original, chatgpt, created, changes, applied, loading, handlers, event, invoke,
    add: (name: unknown) => invoke(CHANNELS.addDeepSeekAccount, undefined, name),
    select: (id: unknown) => invoke(CHANNELS.setDeepSeekAccount, undefined, id),
    platform: (platform: string) => invoke(CHANNELS.setWebPlatform, undefined, platform),
    prepare(fn: () => Promise<void>) { prepare = fn; },
    bind(fn: (state: WebPlatformState) => Promise<void>) { bind = fn; },
    apply(fn: (view: WebContentsView) => void) { apply = fn; },
    failCreation(value: boolean) { createFailure = value; },
    block(reason: WebPlatformState['switchBlockedReason']) { blocked = reason; controller.refreshSwitchAvailability(); },
    creations: () => creations, reads: () => reads,
  };
}

const settle = () => new Promise<void>(done => setImmediate(done));

test('账号操作仅顶栏主 frame 可用，未知账号和任意分区参数不创建视图', async t => {
  const f = fixture(t);
  for (const channel of [CHANNELS.setDeepSeekAccount, CHANNELS.addDeepSeekAccount]) {
    for (const event of [f.event(f.editor.value), { sender: {}, senderFrame: f.webbar.value.mainFrame }, { sender: f.webbar.value, senderFrame: {} }]) {
      await assert.rejects(f.invoke(channel, event as IpcMainInvokeEvent, '账号'), /主 frame/);
    }
  }
  for (const args of [[], ['account-99'], ['persist:arbitrary'], [{ id: 'default', partition: 'persist:arbitrary' }], ['default', 'persist:arbitrary'], [null]]) {
    await assert.rejects(f.invoke(CHANNELS.setDeepSeekAccount, undefined, ...args), /账号不存在/);
  }
  for (const args of [[], ['备注', 'persist:arbitrary'], [{ name: '备注', partition: 'persist:arbitrary' }]]) {
    await assert.rejects(f.invoke(CHANNELS.addDeepSeekAccount, undefined, ...args));
  }
  assert.equal(f.store.accounts.length, 1); assert.equal(f.creations(), 0);
  assert.equal(f.accounts.selectedId, 'default');
  await f.platform('chatgpt');
  await assert.rejects(f.add('备注'), /请先切换到 DeepSeek/);
  await assert.rejects(f.select('default'), /请先切换到 DeepSeek/);
});

test('执行、后台进程及发送期间拒绝添加与切换，不占用账号编号', async t => {
  const f = fixture(t); const account = f.store.add('已有账号');
  for (const reason of ['工具正在执行，完成后可切换', '后台命令正在运行，结束后可切换', '正在发送，请稍候'] as const) {
    f.block(reason);
    await assert.rejects(f.add('新账号'), error => error instanceof Error && error.message === reason);
    await assert.rejects(f.select(account.id), error => error instanceof Error && error.message === reason);
    assert.equal(f.creations(), 0); assert.equal(f.store.accounts.length, 2);
    assert.equal(f.accounts.selectedId, 'default');
    f.block(undefined);
  }
  await f.add('新账号'); assert.equal(f.accounts.selectedId, 'account-2');
});

test('准备期间并发添加与选择同步拒绝，await 后再次核验忙门禁', async t => {
  const f = fixture(t); const account = f.store.add('已有账号'); const wait = deferred();
  f.prepare(() => wait.promise);
  const switching = f.select(account.id); await settle();
  assert.equal(f.controller.state.switching, true);
  assert.equal(f.webbar.sent.at(-1)?.switching, true);
  await assert.rejects(f.select(account.id), /正在切换/);
  await assert.rejects(f.add('并发账号'), /正在切换/);
  f.block('后台命令正在运行，结束后可切换'); wait.resolve();
  await assert.rejects(switching, /后台命令/);
  assert.equal(f.creations(), 0); assert.equal(f.store.accounts.length, 2);
  assert.equal(f.accounts.selectedId, 'default'); assert.equal(f.controller.state.switching, false);
});

test('同平台不同账号切换更换真实 webContents，相同 URL 也重绑，视图与首页加载仅首次创建', async t => {
  const f = fixture(t);
  await f.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url);
  await f.add('工作账号');
  const work = f.created.get('persist:postcheck-ds-1')!;
  assert.equal(f.controller.getView('deepseek'), work.view);
  assert.equal(f.changes.at(-1)?.web, work.view.webContents);
  assert.notEqual(work.view.webContents, f.original.view.webContents);
  assert.equal(work.value.getURL(), f.original.value.getURL());
  await f.select('default'); assert.equal(f.changes.at(-1)?.web, f.original.view.webContents);
  await f.select('account-1'); assert.equal(f.changes.at(-1)?.web, work.view.webContents);
  await f.platform('chatgpt'); await f.platform('deepseek');
  assert.equal(f.controller.getView('deepseek'), work.view);
  assert.equal(f.controller.state.deepseekAccounts?.activeId, 'account-1');
  assert.equal(f.creations(), 1);
  assert.deepEqual(work.urls, [WEB_PLATFORMS.deepseek.url]);
  assert.deepEqual(f.original.urls, [WEB_PLATFORMS.deepseek.url]);
  await assert.rejects(f.select('account-1'), /当前已是/);
});

test('绑定结束前仍持有切换锁，不提前加载官网或允许下一个账号操作', async t => {
  const f = fixture(t); const account = f.store.add('工作账号'); const wait = deferred();
  f.bind(() => wait.promise);
  const switching = f.select(account.id); await settle();
  const work = f.created.get('persist:postcheck-ds-1')!;
  assert.equal(f.controller.state.switching, true); assert.deepEqual(work.urls, []);
  await assert.rejects(f.add('并发账号'), /正在切换/);
  await assert.rejects(f.select('default'), /正在切换/);
  wait.resolve(); await switching;
  assert.equal(f.controller.state.switching, false); assert.deepEqual(work.urls, [WEB_PLATFORMS.deepseek.url]);
});

test('隐藏账号失败与完成不污染当前账号，错误分别保留并在对应账号成功导航后清除', async t => {
  const f = fixture(t);
  f.original.value.emit('did-finish-load'); await settle();
  await f.add('工作账号'); const work = f.created.get('persist:postcheck-ds-1')!;
  work.value.emit('did-finish-load'); await settle();
  const counts = { loading: f.loading.length, sent: f.webbar.sent.length, reads: f.reads() };
  f.original.value.emit('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', 'https://secret.invalid/', true);
  f.original.value.emit('did-finish-load'); await settle();
  assert.equal(f.controller.state.error, undefined);
  assert.equal(f.loading.length, counts.loading); assert.equal(f.webbar.sent.length, counts.sent); assert.equal(f.reads(), counts.reads);
  assert.doesNotMatch(JSON.stringify(f.webbar.sent), /secret/);
  await f.select('default'); assert.match(f.controller.state.error!, /ERR_INTERNET_DISCONNECTED/);
  const before = { loading: f.loading.length, sent: f.webbar.sent.length, reads: f.reads() };
  work.value.emit('did-start-navigation', {}, WEB_PLATFORMS.deepseek.url, false, true);
  work.value.emit('did-finish-load'); await settle();
  assert.match(f.controller.state.error!, /ERR_INTERNET_DISCONNECTED/);
  assert.equal(f.loading.length, before.loading); assert.equal(f.webbar.sent.length, before.sent); assert.equal(f.reads(), before.reads);
  await f.select('account-1'); assert.equal(f.controller.state.error, undefined); await settle();
  work.value.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', '', true);
  assert.match(f.controller.state.error!, /ERR_NAME_NOT_RESOLVED/);
  await f.select('default'); assert.match(f.controller.state.error!, /ERR_INTERNET_DISCONNECTED/);
  f.original.value.emit('did-start-navigation', {}, WEB_PLATFORMS.deepseek.url, false, true);
  f.original.value.emit('did-finish-load'); await settle();
  assert.equal(f.controller.state.error, undefined);
  await f.select('account-1'); assert.match(f.controller.state.error!, /ERR_NAME_NOT_RESOLVED/);
});

test('新增账号视图创建失败仍保留元数据，之后可重新选择且复用原编号', async t => {
  const f = fixture(t); f.failCreation(true);
  await assert.rejects(f.add('工作账号'), /创建失败/);
  assert.deepEqual(f.store.accounts, [{ id: 'default', name: '默认账号' }, { id: 'account-1', name: '工作账号' }]);
  assert.equal(f.webbar.sent.at(-1)?.deepseekAccounts?.accounts.length, 2);
  assert.equal(f.accounts.selectedId, 'default'); assert.equal(f.controller.getView('deepseek'), f.original.view);
  f.failCreation(false); await f.select('account-1');
  assert.equal(f.controller.state.deepseekAccounts?.activeId, 'account-1');
  assert.deepEqual(f.created.get('persist:postcheck-ds-1')!.urls, [WEB_PLATFORMS.deepseek.url]);
});

test('准备、视图应用与绑定失败均回滚原账号和视图，重试不重复创建或提前加载', async t => {
  for (const mode of ['prepare', 'apply', 'bind']) {
    await t.test(mode, async t => {
      const f = fixture(t); const account = f.store.add('工作账号');
      if (mode === 'prepare') f.prepare(async () => { throw new Error('准备失败'); });
      if (mode === 'apply') f.apply(view => { if (view !== f.original.view) throw new Error('应用失败'); });
      if (mode === 'bind') f.bind(async () => { if (f.accounts.selectedId !== 'default') throw new Error('绑定失败'); });
      await assert.rejects(f.select(account.id), /失败/);
      assert.equal(f.accounts.selectedId, 'default'); assert.equal(f.controller.state.deepseekAccounts?.activeId, 'default');
      assert.equal(f.controller.getView('deepseek'), f.original.view); assert.equal(f.applied.at(-1), f.original.view);
      assert.equal(f.changes.at(-1)?.web, f.original.view.webContents); assert.equal(f.controller.state.switching, false);
      const prior = f.created.get('persist:postcheck-ds-1');
      if (prior) assert.deepEqual(prior.urls, []);
      f.prepare(async () => {}); f.apply(() => {}); f.bind(async () => {});
      await f.select(account.id); assert.equal(f.creations(), 1);
      assert.deepEqual(f.created.get('persist:postcheck-ds-1')!.urls, [WEB_PLATFORMS.deepseek.url]);
    });
  }
});

test('新增后准备失败保留资料但不创建视图，重试选择不额外添加账号', async t => {
  const f = fixture(t); f.prepare(async () => { throw new Error('准备失败'); });
  await assert.rejects(f.add('工作账号'), /准备失败/);
  assert.equal(f.store.accounts.length, 2); assert.equal(f.creations(), 0); assert.equal(f.accounts.selectedId, 'default');
  f.prepare(async () => {}); await f.select('account-1'); assert.equal(f.creations(), 1); assert.equal(f.store.accounts.length, 2);
});

test('关闭释放全部附加账号视图和监听，保留默认视图并撤销账号 IPC', async t => {
  const f = fixture(t); await f.add('工作账号'); await f.add('个人账号'); await f.platform('chatgpt');
  const extra = [...f.created.values()]; assert.equal(extra.length, 2);
  f.controller.dispose(); f.controller.dispose();
  for (const item of extra) {
    assert.equal(item.value.isDestroyed(), true);
    assert.equal(item.value.listenerCount('did-fail-load'), 0);
    assert.equal(item.value.listenerCount('did-finish-load'), 0);
  }
  assert.equal(f.original.value.isDestroyed(), false); assert.equal(f.chatgpt.value.isDestroyed(), true);
  assert.equal(f.handlers.size, 0);
});
