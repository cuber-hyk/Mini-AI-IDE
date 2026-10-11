import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it, type TestContext } from 'node:test';
import { FileService } from '../src/main/fileService';
import { registerWorkspaceFileDrag } from '../src/main/workspaceFileDrag';

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-native-drag-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  const root = path.join(directory, 'project'); await fs.mkdir(root);
  const files = new FileService(); files.setRoot(root);
  let handler: any; let beforeIcon: (file: string) => Promise<void> = async () => {};
  const drags: any[] = []; let dead = false; let empty = false; const icon = { native: true, isEmpty: () => empty };
  const editor = { mainFrame: {}, isDestroyed: () => dead, startDrag(item: any) { drags.push(item); } };
  const channels = registerWorkspaceFileDrag({ handle(channel: string, action: any) { assert.equal(channel, 'fs:start-workspace-file-drag'); handler = action; } } as any,
    editor as any, files, async file => { await beforeIcon(file); return icon as any; });
  assert.deepEqual(channels, ['fs:start-workspace-file-drag']);
  return { directory, root, files, editor, icon, drags, request: (relative: unknown, requestedRoot: unknown = root, event = { sender: editor, senderFrame: editor.mainFrame }) => handler(event, relative, requestedRoot),
    iconAction: (action: (file: string) => Promise<void>) => { beforeIcon = action; }, destroy: () => { dead = true; }, emptyIcon: () => { empty = true; } };
}

it('原生拖拽保持 TXT/Markdown 和图片/PDF/Word 的磁盘文件，不读取转换或发送内容', async t => {
  const f = await fixture(t);
  for (const name of ['notes.txt', 'README.md', 'script.py', 'picture.png', 'report.pdf', 'report.docx']) {
    const bytes = Buffer.from('原始附件\r\n\0'); await fs.writeFile(path.join(f.root, name), bytes);
    assert.equal((await f.request(name)).ok, true);
    assert.equal(f.drags.at(-1).file, await fs.realpath(path.join(f.root, name)));
    assert.equal(f.drags.at(-1).icon, f.icon);
    assert.deepEqual(await fs.readFile(path.join(f.root, name)), bytes);
  }
});

it('仅当前项目的编辑器主 frame 可拖出普通文件，拒绝目录/越界/绝对路径/不存在目标', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.txt'), 'text');
  for (const event of [{ sender: {} as any, senderFrame: f.editor.mainFrame }, { sender: f.editor, senderFrame: {} }])
    assert.equal((await f.request('a.txt', f.root, event)).ok, false);
  for (const relative of ['', '.', '../outside.txt', path.join(f.root, 'a.txt'), 'C:\\windows\\a.txt', 'missing.txt', 42, null])
    assert.equal((await f.request(relative)).ok, false);
  assert.equal((await f.request('a.txt', 'other')).ok, false); assert.equal(f.drags.length, 0);
});

it('链接目录不能逃出根目录，文件夹链接不作为可上传文件', async t => {
  const f = await fixture(t); const outside = path.join(f.directory, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  await fs.symlink(outside, path.join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.request('link')).ok, false); assert.equal((await f.request('link/secret.txt')).ok, false);
  assert.equal(f.drags.length, 0);
});

it('图标读取期间根目录或文件身份变化时取消原生拖拽，同根重新打开也不复用旧请求', async t => {
  for (const change of ['root', 'file', 'window']) {
    const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.txt'), 'before');
    f.iconAction(async file => { if (change === 'root') f.files.setRoot(f.root); else if (change === 'file') await fs.writeFile(file, 'after change'); else f.destroy(); });
    assert.equal((await f.request('a.txt')).ok, false); assert.equal(f.drags.length, 0);
  }
});

it('原生拖拽错误可见且释放忙状态，不重复启动并发拖拽', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.txt'), 'file');
  let resume!: () => void; let reached!: () => void;
  const started = new Promise<void>(done => { reached = done; });
  f.iconAction(() => { reached(); return new Promise<void>(done => { resume = done; }); });
  const pending = f.request('a.txt'); await started;
  assert.equal((await f.request('a.txt')).ok, false); resume(); assert.equal((await pending).ok, true);
  f.iconAction(async () => { throw new Error('icon failed'); });
  assert.match((await f.request('a.txt')).error, /icon failed/);
  f.iconAction(async () => {}); f.editor.startDrag = () => { throw new Error('native failed'); };
  assert.match((await f.request('a.txt')).error, /native failed/);
  f.emptyIcon(); assert.match((await f.request('a.txt')).error, /图标/);
});
