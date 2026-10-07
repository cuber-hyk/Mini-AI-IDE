import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { it } from 'node:test';

it('编辑和 Diff 共用工作区，切换不请求文件写入；Diff 阻止焦点进入被覆盖的编辑器', async () => {
  const nodes = new Map<string, any>();
  function node(id: string) {
    if (!nodes.has(id)) nodes.set(id, { attrs: {}, hidden: false, inert: false, events: {} as Record<string, (event?: unknown) => unknown>, dispatched: [] as unknown[],
      addEventListener(name: string, callback: (event?: unknown) => unknown) { this.events[name] = callback; },
      dispatchEvent(event: unknown) { this.dispatched.push(event); },
      setAttribute(name: string, value: string) { this.attrs[name] = value; } });
    return nodes.get(id);
  }
  const patches: unknown[] = [];
  let defer = false;
  let finish!: () => void;
  let publish!: (state: { previewVisible: boolean }) => void;
  const bridge = {
    async setWorkspaceLayout(patch: unknown) { patches.push(patch); if (defer) await new Promise<void>(resolve => { finish = resolve; }); },
    onChromeState(callback: typeof publish) { publish = callback; },
  };
  class MenuEvent { constructor(readonly type: string, init: object) { Object.assign(this, init); } }
  const context: any = { window: {}, MouseEvent: MenuEvent, KeyboardEvent: MenuEvent, document: { getElementById: node, body: { classList: { toggle() {} } } } };
  vm.runInNewContext(fs.readFileSync('src/renderer/fileWorkspace.js', 'utf8'), context);
  const workspace = context.window.setupFileWorkspace(bridge);
  const tabStates: unknown[] = [];
  workspace.attachTabs({ setReview(opened: boolean, active: boolean) { tabStates.push([opened, active]); } });
  node('tool-view-changes').events.click();
  assert.equal(JSON.stringify(patches[0]), '{"previewVisible":true,"fileVisible":true}', '文件区收起时查看改动也恢复文件区');
  publish({ previewVisible: true });
  assert.equal(node('monaco').inert, true);
  assert.equal(JSON.stringify(tabStates.at(-1)), '[true,true]');
  await workspace.showEditor();
  publish({ previewVisible: false });
  assert.equal(node('monaco').inert, false);
  assert.equal(JSON.stringify(tabStates.at(-1)), '[true,false]', '切回文件保留改动标签');
  assert.equal(JSON.stringify(patches), '[{"previewVisible":true,"fileVisible":true},{"previewVisible":false}]');
  await workspace.closeReview();
  assert.equal(JSON.stringify(tabStates.at(-1)), '[false,false]', '关闭改动标签不关闭任何文件');
  publish({ previewVisible: true });
  workspace.resetReview();
  assert.equal(JSON.stringify(tabStates.at(-1)), '[false,false]', '切换项目清除旧项目改动标签');
  node('btn-update').events.click();
  assert.equal(JSON.stringify(patches.at(-1)), '{"previewVisible":false}');

  for (const [id, type, extra] of [
    ['sidebar', 'contextmenu', { clientX: 1400, clientY: 300, button: 2 }],
    ['sidebar', 'keydown', { key: 'ContextMenu' }],
    ['sidebar', 'keydown', { key: 'F10', shiftKey: true }],
  ] as const) {
    publish({ previewVisible: true });
    defer = true;
    const target = node(id);
    const previous = target.dispatched.length;
    let prevented = false;
    let stopped = false;
    const action = target.events[type]({ target, ...extra, bubbles: true, cancelable: true,
      preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.equal(target.dispatched.length, previous, '原生预览退出前不能打开 DOM 菜单');
    finish();
    await action;
    assert.equal(target.dispatched.length, previous + 1);
    const replay = target.dispatched.at(-1);
    assert.equal(replay.type, type);
    for (const [key, value] of Object.entries(extra)) assert.equal(replay[key], value, '菜单坐标或键盘方向保持不变');
    defer = false;
  }

});
