import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import { WebResultSender, RESULT_SEND_WORLD } from '../src/main/tools/webResultSender';

function fixture(url = 'https://chat.deepseek.com/a/chat/one') {
  const web = new EventEmitter() as any;
  const scripts: string[] = [];
  web.getURL = () => url;
  web.isDestroyed = () => false;
  web.executeJavaScriptInIsolatedWorld = async (world: number, entries: { code: string }[]) => {
    assert.equal(world, RESULT_SEND_WORLD);
    scripts.push(entries[0]!.code);
    return { ok: true };
  };
  return { web, scripts, sender: new WebResultSender(web), navigate(next: string) { url = next; } };
}

it('自动回传仅接纳官方 origin 和本批会话；不把结果送到相似域名或其他会话', async () => {
  for (const url of ['https://chat.deepseek.com.evil.test/a/chat/one', 'http://chat.deepseek.com/a/chat/one', 'https://chat.deepseek.com:444/a/chat/one', 'file:///C:/fixture.html', 'invalid']) {
    const f = fixture(url);
    try { assert.equal((await f.sender.send('tools result', url)).ok, false); assert.equal(f.scripts.length, 0); }
    finally { await f.sender.dispose(); }
  }
  const f = fixture();
  try {
    assert.equal((await f.sender.send('tools result', 'https://chat.deepseek.com/a/chat/other')).ok, false);
    assert.equal(f.scripts.length, 0);
    f.navigate('https://chat.deepseek.com/a/chat/one?tracking=changed#tail');
    assert.equal((await f.sender.send('tools result', 'https://chat.deepseek.com/a/chat/one')).ok, true);
    assert.equal(f.scripts.length, 1);
  } finally { await f.sender.dispose(); }
});

it('关闭开关与开始发送同一时刻发生时，不安装发送脚本', async () => {
  const f = fixture();
  try {
    const sending = f.sender.send('result', 'https://chat.deepseek.com/a/chat/one');
    await f.sender.cancel();
    assert.equal((await sending).ok, false);
    assert.equal(f.scripts.length, 0);
  } finally { await f.sender.dispose(); }
});

it('同一时间仅一份结果发送，导航取消隔离世界等待且销毁移除监听', async () => {
  const f = fixture(); let finish: ((value: unknown) => void) | undefined;
  f.web.executeJavaScriptInIsolatedWorld = async (_world: number, entries: { code: string }[]) => {
    f.scripts.push(entries[0]!.code);
    if (entries[0]!.code.includes('state.cancel();')) { finish?.({ ok: false, error: '自动发送已取消' }); return true; }
    return new Promise(resolve => { finish = resolve; });
  };
  const first = f.sender.send('first', 'https://chat.deepseek.com/a/chat/one');
  await Promise.resolve();
  assert.equal((await f.sender.send('second', 'https://chat.deepseek.com/a/chat/one')).ok, false);
  f.web.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  assert.equal(f.scripts.length, 1);
  f.web.emit('did-navigate-in-page', {}, 'https://chat.deepseek.com/a/chat/two', true);
  assert.equal((await first).ok, false);
  assert.equal(f.scripts.length, 2);
  await f.sender.dispose();
  assert.equal(f.web.listenerCount('did-start-navigation'), 0);
  assert.equal(f.web.listenerCount('did-navigate-in-page'), 0);
  assert.equal(f.web.listenerCount('destroyed'), 0);
});

it('渲染异常或不可识别返回值必须报不确定；不重新提交同一份结果', async () => {
  for (const execute of [async () => { throw new Error('page failed'); }, async () => undefined]) {
    const f = fixture(); let count = 0;
    f.web.executeJavaScriptInIsolatedWorld = async () => { count++; return execute(); };
    try {
      const result = await f.sender.send('result', 'https://chat.deepseek.com/a/chat/one');
      assert.equal(result.ok, false);
      assert.equal(result.uncertain, true);
      assert.match(result.error!, /不会重试/);
      assert.equal(count, 1);
    } finally { await f.sender.dispose(); }
  }
});

it('网页取消检查悬挂时有界结束并阻止后续结果，不能在未确认取消后继续发送', async () => {
  const f = fixture(); let count = 0;
  f.web.executeJavaScriptInIsolatedWorld = () => { count++; return new Promise(() => {}); };
  const sending = f.sender.send('result', 'https://chat.deepseek.com/a/chat/one');
  await Promise.resolve();
  await f.sender.cancel();
  const result = await sending;
  assert.equal(result.ok, false); assert.equal(result.uncertain, true);
  assert.match(result.error!, /取消状态未确认/);
  assert.equal((await f.sender.send('next', 'https://chat.deepseek.com/a/chat/one')).ok, false);
  assert.equal(count, 2);
  await f.sender.dispose();
});
