import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { it } from 'node:test';

function fixture() {
  const context = { root: 'project', path: 'notes/readme.md', revision: 1 };
  const reads: unknown[][] = [];
  let reply: (path: string, root: string) => Promise<object> = async () => ({ ok: true, kind: 'image', mimeType: 'image/png', bytes: new Uint8Array([1]) });
  const scope: any = { window: {} };
  vm.runInNewContext(fs.readFileSync('src/renderer/markdownImages.js', 'utf8'), scope);
  const read = scope.window.createMarkdownImageReader({ context: () => ({ ...context }), bridge: {
    readFilePreview: async (path: string, root: string) => { reads.push([path, root]); return reply(path, root); },
  } });
  return { context, reads, read: (source: string) => read(source, 'notes/readme.md'), reply(fn: typeof reply) { reply = fn; } };
}

it('Markdown 图片按文档所在目录解析并复用项目根校验入口', async () => {
  const f = fixture();
  assert.equal((await f.read('../images/%E5%9B%BE%20%E7%89%87.png#caption')).ok, true);
  assert.deepEqual(f.reads, [['images/图 片.png', 'project']]);
});

it('图片源不能触发外部资源、绝对路径或越界文件读取', async () => {
  const f = fixture();
  for (const source of ['https://example.com/image.png', '//host/x.png', 'C:\\file.png', '/x.png', '../../x.png', '%2fetc/x.png', '%00.png', '%broken']) {
    assert.equal((await f.read(source)).ok, false, source);
  }
  assert.equal(f.reads.length, 0);
});

it('切项目后再切回、切文件和非图片结果均不能被旧图片请求接纳', async () => {
  const f = fixture();
  f.reply(async () => { f.context.revision += 2; return { ok: true, kind: 'image' }; });
  assert.equal((await f.read('a.png')).ok, false);
  f.reply(async () => { f.context.path = 'other.md'; return { ok: true, kind: 'image' }; });
  assert.equal((await f.read('a.png')).ok, false);
  f.context.path = 'notes/readme.md';
  f.reply(async () => ({ ok: true, kind: 'pdf', bytes: new Uint8Array([1]) }));
  assert.equal((await f.read('a.pdf')).ok, false);
});
