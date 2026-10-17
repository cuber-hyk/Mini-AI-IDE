import assert from 'node:assert/strict';
import { it } from 'node:test';
import { undo, undoDepth } from '@codemirror/commands';
import { createMarkdownEditor } from '../src/renderer/markdownEditor.js';
import { markdownLive } from '../src/renderer/markdownPresentation.js';

function fixture() {
  const node = (): any => ({ classList: { add() {}, toggle() {} }, append() {},
    setAttribute() {}, addEventListener() {}, hidden: false });
  const previous = globalThis.document;
  let changes = 0;
  Object.assign(globalThis, { document: { createElement: node } });
  const editor = createMarkdownEditor({ host: node(), onChange() { changes++; }, onSave() {}, onCopy() {}, setInfo() {} });
  Object.assign(globalThis, { document: previous });
  return { editor, changes: () => changes };
}

it('打开、切换模式和撤销不改原文或换行，模式不占用撤销记录', () => {
  const f = fixture();
  const original = '# 中文\r\n\r\n- [x] 任务\r\n';
  const model = f.editor.createModel('a.md', original);
  assert.equal(model.mode, 'live'); assert.equal(model.getValue(), original);
  assert.equal(model.getValueLength(), original.length); assert.equal(f.changes(), 0);
  model.replaceRange(model.state.doc.length, model.state.doc.length, '编辑');
  assert.equal(model.getValue(), original + '编辑');
  assert.equal(model.getValueLength(), original.length + 2);
  const depth = undoDepth(model.state);
  model.state = model.state.update({ effects: model.presentation.reconfigure(markdownLive.of(false)) }).state;
  assert.equal(model.getValue(), original + '编辑'); assert.equal(undoDepth(model.state), depth);
  assert.equal(undo({ state: model.state, dispatch(transaction: any) { model.state = transaction.state; } }), true);
  assert.equal(model.getValue(), original); assert.equal(model.getValueLength(), original.length);
  model.replaceRange(model.state.doc.length, model.state.doc.length, '\n新行\n');
  assert.equal(model.state.doc.lines, 6);
  assert.equal(model.getValue(), original + '\r\n新行\r\n');
});

it('多文件保存各自正文、历史和选区；AI重载只重置目标文件历史', () => {
  const f = fixture();
  const first = f.editor.createModel('a.md', 'A'); const second = f.editor.createModel('b.md', 'B');
  first.replaceRange(1, 1, ' 草稿'); second.replaceRange(1, 1, ' 修改');
  first.state = first.state.update({ selection: { anchor: 1, head: 3 } }).state;
  const selection = first.state.selection;
  assert.ok(undoDepth(first.state) > 0); assert.ok(undoDepth(second.state) > 0);
  second.setValue('磁盘新内容');
  assert.equal(second.getValue(), '磁盘新内容'); assert.equal(undoDepth(second.state), 0);
  assert.equal(first.getValue(), 'A 草稿'); assert.ok(undoDepth(first.state) > 0);
  assert.equal(first.state.selection, selection);
  first.dispose(); assert.equal(first.disposed, true); assert.equal(first.state, null);
  assert.equal(second.getValue(), '磁盘新内容');
});

it('原文未变化时保留混合换行；改名更新路径但不改正文或清空历史', () => {
  const f = fixture(); const original = '# 一\r\n二\n三\r四';
  const model = f.editor.createModel('notes/a.md', original);
  assert.equal(model.getValue(), original); assert.equal(model.getValueLength(), original.length);
  f.editor.renameModel(model, 'moved/a.txt');
  assert.equal(model.path, 'moved/a.txt'); assert.equal(model.markdown, true);
  assert.equal(model.getValue(), original); assert.equal(f.changes(), 0);
  model.replaceRange(model.state.doc.length, model.state.doc.length, '!');
  const depth = undoDepth(model.state);
  f.editor.renameModel(model, 'moved/b.md');
  assert.equal(undoDepth(model.state), depth); assert.ok(depth > 0);
});
