import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import { WebComposerSender, COMPOSER_SEND_WORLD } from '../src/main/webComposerSender';

function fixture(url = 'https://chatgpt.com/c/current', backupDraft?: (text: string, session: string) => Promise<string>, draftSaved?: (path: string) => void) {
  const web = new EventEmitter() as any;
  const scripts: string[] = [];
  web.getURL = () => url;
  web.isDestroyed = () => false;
  web.executeJavaScriptInIsolatedWorld = async (world: number, entries: { code: string }[]) => {
    assert.equal(world, COMPOSER_SEND_WORLD);
    scripts.push(entries[0]!.code);
    return { ok: true };
  };
  return { web, scripts, sender: new WebComposerSender(web, { backupDraft, draftSaved }) };
}

it('保存通知在成功落盘后、覆盖前一次发生，通知异常不能使运输失败或重试', async () => {
  for (const throws of [false, true]) {
    const events: string[] = [];
    const savedPath = '/project/.mini-ai-ide/composer-drafts/one.txt';
    const f = fixture(undefined, async () => { events.push('saved'); return savedPath; }, path => {
      assert.equal(path, savedPath); assert.deepEqual(events, ['saved']); events.push('notified');
      if (throws) throw new Error('editor unavailable');
    });
    f.web.executeJavaScriptInIsolatedWorld = async (_world: number, entries: { code: string }[]) => {
      f.scripts.push(entries[0]!.code);
      if (entries[0]!.code.includes('return state.resume();')) { events.push('resume'); return { ok: true }; }
      return { ok: true, draftText: 'draft' };
    };
    assert.equal((await f.sender.send('result', 'https://chatgpt.com/c/current')).ok, true);
    assert.deepEqual(events, ['saved', 'notified', 'resume']); assert.equal(f.scripts.length, 2);
    await f.sender.dispose();
  }
});

it('失败、空输入和保存后失效不通知编辑器打开历史备份', async () => {
  for (const mode of ['failed', 'empty', 'invalidated']) {
    let current = true; let notified = 0;
    const f = fixture(undefined, async () => {
      if (mode === 'failed') throw Error('disk full');
      if (mode === 'invalidated') current = false;
      return '/project/.mini-ai-ide/composer-drafts/one.txt';
    }, () => { notified++; });
    f.web.executeJavaScriptInIsolatedWorld = async (_world: number, entries: { code: string }[]) => {
      f.scripts.push(entries[0]!.code);
      return mode === 'empty' ? { ok: true } : { ok: true, draftText: 'draft' };
    };
    const result = await f.sender.send('result', 'https://chatgpt.com/c/current', 'results', () => current);
    assert.equal(result.ok, mode === 'empty'); assert.equal(notified, 0);
    await f.sender.dispose();
  }
});

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

it('当前工具结果必须先保存完整草稿，成功后才恢复一次发送，并反馈备份位置', async () => {
  let saved = false;
  const f = fixture(undefined, async (text, session) => {
    assert.equal(text, ' 用户草稿\n\n末行 '); assert.equal(session, 'https://chatgpt.com/c/current');
    assert.equal(f.scripts.length, 1); saved = true; return '/project/.mini-ai-ide/composer-drafts/one.txt';
  });
  f.web.executeJavaScriptInIsolatedWorld = async (_world: number, entries: { code: string }[]) => {
    const code = entries[0]!.code; f.scripts.push(code);
    if (code.includes('return state.resume();')) { assert.equal(saved, true); return { ok: true }; }
    return { ok: true, draftText: ' 用户草稿\n\n末行 ' };
  };
  const result = await f.sender.send('result', 'https://chatgpt.com/c/current');
  assert.equal(result.ok, true); assert.equal(result.draftBackupPath, '/project/.mini-ai-ide/composer-drafts/one.txt');
  assert.equal(f.scripts.length, 2); await f.sender.dispose();
});

it('备份失败或保存期间当前批次失效均不得恢复发送', async () => {
  for (const failure of ['disk', 'scope']) {
    let current = true;
    const f = fixture(undefined, async () => {
      if (failure === 'disk') throw new Error('disk full');
      current = false; return '/backup.txt';
    });
    f.web.executeJavaScriptInIsolatedWorld = async (_world: number, entries: { code: string }[]) => {
      const code = entries[0]!.code; f.scripts.push(code);
      assert.ok(!code.includes('return state.resume();'));
      return code.includes('state.cancel();') ? { ok: false, error: 'cancelled' } : { ok: true, draftText: 'draft' };
    };
    const result = await f.sender.send('result', 'https://chatgpt.com/c/current', 'results', () => current);
    assert.equal(result.ok, false); assert.match(result.error!, /未覆盖/);
    assert.equal(f.scripts.length, 2); await f.sender.dispose();
  }
});

it('草稿备份挂起期间取消不会等待磁盘或继续发送，迟到备份也不复活旧批', async () => {
  let saved!: (path: string) => void;
  let capturing!: () => void;
  const captured = new Promise<void>(resolve => { capturing = resolve; });
  const f = fixture(undefined, () => { capturing(); return new Promise(resolve => { saved = resolve; }); });
  f.web.executeJavaScriptInIsolatedWorld = async (_world: number, entries: { code: string }[]) => {
    const code = entries[0]!.code; f.scripts.push(code);
    assert.ok(!code.includes('return state.resume();'));
    return code.includes('state.cancel();') ? { ok: false, error: 'cancelled' } : { ok: true, draftText: 'draft' };
  };
  const sending = f.sender.send('result', 'https://chatgpt.com/c/current');
  await captured; await f.sender.cancel(); assert.equal((await sending).ok, false);
  saved('/late-backup.txt'); await Promise.resolve(); assert.equal(f.scripts.length, 2);
  await f.sender.dispose();
});

it('本地主动需求即使有备份服务也没有覆盖草稿资格', async () => {
  let reads = 0;
  const f = fixture(undefined, async () => { reads++; return '/backup.txt'; });
  assert.equal((await f.sender.send('prompt', 'https://chatgpt.com/c/current', 'prompt')).ok, true);
  assert.equal(reads, 0); assert.ok(f.scripts[0]!.includes('!false'));
  await f.sender.dispose();
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
