import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';
import { it } from 'node:test';
import { FileService } from '../src/main/fileService';
import { FileManagementService } from '../src/main/fileManagement';
import { EditorSession } from '../src/main/editorSession';
import { CHANNELS } from '../src/shared/contract';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-controller-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new FileService(); files.setRoot(root);
  const handlers = new Map<string, (...args: any[]) => any>(); const notifications: any[] = [];
  const dialogs: any[] = []; const answers: number[] = []; const clipboard: string[] = []; const revealed: string[] = []; const trashed: string[] = [];
  let beforeAnswer: (() => Promise<void>) | undefined;
  const electron = { ipcMain: { handle(channel: string, fn: any) { handlers.set(channel, fn); }, on() {} },
    dialog: { async showMessageBox(_window: any, options: any) { dialogs.push(options); await beforeAnswer?.(); return { response: answers.shift() ?? 1 }; } },
    clipboard: { writeText(text: string) { clipboard.push(text); } }, shell: {
      showItemInFolder(absolute: string) { revealed.push(absolute); }, async trashItem(absolute: string) { trashed.push(absolute); },
    } };
  const dependencies: Record<string, unknown> = { electron, '../shared/contract': { CHANNELS }, './editorSession': { EditorSession }, './fileManagement': { FileManagementService } };
  const exports: any = {};
  const code = ts.transpileModule(await fs.readFile('src/main/workspaceController.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require(name: string) { assert.ok(name in dependencies, name); return dependencies[name]; } });
  const view = { id: 1, mainFrame: {}, send() {} };
  const workspace = { getState: () => ({ root: files.getRoot(), revision: 1, recentRoots: [] }) };
  const controller = new exports.WorkspaceController({}, view, files, workspace, () => {}, (event: any) => notifications.push(event), () => false);
  controller.register();
  const event = { sender: view, senderFrame: view.mainFrame };
  return { root, files, controller, dialogs, answers, clipboard, revealed, trashed, notifications, view,
    beforeAnswer(fn: () => Promise<void>) { beforeAnswer = fn; },
    invoke(channel: string, ...args: unknown[]) { return handlers.get(channel)!(event, ...args); },
    foreign(channel: string, ...args: unknown[]) { return handlers.get(channel)!({ sender: view, senderFrame: {} }, ...args); } };
}

it('复制与定位只允许当前编辑器主 frame 和当前根，路径由主进程解析', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'sub')); await fs.writeFile(path.join(f.root, 'sub/a.txt'), 'keep');
  for (const channel of [CHANNELS.copyEntryPath, CHANNELS.revealEntry, CHANNELS.deleteEntry]) assert.equal((await f.foreign(channel, 'sub/a.txt', false, f.root)).ok, false);
  assert.equal((await f.invoke(CHANNELS.copyEntryPath, 'sub/a.txt', false, f.root)).ok, true);
  assert.equal((await f.invoke(CHANNELS.copyEntryPath, 'sub/a.txt', true, f.root)).ok, true);
  assert.equal((await f.invoke(CHANNELS.copyEntryPath, '', true, f.root)).ok, true);
  assert.equal((await f.invoke(CHANNELS.revealEntry, 'sub/a.txt', f.root)).ok, true);
  assert.deepEqual(f.clipboard, [path.join(f.root, 'sub/a.txt'), 'sub/a.txt', '.']);
  assert.deepEqual(f.revealed, [path.join(f.root, 'sub/a.txt')]);
  assert.equal((await f.invoke(CHANNELS.copyEntryPath, 'sub/a.txt', true, 'old-root')).ok, false);
  assert.equal((await f.invoke(CHANNELS.revealEntry, '..', f.root)).ok, false);
  assert.equal(f.clipboard.length, 3); assert.equal(f.revealed.length, 1);
});

it('永久删除先处理文件夹内草稿，再确认永久删除；取消不改变文件或通知', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'sub')); await fs.writeFile(path.join(f.root, 'sub/a.txt'), 'keep');
  f.controller.editor.update({ root: f.root, path: 'sub/a.txt', documents: [{ path: 'sub/a.txt', dirty: true }] });
  f.answers.push(2); assert.equal((await f.invoke(CHANNELS.deleteEntry, 'sub', f.root)).ok, false);
  assert.equal(f.dialogs.length, 1); assert.equal(f.dialogs[0].title, '未保存的修改');
  f.answers.push(1, 1); assert.equal((await f.invoke(CHANNELS.deleteEntry, 'sub', f.root)).ok, false);
  assert.match(f.dialogs[2].detail, /全部内容.*不会进入回收站/); assert.equal(f.dialogs[2].defaultId, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'sub/a.txt'), 'utf8'), 'keep'); assert.equal(f.notifications.length, 0);
  f.answers.push(1, 0); assert.equal((await f.invoke(CHANNELS.deleteEntry, 'sub', f.root)).ok, true);
  await assert.rejects(fs.stat(path.join(f.root, 'sub')), { code: 'ENOENT' });
  assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].kind, 'deleted'); assert.equal(f.trashed.length, 0);
});

it('永久删除确认期间切换根会拒绝，原回收站仍使用独立通道', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.txt'), 'keep');
  f.answers.push(0); assert.equal((await f.invoke(CHANNELS.trashEntry, 'a.txt', f.root)).ok, true);
  assert.deepEqual(f.trashed, [path.join(f.root, 'a.txt')]);
  f.beforeAnswer(async () => { f.files.clearRoot(); }); f.answers.push(0);
  assert.equal((await f.invoke(CHANNELS.deleteEntry, 'a.txt', f.root)).ok, false);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'keep'); assert.equal(f.notifications.length, 1);
});
