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
  const context: any = { window: {}, MouseEvent: MenuEvent, KeyboardEvent: MenuEvent, document: { addEventListener() {}, getElementById: node, body: { classList: { toggle() {} } } } };
  vm.runInNewContext(fs.readFileSync('src/renderer/fileWorkspace.js', 'utf8'), context);
  const workspace = context.window.setupFileWorkspace(bridge);
  const tabStates: unknown[] = [];
  workspace.attachTabs({ setReview(opened: boolean, active: boolean) { tabStates.push([opened, active]); }, setTools() {} });
  node('tool-view-changes').events.click();
  assert.equal(JSON.stringify(patches[0]), '{"previewVisible":true,"fileVisible":true}', '文件区收起时查看改动也恢复文件区');
  publish({ previewVisible: true });
  assert.equal(node('monaco').inert, true);
  assert.equal(JSON.stringify(tabStates.at(-1)), '[true,true]');
  await workspace.showEditor();
  publish({ previewVisible: false });
  assert.equal(node('monaco').inert, false);
  assert.equal(JSON.stringify(tabStates.at(-1)), '[true,false]', '切回文件保留改动标签');
  assert.equal(JSON.stringify(patches), '[{"previewVisible":true,"fileVisible":true},{"previewVisible":false,"toolsVisible":false}]');
  await workspace.closeReview();
  assert.equal(JSON.stringify(tabStates.at(-1)), '[false,false]', '关闭改动标签不关闭任何文件');
  publish({ previewVisible: true });
  workspace.resetReview();
  assert.equal(JSON.stringify(tabStates.at(-1)), '[false,false]', '切换项目清除旧项目改动标签');
  node('btn-update').events.click();
  assert.equal(JSON.stringify(patches.at(-1)), '{"previewVisible":false,"toolsVisible":false}');

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

it('关闭工具只隐藏标签，恢复与异常定位保留正文；迟到定位不干扰新导航', async () => {
  const nodes = new Map<string, any>(); const events: Record<string, (event: any) => void> = {};
  function node(id: string): any {
    if (!nodes.has(id)) nodes.set(id, { children: [], events: {}, dataset: {}, open: false, scrollTop: 145, inert: false,
      addEventListener(name: string, fn: any) { this.events[name] = fn; }, scrollIntoView() { this.scrolled = true; }, classList: { add() {} } });
    return nodes.get(id);
  }
  const patches: any[] = []; const tools: any[] = []; let publish!: (value: any) => void; let resolve: (() => void) | undefined;
  const bridge = { onChromeState(fn: any) { publish = fn; }, async setWorkspaceLayout(patch: any) { patches.push(JSON.parse(JSON.stringify(patch))); if (resolve === undefined) return; await new Promise<void>(done => { resolve = done; }); } };
  const context: any = { window: {}, MouseEvent: class {}, KeyboardEvent: class {}, document: { getElementById: node, addEventListener(name: string, fn: any) { events[name] = fn; }, body: { classList: { toggle() {} } } } };
  vm.runInNewContext(fs.readFileSync('src/renderer/fileWorkspace.js', 'utf8'), context);
  const owner = context.window.setupFileWorkspace(bridge);
  owner.attachTabs({ setReview() {}, setTools(open: boolean, active: boolean) { tools.push([open, active]); } });
  const result = node('result'); result.dataset.key = 'failed-request'; node('tool-results').children.push(result);
  events['tool-attention']({ detail: { kind: 'batch' } });
  assert.deepEqual(patches.at(-1), { toolsVisible: true, previewVisible: false, fileVisible: true });
  publish({ toolsVisible: true });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(result.scrolled, undefined); assert.equal(node('tool-message').scrolled, undefined, '批次开始保留阅读位置');
  const openedCount = patches.length;
  events['tool-attention']({ detail: { kind: 'batch' } });
  assert.equal(patches.length, openedCount, '工具页已显示时不重复打开');
  events['tool-attention']({ detail: { key: 'failed-request' } });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(patches.length, openedCount, '工具页已显示时异常只定位，不重复打开');
  assert.equal(result.open, true); result.scrolled = false;
  publish({ toolsVisible: true }); assert.equal(node('monaco').inert, true);
  await owner.closeTools(); publish({ toolsVisible: false });
  assert.deepEqual(tools.at(-1), [false, false]); assert.equal(node('monaco').inert, false);
  assert.equal(node('tool-results').children[0], result); assert.equal(node('tool-results').scrollTop, 145);
  await owner.openTools(); assert.deepEqual(patches.at(-1), { toolsVisible: true, previewVisible: false, fileVisible: true });
  publish({ toolsVisible: true }); publish({ previewVisible: true });
  const before = patches.length; await owner.closeTools(); assert.equal(patches.length, before, '关闭非活动工具不能抢占 Diff');
  events['tool-attention']({ detail: { key: 'failed-request' } }); publish({ toolsVisible: true });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(result.open, true); assert.equal(result.scrolled, true);
  result.scrolled = false; resolve = () => {};
  events['tool-attention']({ detail: { key: 'failed-request' } });
  const finish = resolve!; owner.resetReview(); finish();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(result.scrolled, false, '项目重置后不能定位到旧异常');
});
