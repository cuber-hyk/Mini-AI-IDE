import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { it } from 'node:test';

const path = '.mini-ai-ide/composer-drafts/2026-10-13-draft.txt';
function fixture() {
  let root: string | null = 'A'; let revision = 1;
  let receive!: (event: any) => Promise<void>;
  let open: any = async () => true;
  const opens: any[] = []; const infos: any[] = [];
  const context: any = { window: {} };
  vm.runInNewContext(fs.readFileSync('src/renderer/composerDraftFeedback.js', 'utf8'), context);
  context.window.setupComposerDraftFeedback({
    bridge: { onComposerDraftSaved(fn: typeof receive) { receive = fn; } },
    getRoot: () => root, getRevision: () => revision,
    setInfo(text: string, warn?: boolean) { infos.push({ text, warn }); },
    openFile(...args: any[]) { opens.push(JSON.parse(JSON.stringify(args))); return open(...args); },
  });
  return { receive, opens, infos, event: (relPath = path) => ({ root, revision, relPath }),
    scope(next: string | null, version: number) { root = next; revision = version; },
    opening(fn: any) { open = fn; } };
}

it('只有新保存事件打开真实备份一次，不抢焦点并恢复文件正文，重复通知不切标签', async () => {
  const f = fixture();
  assert.equal(f.opens.length, 0, '启动不查询或重放历史备份');
  let finish!: (ok: boolean) => void;
  f.opening(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.receive(f.event());
  assert.deepEqual(f.opens, [[path, { focus: false, reveal: true }]]);
  assert.equal(f.infos[0].text, '网页草稿已保存，工具结果回传继续');
  await f.receive(f.event()); assert.equal(f.opens.length, 1, '打开过程中也去重');
  finish(true); await pending;
  assert.equal(f.infos.at(-1).text, '网页草稿已保存，已打开备份：' + path);
  await f.receive(f.event()); assert.equal(f.opens.length, 1);
});

it('拒绝其他项目、旧版本及非专用单个TXT路径，不产生提示或读取', async () => {
  const f = fixture();
  for (const event of [null, {}, { ...f.event(), root: 'B' }, { ...f.event(), revision: 0 }, { ...f.event(), revision: '1' }]) await f.receive(event);
  for (const relPath of ['/tmp/draft.txt', 'C:/draft.txt', '.mini-ai-ide/composer-drafts/../a.txt',
    '.mini-ai-ide/composer-drafts/nested/a.txt', '.mini-ai-ide/composer-drafts/a.js',
    '.mini-ai-ide\\composer-drafts\\a.txt', '.mini-ai-ide/composer-drafts/a:stream.txt']) await f.receive(f.event(relPath));
  assert.equal(f.opens.length, 0); assert.equal(f.infos.length, 0);
  f.scope('B', 2); await f.receive(f.event()); assert.equal(f.opens.length, 1);
});

it('文件打开失败仍保留保存事实及路径，不抛错，也不自动重试', async () => {
  for (const open of [async () => false, async () => { throw new Error('read failed'); }]) {
    const f = fixture(); f.opening(open);
    await f.receive(f.event());
    assert.equal(f.infos.at(-1).text, '网页草稿已保存，打开备份失败，请从文件区查看：' + path);
    assert.equal(f.infos.at(-1).warn, true);
    await f.receive(f.event()); assert.equal(f.opens.length, 1);
  }
});

it('延迟打开结束后切项目或更新版本，不把旧提示写入新项目', async () => {
  for (const next of [['B', 2], ['A', 2]] as const) {
    const f = fixture(); let finish!: (ok: boolean) => void;
    f.opening(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.receive(f.event()); f.scope(next[0], next[1]); finish(true); await pending;
    assert.equal(f.infos.length, 1);
    f.opening(async () => true); await f.receive(f.event());
    assert.equal(f.opens.length, 2, '新项目版本有独立通知范围');
  }
});

it('两份新备份并发到达，迟到打开失败不覆盖最新保存提示', async () => {
  const f = fixture(); let finish!: (ok: boolean) => void;
  f.opening(() => new Promise(resolve => { finish = resolve; }));
  const first = f.receive(f.event());
  const secondPath = '.mini-ai-ide/composer-drafts/next.txt';
  f.opening(async () => true); await f.receive(f.event(secondPath));
  finish(false); await first;
  assert.equal(f.infos.at(-1).text, '网页草稿已保存，已打开备份：' + secondPath);
});
