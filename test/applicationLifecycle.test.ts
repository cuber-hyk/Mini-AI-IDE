import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApplicationLifecycle, closeApplicationContents } from '../src/main/applicationLifecycle';
import { SettingsStore } from '../src/main/settings';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const app = new EventEmitter() as any;
  const window = new EventEmitter() as any;
  const calls = { approve: 0, cleanup: 0, quit: 0, hidden: 0, tray: 0, destroyedTray: 0, auxiliary: 0 };
  const state = { behavior: 'quit' as 'quit' | 'tray', allow: true, visible: true, destroyed: false, enabled: true, minimized: false };
  const failures: unknown[] = [];
  let clean: () => Promise<void> = async () => {};
  let trayShow!: () => void; let trayQuit!: () => void;
  const close = () => {
    let prevented = false;
    window.emit('close', { preventDefault() { prevented = true; } });
    if (!prevented) { state.destroyed = true; window.emit('closed'); }
    return !prevented;
  };
  app.quit = () => {
    let prevented = false;
    app.emit('before-quit', { preventDefault() { prevented = true; } });
    if (!prevented && close()) calls.quit++;
  };
  Object.assign(window, { isDestroyed: () => state.destroyed, isMinimized: () => state.minimized,
    restore() { state.minimized = false; }, show() { state.visible = true; }, focus() {},
    hide() { calls.hidden++; state.visible = false; }, setEnabled(value: boolean) { state.enabled = value; } });
  new ApplicationLifecycle(app, window, {
    closeBehavior: () => state.behavior,
    approve: async () => { calls.approve++; return state.allow; },
    cleanup: async () => { calls.cleanup++; await clean(); },
    hideAuxiliary: () => { calls.auxiliary++; }, failed: error => failures.push(error),
    createTray: (show, quit) => { calls.tray++; trayShow = show; trayQuit = quit; return { destroy() { calls.destroyedTray++; } }; },
  });
  return { app, window, state, calls, failures, close, cleanup(fn: typeof clean) { clean = fn; }, show: () => trayShow(), quitTray: () => trayQuit() };
}

test('直接关闭保留窗口直到真实清理完成，重复退出只清理一次', async () => {
  const f = fixture(); let finish!: () => void;
  f.cleanup(() => new Promise(resolve => { finish = resolve; }));
  f.close(); await tick(); f.close(); f.app.quit();
  assert.equal(f.state.destroyed, false); assert.equal(f.state.enabled, false);
  assert.equal(f.calls.cleanup, 1); assert.equal(f.calls.quit, 0);
  finish(); await tick();
  assert.equal(f.state.destroyed, true); assert.equal(f.calls.quit, 1);
});

test('缩小至托盘不确认离开、不清理工具；恢复原窗口，托盘退出仍完整退出', async () => {
  const f = fixture(); f.state.behavior = 'tray'; f.state.allow = false;
  f.close(); f.close(); await tick();
  assert.equal(f.state.visible, false); assert.equal(f.state.destroyed, false);
  assert.equal(f.calls.approve, 0); assert.equal(f.calls.cleanup, 0); assert.equal(f.calls.tray, 1);
  f.state.minimized = true; f.show();
  assert.equal(f.state.visible, true); assert.equal(f.state.minimized, false);
  f.quitTray(); await tick();
  assert.equal(f.calls.quit, 0); assert.equal(f.state.destroyed, false);
  f.state.allow = true; f.quitTray(); await tick();
  assert.equal(f.calls.quit, 1); assert.equal(f.calls.destroyedTray, 1);
});

test('取消未保存确认不停止工具，下次关闭可以完整退出', async () => {
  const f = fixture(); f.state.allow = false;
  f.close(); await tick();
  assert.equal(f.calls.cleanup, 0); assert.equal(f.state.enabled, true); assert.equal(f.state.destroyed, false);
  f.state.allow = true; f.close(); await tick();
  assert.equal(f.calls.quit, 1); assert.equal(f.calls.cleanup, 1);
});

test('清理失败不制造无窗口残留，恢复窗口并允许重试', async () => {
  const f = fixture(); f.state.behavior = 'tray'; f.close();
  f.cleanup(async () => { throw new Error('停止命令失败'); });
  f.quitTray(); await tick();
  assert.equal(f.calls.quit, 0); assert.equal(f.state.destroyed, false);
  assert.equal(f.state.enabled, true); assert.equal(f.state.visible, true); assert.equal(f.failures.length, 1);
  f.cleanup(async () => {}); f.app.quit(); await tick();
  assert.equal(f.calls.quit, 1); assert.equal(f.calls.cleanup, 2);
});

test('设置缺省及非法值缩小至托盘，明确选择原子保存并跨重启保留', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-close-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const load = () => new SettingsStore('settings.json', directory);
  assert.equal(load().get().closeBehavior, 'tray');
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ sidebarVisible: false }));
  assert.equal(load().get().closeBehavior, 'tray', '升级前缺少关闭偏好的配置也采用托盘默认值');
  load().update({ closeBehavior: 'tray' }); assert.equal(load().get().closeBehavior, 'tray');
  const store = load(); store.update({ sidebarVisible: false }); assert.equal(load().get().closeBehavior, 'tray');
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error('写盘失败'); };
  try { assert.throws(() => store.update({ closeBehavior: 'quit' }), /保存失败/); }
  finally { fs.renameSync = original; }
  assert.equal(store.get().closeBehavior, 'tray'); assert.equal(load().get().closeBehavior, 'tray');
  store.update({ closeBehavior: 'quit' });
  assert.equal(load().get().closeBehavior, 'quit', '明确选择直接退出后，重启不能被托盘默认值覆盖');
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ closeBehavior: 'unexpected' }));
  assert.equal(load().get().closeBehavior, 'tray');
});

test('视图close返回不等于销毁；全部实际销毁后才完成清理，超时明确失败', async () => {
  const contents = new EventEmitter() as any; let closed = false; let destroyed = false; let finished = false;
  contents.isDestroyed = () => destroyed;
  contents.close = (options: unknown) => { assert.deepEqual(options, { waitForBeforeUnload: false }); closed = true; };
  const cleanup = closeApplicationContents([contents]).then(() => { finished = true; });
  await tick(); assert.equal(closed, true); assert.equal(finished, false);
  destroyed = true; contents.emit('destroyed'); await cleanup; assert.equal(finished, true);
  destroyed = false;
  await assert.rejects(closeApplicationContents([contents], 5), /关闭网页视图超时/);
  assert.equal(contents.listenerCount('destroyed'), 0);
});
