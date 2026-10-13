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
  const original = { webContents: deepseek.value } as unknown as WebContentsView;
  const controller = new WebPlatformController({
    ipc: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
    webbar: webbar.value as unknown as WebContents, editor: editor.value as unknown as WebContents, deepseek: original,
    createChatGPT() { creations++; return create(); }, prepareSwitch: () => prepare(), applyView(view) { applied.push(view); },
    async changed(state) { changed.push(state); await gate(state); },
    switchBlock: () => blocked,
  });
  const channels = controller.register();
  const event = (sender = webbar.value) => ({ sender, senderFrame: sender.mainFrame }) as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, input = event(), ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!(input, ...args));
  return { controller, webbar, editor, chatgpt, deepseek, original, changed, applied, channels, handlers, event, invoke,
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
