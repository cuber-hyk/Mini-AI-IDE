import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';
import { FileService } from '../src/main/fileService';
import { SettingsStore, normalizeRecentRoots } from '../src/main/settings';
import { WorkspaceService } from '../src/main/workspaceService';

function fixture(t: any) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-workspace-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const a = path.join(home, 'A'); const b = path.join(home, 'B'); fs.mkdirSync(a); fs.mkdirSync(b);
  const settings = new SettingsStore('test.json', home); const files = new FileService();
  return { home, a, b, settings, files, workspace: new WorkspaceService(files, settings) };
}
it('A→B 后重新创建服务恢复 B；最近目录去重、排序且与持久设置一致', (t) => {
  const f = fixture(t); assert.equal(f.workspace.open(f.a).ok, true); assert.equal(f.workspace.open(f.b).ok, true);
  assert.equal(f.workspace.open(f.a).ok, true); assert.equal(f.workspace.open(f.b).ok, true);
  const next = new WorkspaceService(new FileService(), new SettingsStore('test.json', f.home));
  assert.equal(next.restore().root, f.b); assert.deepEqual(next.getState().recentRoots, [f.b, f.a]);
});
it('取消及失效目录不由服务替换当前目录；关闭后重启为空但最近历史保留', (t) => {
  const f = fixture(t); f.workspace.open(f.a); const previous = f.workspace.getState();
  assert.equal(f.workspace.open(path.join(f.home, 'missing')).ok, false); assert.deepEqual(f.workspace.getState(), previous);
  assert.equal(f.workspace.openRecent(-1).ok, false); assert.deepEqual(f.workspace.getState(), previous);
  assert.equal(f.workspace.close().root, null);
  const next = new WorkspaceService(new FileService(), new SettingsStore('test.json', f.home));
  assert.equal(next.restore().root, null); assert.deepEqual(next.getState().recentRoots, [f.a]);
});
it('启动历史失效后清理恢复记录，不自动打开最近的其他目录', (t) => {
  const f = fixture(t); f.workspace.open(f.a); f.workspace.open(f.b); fs.rmdirSync(f.b);
  const next = new WorkspaceService(new FileService(), new SettingsStore('test.json', f.home));
  const restored = next.restore(); assert.equal(restored.stale, true); assert.equal(restored.root, null);
  assert.equal(new SettingsStore('test.json', f.home).get().lastRoot, null);
});
it('设置保存失败保持当前根、最近历史、修订和磁盘设置', (t) => {
  const f = fixture(t); f.workspace.open(f.a); const before = f.workspace.getState();
  const workspace = new WorkspaceService(f.files, { get: () => f.settings.get(), update: () => { throw new Error('模拟存储失败'); } });
  assert.equal(workspace.open(f.b).ok, false); assert.equal(f.files.getRoot(), f.a);
  assert.deepEqual(workspace.getState().recentRoots, before.recentRoots); assert.equal(f.settings.get().lastRoot, f.a);
  assert.equal(workspace.close().ok, false); assert.equal(f.files.getRoot(), f.a);
});
it('最近最多五项，返回数组不能修改存储，非绝对路径不成为工作区', (t) => {
  const f = fixture(t); const roots = Array.from({ length: 7 }, (_, i) => path.join(f.home, 'p' + i));
  roots.forEach((root) => { fs.mkdirSync(root); f.workspace.open(root); });
  assert.deepEqual(f.workspace.getState().recentRoots, roots.slice(-5).reverse());
  assert.deepEqual(f.workspace.getState().workspaceRoots, roots);
  f.workspace.open(roots[0]!);
  assert.deepEqual(f.workspace.getState().workspaceRoots, roots);
  assert.deepEqual(new SettingsStore('test.json', f.home).get().workspaceRoots, roots);
  const copy = f.settings.get(); copy.recentRoots.length = 0; assert.equal(f.settings.get().recentRoots.length, 5);
  copy.workspaceRoots.length = 0; assert.equal(f.settings.get().workspaceRoots.length, 7);
  assert.equal(f.workspace.open('relative').ok, false);
  assert.deepEqual(normalizeRecentRoots([f.a, f.a.toUpperCase(), 'relative']), [f.a]);
});

it('首次从当前和最近目录初始化；明确保存的空工作区不会被历史重新填充', t => {
  const f = fixture(t);
  fs.writeFileSync(f.settings.filePath, JSON.stringify({ lastRoot: f.b, recentRoots: [f.a, f.b] }));
  const migrated = new SettingsStore('test.json', f.home);
  assert.deepEqual(migrated.get().workspaceRoots, [f.b, f.a]);
  migrated.update({ workspaceRoots: [] });
  assert.deepEqual(new SettingsStore('test.json', f.home).get().workspaceRoots, []);
});

it('移除仅取消注册；失效目录保留，保存失败不会关闭活动项目', t => {
  const f = fixture(t); f.workspace.open(f.a); f.workspace.open(f.b);
  fs.rmdirSync(f.a);
  assert.equal(f.workspace.open(f.a).ok, false);
  assert.deepEqual(f.workspace.getState().workspaceRoots, [f.a, f.b]);
  assert.equal(f.workspace.getState().root, f.b);
  const failing = new WorkspaceService(f.files, { get: () => f.settings.get(), update: () => { throw new Error('模拟存储失败'); } });
  assert.equal(failing.remove(f.b).ok, false); assert.equal(f.files.getRoot(), f.b);
  assert.equal(f.workspace.remove(f.a).ok, true); assert.equal(f.files.getRoot(), f.b);
  assert.equal(f.workspace.remove(f.b).ok, true); assert.equal(f.files.getRoot(), null);
  assert.ok(fs.statSync(f.b).isDirectory());
  assert.deepEqual(new SettingsStore('test.json', f.home).get().workspaceRoots, []);
});

it('新版布局持久化仅保存合法尺寸和显隐，读取返回独立对象', t => {
  const f = fixture(t);
  const workspaceLayout = { workspaceWidth: 220, workspaceVisible: true, fileWidth: 640,
    fileVisible: true, treeWidth: 180, treeVisible: false };
  f.settings.update({ workspaceLayout });
  const copy = f.settings.get(); copy.workspaceLayout!.treeWidth = 900;
  assert.deepEqual(new SettingsStore('test.json', f.home).get().workspaceLayout, workspaceLayout);
  f.settings.update({ workspaceLayout: { ...workspaceLayout, treeWidth: NaN } });
  assert.equal(f.settings.get().workspaceLayout, null);
  fs.writeFileSync(f.settings.filePath, JSON.stringify({ workspaceLayout: { ...workspaceLayout, fileVisible: 'true' } }));
  assert.equal(new SettingsStore('test.json', f.home).get().workspaceLayout, null);
});
it('真实设置写入失败抛错且缓存不先行更新；自检存储不污染另一份设置', (t) => {
  const f = fixture(t); f.settings.update({ lastRoot: f.a });
  const isolated = new SettingsStore('self-test.json', f.home); isolated.update({ lastRoot: f.b });
  assert.equal(new SettingsStore('test.json', f.home).get().lastRoot, f.a);
  fs.unlinkSync(f.settings.filePath); fs.mkdirSync(f.settings.filePath);
  assert.throws(() => f.settings.update({ lastRoot: f.b }), /设置保存失败/); assert.equal(f.settings.get().lastRoot, f.a);
});


it('初始化默认附带；用户选择落盘重载且不与其他设置串改', (t) => {
  const f=fixture(t); assert.deepEqual(f.settings.get().localPrompt,{includeInitialization:true});
  f.settings.update({localPrompt:{includeInitialization:false}});
  const reread=new SettingsStore('test.json',f.home);
  assert.deepEqual(reread.get().localPrompt,{includeInitialization:false});
  reread.get().localPrompt.includeInitialization=true;
  assert.equal(reread.get().localPrompt.includeInitialization,false);
  reread.update({sidebarVisible:false}); assert.equal(reread.get().localPrompt.includeInitialization,false);
});
