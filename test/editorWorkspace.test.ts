import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { it } from 'node:test';
import { filePreviewKind } from '../src/shared/filePreview';

it('批准丢弃 B 后读取 C，磁盘 C 同步为编辑器 C 并清除 dirty；停止保留 B', async () => {
  const f = await fixture(); f.state.currentText = 'B'; f.workspace.report();
  f.readLater(async () => ({ ok: true, text: 'C' }));
  assert.equal(await f.workspace.reload('a.txt', false, false), false);
  assert.equal(f.state.currentText, 'B');
  assert.equal(await f.workspace.reload('a.txt', false, false, true), true);
  assert.equal(f.state.currentText, 'C'); assert.equal(f.state.savedText, 'C');
  assert.equal(f.report().documents[0].dirty, false); assert.equal(f.writes.length, 0);
});

async function fixture(path = 'a.txt') {
  const state = { root: 'A', currentPath: null as string | null, currentKind: null as string | null, currentText: '', savedText: '' };
  let leave = true; let write = true; let writeLater: any; let read: any = async () => ({ ok: true, text: 'saved', encoding: 'utf8' });
  let report: any; let reports = 0; let shown: any; let tabs: any; let focus: any; const writes: any[] = []; const disposed: any[] = [];
  let previewRead: any = async () => ({ ok: true, kind: 'image', bytes: new Uint8Array([1]), mimeType: 'image/png' });
  const bridge = { reportEditorState(value: any) { report = value; reports++; }, confirmLeave: async () => ({ ok: leave }), readFile: (...args: any[]) => read(...args),
    readFilePreview: (...args: any[]) => previewRead(...args),
    writeFile: async (...args: any[]) => { writes.push(args); return writeLater ? writeLater(...args) : { ok: write }; }, onEditorRequest() {}, editorReply: async () => ({ ok: true }) };
  const context: any = { window: {} }; vm.runInNewContext(fs.readFileSync('src/renderer/editorWorkspace.js', 'utf8'), context);
  const workspace = context.window.createEditorWorkspace({ state, bridge, ready: async () => {}, kindForPath: filePreviewKind,
    changed() { workspace.report(); }, highlight() {}, setInfo() {}, renderTabs(value: any) { tabs = value; }, captureViewState() { return { cursor: 8 }; },
    createModel(path: string, text: string) { return { path, text }; }, showDocument(doc: any, requestedFocus: boolean) { shown = doc; focus = requestedFocus; },
    disposeModel(model: any) { disposed.push(model); }, renameModel() {}, replaceContent(doc: any, text: string) { if (doc.model) doc.model.text = text; } });
  await workspace.open(path); state.currentText = 'draft'; workspace.report();
  return { state, workspace, writes, disposed, shown: () => shown, focus: () => focus, report: () => report, reportCount: () => reports, tabs: () => tabs,
    cancel() { leave = false; }, allow() { leave = true; }, failSave() { write = false; }, writeLater(fn: any) { writeLater = fn; }, readLater(fn: any) { read = fn; }, previewLater(fn: any) { previewRead = fn; } };
}

it('自动打开备份不聚焦且保留原脏缓冲模型与视图，普通打开仍聚焦', async () => {
  const f = await fixture(); const original = f.shown();
  assert.equal(f.focus(), true);
  f.state.currentText = 'unsaved original';
  f.readLater(async () => ({ ok: true, text: 'web draft', encoding: 'utf8' }));
  assert.equal(await f.workspace.open('.mini-ai-ide/composer-drafts/backup.txt', false), true);
  assert.equal(f.focus(), false); assert.equal(f.state.currentText, 'web draft');
  assert.equal(f.report().documents.find((doc: any) => doc.path === 'a.txt').dirty, true);
  assert.equal(original.text, 'unsaved original'); assert.equal(original.viewState.cursor, 8);
  assert.equal(f.disposed.length, 0); assert.equal(f.writes.length, 0);
  await f.workspace.open('a.txt');
  assert.equal(f.focus(), true); assert.equal(f.shown(), original); assert.equal(f.state.currentText, 'unsaved original');
  await f.workspace.open('a.txt', false); assert.equal(f.focus(), false, '已打开标签也遵守无焦点请求');
});

async function typingFixture() {
  const f = await fixture();
  f.state.currentText = 'saved'; f.workspace.report();
  const model = f.shown().model;
  model.text = 'saved';
  let reads = 0;
  model.getValue = () => { reads++; return model.text; };
  model.getValueLength = () => model.text.length;
  return { ...f, model, reads: () => reads, edit(text: string) { model.text = text; f.workspace.contentChanged(model); } };
}

it('首次输入立即保护草稿，连续追加不读取全文、不反复报告全部标签；按需快照始终最新', async () => {
  const f = await typingFixture(); const reports = f.reportCount();
  for (let i = 0; i < 100; i++) {
    f.edit('saved' + 'x'.repeat(i + 1));
    assert.equal(f.workspace.isDirty(), true);
    assert.equal(f.report().documents[0].dirty, true);
  }
  assert.equal(f.reads(), 0); assert.equal(f.reportCount() - reports, 1);
  assert.equal(f.state.currentText, 'saved' + 'x'.repeat(100)); assert.equal(f.reads(), 1);
  assert.equal(f.state.currentText, f.model.text); assert.equal(f.reads(), 1);
  assert.equal(await f.workspace.save(), true); assert.equal(f.writes[0][1], f.model.text);
  assert.equal(f.workspace.isDirty(), false); assert.equal(f.reportCount() - reports, 2);
});

it('等长替换仍按真实全文比较，撤销及手工还原立即清除未保存标记', async () => {
  const f = await typingFixture(); const reports = f.reportCount();
  f.edit('sXved'); assert.equal(f.workspace.isDirty(), true); assert.equal(f.reads(), 1);
  f.edit('saved'); assert.equal(f.workspace.isDirty(), false); assert.equal(f.reads(), 2);
  f.edit('saved plus'); assert.equal(f.workspace.isDirty(), true); assert.equal(f.reads(), 2);
  f.edit('saved'); assert.equal(f.workspace.isDirty(), false); assert.equal(f.reads(), 3);
  assert.equal(f.reportCount() - reports, 4);
});

it('保存中的继续输入保留真实最新文本和脏状态，关闭确认与切换不会丢失惰性快照', async () => {
  const f = await typingFixture(); let finish: any;
  f.edit('saved first'); f.writeLater(() => new Promise(resolve => { finish = resolve; }));
  const saving = f.workspace.save(); f.edit('saved first second'); finish({ ok: true });
  assert.equal(await saving, false); assert.equal(f.state.savedText, 'saved first');
  assert.equal(f.workspace.isDirty(), true); assert.equal(f.state.currentText, 'saved first second');
  f.edit('latest before close'); f.cancel();
  assert.equal(await f.workspace.close('a.txt'), false); assert.equal(f.state.currentText, 'latest before close');
  f.edit('latest before switch'); await f.workspace.open('b.txt'); await f.workspace.open('a.txt');
  assert.equal(f.state.currentText, 'latest before switch'); assert.equal(f.workspace.isDirty(), true);
});

it('异步外部重载拒绝覆盖期间的真实输入，切项目后旧模型事件不能重新产生草稿', async () => {
  const f = await typingFixture(); let finish: any;
  f.readLater(() => new Promise(resolve => { finish = resolve; }));
  const reload = f.workspace.reload('a.txt', false, false);
  await new Promise(resolve => setImmediate(resolve));
  f.edit('typed during reload'); finish({ ok: true, text: 'external' });
  assert.equal(await reload, false); assert.equal(f.state.currentText, 'typed during reload');
  f.state.root = 'B'; f.workspace.clear(); f.edit('stale model event');
  assert.equal(f.state.currentText, ''); assert.equal(f.workspace.isDirty(), false);
  assert.equal(f.report().root, 'B'); assert.equal(f.report().documents.length, 0);
});

it('附件与文本共用标签，预览不产生脏状态或保存写入，返回时保留文本草稿', async () => {
  const f = await fixture(); const draft = f.shown();
  await f.workspace.open('photo.PNG');
  assert.equal(f.shown().kind, 'image'); assert.equal(f.shown().model, null);
  assert.equal(f.state.currentKind, 'image');
  f.state.currentText = 'unexpected editor event'; f.workspace.report();
  assert.equal(f.report().documents[1].dirty, false);
  assert.equal(await f.workspace.save(), true); assert.equal(f.writes.length, 0);
  await f.workspace.open('a.txt'); assert.equal(f.state.currentText, 'draft'); assert.equal(f.shown(), draft);
  assert.equal(f.state.currentKind, null);
  assert.equal(f.report().documents[0].dirty, true);
});
it('延迟二进制读取不能覆盖后选文本或切换后的项目', async () => {
  const f = await fixture(); let finish: any;
  f.previewLater(() => new Promise(resolve => { finish = resolve; }));
  const first = f.workspace.open('old.pdf'); await new Promise(resolve => setImmediate(resolve));
  await f.workspace.open('a.txt'); finish({ ok: true, bytes: new Uint8Array([1]) });
  assert.equal(await first, false); assert.equal(f.state.currentPath, 'a.txt');
  const second = f.workspace.open('old.pdf'); await new Promise(resolve => setImmediate(resolve));
  f.state.root = 'B'; f.workspace.clear(); finish({ ok: true, bytes: new Uint8Array([2]) });
  assert.equal(await second, false); assert.equal(f.tabs().length, 0);
});
it('预览改名与删除更新同一标签并释放二进制引用，不触碰其他草稿', async () => {
  const f = await fixture(); await f.workspace.open('photo.png'); const doc = f.shown();
  f.workspace.entryChanged({ kind: 'renamed', oldRelPath: 'photo.png', relPath: 'new.png', isDirectory: false });
  assert.equal(f.state.currentPath, 'new.png'); await f.workspace.open('new.png'); assert.equal(f.shown(), doc);
  await f.workspace.reload('new.png', false, false); assert.equal(f.shown().kind, 'image');
  f.workspace.entryChanged({ kind: 'deleted', oldRelPath: 'new.png', isDirectory: false });
  assert.equal(doc.preview, null); assert.equal(f.state.currentText, 'draft'); assert.equal(f.disposed.length, 0);
});
it('损坏或不支持的附件保留只读错误标签，允许系统打开且不读写文本', async () => {
  const f = await fixture(); f.readLater(() => { throw new Error('不应走文本读取'); });
  f.previewLater(async () => ({ ok: false, error: '文件损坏' }));
  assert.equal(await f.workspace.open('broken.docx'), true); assert.equal(f.shown().preview.error, '文件损坏');
  assert.equal(await f.workspace.open('old.doc'), true); assert.equal(f.shown().kind, 'unsupported');
  assert.equal(await f.workspace.save(), true); assert.equal(f.writes.length, 0);
});

it('附件改名跨类型关闭旧只读呈现，再打开按新类型读取，文本草稿保持可编辑', async () => {
  const f = await fixture(); await f.workspace.open('wrong.doc'); const old = f.shown();
  f.workspace.entryChanged({ kind: 'renamed', oldRelPath: 'wrong.doc', relPath: 'correct.docx', isDirectory: false });
  assert.equal(f.state.currentPath, 'a.txt'); assert.equal(f.state.currentText, 'draft');
  assert.equal(f.tabs().length, 1); assert.equal(old.preview, null);
  await f.workspace.open('correct.docx'); assert.equal(f.shown().kind, 'docx');
  f.workspace.entryChanged({ kind: 'renamed', oldRelPath: 'a.txt', relPath: 'draft.pdf', isDirectory: false });
  await f.workspace.open('draft.pdf'); assert.equal(f.shown().kind, null); assert.equal(f.state.currentText, 'draft');
});
it('切换已打开标签保留草稿、独立模型和视图状态，重复打开不新增标签', async () => {
  const f = await fixture(); const first = f.shown(); f.cancel();
  assert.equal(await f.workspace.open('b.txt'), true); const second = f.shown();
  f.state.currentText = 'draft B'; await f.workspace.open('a.txt');
  assert.equal(f.state.currentText, 'draft'); assert.equal(f.shown(), first); assert.equal(first.viewState.cursor, 8);
  assert.notEqual(first.model, second.model); assert.equal(f.report().documents.length, 2);
  await f.workspace.open('b.txt'); assert.equal(f.state.currentText, 'draft B');
});
it('关闭脏标签取消或保存失败保留所有草稿，放弃只关闭目标', async () => {
  const f = await fixture(); await f.workspace.open('b.txt'); f.cancel();
  assert.equal(await f.workspace.close('a.txt'), false); assert.equal(f.report().documents.length, 2);
  f.failSave(); assert.equal(await f.workspace.save('a.txt'), false); assert.equal(f.writes[0][0], 'a.txt');
  f.allow(); assert.equal(await f.workspace.close('a.txt'), true); assert.equal(f.state.currentPath, 'b.txt'); assert.equal(f.disposed.length, 1);
});
it('非活动标签保存使用该标签文本', async () => {
  const f = await fixture(); await f.workspace.open('b.txt');
  assert.equal(await f.workspace.save('a.txt'), true); assert.equal(f.writes[0][1], 'draft');
  assert.equal(f.report().documents.find((doc: any) => doc.path === 'a.txt').dirty, false);
  await f.workspace.open('a.txt'); assert.equal(f.state.savedText, 'draft');
});
it('保存期间新输入及切换标签不会被旧保存回执清除', async () => {
  const f = await fixture(); let resolve: any;
  f.writeLater(() => new Promise(done => { resolve = done; })); const saving = f.workspace.save();
  f.state.currentText = 'new typing'; await f.workspace.open('b.txt'); resolve({ ok: true });
  assert.equal(await saving, false); assert.equal(f.state.currentPath, 'b.txt');
  await f.workspace.open('a.txt'); assert.equal(f.state.currentText, 'new typing'); assert.equal(f.state.savedText, 'draft');
  assert.equal(f.report().documents.find((doc: any) => doc.path === 'a.txt').dirty, true);
});
it('旧目录延迟读取不能在新目录覆盖编辑器，所有旧模型释放', async () => {
  const f = await fixture(); let resolve: any;
  f.readLater(() => new Promise((done) => { resolve = done; })); const pending = f.workspace.open('b.txt');
  await new Promise((done) => setImmediate(done)); f.state.root = 'B'; f.workspace.clear(); resolve({ ok: true, text: 'old' });
  assert.equal(await pending, false); assert.equal(f.state.currentPath, null); assert.equal(f.report().documents.length, 0); assert.equal(f.disposed.length, 1);
});
it('新文件读取期间的输入保留在原标签，强制刷新期间新输入不能被覆盖', async () => {
  const f = await fixture(); let resolve: any; f.readLater(() => new Promise((done) => { resolve = done; }));
  const pending = f.workspace.open('b.txt'); await new Promise((done) => setImmediate(done)); f.state.currentText = 'new typing';
  resolve({ ok: true, text: 'next' }); assert.equal(await pending, true); await f.workspace.open('a.txt'); assert.equal(f.state.currentText, 'new typing');
  const reload = f.workspace.reload('a.txt', true, true); await new Promise((done) => setImmediate(done));
  f.state.currentText = 'later typing'; resolve({ ok: true, text: 'disk' }); assert.equal(await reload, false); assert.equal(f.state.currentText, 'later typing');
});
it('改名同步所有内部标签并保留草稿，删除只关闭受影响标签', async () => {
  const f = await fixture('sub/a.txt'); await f.workspace.open('sub/b.txt'); f.state.currentText = 'draft B'; await f.workspace.open('keep.txt');
  f.workspace.entryChanged({ kind: 'renamed', oldRelPath: 'sub', relPath: 'new', isDirectory: true });
  await f.workspace.open('new/a.txt'); assert.equal(f.state.currentText, 'draft');
  await f.workspace.open('new/b.txt'); assert.equal(f.state.currentText, 'draft B');
  f.workspace.entryChanged({ kind: 'deleted', oldRelPath: 'new', isDirectory: true });
  assert.equal(f.state.currentPath, 'keep.txt'); assert.equal(f.report().documents.length, 1); assert.equal(f.disposed.length, 2);
});
it('磁盘刷新非活动已保存标签不会切换当前标签，脏标签禁止自动覆盖', async () => {
  const f = await fixture(); await f.workspace.save(); await f.workspace.open('b.txt');
  f.readLater(async () => ({ ok: true, text: 'AI applied' })); assert.equal(await f.workspace.reload('a.txt', false, false), true);
  assert.equal(f.state.currentPath, 'b.txt'); await f.workspace.open('a.txt'); assert.equal(f.state.currentText, 'AI applied');
  f.state.currentText = 'local draft'; assert.equal(await f.workspace.reload('a.txt', false, false), false); assert.equal(f.state.currentText, 'local draft');
});
it('Windows 大小写及分隔符别名共享一个标签，刷新和删除匹配同一文档', async () => {
  const f = await fixture('sub/a.txt'); const first = f.shown();
  await f.workspace.open('SUB\\A.TXT'); assert.equal(f.report().documents.length, 1); assert.equal(f.shown(), first);
  await f.workspace.save(); f.readLater(async () => ({ ok: true, text: 'AI modification' }));
  await f.workspace.reload('SUB\\A.TXT', false, false); assert.equal(f.state.currentText, 'AI modification');
  f.workspace.entryChanged({ kind: 'renamed', oldRelPath: 'SUB', relPath: 'new', isDirectory: true });
  assert.equal(f.state.currentPath, 'new/a.txt');
  f.workspace.entryChanged({ kind: 'deleted', oldRelPath: 'NEW', isDirectory: true }); assert.equal(f.state.currentPath, null);
});

it('不存在的文件读取失败不创建虚拟标签，也不写盘', async () => {
  const f = await fixture(); const original = f.shown();
  f.readLater(async () => ({ ok: false, error: 'ENOENT' }));
  assert.equal(await f.workspace.open('missing.ts'), false);
  assert.equal(f.shown(), original); assert.equal(f.tabs().length, 1);
  assert.equal(f.state.currentText, 'draft'); assert.equal(f.writes.length, 0);
});
it('工具创建完成后打开真实文件，删除通知只释放新增标签并保留原草稿', async () => {
  const f = await fixture();
  f.readLater(async () => ({ ok: true, text: 'export const value = 1;', encoding: 'utf8' }));
  assert.equal(await f.workspace.open('new.ts'), true);
  assert.equal(f.state.currentText, 'export const value = 1;');
  assert.equal(f.report().documents.length, 2); assert.equal(f.writes.length, 0);
  f.workspace.entryChanged({ kind: 'deleted', oldRelPath: 'new.ts', isDirectory: false });
  assert.equal(f.state.currentPath, 'a.txt'); assert.equal(f.state.currentText, 'draft');
  assert.equal(f.disposed.length, 1);
});
