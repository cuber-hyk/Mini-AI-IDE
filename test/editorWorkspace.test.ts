import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { it } from 'node:test';

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
  const state = { root: 'A', currentPath: null as string | null, currentText: '', savedText: '' };
  let leave = true; let write = true; let writeLater: any; let read: any = async () => ({ ok: true, text: 'saved', encoding: 'utf8' });
  let report: any; let shown: any; let tabs: any; const writes: any[] = []; const disposed: any[] = [];
  const bridge = { reportEditorState(value: any) { report = value; }, confirmLeave: async () => ({ ok: leave }), readFile: (...args: any[]) => read(...args),
    writeFile: async (...args: any[]) => { writes.push(args); return writeLater ? writeLater(...args) : { ok: write }; }, onEditorRequest() {}, editorReply: async () => ({ ok: true }) };
  const context: any = { window: {} }; vm.runInNewContext(fs.readFileSync('src/renderer/editorWorkspace.js', 'utf8'), context);
  const workspace = context.window.createEditorWorkspace({ state, bridge, ready: async () => {}, clearDiff() {},
    changed() { workspace.report(); }, highlight() {}, setInfo() {}, renderTabs(value: any) { tabs = value; }, captureViewState() { return { cursor: 8 }; },
    createModel(path: string, text: string) { return { path, text }; }, showDocument(doc: any) { shown = doc; },
    disposeModel(model: any) { disposed.push(model); }, renameModel() {}, replaceContent(doc: any, text: string) { doc.model.text = text; } });
  await workspace.open(path); state.currentText = 'draft'; workspace.report();
  return { state, workspace, writes, disposed, shown: () => shown, report: () => report, tabs: () => tabs,
    cancel() { leave = false; }, allow() { leave = true; }, failSave() { write = false; }, writeLater(fn: any) { writeLater = fn; }, readLater(fn: any) { read = fn; } };
}
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

it('新增文件预览不读盘或写盘，保存和重复打开不会将预览变成草稿', async () => {
  const f = await fixture(); const original = f.shown(); let reads = 0;
  f.readLater(async () => { reads++; return { ok: false, error: 'ENOENT' }; });
  assert.equal(await f.workspace.previewNewFile('new/sub.ts'), true); const preview = f.shown();
  assert.equal(preview.previewOnly, true); assert.equal(f.state.currentText, '');
  assert.equal(f.tabs().find((tab: any) => tab.path === 'new/sub.ts').previewOnly, true);
  assert.equal(f.report().path, null); assert.equal(f.report().documents.length, 1);
  assert.equal(await f.workspace.save(), false); assert.equal(await f.workspace.open('NEW\\SUB.TS'), true);
  assert.equal(f.shown(), preview); assert.equal(preview.previewOnly, true); assert.equal(reads, 0); assert.equal(f.writes.length, 0);
  await f.workspace.open('a.txt'); assert.equal(f.shown(), original); assert.equal(f.state.currentText, 'draft');
  assert.equal(f.tabs().length, 1); assert.equal(f.disposed.includes(preview.model), true);
});
it('退出或关闭新增预览只释放虚拟模型，现有文件及草稿不会被覆盖', async () => {
  const f = await fixture(); const original = f.shown();
  assert.equal(await f.workspace.previewNewFile('A.TXT'), false); assert.equal(f.shown(), original); assert.equal(f.state.currentText, 'draft');
  await f.workspace.previewNewFile('first.ts'); const first = f.shown();
  await f.workspace.previewNewFile('second.ts'); assert.equal(f.disposed.includes(first.model), true);
  f.workspace.exitPreview(); assert.equal(f.shown(), original); assert.equal(f.state.currentText, 'draft'); assert.equal(f.tabs().length, 1);
  await f.workspace.previewNewFile('third.ts'); f.cancel(); assert.equal(await f.workspace.close('third.ts'), true);
  assert.equal(f.shown(), original); assert.equal(f.writes.length, 0);
});
it('创建事件读盘后预览转换为真实文档，后续保存使用真实完整内容', async () => {
  const f = await fixture(); await f.workspace.previewNewFile('new.ts'); const preview = f.shown();
  f.readLater(async () => ({ ok: true, text: 'export const value = 1;', encoding: 'utf8' }));
  assert.equal(await f.workspace.reload('new.ts', false, false), true);
  assert.equal(f.shown(), preview); assert.equal(preview.previewOnly, false); assert.equal(f.state.currentText, 'export const value = 1;');
  assert.equal(f.report().path, 'new.ts'); assert.equal(f.report().documents.length, 2);
  assert.equal(await f.workspace.save(), true); assert.deepEqual(f.writes[0], ['new.ts', 'export const value = 1;', 'A']);
  f.workspace.entryChanged({ kind: 'deleted', oldRelPath: 'new.ts', isDirectory: false });
  assert.equal(f.state.currentPath, 'a.txt'); assert.equal(f.state.currentText, 'draft');
});
it('目录切换使新增预览等待与模型失效，创建刷新读盘失败保持只读预览', async () => {
  const f = await fixture(); await f.workspace.previewNewFile('new.ts'); const preview = f.shown();
  f.readLater(async () => ({ ok: false, error: 'ENOENT' }));
  assert.equal(await f.workspace.reload('new.ts', false, false), false); assert.equal(preview.previewOnly, true);
  f.state.root = 'B'; f.workspace.clear(); assert.equal(f.tabs().length, 0); assert.equal(f.disposed.includes(preview.model), true);
  assert.equal(f.report().path, null); assert.equal(f.writes.length, 0);
});
