import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import type { App, BaseWindow } from 'electron';
import { SharedSessionInstance } from '../src/main/sharedSessionInstance';

function fixture(allowed = true) {
  const events = new EventEmitter(); let requests = 0; const actions: string[] = [];
  let destroyed = false; let minimized = false;
  const app = Object.assign(events, { requestSingleInstanceLock() { requests++; return allowed; } });
  const window = { isDestroyed: () => destroyed, isMinimized: () => minimized,
    restore() { actions.push('restore'); minimized = false; }, show() { actions.push('show'); }, focus() { actions.push('focus'); } };
  return { events, actions, requests: () => requests, window: window as unknown as BaseWindow,
    instance: new SharedSessionInstance(app as unknown as App), destroy() { destroyed = true; }, minimize() { minimized = true; } };
}

it('锁失败移除监听，无窗口操作；重复 acquire 不重复申请', () => {
  const f = fixture(false);
  assert.equal(f.instance.acquire(), false); assert.equal(f.instance.acquire(), false);
  assert.equal(f.requests(), 1); assert.equal(f.events.listenerCount('second-instance'), 0);
  f.instance.setWindow(f.window); f.events.emit('second-instance'); assert.deepEqual(f.actions, []);
});

it('首次启动绑定窗口不自动显示或聚焦；第二启动才恢复并激活', () => {
  const f = fixture(); assert.equal(f.instance.acquire(), true); f.instance.setWindow(f.window);
  assert.deepEqual(f.actions, []); f.minimize(); f.events.emit('second-instance', {}, ['file-secret'], 'private', { url: 'private' });
  assert.deepEqual(f.actions, ['restore', 'show', 'focus']);
  f.actions.length = 0; f.events.emit('second-instance'); assert.deepEqual(f.actions, ['show', 'focus']);
  assert.equal(f.requests(), 1);
});

it('窗口创建前的第二启动保留一次激活请求，销毁后不操作窗口', () => {
  const f = fixture(); f.instance.acquire(); f.events.emit('second-instance'); f.events.emit('second-instance');
  f.instance.setWindow(f.window); assert.deepEqual(f.actions, ['show', 'focus']);
  f.actions.length = 0; f.instance.setWindow(f.window); assert.deepEqual(f.actions, []);
  f.destroy(); f.events.emit('second-instance'); assert.deepEqual(f.actions, []);
});

it('申请抛错撤销监听；成功实例不提供手动释放登录资料锁', () => {
  const events = new EventEmitter();
  const app = Object.assign(events, { requestSingleInstanceLock() { throw new Error('lock unavailable'); } });
  assert.throws(() => new SharedSessionInstance(app as unknown as App).acquire(), /lock unavailable/);
  assert.equal(events.listenerCount('second-instance'), 0);
  const f = fixture(); f.instance.acquire();
  assert.equal('dispose' in f.instance, false); assert.equal('releaseSingleInstanceLock' in f.instance, false);
});
