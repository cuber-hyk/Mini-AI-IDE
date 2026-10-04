import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EditorSession } from '../src/main/editorSession';

it('取消阻止离开，放弃不修改缓冲状态，无修改时不弹窗', async () => {
  let choice: 'save' | 'discard' | 'cancel' = 'cancel'; let asked = 0;
  const session = new EditorSession(async () => { asked++; return choice; }, () => {});
  assert.equal(await session.canLeave(), true); assert.equal(asked, 0);
  session.update({ root: 'A', path: 'a.txt', documents: [{ path: 'a.txt', dirty: true }] }); assert.equal(await session.canLeave(), false);
  choice = 'discard'; assert.equal(await session.canLeave(), true); assert.equal(session.hasDirty, true);
});
it('保存失败不能离开；只有同根同文件且已保存的回执才可离开', async () => {
  let sent = 0; const session = new EditorSession(async () => 'save', (id) => { sent = id; });
  session.update({ root: 'A', path: 'a.txt', documents: [{ path: 'a.txt', dirty: true }] });
  const fail = session.canLeave(); await Promise.resolve(); session.reply(sent, false); assert.equal(await fail, false);
  const success = session.canLeave(); await Promise.resolve(); session.update({ root: 'A', path: 'a.txt', documents: [{ path: 'a.txt', dirty: false }] });
  assert.equal(session.reply(sent, true), true); assert.equal(await success, true);
});
it('旧保存回执和未清除的 dirty 状态不能导致离开，超时保持原编辑', async () => {
  let sent = 0; const session = new EditorSession(async () => 'save', (id) => { sent = id; }, 15);
  session.update({ root: 'A', path: 'a.txt', documents: [{ path: 'a.txt', dirty: true }] });
  const dirty = session.canLeave(); await Promise.resolve(); assert.equal(session.reply(sent + 1, true), false);
  session.reply(sent, true); assert.equal(await dirty, false);
  assert.equal(await session.canLeave(), false); assert.equal(session.hasDirty, true);
});

it('关闭目录检查所有脏标签，后一个取消时不会清除前一个放弃的草稿', async () => {
  const asked: string[] = [];
  const session = new EditorSession(async file => { asked.push(file); return file === 'a.txt' ? 'discard' : 'cancel'; }, () => {});
  session.update({ root: 'A', path: 'clean.txt', documents: [{ path: 'a.txt', dirty: true }, { path: 'b.txt', dirty: true }, { path: 'clean.txt', dirty: false }] });
  assert.equal(await session.canLeave(), false); assert.deepEqual(asked, ['a.txt', 'b.txt']); assert.equal(session.current.documents.filter(doc => doc.dirty).length, 2);
});
it('非活动标签的保存回执按目标验证，删除目录仅确认其内部脏文档', async () => {
  const asked: string[] = []; const saved: string[] = [];
  const session = new EditorSession(async file => { asked.push(file); return 'save'; }, (id, path) => {
    saved.push(path); const state = session.current; state.documents.find(doc => doc.path === path)!.dirty = false;
    session.update(state); session.reply(id, true);
  });
  session.update({ root: 'A', path: 'other.txt', documents: [{ path: 'sub/a.txt', dirty: true }, { path: 'sub/b.txt', dirty: true }, { path: 'other.txt', dirty: true }] });
  assert.equal(await session.canLeave('sub', true), true); assert.deepEqual(asked, ['sub/a.txt', 'sub/b.txt']); assert.deepEqual(saved, asked);
  assert.equal(session.isDirty('OTHER.txt'), true); assert.equal(session.current.path, 'other.txt');
});
it('确认期间新产生的其他草稿不能被一次旧确认放弃', async () => {
  const session = new EditorSession(async () => {
    session.update({ root: 'A', path: 'b.txt', documents: [{ path: 'a.txt', dirty: true }, { path: 'b.txt', dirty: true }] }); return 'discard';
  }, () => {});
  session.update({ root: 'A', path: 'a.txt', documents: [{ path: 'a.txt', dirty: true }, { path: 'b.txt', dirty: false }] });
  assert.equal(await session.canLeave(), false);
});
it('Windows 别名同样保护后台草稿，删除文件夹不能漏掉反斜杠路径', async () => {
  const asked: string[] = []; const session = new EditorSession(async file => { asked.push(file); return 'cancel'; }, () => {});
  session.update({ root: 'A', path: 'other.txt', documents: [{ path: 'SUB\\a.txt', dirty: true }] });
  assert.equal(session.isDirty('sub/A.TXT'), true); assert.equal(await session.canLeave('sub', true), false); assert.deepEqual(asked, ['SUB\\a.txt']);
});
