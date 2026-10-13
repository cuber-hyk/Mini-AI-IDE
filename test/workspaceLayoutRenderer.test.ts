import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { it } from 'node:test';
import { computeLayout } from '../src/main/windowLayout';

function fixture() {
  const nodes = new Map<string, any>();
  const events = new Map<string, any[]>();
  const frames = new Map<number, () => void>();
  let frame = 0;
  const node = (id: string): any => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, hidden: false, children: [], events: {} as any,
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name: string, fn: any) { this.events[name] = fn; },
      setAttribute() {}, setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {} });
    return nodes.get(id);
  };
  const calls: { patch: any; temporary: boolean; resolve: (state: any) => void }[] = [];
  let publish!: (state: any) => void;
  const bridge = { onChromeState(fn: any) { publish = fn; }, setWorkspaceLayout(patch: any, temporary: boolean) {
    return new Promise(resolve => calls.push({ patch: JSON.parse(JSON.stringify(patch)), temporary, resolve }));
  } };
  const window = { innerWidth: 1600, addEventListener(name: string, fn: any) { events.set(name, [...events.get(name) ?? [], fn]); } };
  const document = { getElementById: node, querySelector: node,
    documentElement: { style: { setProperty() {} } }, addEventListener() {}, dispatchEvent() {} };
  vm.runInNewContext(fs.readFileSync('src/renderer/workspaceLayout.js', 'utf8'), {
    window, document, console, Event: class {}, ResizeObserver: class { observe() {} }, queueMicrotask,
    requestAnimationFrame(fn: () => void) { frames.set(++frame, fn); return frame; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  });
  (window as any).setupWorkspaceLayout(bridge);
  const state = (revision: number, width = 680) => ({ layoutRevision: revision,
    layout: computeLayout(1600, 900, { fileWidth: width }), fileMaximized: false });
  publish(state(1));
  calls.length = 0;
  const send = (name: string, extra = {}) => node('resizer').events[name]({ pointerId: 1, button: 0, clientX: 900, preventDefault() {}, ...extra });
  return { calls, node, state, publish, send,
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    windowEvent(name: string) { events.get(name)?.forEach(fn => fn({})); },
  };
}

it('600 次拖动按 60 帧只发送 60 次临时布局及一次最终偏好，迟到回执不倒退布局', async () => {
  const f = fixture(); f.send('pointerdown');
  for (let frame = 0; frame < 60; frame++) {
    for (let move = 0; move < 10; move++) f.send('pointermove', { clientX: 900 - frame - move });
    f.frame();
  }
  assert.equal(f.calls.length, 60);
  assert.ok(f.calls.every(c => c.temporary));
  f.send('pointerup');
  assert.equal(f.calls.length, 61);
  assert.equal(f.calls[60]!.temporary, false);
  assert.deepEqual(f.calls[60]!.patch, { fileWidth: 748 });
  f.publish(f.state(100, 748));
  f.calls[0]!.resolve(f.state(2, 690));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.node('.toolbar').style.width, '558px', '旧 IPC 回执不能覆盖主进程较新广播');
  f.calls[60]!.resolve(f.state(100, 748));
  await Promise.resolve();
  assert.equal(f.node('.toolbar').style.width, '558px');
});

it('取消、失捕获、失焦及卸载会提交未到帧的最终宽度一次，其他指针不能结束拖动', () => {
  for (const event of ['pointercancel', 'lostpointercapture', 'blur', 'beforeunload']) {
    const f = fixture(); f.send('pointerdown'); f.send('pointermove', { clientX: 850 });
    f.send('pointerup', { pointerId: 2 });
    assert.equal(f.calls.length, 0);
    if (event === 'blur' || event === 'beforeunload') f.windowEvent(event); else f.send(event);
    assert.equal(f.calls.length, 1, event);
    assert.equal(f.calls[0]!.temporary, false);
    assert.deepEqual(f.calls[0]!.patch, { fileWidth: 730 });
    f.frame(); f.send('pointerup');
    assert.equal(f.calls.length, 1, '结束时取消待处理帧且不会重复提交');
  }
});

it('键盘与双击直接保存布局，resize 可重绘同一版本，重复广播不重复布局', () => {
  const f = fixture();
  f.send('keydown', { key: 'ArrowLeft' }); f.send('dblclick');
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(c => !c.temporary));
  assert.deepEqual(f.calls[0]!.patch, { fileWidth: 704 });
  assert.deepEqual(f.calls[1]!.patch, { fileWidth: 700 });
  f.publish(f.state(1, 900));
  assert.equal(f.node('.toolbar').style.width, '490px');
  f.windowEvent('resize');
  assert.equal(f.node('.toolbar').style.width, '490px');
});
