import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import type { IpcMainInvokeEvent, WebContents, WebContentsView } from 'electron';
import { WebPlatformController } from '../src/main/webPlatformController';
import { CHANNELS } from '../src/shared/contract';
import { WEB_PLATFORMS, type WebPlatformState } from '../src/shared/webPlatform';

function deferred() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function contents(initialUrl = WEB_PLATFORMS.deepseek.url as string) {
  let dead = false; const sent: Array<{ channel: string; state: WebPlatformState }> = []; const urls: string[] = [];
  const loading = deferred();
  let reloads = 0; let currentUrl = initialUrl;
  const value = Object.assign(new EventEmitter(), {
    mainFrame: { send(channel: string, state: WebPlatformState) { sent.push({ channel, state }); } },
    isDestroyed: () => dead, close() { dead = true; },
    getURL: () => currentUrl,
    reload() { reloads++; value.emit('did-start-navigation', {}, '', false, true); },
    loadURL(url: string) { currentUrl = url; urls.push(url); value.emit('did-start-navigation', {}, url, false, true); return loading.promise.catch(error => {
      value.emit('did-fail-load', {}, -2, 'ERR_FAILED', url, true); value.emit('did-finish-load'); throw error;
    }); },
  });
  return { value, sent, urls, loading, reloads: () => reloads, navigate: (url: string) => { currentUrl = url; } };
}

it('仅显式启动的首页连接关闭延迟恢复一次，错误页完成和停止不提前结束等待', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture();
  try {
    void f.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url);
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', WEB_PLATFORMS.deepseek.url, true);
    f.deepseek.value.emit('did-finish-load'); f.deepseek.value.emit('did-stop-loading');
    assert.equal(f.controller.state.reloading, true); assert.match(f.controller.state.error!, /ERR_CONNECTION_CLOSED/);
    assert.equal(f.loadingStates.at(-1)?.loading, true);
    await assert.rejects(f.invoke(CHANNELS.reloadWebPlatform), /正在重新加载/);
    context.mock.timers.tick(999); assert.equal(f.deepseek.reloads(), 0);
    context.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.deepseek.reloads(), 1); assert.equal(f.controller.getView('deepseek'), f.original);
    assert.deepEqual(f.deepseek.urls, [WEB_PLATFORMS.deepseek.url]);
    f.deepseek.value.emit('did-finish-load'); f.deepseek.value.emit('did-stop-loading');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.controller.state.error, undefined); assert.equal(f.controller.state.reloading, undefined);
    assert.equal(f.loadingStates.at(-1)?.loading, false);
    f.deepseek.value.emit('did-start-navigation', {}, WEB_PLATFORMS.deepseek.url, false, true);
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', WEB_PLATFORMS.deepseek.url, true);
    context.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.deepseek.reloads(), 1, '已成功打开的页面不因后续连接错误自动刷新');
    await assert.rejects(f.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url), /已发起/);
  } finally { f.controller.dispose(); }
});

it('首次自动恢复再次失败终止，保留真实错误和原手动重载入口', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture();
  try {
    void f.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url);
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', WEB_PLATFORMS.deepseek.url, true);
    context.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', WEB_PLATFORMS.deepseek.url, true);
    f.deepseek.value.emit('did-finish-load'); f.deepseek.value.emit('did-stop-loading');
    context.mock.timers.tick(10_000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.deepseek.reloads(), 1); assert.equal(f.controller.state.reloading, undefined);
    assert.match(f.controller.state.error!, /ERR_CONNECTION_CLOSED/); assert.equal(f.loadingStates.at(-1)?.loading, false);
    await f.invoke(CHANNELS.reloadWebPlatform); assert.equal(f.deepseek.reloads(), 2);
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', WEB_PLATFORMS.deepseek.url, true);
    f.deepseek.value.emit('did-stop-loading'); context.mock.timers.tick(5000);
    assert.equal(f.deepseek.reloads(), 2, '手动重载不重新取得启动恢复额度');
  } finally { f.controller.dispose(); }
});

it('证书、取消、未知错误、非首页和未武装的加载失败均不自动重载', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const cases = [
    { code: -202, description: 'ERR_CERT_AUTHORITY_INVALID', url: WEB_PLATFORMS.deepseek.url, start: true },
    { code: -3, description: 'ERR_ABORTED', url: WEB_PLATFORMS.deepseek.url, start: true },
    { code: -2, description: 'ERR_FAILED', url: WEB_PLATFORMS.deepseek.url, start: true },
    { code: -100, description: 'ERR_UNKNOWN', url: WEB_PLATFORMS.deepseek.url, start: true },
    { code: -100, description: 'ERR_CONNECTION_CLOSED', url: 'https://chat.deepseek.com/a/chat/s/conversation', start: true },
    { code: -100, description: 'ERR_CONNECTION_CLOSED', url: WEB_PLATFORMS.deepseek.url, start: false },
  ];
  for (const test of cases) {
    const f = fixture();
    try {
      if (test.start) void f.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url);
      f.deepseek.value.emit('did-fail-load', {}, test.code, test.description, test.url, true);
      context.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.deepseek.reloads(), 0, test.description); assert.equal(f.controller.state.reloading, undefined);
    } finally { f.controller.dispose(); }
  }
});

it('首个文档成功或重定向至登录页后不自动刷新，子frame错误不消耗首页恢复', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  for (const mode of ['success', 'redirect', 'custom', 'subframe']) {
    const f = fixture();
    try {
      void f.controller.loadInitialDeepSeek(mode === 'custom' ? 'https://example.test/' : WEB_PLATFORMS.deepseek.url);
      if (mode === 'success') f.deepseek.value.emit('did-finish-load');
      if (mode === 'redirect') f.deepseek.value.emit('did-start-navigation', {}, 'https://chat.deepseek.com/sign_in', false, true);
      if (mode === 'subframe') f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', WEB_PLATFORMS.deepseek.url, false);
      f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', WEB_PLATFORMS.deepseek.url, true);
      context.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.deepseek.reloads(), mode === 'subframe' ? 1 : 0, mode);
    } finally { f.controller.dispose(); }
  }
});

it('待首次恢复时切平台、新导航、退出、地址改变或工具忙均撤销，不迟到刷新', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  for (const mode of ['switch', 'navigate', 'in-place', 'dispose', 'url', 'busy']) {
    const f = fixture();
    try {
      void f.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url);
      f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', WEB_PLATFORMS.deepseek.url, true);
      if (mode === 'switch') await f.set('chatgpt');
      if (mode === 'navigate' || mode === 'in-place') f.deepseek.value.emit('did-start-navigation', {}, WEB_PLATFORMS.deepseek.url, mode === 'in-place', true);
      if (mode === 'dispose') f.controller.dispose();
      if (mode === 'url') f.deepseek.navigate('https://example.test/');
      if (mode === 'busy') f.block('工具正在执行，完成后可切换');
      context.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.deepseek.reloads(), 0, mode); assert.equal(f.controller.state.reloading, undefined, mode);
    } finally { f.controller.dispose(); }
  }
});

it('首次恢复准备期间已出现新导航时不覆盖新页面，准备失败也不遗留等待状态', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  for (const mode of ['navigate', 'in-place', 'in-place-same-url', 'address-change', 'prepare-failure', 'busy', 'dispose']) {
    const f = fixture(); const pending = deferred(); f.prepare(() => pending.promise);
    try {
      void f.controller.loadInitialDeepSeek(WEB_PLATFORMS.deepseek.url);
      f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', WEB_PLATFORMS.deepseek.url, true);
      context.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.controller.state.switching, true);
      if (mode === 'navigate') f.deepseek.value.emit('did-start-navigation', {}, WEB_PLATFORMS.deepseek.url, false, true);
      if (mode === 'in-place') {
        f.deepseek.navigate('https://chat.deepseek.com/other');
        f.deepseek.value.emit('did-start-navigation', {}, 'https://chat.deepseek.com/other', true, true);
      }
      if (mode === 'in-place-same-url') f.deepseek.value.emit('did-start-navigation', {}, WEB_PLATFORMS.deepseek.url, true, true);
      if (mode === 'address-change') f.deepseek.navigate('https://chat.deepseek.com/other');
      if (mode === 'busy') f.block('正在发送，请稍候');
      if (mode === 'dispose') f.controller.dispose();
      if (mode === 'prepare-failure') pending.reject(Error('fixture preparation failed')); else pending.resolve();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.deepseek.reloads(), 0, mode); assert.equal(f.controller.state.reloading, undefined, mode);
      if (mode !== 'dispose') assert.equal(f.controller.state.switching, false, mode);
    } finally { f.controller.dispose(); }
  }
});

it('DeepSeek主frame加载失败后错误页完成不能冒充成功，隐藏错误切回仍可见', async () => {
  const f = fixture();
  try {
    f.deepseek.value.emit('did-start-navigation', {}, 'https://chat.deepseek.com/', false, true);
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', 'https://private.invalid/?secret=1', true);
    f.deepseek.value.emit('did-finish-load');
    assert.match(f.controller.state.error!, /DeepSeek.*ERR_CONNECTION_CLOSED.*-100/);
    assert.doesNotMatch(JSON.stringify(f.webbar.sent), /private|secret/);
    await f.set('chatgpt'); assert.equal(f.controller.state.error, undefined);
    await f.set('deepseek'); assert.match(f.controller.state.error!, /ERR_CONNECTION_CLOSED/);
    f.deepseek.value.emit('did-start-navigation', {}, 'https://chat.deepseek.com/', false, true);
    f.deepseek.value.emit('did-finish-load'); assert.equal(f.controller.state.error, undefined);
  } finally { f.controller.dispose(); }
});

it('失败后的取消或子frame完成不清除旧错误，子frame失败不污染平台状态', async () => {
  const f = fixture();
  try {
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', '', false);
    assert.equal(f.controller.state.error, undefined);
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', '', true);
    f.deepseek.value.emit('did-start-navigation', {}, '', false, false);
    f.deepseek.value.emit('did-finish-load'); assert.match(f.controller.state.error!, /ERR_CONNECTION_CLOSED/);
    f.deepseek.value.emit('did-start-navigation', {}, '', false, true);
    f.deepseek.value.emit('did-fail-load', {}, -3, 'ERR_ABORTED', '', true);
    f.deepseek.value.emit('did-finish-load'); assert.match(f.controller.state.error!, /ERR_CONNECTION_CLOSED/);
  } finally { f.controller.dispose(); }
});
function fixture() {
  const webbar = contents(), editor = contents(), deepseek = contents(), chatgpt = contents(WEB_PLATFORMS.chatgpt.url);
  const handlers = new Map<string, Function>(); const applied: WebContentsView[] = []; const changed: WebPlatformState[] = [];
  let prepare: () => Promise<void> = async () => {}; let create: () => WebContentsView = () => ({ webContents: chatgpt.value }) as unknown as WebContentsView;
  let gate: (state: WebPlatformState) => Promise<void> = async () => {}; let creations = 0;
  let blocked: WebPlatformState['switchBlockedReason'];
  const loadingStates: Array<{ platform: string; loading: boolean }> = [];
  let contentReady = async () => true;
  const original = { webContents: deepseek.value } as unknown as WebContentsView;
  const controller = new WebPlatformController({
    ipc: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
    webbar: webbar.value as unknown as WebContents, editor: editor.value as unknown as WebContents, deepseek: original,
    createChatGPT() { creations++; return create(); }, prepareSwitch: () => prepare(), applyView(view) { applied.push(view); },
    async changed(state) { changed.push(state); await gate(state); },
    switchBlock: () => blocked,
    loadingChanged: (platform, loading) => loadingStates.push({ platform, loading }),
    contentReady: () => contentReady(),
  });
  const channels = controller.register();
  const event = (sender = webbar.value) => ({ sender, senderFrame: sender.mainFrame }) as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, input = event(), ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!(input, ...args));
  return { controller, webbar, editor, chatgpt, deepseek, original, changed, applied, channels, handlers, event, invoke,
    loadingStates, ready(fn: () => Promise<boolean>) { contentReady = fn; },
    set: (platform: unknown) => invoke(CHANNELS.setWebPlatform, undefined, platform),
    prepare(fn: () => Promise<void>) { prepare = fn; }, create(fn: () => WebContentsView) { create = fn; },
    gate(fn: (state: WebPlatformState) => Promise<void>) { gate = fn; }, creations: () => creations,
    block(reason: WebPlatformState['switchBlockedReason']) { blocked = reason; controller.refreshSwitchAvailability(); } };
}

it('权威忙原因即时广播并在入口拒绝切换，忙结束后恢复且不重新加载官网', async () => {
  const f=fixture();
  try {
    for(const reason of ['工具正在执行，完成后可切换','后台命令正在运行，结束后可切换','正在发送，请稍候'] as const){
      const editorCount=f.editor.sent.length;
      f.block(reason);assert.equal(f.controller.state.switchBlockedReason,reason);assert.equal(f.webbar.sent.at(-1)?.state.switchBlockedReason,reason);
      assert.equal(f.editor.sent.length,editorCount,'仅忙原因变化不能让本地需求区重复显示平台切换提示');
      const count=f.webbar.sent.length;f.block(reason);assert.equal(f.webbar.sent.length,count,'重复状态不广播');
      await assert.rejects(f.set('chatgpt'),error=>error instanceof Error&&error.message===reason);
      assert.equal(f.creations(),0);assert.equal(f.controller.state.platform,'deepseek');
      f.block(undefined);assert.equal(f.webbar.sent.at(-1)?.state.switchBlockedReason,undefined);
    }
    await f.set('chatgpt');assert.equal(f.creations(),1);
  }finally{f.controller.dispose();}
});

it('默认 DeepSeek、固定隔离分区，仅顶栏主 frame 可切换且不接受任意 URL', async () => {
  const f = fixture();
  assert.deepEqual(f.controller.state, { platform: 'deepseek', switching: false });
  assert.equal(WEB_PLATFORMS.deepseek.partition, 'persist:postcheck');
  assert.equal(WEB_PLATFORMS.chatgpt.partition, 'persist:postcheck-02');
  assert.equal(WEB_PLATFORMS.chatgpt.url, 'https://chatgpt.com/');
  assert.deepEqual(await f.invoke(CHANNELS.getWebPlatform, f.event(f.editor.value)), f.controller.state);
  for (const event of [f.event(f.editor.value), { sender: {}, senderFrame: f.webbar.value.mainFrame }, { sender: f.webbar.value, senderFrame: {} }])
    await assert.rejects(f.invoke(CHANNELS.setWebPlatform, event as IpcMainInvokeEvent, 'chatgpt'), /主 frame/);
  for (const args of [[], ['https://chatgpt.com/'], ['chatgpt', 'extra'], [null], [{ platform: 'chatgpt' }]])
    await assert.rejects(f.invoke(CHANNELS.setWebPlatform, undefined, ...args), /参数/);
  await assert.rejects(f.invoke(CHANNELS.getWebPlatform, undefined, 'extra'), /参数/);
  await assert.rejects(f.invoke(CHANNELS.getWebPlatform, { sender: f.editor.value, senderFrame: {} } as unknown as IpcMainInvokeEvent), /主 frame/);
  assert.equal(f.creations(), 0);
});

it('切换同步锁住并广播，忙拒绝恢复原门禁且不创建官网视图', async () => {
  const f = fixture(); const wait = deferred(); f.prepare(() => wait.promise);
  const switching = f.set('chatgpt'); await new Promise(done => setImmediate(done));
  assert.equal(f.controller.state.switching, true);
  assert.equal(f.webbar.sent.at(-1)?.state.switching, true);
  await assert.rejects(f.set('chatgpt'), /正在切换/);
  wait.reject(new Error('工具执行中')); await assert.rejects(switching, /工具执行中/);
  assert.deepEqual(f.controller.state, { platform: 'deepseek', switching: false });
  assert.equal(f.creations(), 0); assert.deepEqual(f.changed.at(-1), f.controller.state);
});

it('局部门禁应用完成才结束切换，官网网络加载不阻止立即切回', async () => {
  const f = fixture(); const gate = deferred(); f.gate(state => state.platform === 'chatgpt' ? gate.promise : Promise.resolve());
  const switching = f.set('chatgpt'); await new Promise(done => setImmediate(done));
  assert.equal(f.controller.state.switching, true); assert.equal(f.chatgpt.urls.length, 0);
  await assert.rejects(f.set('deepseek'), /正在切换/);
  gate.resolve(); assert.deepEqual(await switching, { platform: 'chatgpt', switching: false });
  assert.deepEqual(f.chatgpt.urls, [WEB_PLATFORMS.chatgpt.url]);
  await assert.rejects(f.set('chatgpt'), /当前已是/);
  await f.set('deepseek'); assert.equal(f.applied.at(-1), f.original);
  await f.set('chatgpt'); assert.equal(f.creations(), 1); assert.equal(f.chatgpt.urls.length, 1);
});

it('创建失败恢复 DeepSeek，后续真实切换仍可创建；加载失败保持活动并只给固定提示', async () => {
  const f = fixture(); f.create(() => { throw new Error('creation failed'); });
  await assert.rejects(f.set('chatgpt'), /creation failed/);
  assert.deepEqual(f.controller.state, { platform: 'deepseek', switching: false }); assert.equal(f.applied.at(-1), f.original);
  f.create(() => ({ webContents: f.chatgpt.value }) as unknown as WebContentsView); await f.set('chatgpt');
  f.chatgpt.loading.reject(new Error('https://secret.invalid/?token=private')); await new Promise(done => setImmediate(done));
  assert.equal(f.controller.state.platform, 'chatgpt'); assert.match(f.controller.state.error!, /页面加载失败/);
  assert.doesNotMatch(JSON.stringify(f.webbar.sent), /secret|token|private/);
  await f.set('deepseek'); assert.equal(f.controller.state.error, undefined);
  await f.set('chatgpt'); assert.match(f.controller.state.error!, /页面加载失败/);
  f.chatgpt.value.emit('did-start-navigation', {}, '', false, true);
  f.chatgpt.value.emit('did-finish-load');
  assert.equal(f.controller.state.error, undefined, '手动恢复加载后不显示过期错误');
  await f.set('deepseek'); await f.set('chatgpt');
  assert.equal(f.controller.state.error, undefined, '再次切回不恢复旧错误');
});

it('隐藏 ChatGPT 的旧加载错误不覆盖当前 DeepSeek，关闭仅释放新增视图和弹窗', async () => {
  const f = fixture(); await f.set('chatgpt'); await f.set('deepseek');
  f.chatgpt.loading.reject(new Error('old failure')); await new Promise(done => setImmediate(done));
  assert.deepEqual(f.controller.state, { platform: 'deepseek', switching: false });
  let closed = false;
  const popup = Object.assign(new EventEmitter(), { isDestroyed: () => closed, close() { closed = true; } });
  f.chatgpt.value.emit('did-create-window', popup);
  f.controller.dispose(); f.controller.dispose();
  assert.equal(closed, true); assert.equal(f.chatgpt.value.isDestroyed(), true); assert.equal(f.deepseek.value.isDestroyed(), false);
  assert.equal(f.handlers.size, 0);
});

it('门禁完成失败恢复原视图，再切换时仍首次加载固定地址', async () => {
  const f = fixture(); let fail = true;
  f.gate(async state => { if (fail && state.platform === 'chatgpt') throw new Error('gate failed'); });
  await assert.rejects(f.set('chatgpt'), /gate failed/);
  assert.deepEqual(f.controller.state, { platform: 'deepseek', switching: false });
  assert.equal(f.applied.at(-1), f.original); assert.equal(f.chatgpt.urls.length, 0);
  fail = false; await f.set('chatgpt');
  assert.equal(f.creations(), 1); assert.deepEqual(f.chatgpt.urls, [WEB_PLATFORMS.chatgpt.url]);
});

it('准备期间关闭窗口不再创建视图或广播过期切换', async () => {
  const f = fixture(); const wait = deferred(); f.prepare(() => wait.promise);
  const switching = f.set('chatgpt'); await new Promise(done => setImmediate(done));
  f.controller.dispose(); wait.resolve(); await assert.rejects(switching, /已关闭/);
  assert.equal(f.creations(), 0);
});

it('重载仅顶栏主frame零参数可发起，限当前失败页面并复用原视图', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.invoke(CHANNELS.reloadWebPlatform), /没有加载失败/);
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', '', true);
    for (const event of [f.event(f.editor.value), { sender: f.webbar.value, senderFrame: {} }])
      await assert.rejects(f.invoke(CHANNELS.reloadWebPlatform, event as IpcMainInvokeEvent), /主 frame/);
    await assert.rejects(f.invoke(CHANNELS.reloadWebPlatform, undefined, 'https://example.test/'), /不接受参数/);
    const result = await f.invoke(CHANNELS.reloadWebPlatform);
    assert.equal(result.reloading, true); assert.match(result.error, /ERR_CONNECTION_CLOSED/);
    assert.equal(result.switching, false); assert.equal(f.deepseek.reloads(), 1); assert.equal(f.deepseek.urls.length, 0);
    assert.equal(f.controller.getView('deepseek'), f.original);
    await assert.rejects(f.invoke(CHANNELS.reloadWebPlatform), /重新加载/);
    await f.set('chatgpt'); assert.equal(f.controller.state.reloading, undefined); assert.equal(f.controller.state.error, undefined);
    await f.set('deepseek'); assert.equal(f.controller.state.reloading, true);
    f.deepseek.value.emit('did-finish-load'); f.deepseek.value.emit('did-stop-loading');
    assert.deepEqual(f.controller.state, { platform: 'deepseek', switching: false });
  } finally { f.controller.dispose(); }
});

it('忙、准备失败或准备期间退出不发起重载，关闭后撤销两平台加载监听', async () => {
  for (const mode of ['busy', 'prepare', 'race', 'closed']) {
    const f = fixture();
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', '', true);
    if (mode === 'busy') f.block('工具正在执行，完成后可切换');
    if (mode === 'prepare') f.prepare(async () => { throw Error('prepare failed'); });
    if (mode === 'race') f.prepare(async () => { f.block('工具正在执行，完成后可切换'); });
    if (mode === 'closed') f.prepare(async () => { f.controller.dispose(); });
    await assert.rejects(f.invoke(CHANNELS.reloadWebPlatform)); assert.equal(f.deepseek.reloads(), 0);
    const count = f.webbar.sent.length; f.controller.dispose();
    assert.equal(f.deepseek.value.listenerCount('did-fail-load'), 0);
    f.deepseek.value.emit('did-fail-load', {}, -2, 'ERR_FAILED', '', true);
    assert.equal(f.webbar.sent.length, count);
  }
});

it('重复失败仍保留错误，未成功的重载不报告恢复', async () => {
  const f = fixture();
  try {
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', '', true);
    await f.invoke(CHANNELS.reloadWebPlatform);
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', '', true);
    f.deepseek.value.emit('did-finish-load'); f.deepseek.value.emit('did-stop-loading');
    assert.equal(f.controller.state.reloading, undefined); assert.match(f.controller.state.error!, /ERR_CONNECTION_CLOSED/);
    await f.invoke(CHANNELS.reloadWebPlatform); assert.equal(f.deepseek.reloads(), 2);
  } finally { f.controller.dispose(); }
});

it('当前非官网或准备期间地址改变时不重载，错误文案不能泄漏加载URL', async () => {
  for (const url of ['file:///private.html', 'https://example.test/', 'https://chat.deepseek.com.evil.test/', 'https://user:password@chat.deepseek.com/', 'about:blank']) {
    for (const duringPrepare of [false, true]) {
      const f = fixture();
      try {
        f.deepseek.value.emit('did-fail-load', {}, -999999, 'https://secret.invalid/?token=private', '', true);
        assert.match(f.controller.state.error!, /ERR_FAILED \/ -2/);
        assert.doesNotMatch(JSON.stringify(f.webbar.sent), /secret|token|private/);
        if (duringPrepare) f.prepare(async () => { f.deepseek.navigate(url); }); else f.deepseek.navigate(url);
        await assert.rejects(f.invoke(CHANNELS.reloadWebPlatform)); assert.equal(f.deepseek.reloads(), 0);
      } finally { f.controller.dispose(); }
    }
  }
});

it('准备期间已成功恢复时不再重载正常页面', async () => {
  const f = fixture();
  try {
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', '', true);
    f.prepare(async () => {
      f.deepseek.value.emit('did-start-navigation', {}, '', false, true);
      f.deepseek.value.emit('did-finish-load');
    });
    await assert.rejects(f.invoke(CHANNELS.reloadWebPlatform), /状态已变化/);
    assert.equal(f.deepseek.reloads(), 0); assert.equal(f.controller.state.error, undefined);
  } finally { f.controller.dispose(); }
});

it('首次加载与 SPA 空壳保留提示，完成正文核验后收起，正常切换不重载', async () => {
  const f = fixture();
  let release!: (ready: boolean) => void;
  f.ready(() => new Promise(resolve => { release = resolve; }));
  try {
    assert.deepEqual(f.loadingStates.at(-1), { platform: 'deepseek', loading: true });
    f.deepseek.value.emit('dom-ready');
    assert.equal(f.loadingStates.at(-1)?.loading, true);
    f.deepseek.value.emit('did-finish-load');
    assert.equal(f.loadingStates.at(-1)?.loading, true);
    release(true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.loadingStates.at(-1)?.loading, false);
    f.ready(async () => true);
    await f.set('chatgpt');
    assert.deepEqual(f.loadingStates.at(-1), { platform: 'chatgpt', loading: true });
    f.chatgpt.value.emit('did-finish-load'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.loadingStates.at(-1)?.loading, false);
    await f.set('deepseek');
    assert.deepEqual(f.loadingStates.at(-1), { platform: 'deepseek', loading: false });
    assert.equal(f.deepseek.reloads(), 0); assert.equal(f.chatgpt.urls.length, 1);
  } finally { f.controller.dispose(); }
});

it('导航过期、隐藏平台完成及失败不能掩盖当前平台状态', async () => {
  const f = fixture();
  const pending: Array<(value: boolean) => void> = [];
  f.ready(() => new Promise(resolve => pending.push(resolve)));
  try {
    f.deepseek.value.emit('did-finish-load');
    f.deepseek.value.emit('did-start-navigation', {}, '', false, true);
    pending.shift()!(true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.loadingStates.at(-1)?.loading, true);
    await f.set('chatgpt');
    const count = f.loadingStates.length;
    f.deepseek.value.emit('did-finish-load');
    assert.equal(pending.length, 0, '后台页面不持续扫描 DOM');
    assert.equal(f.loadingStates.length, count);
    f.chatgpt.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', '', true);
    assert.deepEqual(f.loadingStates.at(-1), { platform: 'chatgpt', loading: false });
    assert.match(f.controller.state.error!, /ERR_CONNECTION_CLOSED/);
  } finally { f.controller.dispose(); }
});

it('文档完成后即使只读渲染检查无回执，也在有界等待后撤下遮罩', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture(); f.ready(() => new Promise(() => {}));
  try {
    f.deepseek.value.emit('did-finish-load');
    assert.equal(f.loadingStates.at(-1)?.loading, true);
    context.mock.timers.tick(10_000);
    assert.deepEqual(f.loadingStates.at(-1), { platform: 'deepseek', loading: false });
    assert.equal(f.controller.state.error, undefined, '观察超时不伪造官网加载失败');
  } finally { f.controller.dispose(); }
});

it('取消主 frame 导航撤下加载提示，迟到只读结果不能恢复遮罩或清除旧错误', async () => {
  const f = fixture(); let release!: (ready: boolean) => void;
  f.ready(() => new Promise(resolve => { release = resolve; }));
  try {
    f.deepseek.value.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', '', true);
    f.deepseek.value.emit('did-start-navigation', {}, '', false, true);
    f.deepseek.value.emit('did-finish-load');
    f.deepseek.value.emit('did-fail-load', {}, -3, 'ERR_ABORTED', '', true);
    assert.equal(f.loadingStates.at(-1)?.loading, false);
    release(true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.loadingStates.at(-1)?.loading, false);
  } finally { f.controller.dispose(); }
});
