import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

const read = (name: string) => fs.readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8');
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
class Element {
  children: Element[] = [];
  className = ''; dataset: Record<string, string> = {}; attrs: Record<string, string> = {};
  value = ''; hidden = false; disabled = false; title = ''; type = ''; open = false; focused = false;
  selectionStart = 0; selectionEnd = 0;
  private text = '';
  listeners: Record<string, Array<(event: any) => any>> = {};
  constructor(public tag = 'div', private onFocus: (element: Element) => void = () => {}) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(n => n.textContent).join(''); }
  get classList() { return { toggle: (name: string, on: boolean) => {
    const classes = new Set(this.className.split(' ').filter(Boolean));
    if (on) classes.add(name); else classes.delete(name); this.className = [...classes].join(' ');
  } }; }
  appendChild(child: Element) { this.children.push(child); return child; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  addEventListener(name: string, listener: (event: any) => any) { (this.listeners[name] ||= []).push(listener); }
  async fire(name: string, event: Record<string, unknown> = {}) {
    await Promise.all((this.listeners[name] || []).map(fn => fn({ type: name, preventDefault() {}, ...event })));
    await flush();
  }
  focus() { this.focused = true; this.onFocus(this); }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  querySelectorAll(selector: string) { return this.all(e => selector === '[data-focus-key]' && !!e.dataset.focusKey); }
  setPointerCapture() {} hasPointerCapture() { return false; } releasePointerCapture() {}
  all(predicate: (e: Element) => boolean): Element[] {
    return [this, ...this.children.flatMap(child => child.all(predicate))].filter(predicate);
  }
}
function block(index: number, filePath = 'src/a.ts', applicable = true) {
  return { index, filePath, range: { start: 10, end: 10 }, codeLines: 10, applicable,
    blockedReason: applicable ? undefined : '内容不匹配', hints: [], diff: { added: 10, removed: 1 } };
}
function setup(overrides: Record<string, unknown> = {}) {
  let activeElement: Element | null = null;
  const onFocus = (element: Element) => { if (activeElement) activeElement.focused = false; activeElement = element; };
  const nodes: Record<string, Element> = {};
  for (const name of ['meta', 'notes', 'list', 'collapse', 'undo', 'apply-all', 'filter', 'detail', 'resizer']) nodes[name] = new Element('div', onFocus);
  const listeners: Record<string, (value: any) => void> = {};
  const writes: any[] = []; const shown: any[] = []; const widths: number[] = [];
  const bridge = {
    onPreviewData(fn: (v: any) => void) { listeners.preview = fn; },
    onAppliedChange(fn: (v: any) => void) { listeners.applied = fn; },
    onActiveDiff(fn: (v: any) => void) { listeners.active = fn; },
    onChromeState(fn: (v: any) => void) { listeners.chrome = fn; },
    async applyChange(input: any) { writes.push(input); return { ok: true, filePath: input.filePath }; },
    async showDiffInEditor(...args: any[]) { shown.push(args); return { ok: true }; },
    async undoSave() { return { ok: true, collectionId: 'batch', index: 9, filePath: 'src/a.ts' }; },
    async setPreviewPanel(width: number) { widths.push(width); return { width, visible: width > 0 }; },
    ...overrides,
  };
  const sandbox = { window: { previewBridge: bridge, innerWidth: 300, changeTree: undefined as any },
    document: { get activeElement() { return activeElement; },
      getElementById: (id: string) => nodes[id.slice(3)], createElement: (tag: string) => new Element(tag, onFocus) } };
  vm.createContext(sandbox); vm.runInContext(read('changeTree.js'), sandbox); vm.runInContext(read('preview.js'), sandbox);
  return { nodes, writes, shown, widths, model: sandbox.window.changeTree,
    focused: () => activeElement,
    preview(blocks = [block(4), block(9)], collectionId = 'batch') { listeners.preview({ ok: true, collectionId, blocks, notes: [] }); },
    publish: (event: any) => listeners.applied(event),
    active: (index: number) => listeners.active(index),
    chrome: (width: number) => listeners.chrome({ previewWidth: width }),
    rows: () => nodes.list.all(e => e.className.split(' ').includes('pv-file')),
    detailButton: (text: string) => nodes.detail.all(e => e.tag === 'button' && e.textContent === text)[0],
  };
}

it('树按目录文件聚合；筛选后预览仍使用原批次的片段 index', async () => {
  const ui = setup(); ui.preview([block(4), block(9), block(21, 'docs/readme.md')]);
  assert.equal(ui.nodes.list.all(e => e.className === 'pv-folder').length, 2);
  assert.equal(ui.nodes.list.all(e => e.className === 'pv-file-group').length, 1);
  ui.nodes.filter.value = 'README'; await ui.nodes.filter.fire('input');
  assert.equal(ui.rows().length, 1); assert.equal(ui.rows()[0].dataset.index, '21');
  await ui.rows()[0].children[0].fire('click');
  assert.deepEqual(Array.from(ui.shown[0]), ['batch', 21]);
});
it('一行替换为十行的范围和增量符合用户的行号预期', () => {
  const ui = setup(); assert.equal(ui.model.rangeLabel(block(4)), '原 10–10 → 新 10–19（+9 行）');
  assert.equal(ui.model.rangeLabel({ ...block(4), codeLines: 1 }), '原 10–10 → 新 10–10（0 行）');
});
it('同文件多片段撤销只复位精确身份；旧批次和无身份广播不污染当前树', () => {
  const ui = setup(); ui.preview();
  ui.publish({ kind: 'applied', collectionId: 'batch', index: 4 });
  ui.publish({ kind: 'applied', collectionId: 'batch', index: 9 });
  ui.publish({ kind: 'undone', collectionId: 'old', index: 4, filePath: 'src/a.ts' });
  ui.publish({ kind: 'undone', filePath: 'src/a.ts' });
  assert.ok(ui.rows().every(e => e.className.includes('done')));
  ui.publish({ kind: 'undone', collectionId: 'batch', index: 9 });
  assert.ok(ui.rows()[0].className.includes('done')); assert.ok(!ui.rows()[1].className.includes('done'));
});
it('集中详情保留改路径；批量应用采用改后路径且跳过已应用的片段', async () => {
  const ui = setup(); ui.preview(); await ui.rows()[1].children[0].fire('click');
  await ui.detailButton('改路径').fire('click');
  const input = ui.nodes.detail.all(e => e.className === 'pv-path')[0];
  input.value = 'src/correct.ts'; await input.fire('input');
  ui.publish({ kind: 'applied', collectionId: 'batch', index: 4 });
  await ui.nodes['apply-all'].fire('click');
  assert.equal(ui.writes.length, 1); assert.equal(ui.writes[0].index, 9); assert.equal(ui.writes[0].filePath, 'src/correct.ts');
  assert.ok(ui.rows()[1].className.includes('done'));
});
it('全部应用含筛选外条目；失败不会中断后续片段，且始终串行', async () => {
  let pending = 0; let max = 0; const attempts: number[] = [];
  const ui = setup({ applyChange: async (input: any) => {
    pending++; max = Math.max(max, pending); attempts.push(input.index); await Promise.resolve(); pending--;
    if (input.index === 4) throw new Error('写盘失败'); return { ok: true, filePath: input.filePath };
  } });
  ui.preview([block(4), block(9, 'docs/readme.md')]); ui.nodes.filter.value = 'docs'; await ui.nodes.filter.fire('input');
  await ui.nodes['apply-all'].fire('click');
  assert.deepEqual(attempts, [4, 9]); assert.equal(max, 1); assert.match(ui.nodes.notes.textContent, /写盘失败/);
  assert.equal(ui.nodes['apply-all'].disabled, false); assert.equal(ui.nodes.undo.disabled, false);
});
it('单次应用拒绝或异常后可重试，阻塞片段可查看原因但没有应用入口', async () => {
  const ui = setup({ applyChange: async () => { throw new Error('断开'); } });
  ui.preview([block(4), block(9, 'src/b.ts', false)]);
  await ui.rows()[0].children[0].fire('click'); await ui.detailButton('应用此片段').fire('click');
  assert.equal(ui.detailButton('应用此片段').disabled, false); assert.match(ui.nodes.notes.textContent, /断开/);
  await ui.rows()[1].children[0].fire('click'); assert.equal(ui.detailButton('应用此片段'), undefined);
  assert.match(ui.nodes.detail.textContent, /内容不匹配/); assert.equal(ui.shown.length, 1);
});
it('更换批次时停止旧批次剩余应用，异步结果不把新条目标为已应用', async () => {
  let resolve: (value: any) => void = () => {}; let calls = 0;
  const ui = setup({ applyChange: () => { calls++; return new Promise(yes => { resolve = yes; }); } });
  ui.preview(); const click = ui.nodes['apply-all'].fire('click'); await flush();
  ui.preview([block(4)], 'new'); resolve({ ok: true, filePath: 'src/a.ts' }); await click;
  assert.equal(calls, 1); assert.ok(!ui.rows()[0].className.includes('done'));
});
it('撤销自身入口与广播幂等，同文件的其他片段维持已应用', async () => {
  const ui = setup(); ui.preview();
  for (const index of [4, 9]) ui.publish({ kind: 'applied', collectionId: 'batch', index });
  await ui.nodes.undo.fire('click'); ui.publish({ kind: 'undone', collectionId: 'batch', index: 9 });
  assert.ok(ui.rows()[0].className.includes('done')); assert.ok(!ui.rows()[1].className.includes('done'));
});
it('列宽可用方向键或拖动调整，主进程返回的真实宽度用于下一次操作', async () => {
  const ui = setup(); ui.chrome(320);
  await ui.nodes.resizer.fire('keydown', { key: 'ArrowLeft' }); assert.equal(ui.widths[0], 340);
  await ui.nodes.resizer.fire('pointerdown', { button: 0, pointerId: 1, screenX: 800 });
  await ui.nodes.resizer.fire('pointermove', { pointerId: 1, screenX: 760 });
  await ui.nodes.resizer.fire('pointerup', { pointerId: 1, screenX: 750 });
  assert.equal(ui.widths.at(-1), 390); assert.equal(ui.nodes.resizer.attrs['aria-valuenow'], '390');
});

it('键盘选中片段后重建树保留同一按钮焦点，activeDiff 广播也不打断键盘操作', async () => {
  const ui = setup(); ui.preview();
  const original = ui.rows()[1].children[0]; original.focus();
  await original.fire('click');
  const selected = ui.rows()[1].children[0];
  assert.notEqual(selected, original); assert.equal(ui.focused(), selected);
  assert.equal(selected.attrs['aria-pressed'], 'true');
  ui.active(9); assert.equal(ui.focused(), ui.rows()[1].children[0]);
});
it('同片段状态广播保留改路径可见态、草稿、焦点和输入光标', async () => {
  const ui = setup(); ui.preview(); await ui.rows()[1].children[0].fire('click');
  await ui.detailButton('改路径').fire('click');
  const original = ui.nodes.detail.all(e => e.className === 'pv-path')[0];
  original.value = 'src/renamed.ts'; await original.fire('input'); original.setSelectionRange(4, 11);
  ui.active(9);
  let input = ui.nodes.detail.all(e => e.className === 'pv-path')[0];
  assert.notEqual(input, original); assert.equal(input.hidden, false); assert.equal(input.value, 'src/renamed.ts');
  assert.equal(ui.focused(), input); assert.deepEqual([input.selectionStart, input.selectionEnd], [4, 11]);
  ui.publish({ kind: 'applied', collectionId: 'batch', index: 4 });
  input = ui.nodes.detail.all(e => e.className === 'pv-path')[0];
  assert.equal(input.hidden, false); assert.equal(ui.focused(), input); assert.equal(input.value, 'src/renamed.ts');
  await input.fire('keydown', { key: 'Escape' });
  assert.equal(input.hidden, true); assert.equal(ui.focused(), ui.detailButton('改路径'));
  ui.active(9); assert.equal(ui.nodes.detail.all(e => e.className === 'pv-path')[0].hidden, true);
});
