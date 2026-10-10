import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

function fixture() {
  function node(rect = { left: 0, top: 0, width: 200, height: 100 }) {
    const listeners = new Map<string, (event: any) => void>();
    return { style: {} as Record<string, string>, attrs: {} as Record<string, string>, hidden: false, focused: false,
      rect, children: [] as any[],
      getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; },
      addEventListener(type: string, fn: (event: any) => void) { listeners.set(type, fn); },
      fire(type: string, extra = {}) { listeners.get(type)?.({ preventDefault() {}, ...extra }); },
      setAttribute(key: string, value: string) { this.attrs[key] = value; },
      contains(other: any): boolean { return this === other || this.children.some(child => child.contains(other)); },
      querySelector() { return this.children[0]; }, focus() { this.focused = true; },
    };
  }
  const nodes = {
    'tool-workspace': node({ left: 600, top: 36, width: 300, height: 500 }),
    'tool-more-wrap': node(),
    'tool-more-toggle': node({ left: 850, top: 41, width: 28, height: 28 }),
    'tool-more': node({ left: 0, top: 0, width: 180, height: 70 }),
    'tool-undo': node(),
  };
  nodes['tool-more-wrap'].children = [nodes['tool-more-toggle'], nodes['tool-more']];
  nodes['tool-more'].children = [nodes['tool-undo']]; nodes['tool-more'].hidden = true;
  const document = { ...node(), getElementById: (id: keyof typeof nodes) => nodes[id] };
  const window = { ...node(), setupToolPanelLayout: null as any };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/toolPanelLayout.js'), 'utf8'), { window, document });
  const layout = window.setupToolPanelLayout();
  return { nodes, document, window, layout };
}

it('工具操作浮层被限制在右侧工具页内部，不改变中间需求 dock 的尺寸', () => {
  const { nodes, layout } = fixture();
  nodes['tool-more-toggle'].fire('click');
  assert.equal(nodes['tool-more'].hidden, false);
  assert.equal(nodes['tool-more-toggle'].attrs['aria-expanded'], 'true');
  assert.equal(nodes['tool-undo'].focused, true);
  assert.deepEqual(nodes['tool-more'].style, { maxHeight: '484px', maxWidth: '284px', left: '698px', top: '44px' });
  nodes['tool-workspace'].rect = { left: 500, top: 36, width: 240, height: 100 };
  layout.refresh();
  assert.deepEqual(nodes['tool-more'].style, { maxHeight: '84px', maxWidth: '224px', left: '552px', top: '44px' });
});

it('Esc 收起浮层并恢复触发按钮焦点，内部点击保留，外部点击和失焦不抢焦点', () => {
  const { nodes, document, window } = fixture();
  const trigger = nodes['tool-more-toggle'];
  trigger.fire('click'); document.fire('keydown', { key: 'Escape' });
  assert.equal(nodes['tool-more'].hidden, true); assert.equal(trigger.attrs['aria-expanded'], 'false'); assert.equal(trigger.focused, true);
  trigger.focused = false; trigger.fire('click'); document.fire('pointerdown', { target: nodes['tool-undo'] });
  assert.equal(nodes['tool-more'].hidden, false);
  document.fire('pointerdown', { target: {} }); assert.equal(nodes['tool-more'].hidden, true); assert.equal(trigger.focused, false);
  trigger.fire('click'); window.fire('blur'); assert.equal(nodes['tool-more'].hidden, true); assert.equal(trigger.focused, false);
});

it('切换工具标签或隐藏操作按钮立即关闭浮层，避免浮层遗留在文件标签上', () => {
  const { nodes, document, layout } = fixture();
  const trigger = nodes['tool-more-toggle'];
  trigger.fire('click'); nodes['tool-workspace'].hidden = true; document.fire('workspace-layout-changed');
  assert.equal(nodes['tool-more'].hidden, true);
  nodes['tool-workspace'].hidden = false; trigger.fire('click'); trigger.hidden = true; layout.refresh();
  assert.equal(nodes['tool-more'].hidden, true); assert.equal(trigger.focused, false);
});
