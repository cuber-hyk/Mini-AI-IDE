import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

function fixture() {
  function node() {
    const listeners = new Map<string, (event: any) => void>(); const captures = new Set<number>(); const classes = new Set<string>();
    return { style: {} as Record<string, string>, attrs: {} as Record<string, string>, hidden: false, open: false, focused: false,
      height: 30, width: 200, children: [] as any[],
      getBoundingClientRect() { return { height: parseFloat(this.style.height) || this.height, width: this.width, left: 0, right: this.width, top: 400, bottom: 430 }; },
      addEventListener(type: string, fn: (event: any) => void) { listeners.set(type, fn); },
      dispatchEvent(event: {type: string}) { this.fire(event.type); },
      fire(type: string, extra = {}) { const event = { preventDefault() {}, ...extra }; listeners.get(type)?.(event); },
      setAttribute(key: string, value: string) { this.attrs[key] = value; },
      classList: { contains(key: string) { return classes.has(key); }, add(key: string) { classes.add(key); }, remove(key: string) { classes.delete(key); } },
      setPointerCapture(id: number) { captures.add(id); }, hasPointerCapture(id: number) { return captures.has(id); }, releasePointerCapture(id: number) { captures.delete(id); },
      contains(other: any) { return this === other || this.children.includes(other); },
      querySelector() { return this.children[0]; }, focus() { this.focused = true; },
    };
  }
  const ids = ['collaboration-dock','tool-panel','tool-panel-body','tool-resizer','tool-settings-wrap','tool-settings-toggle','tool-settings-panel','tool-settings-close','tool-more-wrap','tool-more-toggle','tool-more','btn-settings'];
  const nodes = Object.fromEntries(ids.map(id => [id, node()]));
  const prompt = node(); prompt.height = 130;
  const toolbar = node(); toolbar.height = 36;
  const heading = node(); heading.height = 38;
  nodes['tool-panel'].children = [heading]; nodes['tool-panel'].classList.add('has-results');
  nodes['tool-settings-wrap'].children = [nodes['tool-settings-toggle'], nodes['tool-settings-panel']];
  nodes['tool-more-wrap'].children = [nodes['tool-more-toggle'], nodes['tool-more']];
  nodes['tool-settings-panel'].hidden = true; nodes['tool-more'].hidden = true;
  nodes['tool-settings-panel'].children = [nodes['tool-settings-close']];
  const document = { ...node(), getElementById: (id: string) => nodes[id], querySelector: (selector: string) => selector === '.prompt-bar' ? prompt : toolbar };
  const window = { ...node(), innerHeight: 600, innerWidth: 420, setupToolPanelLayout: null as any };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/toolPanelLayout.js'), 'utf8'), {
    window, document, Event: class { constructor(readonly type: string) {} }, ResizeObserver: class { observe() {} },
  });
  const layout = window.setupToolPanelLayout();
  return { nodes, document, window, prompt, layout };
}

it('拖动只消费捕获的指针，取消或失焦清理，面板高度始终保留编辑预算', () => {
  const f = fixture(); const { nodes } = f; const handle = nodes['tool-resizer'];
  nodes['tool-panel'].open = true; nodes['tool-panel'].fire('toggle');
  assert.equal(handle.hidden, false); assert.equal(nodes['tool-panel-body'].style.height, '160px');
  handle.fire('pointerdown', { button: 0, pointerId: 1, clientY: 400 });
  handle.fire('pointermove', { pointerId: 2, clientY: 100 }); assert.equal(nodes['tool-panel-body'].style.height, '160px');
  handle.fire('pointermove', { pointerId: 1, clientY: 100 }); assert.equal(nodes['tool-panel-body'].style.height, '252px');
  handle.fire('pointercancel'); assert.equal(handle.hasPointerCapture(1), false);
  f.prompt.height = 286; f.document.fire('prompt-size-changed'); assert.equal(nodes['tool-panel-body'].style.height, '120px');
  handle.fire('pointerdown', { button: 0, pointerId: 3, clientY: 400 }); f.window.fire('blur'); assert.equal(handle.hasPointerCapture(3), false);
  handle.fire('pointermove', { pointerId: 3, clientY: 600 }); assert.equal(nodes['tool-panel-body'].style.height, '120px');
});

it('键盘调整有上下限、关闭面板清理拖动，浮层Esc恢复焦点而外部点击不抢焦点', () => {
  const f = fixture(); const { nodes } = f; const handle = nodes['tool-resizer'];
  nodes['tool-panel'].open = true; nodes['tool-panel'].fire('toggle');
  handle.fire('keydown', { key: 'Home' }); assert.equal(nodes['tool-panel-body'].style.height, '80px');
  handle.fire('keydown', { key: 'ArrowDown' }); assert.equal(handle.attrs['aria-valuenow'], '80');
  handle.fire('keydown', { key: 'End' }); assert.equal(handle.attrs['aria-valuenow'], handle.attrs['aria-valuemax']);
  handle.fire('pointerdown', { button: 0, pointerId: 1, clientY: 400 }); nodes['tool-panel'].open = false; nodes['tool-panel'].fire('toggle');
  assert.equal(handle.hasPointerCapture(1), false); assert.equal(handle.hidden, true);
  nodes['tool-more-toggle'].fire('click'); assert.equal(nodes['tool-more'].hidden, false);
  f.document.fire('keydown', { key: 'Escape' }); assert.equal(nodes['tool-more'].hidden, true); assert.equal(nodes['tool-more-toggle'].focused, true);
  nodes['tool-more-toggle'].focused = false; nodes['tool-more-toggle'].fire('click');
  f.document.fire('pointerdown', { target: {} }); assert.equal(nodes['tool-more-toggle'].focused, false);
  nodes['tool-settings-toggle'].fire('click'); assert.equal(nodes['tool-settings-panel'].hidden, true, '布局 owner 不再打开或计量设置 DOM');
});
