import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import { WebComposerSender, COMPOSER_SEND_WORLD } from '../src/main/webComposerSender';

function fixture(url = 'https://chatgpt.com/c/current') {
  const web = new EventEmitter() as any;
  const scripts: string[] = [];
  web.getURL = () => url;
  web.isDestroyed = () => false;
  web.executeJavaScriptInIsolatedWorld = async (world: number, entries: { code: string }[]) => {
    assert.equal(world, COMPOSER_SEND_WORLD);
    scripts.push(entries[0]!.code);
    return { ok: true };
  };
  return { web, scripts, sender: new WebComposerSender(web) };
}

it('ChatGPT 受控发送只接纳官方普通对话，特殊界面和相似域名不能获得写入', async () => {
  for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/c/abc-123?tracking=1']) {
    const f = fixture(url);
    try { assert.equal((await f.sender.send('text', url.split('?')[0]!)).ok, true); assert.equal(f.scripts.length, 1); }
    finally { await f.sender.dispose(); }
  }
  for (const url of ['https://chatgpt.com/g/custom', 'https://chatgpt.com/g/custom/c/abc', 'https://chatgpt.com/project/abc', 'https://chatgpt.com/c/', 'https://chatgpt.com.evil.test/c/abc', 'http://chatgpt.com/c/abc', 'https://chatgpt.com:444/c/abc', 'https://name@chatgpt.com/c/abc']) {
    const f = fixture(url);
    try { assert.equal((await f.sender.send('text', url)).ok, false); assert.equal(f.scripts.length, 0); }
    finally { await f.sender.dispose(); }
  }
});

it('ChatGPT 附件明确拒绝且不启动stream或安装附件脚本，不能静默漏传', async () => {
  for (const kind of ['prompt', 'results'] as const) {
    const f = fixture(); let reads = 0;
    try {
      const result = await f.sender.send('read attachment', 'https://chatgpt.com/c/current', kind, () => true, [{ id: '1', name: 'brief.pdf', size: 1, mediaType: 'application/pdf', async *stream() { reads++; yield new Uint8Array([1]); } }]);
      assert.equal(result.ok, false); assert.match(result.error!, /仅支持纯文本/);
      assert.equal(reads, 0); assert.equal(f.scripts.length, 0);
    } finally { await f.sender.dispose(); }
  }
});

it('ChatGPT 取消与发送同一时刻发生时不安装写入脚本', async () => {
  const f = fixture();
  try {
    const sending = f.sender.send('text', 'https://chatgpt.com/c/current');
    await f.sender.cancel();
    assert.equal((await sending).ok, false); assert.equal(f.scripts.length, 0);
  } finally { await f.sender.dispose(); }
});
