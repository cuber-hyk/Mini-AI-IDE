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
function contents() {
  let dead = false; const sent: Array<{ channel: string; state: WebPlatformState }> = []; const urls: string[] = [];
  const loading = deferred();
  const value = Object.assign(new EventEmitter(), {
    mainFrame: { send(channel: string, state: WebPlatformState) { sent.push({ channel, state }); } },
    isDestroyed: () => dead, close() { dead = true; }, loadURL(url: string) { urls.push(url); return loading.promise; },
  });
  return { value, sent, urls, loading };
}
function fixture() {
  const webbar = contents(), editor = contents(), deepseek = contents(), chatgpt = contents();
  const handlers = new Map<string, Function>(); const applied: WebContentsView[] = []; const changed: WebPlatformState[] = [];
  let prepare: () => Promise<void> = async () => {}; let create: () => WebContentsView = () => ({ webContents: chatgpt.value }) as unknown as WebContentsView;
  let gate: (state: WebPlatformState) => Promise<void> = async () => {}; let creations = 0;
  const original = { webContents: deepseek.value } as unknown as WebContentsView;
  const controller = new WebPlatformController({
    ipc: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
    webbar: webbar.value as unknown as WebContents, editor: editor.value as unknown as WebContents, deepseek: original,
    createChatGPT() { creations++; return create(); }, prepareSwitch: () => prepare(), applyView(view) { applied.push(view); },
    async changed(state) { changed.push(state); await gate(state); },
  });
  const channels = controller.register();
  const event = (sender = webbar.value) => ({ sender, senderFrame: sender.mainFrame }) as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, input = event(), ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!(input, ...args));
  return { controller, webbar, editor, chatgpt, deepseek, original, changed, applied, channels, handlers, event, invoke,
    set: (platform: unknown) => invoke(CHANNELS.setWebPlatform, undefined, platform),
    prepare(fn: () => Promise<void>) { prepare = fn; }, create(fn: () => WebContentsView) { create = fn; },
    gate(fn: (state: WebPlatformState) => Promise<void>) { gate = fn; }, creations: () => creations };
}

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
