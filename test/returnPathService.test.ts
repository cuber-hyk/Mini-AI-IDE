/** 真实临时文件验证明确操作、预览基线、冲突与受保护撤销；不允许猜测写盘目标。 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it, type TestContext } from 'node:test';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { parseModelReply, type ParsedCodeBlock } from '../src/shared/returnPath';
import { fenceFor } from '../src/shared/snippet';

function block(file: string, operation: '替换' | '新建' | '覆盖全文', body: string): ParsedCodeBlock {
  const fence = fenceFor(body);
  const parsed = parseModelReply(['### 文件：' + file, '### 操作：' + operation, fence, body, fence].join('\n')).blocks;
  assert.equal(parsed.length, 1); return parsed[0]!;
}
function pair(oldText: string, newText: string): string {
  return ['<<<<<<< SEARCH', oldText, '=======', newText, '>>>>>>> REPLACE'].join('\n');
}
async function fixture(t: TestContext, limit?: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-explicit-service-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new FileService(limit); files.setRoot(root); const service = new ReturnPathService(files);
  return { root, files, service,
    async write(file: string, text: string) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); },
    read(file: string) { return fs.readFile(path.join(root, file), 'utf8'); },
    async exists(file: string) { return fs.stat(path.join(root, file)).then(() => true, () => false); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

it('人工改路径重新核对同批冲突，不得将覆盖全文移到待替换文件', async t => {
  const f = await fixture(t); await f.write('a.txt', 'old'); await f.write('b.txt', 'other');
  const local = block('a.txt', '替换', pair('old', 'new'));
  const whole = block('b.txt', '覆盖全文', 'whole');
  assert.ok((await f.service.prepareBatch([local, whole])).every(result => result.ok));
  const moved = await f.service.prepareChange(whole, 'a.txt');
  assert.equal(moved.ok, false); if (!moved.ok) assert.equal(moved.reason, 'operation-conflict');
  assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: whole })).reason, 'operation-conflict');
  assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: local })).reason, 'operation-conflict');
  assert.equal(await f.read('a.txt'), 'old'); assert.equal(await f.read('b.txt'), 'other');
});
it('同批新建与替换不存在目标不能形成隐式生成依赖', async t => {
  const f = await fixture(t);
  const create = block('new.txt', '新建', 'created old');
  const dependent = block('new.txt', '替换', pair('created old', 'changed generated'));
  const batch = await f.service.prepareBatch([create, dependent]);
  assert.ok(batch.every(result => !result.ok && result.reason === 'operation-conflict'));
  for (const edit of [create, dependent]) assert.equal((await f.service.applyChange({ filePath: 'new.txt', block: edit })).ok, false);
  assert.equal(await f.exists('new.txt'), false);
});

it('首次不存在的 SEARCH 不得隐式依赖前一操作生成的内容', async t => {
  const f = await fixture(t); await f.write('a.txt', 'original');
  const first = block('a.txt', '替换', pair('original', 'generated'));
  const second = block('a.txt', '替换', pair('generated', 'dependent'));
  const batch = await f.service.prepareBatch([first, second]);
  assert.equal(batch[0]!.ok, true); assert.equal(batch[1]!.ok, false);
  assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: first })).ok, true);
  const pending = await f.service.prepareChange(second);
  assert.equal(pending.ok, false); if (!pending.ok) assert.equal(pending.reason, 'search-not-found');
  assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: second })).ok, false);
  assert.equal(await f.read('a.txt'), 'generated');
});
async function apply(f: Fixture, edit: ParsedCodeBlock, source?: { collectionId: string; index: number }, target = edit.filePath!) {
  const preview = await f.service.prepareChange(edit, target); assert.equal(preview.ok, true, JSON.stringify(preview));
  const result = await f.service.applyChange({ filePath: target, block: edit, ...(source ? { source } : {}) });
  assert.equal(result.ok, true, JSON.stringify(result)); return result;
}

it('新建预览零落盘，应用创建多级目录，撤销恢复不存在状态及精确操作身份', async t => {
  const f = await fixture(t); const edit = block('demo/backend/seed.ts', '新建', 'const seed = 1;');
  const preview = await f.service.prepareChange(edit); assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.fileExists, false); assert.equal(preview.before, ''); assert.equal(preview.after, edit.code);
  assert.deepEqual(await fs.readdir(f.root), []);
  const source = { collectionId: 'create', index: 2 };
  const result = await f.service.applyChange({ filePath: edit.filePath!, block: edit, source });
  assert.equal(result.ok, true); assert.equal(result.created, true); assert.equal(result.mode, 'create');
  assert.equal(await f.read(edit.filePath!), edit.code);
  assert.deepEqual(await f.service.undoLast(), { ok: true, filePath: edit.filePath, deleted: true, ...source });
  assert.deepEqual(await fs.readdir(f.root), []); assert.equal(f.service.undoCount, 0);
});
it('有效替换、新建和覆盖操作未预览不得应用，应用接口不能自行建立基线', async t => {
  const f = await fixture(t); await f.write('a.txt', 'original');
  for (const edit of [block('a.txt', '替换', pair('original', 'new')), block('a.txt', '覆盖全文', 'new'), block('new.txt', '新建', 'new')]) {
    assert.equal((await f.service.applyChange({ filePath: edit.filePath!, block: edit })).reason, 'preview-missing');
    assert.equal(f.service.getPrepared(edit, edit.filePath!), undefined);
  }
  assert.equal(await f.read('a.txt'), 'original'); assert.equal(await f.exists('new.txt'), false); assert.equal(f.service.undoCount, 0);
});
it('只读命令、上下文、缺少路径、缺少操作及旧行号格式不能被目标参数改成写入', async t => {
  const f = await fixture(t);
  const samples = [
    ['````bash\nnpm install\n````', 'read-only-content'],
    ['### 上下文文件：a.txt\n### 上下文：完整原文\n````\noriginal\n````', 'read-only-content'],
    ['### 操作：新建\n````\nnew\n````', 'metadata-invalid'],
    ['### 文件：a.txt\n````\nnew\n````', 'metadata-invalid'],
    ['### 文件：a.txt\n### 范围：1-1\n````\nnew\n````', 'metadata-invalid'],
  ];
  for (const [text, reason] of samples) {
    const edit = parseModelReply(text!).blocks[0]!;
    assert.equal((await f.service.prepareChange(edit, 'guess.txt')).ok, false);
    assert.equal((await f.service.applyChange({ filePath: 'guess.txt', block: edit })).reason, reason);
  }
  const missingPath = { ...block('a.txt', '新建', 'new'), filePath: null };
  assert.equal((await f.service.applyChange({ filePath: 'guess.txt', block: missingPath })).reason, 'path-missing');
  assert.deepEqual(await fs.readdir(f.root), []); assert.equal(f.service.undoCount, 0);
});
it('新建不能覆盖已有文件，替换和覆盖全文不能静默创建缺失目标', async t => {
  const f = await fixture(t); await f.write('a.txt', 'keep');
  const cases = [[block('a.txt', '新建', 'AI'), 'target-exists'], [block('missing.txt', '替换', pair('old', 'AI')), 'target-missing'], [block('missing.txt', '覆盖全文', 'AI'), 'target-missing']] as const;
  for (const [edit, reason] of cases) {
    const preview = await f.service.prepareChange(edit); assert.equal(preview.ok, false);
    assert.equal((await f.service.applyChange({ filePath: edit.filePath!, block: edit })).reason, reason);
  }
  assert.equal(await f.read('a.txt'), 'keep'); assert.equal(await f.exists('missing.txt'), false);
});
it('预览后同名新文件出现或已有目标消失时拒绝，不覆盖外部文件或重建目标', async t => {
  const f = await fixture(t); const created = block('new.txt', '新建', 'AI');
  assert.equal((await f.service.prepareChange(created)).ok, true); await f.write('new.txt', 'external');
  assert.equal((await f.service.applyChange({ filePath: 'new.txt', block: created })).reason, 'target-changed');
  assert.equal(await f.read('new.txt'), 'external');
  const overwritten = block('new.txt', '覆盖全文', 'AI'); assert.equal((await f.service.prepareChange(overwritten)).ok, true);
  await fs.unlink(path.join(f.root, 'new.txt'));
  assert.equal((await f.service.applyChange({ filePath: 'new.txt', block: overwritten })).reason, 'target-changed');
  assert.equal(await f.exists('new.txt'), false); assert.equal(f.service.undoCount, 0);
});
it('冻结完整原文基线：即使 SEARCH 仍唯一，预览之外的外部修改也拒绝更新或重预览', async t => {
  const f = await fixture(t); const original = 'head\nold\ntail'; await f.write('a.txt', original);
  const edits = [block('a.txt', '替换', pair('old', 'AI')), block('a.txt', '覆盖全文', 'full AI')];
  assert.ok((await f.service.prepareBatch(edits.slice(0, 1)))[0]!.ok);
  assert.equal((await f.service.prepareChange(edits[1]!)).ok, true);
  await f.write('a.txt', 'changed head\nold\ntail');
  for (const edit of edits) {
    const preview = await f.service.prepareChange(edit); assert.equal(preview.ok, false); if (!preview.ok) assert.equal(preview.reason, 'target-changed');
    assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: edit })).reason, 'target-changed');
  }
  assert.equal(await f.read('a.txt'), 'changed head\nold\ntail'); assert.equal(f.service.undoCount, 0);
});
it('新增后修改拒绝撤销，恢复原内容后仅清理本次创建且仍为空的目录', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'existing'));
  const edit = block('existing/new/file.txt', '新建', 'AI'); await apply(f, edit);
  await f.write(edit.filePath!, 'user content'); assert.equal((await f.service.undoLast()).ok, false); assert.equal(f.service.undoCount, 1);
  assert.equal(await f.read(edit.filePath!), 'user content'); await f.write(edit.filePath!, 'AI');
  await f.write('existing/new/keep.txt', 'keep'); assert.equal((await f.service.undoLast()).deleted, true);
  assert.equal(await f.read('existing/new/keep.txt'), 'keep'); assert.equal(await f.exists('existing'), true);
});
it('撤销新建核对对象身份，同名同内容外部重建不能删除，恢复对象后可撤销', async t => {
  const f = await fixture(t); const edit = block('new.txt', '新建', 'AI'); await apply(f, edit);
  await fs.rename(path.join(f.root, 'new.txt'), path.join(f.root, 'original.txt')); await f.write('new.txt', 'AI');
  const undo = await f.service.undoLast(); assert.equal(undo.ok, false); assert.match(undo.error ?? '', /同名文件替换/);
  assert.equal(f.service.undoCount, 1); assert.equal(await f.read('new.txt'), 'AI');
  await fs.unlink(path.join(f.root, 'new.txt')); await fs.rename(path.join(f.root, 'original.txt'), path.join(f.root, 'new.txt'));
  assert.equal((await f.service.undoLast()).deleted, true); assert.equal(f.service.undoCount, 0);
});
it('新增空文件撤销为不存在，覆盖已有空文件撤销仍保留空文件', async t => {
  const f = await fixture(t); const created = block('empty.txt', '新建', ''); await apply(f, created);
  assert.equal(await f.read('empty.txt'), ''); assert.equal((await f.service.undoLast()).deleted, true); assert.equal(await f.exists('empty.txt'), false);
  await f.write('empty.txt', ''); await apply(f, block('empty.txt', '覆盖全文', 'AI'));
  assert.equal((await f.service.undoLast()).deleted, undefined); assert.equal(await f.exists('empty.txt'), true); assert.equal(await f.read('empty.txt'), '');
  await apply(f, block('empty.txt', '覆盖全文', '')); assert.equal(await f.read('empty.txt'), '');
});
it('目录目标、越界路径与链接越界不能伪装为缺失文件', async t => {
  const f = await fixture(t); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-explicit-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(f.root, 'directory')); await fs.symlink(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const file of ['directory', '../outside.txt', 'linked/new.txt']) {
    const edit = block(file, '新建', 'AI'); assert.equal((await f.service.prepareChange(edit)).ok, false);
    assert.equal((await f.service.applyChange({ filePath: file, block: edit })).ok, false);
  }
  assert.deepEqual(await fs.readdir(outside), []); assert.equal(f.service.undoCount, 0);
});
it('超限新建及替换后的完整文件超限不写盘，读取超限也不能降级创建', async t => {
  const f = await fixture(t, 3); await f.write('a.txt', 'old'); await f.write('large.txt', 'long original');
  for (const edit of [block('new.txt', '新建', 'long'), block('a.txt', '替换', pair('old', 'long')), block('large.txt', '覆盖全文', 'AI')]) {
    assert.equal((await f.service.prepareChange(edit)).ok, false);
    assert.equal((await f.service.applyChange({ filePath: edit.filePath!, block: edit })).ok, false);
  }
  assert.equal(await f.read('a.txt'), 'old'); assert.equal(await f.exists('new.txt'), false); assert.equal(f.service.undoCount, 0);
});
it('绝对目标按根目录内相对路径记录，改名失效不会漏掉撤销快照', async t => {
  const f = await fixture(t); await f.write('a.txt', 'original'); const absolute = path.join(f.root, 'a.txt');
  const result = await apply(f, block('a.txt', '覆盖全文', 'AI'), undefined, absolute); assert.equal(result.filePath, 'a.txt');
  assert.deepEqual(f.service.describeSnapshots().map(s => s.relPath), ['a.txt']);
  await fs.rename(absolute, path.join(f.root, 'renamed.txt')); f.service.invalidate('a.txt', false);
  assert.equal(f.service.undoCount, 0); assert.equal((await f.service.undoLast()).ok, false); assert.equal(await f.read('renamed.txt'), 'AI');
});
it('用户后续保存不能被旧 AI 撤销覆盖，失败保留撤销机会', async t => {
  const f = await fixture(t); await f.write('a.txt', 'original'); await apply(f, block('a.txt', '替换', pair('original', 'AI')));
  assert.equal((await f.files.writeFile('a.txt', 'user saved')).ok, true);
  assert.equal((await f.service.undoLast()).ok, false); assert.equal(f.service.undoCount, 1); assert.equal(await f.read('a.txt'), 'user saved');
});
it('同名目标不允许跨根目录应用或撤销，目录失效只清理指定子树记录', async t => {
  const f = await fixture(t); await f.write('A/a.txt', 'A'); await f.write('A/sub/b.txt', 'A-sub'); await f.write('B/a.txt', 'B');
  f.files.setRoot(path.join(f.root, 'A'));
  for (const file of ['a.txt', 'sub/b.txt']) await apply(f, block(file, '覆盖全文', 'updated'));
  f.service.invalidate('sub', true); assert.equal(f.service.undoCount, 1); assert.deepEqual(f.service.describeSnapshots().map(s => s.relPath), ['a.txt']);
  const pending = block('a.txt', '覆盖全文', 'next'); assert.equal((await f.service.prepareChange(pending)).ok, true);
  f.files.setRoot(path.join(f.root, 'B'));
  assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: pending })).reason, 'target-changed');
  assert.equal((await f.service.undoLast()).ok, false); assert.equal(await f.read('B/a.txt'), 'B');
  f.service.clear(); assert.equal(f.service.undoCount, 0); assert.equal(f.service.getPrepared(pending, 'a.txt'), undefined);
});
it('同文件不同操作及不同批次撤销返回精确身份，重复应用不得写盘', async t => {
  const f = await fixture(t); await f.write('a.txt', 'original');
  const sources = [{ collectionId: 'first', index: 0 }, { collectionId: 'first', index: 1 }, { collectionId: 'second', index: 0 }];
  for (const source of sources) {
    const edit = block('a.txt', '覆盖全文', source.collectionId + '-' + source.index); await apply(f, edit, source);
    assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: edit })).reason, 'already-applied');
  }
  for (const source of [...sources].reverse()) assert.deepEqual(await f.service.undoLast(), { ok: true, filePath: 'a.txt', ...source });
  assert.equal(await f.read('a.txt'), 'original'); assert.equal(f.service.undoCount, 0);
});
it('同文件不重叠替换随自身新增行自动重新定位，预览与落盘一致，按身份逐项撤销', async t => {
  const f = await fixture(t); const original = 'head\nfirst\nseparator\nsecond\ntail'; await f.write('a.txt', original);
  const first = block('a.txt', '替换', pair('first', 'one\ntwo\nthree')); const second = block('a.txt', '替换', pair('second', 'last'));
  assert.ok((await f.service.prepareBatch([first, second])).every(result => result.ok));
  assert.equal(f.service.getPrepared(second, 'a.txt')!.locations[0]!.oldRange!.start, 4);
  const firstSource = { collectionId: 'batch', index: 0 }; const secondSource = { collectionId: 'batch', index: 1 };
  assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: first, source: firstSource })).ok, true);
  const next = await f.service.prepareChange(second); assert.equal(next.ok, true);
  if (!next.ok) return;
  assert.equal(next.locations[0]!.oldRange!.start, 6); assert.equal(next.after, 'head\none\ntwo\nthree\nseparator\nlast\ntail');
  assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: second, source: secondSource })).ok, true); assert.equal(await f.read('a.txt'), next.after);
  assert.deepEqual(await f.service.undoLast(), { ok: true, filePath: 'a.txt', ...secondSource });
  assert.deepEqual(await f.service.undoLast(), { ok: true, filePath: 'a.txt', ...firstSource });
  assert.equal(await f.read('a.txt'), original);
});
it('0 或多个原文匹配不落盘，同块多对中的一个失败也不能部分成功', async t => {
  const f = await fixture(t); const original = 'duplicate\nduplicate\nunique'; await f.write('a.txt', original);
  for (const [body, reason] of [[pair('missing', 'AI'), 'search-not-found'], [pair('duplicate', 'AI'), 'search-ambiguous'], [pair('unique', 'AI') + '\n' + pair('missing', 'new'), 'search-not-found'], [pair('unique', 'generated') + '\n' + pair('generated', 'AI'), 'search-not-found']]) {
    const edit = block('a.txt', '替换', body!); const preview = await f.service.prepareChange(edit); assert.equal(preview.ok, false);
    assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: edit })).reason, reason);
    assert.equal(await f.read('a.txt'), original); assert.equal(f.service.undoCount, 0);
  }
});
for (const conflict of ['overlap', 'overwrite', 'duplicate-create'] as const) {
  it('同文件 ' + conflict + ' 冲突均拒绝，独立文件仍可应用', async t => {
    const f = await fixture(t); await f.write('a.txt', 'abcdef'); await f.write('b.txt', 'independent');
    const edits = conflict === 'duplicate-create' ? [block('new.txt', '新建', 'A'), block('new.txt', '新建', 'B')]
      : conflict === 'overwrite' ? [block('a.txt', '覆盖全文', 'A'), block('a.txt', '替换', pair('abc', 'B'))]
      : [block('a.txt', '替换', pair('abcd', 'A')), block('a.txt', '替换', pair('cdef', 'B'))];
    const independent = block('b.txt', '替换', pair('independent', 'updated'));
    const prepared = await f.service.prepareBatch([...edits, independent]);
    assert.equal(prepared[0]!.ok, false); assert.equal(prepared[1]!.ok, false); assert.equal(prepared[2]!.ok, true);
    for (const edit of edits) assert.equal((await f.service.applyChange({ filePath: edit.filePath!, block: edit })).reason, 'operation-conflict');
    assert.equal((await f.service.applyChange({ filePath: 'b.txt', block: independent })).ok, true);
    assert.equal(await f.read('a.txt'), 'abcdef'); assert.equal(await f.exists('new.txt'), false); assert.equal(await f.read('b.txt'), 'updated');
  });
}
it('修改目标路径必须先预览新目标，不得复用原目标的准备结果', async t => {
  const f = await fixture(t); await f.write('a.txt', 'original A'); await f.write('b.txt', 'original B');
  const edit = block('a.txt', '覆盖全文', 'AI'); assert.equal((await f.service.prepareChange(edit)).ok, true);
  assert.equal((await f.service.applyChange({ filePath: 'b.txt', block: edit })).reason, 'preview-missing');
  assert.equal(await f.read('b.txt'), 'original B');
  const preview = await f.service.prepareChange(edit, 'b.txt'); assert.equal(preview.ok, true);
  assert.equal((await f.service.applyChange({ filePath: 'b.txt', block: edit })).ok, true);
  assert.equal(await f.read('a.txt'), 'original A'); assert.equal(await f.read('b.txt'), 'AI');
});
it('自身应用使剩余 SEARCH 多次匹配时仍保持已知基线，外部修改不能被重新准备洗掉', async t => {
  const f = await fixture(t); await f.write('a.txt', 'top\ntarget');
  const first = block('a.txt', '替换', pair('top', 'target')); const second = block('a.txt', '替换', pair('target', 'new'));
  assert.ok((await f.service.prepareBatch([first, second])).every(result => result.ok));
  assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: first })).ok, true);
  const invalid = await f.service.prepareChange(second); assert.equal(invalid.ok, false); if (!invalid.ok) assert.equal(invalid.reason, 'search-ambiguous');
  assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: second })).reason, 'search-ambiguous');
  await f.write('a.txt', 'external\ntarget');
  const changed = await f.service.prepareChange(second); assert.equal(changed.ok, false); if (!changed.ok) assert.equal(changed.reason, 'target-changed');
  assert.equal((await f.service.applyChange({ filePath: 'a.txt', block: second })).reason, 'target-changed'); assert.equal(await f.read('a.txt'), 'external\ntarget');
});
it('多对修改一次写盘与撤销，保留缩进、Unicode、CRLF 与未修改文本', async t => {
  const f = await fixture(t); const original = '\tconst first = 1;  \r\nconst 中文 = 2;\r\nTAIL'; await f.write('a.ts', original);
  const edit = block('a.ts', '替换', pair('\tconst first = 1;  ', '\tconst first = 3;  \n追加') + '\n' + pair('中文 = 2', '中文 = 4'));
  const result = await apply(f, edit); assert.equal(result.after, '\tconst first = 3;  \r\n追加\r\nconst 中文 = 4;\r\nTAIL');
  assert.equal(await f.read('a.ts'), result.after); assert.equal(f.service.undoCount, 1);
  assert.equal((await f.service.undoLast()).ok, true); assert.equal(await f.read('a.ts'), original);
});
