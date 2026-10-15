import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import vm from 'node:vm';
import { WebComposerSender, COMPOSER_SEND_WORLD, type WebSendResult } from '../src/main/webComposerSender';

async function flush() { for (let index = 0; index < 40; index++) await Promise.resolve(); }
function fixture() {
  const web = new EventEmitter() as any;
  const url = 'https://chatgpt.com/c/current';
  let context = vm.createContext({ document: {}, location: { href: url } });
  const mutations: string[] = [], cancellations: ((value: WebSendResult) => void)[] = [];
  let accept = false, probe: ((code: string) => Promise<unknown>) | undefined;
  web.getURL = () => url; web.isDestroyed = () => false;
  web.executeJavaScriptInIsolatedWorld = async (world: number, entries: { code: string }[]) => {
    assert.equal(world, COMPOSER_SEND_WORLD);
    const code = entries[0]!.code;
    if (code.startsWith('/* composer-document */')) return probe ? probe(code) : vm.runInContext(code, context);
    mutations.push(code);
    if (code.includes('state.cancel();')) return new Promise<WebSendResult>(resolve => { cancellations.push(resolve); });
    return accept ? { ok: true } : new Promise(() => {});
  };
  return { web, sender: new WebComposerSender(web), mutations, cancellations,
    accept() { accept = true; }, probe(fn: (code: string) => Promise<unknown>) { probe = fn; },
    replaceDocument() { context = vm.createContext({ document: {}, location: { href: url } }); },
    run(code: string) { return vm.runInContext(code, context); },
    navigate(status = 200, main = true, process = 11, routing = 22) {
      web.emit('did-start-navigation', { isMainFrame: main, isSameDocument: false });
      web.emit('did-frame-navigate', {}, url, status, '', main, process, routing);
    },
    finish(main = true, process = 11, routing = 22) { web.emit('did-frame-finish-load', {}, main, process, routing); }
  };
}
const session = 'https://chatgpt.com/c/current';
const known: WebSendResult = { ok: false, error: '已取消且清理完成', stage: 'waiting_button', cancellation: 'not_clicked' };

it('取消一秒超时保持旧批未知，迟到未点击清理证明仅恢复未来批且取消单飞', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); const sending = f.sender.send('old-result', session); await flush();
  const cancel = f.sender.cancel(), duplicate = f.sender.cancel(); await flush();
  assert.equal(f.cancellations.length, 1);
  t.mock.timers.tick(1000); await flush(); await Promise.all([cancel, duplicate]);
  const old = await sending; assert.equal(old.uncertain, true); assert.equal(old.cancellation, 'unknown');
  const blocked = await f.sender.send('future-result', session);
  assert.equal(blocked.blockedByPreviousCancellation, true); assert.equal(blocked.transportStarted, false);
  assert.equal(blocked.stage, 'preflight'); assert.equal(blocked.uncertain, undefined); assert.equal(blocked.retryable, undefined);
  assert.match(blocked.error!, /此前取消未确认/); assert.equal(f.mutations.length, 2);
  f.cancellations[0]!(known); await flush(); assert.equal(f.mutations.length, 2, '恢复证据本身不发送旧批或新批');
  f.accept(); assert.equal((await f.sender.send('future-result', session)).ok, true);
  assert.equal(f.mutations.length, 3); assert.equal(old.cancellation, 'unknown', '已返回的旧批结论不被迟到证据改写');
  await f.sender.dispose();
});

it('迟到已点击、清理未知或不确定未点击均不能解开同文档阻断', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const late of [{ ...known, cancellation: 'clicked' as const, uncertain: true }, { ...known, cancellation: 'unknown' as const }, { ...known, uncertain: true }]) {
    const f = fixture(); const sending = f.sender.send('old', session); await flush();
    const cancel = f.sender.cancel(); await flush(); t.mock.timers.tick(1000); await flush(); await cancel; await sending;
    f.cancellations[0]!(late); await flush(); f.accept();
    assert.equal((await f.sender.send('new', session)).blockedByPreviousCancellation, true);
    assert.equal(f.mutations.length, 2); await f.sender.dispose();
  }
});

it('仅完整成功主文档加载和不同文档nonce恢复后续批，旧迟到未知不污染新文档', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); const sending = f.sender.send('old', session); await flush();
  const cancel = f.sender.cancel(); await flush(); t.mock.timers.tick(1000); await flush(); await cancel; await sending;
  f.replaceDocument(); f.navigate();
  assert.equal((await f.sender.send('during-load', session)).blockedByPreviousCancellation, true);
  f.finish(); await flush();
  f.cancellations[0]!({ ...known, cancellation: 'unknown', uncertain: true }); await flush();
  f.accept(); assert.equal((await f.sender.send('new', session)).ok, true);
  assert.equal(f.mutations.filter(code => !code.includes('state.cancel();')).length, 2, '旧批不重发');
  await f.sender.dispose();
});

it('失败/子frame/SPA/仅finish/相同nonce不能冒充成功新文档清除阻断', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const mode of ['http-error', 'failed-load', 'subframe', 'spa', 'finish-only', 'same-document', 'wrong-frame']) {
    const f = fixture(); const sending = f.sender.send('old', session); await flush();
    const cancel = f.sender.cancel(); await flush(); t.mock.timers.tick(1000); await flush(); await cancel; await sending;
    if (mode === 'spa') f.web.emit('did-navigate-in-page', {}, session, true);
    else if (mode === 'finish-only') f.finish();
    else {
      if (mode !== 'same-document') f.replaceDocument();
      f.navigate(mode === 'http-error' ? 500 : 200, mode !== 'subframe');
      if (mode === 'failed-load') f.web.emit('did-fail-load', {}, -2, 'ERR_FAILED', session, true);
      f.finish(mode !== 'subframe', mode === 'wrong-frame' ? 99 : 11);
    }
    await flush(); f.accept();
    assert.equal((await f.sender.send('new', session)).blockedByPreviousCancellation, true, mode);
    assert.equal(f.mutations.length, 2); await f.sender.dispose();
  }
});

it('旧文档迟到取消证明不能解除新文档产生的新阻断', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  for (let index = 0; index < 2; index++) {
    const sending = f.sender.send('result-' + index, session); await flush();
    const cancel = f.sender.cancel(); await flush(); t.mock.timers.tick(1000); await flush(); await cancel; await sending;
    if (index === 0) { f.replaceDocument(); f.navigate(); f.finish(); await flush(); }
  }
  f.cancellations[0]!(known); await flush(); f.accept();
  assert.equal((await f.sender.send('third', session)).blockedByPreviousCancellation, true);
  f.cancellations[1]!(known); await flush();
  assert.equal((await f.sender.send('third', session)).ok, true); await f.sender.dispose();
});

it('同URL新文档拒绝排队旧写入、附件、恢复和取消；同文档取消也撤回未安装写脚本', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); const sending = f.sender.send('old', session); await flush();
  const oldWrite = f.mutations[0]!;
  const cancel = f.sender.cancel(); await flush(); const oldCancel = f.mutations[1]!;
  await f.run(oldCancel); // 真正脚本撤销 activeToken；没有已安装发送state不伪造清理证明。
  assert.equal(f.run(oldWrite).ok, false, '已撤销token不能在同文档迟到安装写脚本');
  f.replaceDocument(); f.navigate(); f.finish(); await flush();
  const rejected = f.run(oldWrite); assert.equal(rejected.ok, false); assert.match(rejected.error, /文档已变化/);
  assert.equal(await f.run(oldCancel), false, '新文档上旧取消不能清理新批');
  t.mock.timers.tick(1000); await flush(); await cancel; await sending;
  f.accept(); assert.equal((await f.sender.send('new', session)).ok, true); await f.sender.dispose();
});

it('文档握手尚未完成时取消不建立运输阻断，迟到握手不再安装写入', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.probe(() => new Promise(done => { resolve = done; }));
  const sending = f.sender.send('old', session); await flush();
  await f.sender.cancel(); const outcome = await sending;
  assert.equal(outcome.transportStarted, false); assert.equal(outcome.cancellation, 'not_clicked');
  resolve('late-nonce'); await flush(); assert.equal(f.mutations.length, 0); await f.sender.dispose();
});
it('附件每一运输阶段及备份resume均在新文档中拒绝排队旧脚本', async () => {
  for (const mode of ['attachments', 'draft']) {
    const url = mode === 'attachments' ? 'https://chat.deepseek.com/a/chat/one' : session;
    let context = vm.createContext({ document: {}, location: { href: url } });
    const web = new EventEmitter() as any, captured: string[] = [];
    web.getURL = () => url; web.isDestroyed = () => false;
    web.executeJavaScriptInIsolatedWorld = async (_world: number, entries: { code: string }[]) => {
      const code = entries[0]!.code;
      if (code.startsWith('/* composer-document */')) return vm.runInContext(code, context);
      captured.push(code);
      if (code.includes('state.cancel();')) return known;
      if (code.includes('return state.resume();')) return new Promise(() => {});
      if (mode === 'draft') return { ok: true, draftText: 'draft' };
      if (code.includes('s.parts.length || s.name') || code.includes('atob(') || code.includes('s.files.push(new File')) return true;
      if (code.includes('const represented = expected.every')) return { ready: true };
      if (code.includes('input[type="file"]') && code.includes('globalThis["__miniAIComposerAttachments"] =') || code.includes('s.input.files = transfer.files')) return { ok: true };
      return new Promise(() => {});
    };
    const sender = new WebComposerSender(web, { backupDraft: async () => '/backup.txt' });
    const files = mode === 'attachments' ? [{ id: 'one', name: 'one.txt', mediaType: 'text/plain', size: 1, async *stream() { yield new Uint8Array([65]); } }] : [];
    const sending = sender.send('result', url, 'results', () => true, files); await flush();
    assert.equal(captured.length, mode === 'attachments' ? 7 : 2);
    await sender.cancel(); await sending;
    context = vm.createContext({ document: {}, location: { href: url } });
    vm.runInContext('globalThis.__miniAIComposerDocument = { document, nonce: "new-document", activeToken: "new-token" }', context);
    for (const code of captured) {
      const result = await vm.runInContext(code, context);
      assert.ok(result === false || result?.ok === false || result?.error, '必须在任何DOM、File或输入操作之前拒绝旧nonce');
    }
    await sender.dispose();
  }
});

it('新文档完成后恢复握手仍未返回时，新导航或加载失败会撤销该恢复', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const mode of ['navigating', 'failed']) {
    const f = fixture(); const sending = f.sender.send('old', session); await flush();
    const cancel = f.sender.cancel(); await flush(); t.mock.timers.tick(1000); await flush(); await cancel; await sending;
    f.replaceDocument(); f.navigate();
    let resolve!: (value: unknown) => void;
    f.probe(() => new Promise(done => { resolve = done; })); f.finish(); await flush();
    if (mode === 'navigating') f.web.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    else f.web.emit('did-fail-load', {}, -2, 'ERR_FAILED', session, true);
    resolve('new-document-nonce'); await flush();
    assert.equal((await f.sender.send('new', session)).blockedByPreviousCancellation, true, mode); await f.sender.dispose();
  }
});


it('旧握手迟到实际执行不能撤销新批token，同一握手重放也不能复活取消token', async () => {
  const f = fixture(); const probes: Array<{ code: string; resolve: (value: unknown) => void }> = [];
  f.probe(code => new Promise(resolve => { probes.push({ code, resolve }); }));
  const old = f.sender.send('old', session); await flush();
  await f.sender.cancel(); await old;
  const fresh = f.sender.send('fresh', session); await flush();
  probes[1]!.resolve(f.run(probes[1]!.code)); await flush();
  const token = f.run('globalThis.__miniAIComposerDocument.activeToken');
  probes[0]!.resolve(f.run(probes[0]!.code)); await flush();
  assert.equal(f.run('globalThis.__miniAIComposerDocument.activeToken'), token, '旧握手不能覆盖最新token');
  const cancel = f.sender.cancel(); await flush();
  f.run(f.mutations[f.mutations.length - 1]!);
  assert.equal(f.run('globalThis.__miniAIComposerDocument.activeToken'), undefined);
  f.run(probes[1]!.code);
  assert.equal(f.run('globalThis.__miniAIComposerDocument.activeToken'), undefined, '取消后重放相同握手不可恢复token');
  f.cancellations[f.cancellations.length - 1]!(known); await cancel; await fresh; await f.sender.dispose();
});
