import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';
import { diffTexts } from '../src/shared/diff';
import type { ChangeReviewRecord, ChangeReviewState } from '../src/main/tools/changeReview';

const read = (name: string) => fs.readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8');
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
class Element {
  children: Element[] = []; className = ''; dataset: Record<string, string> = {}; attrs: Record<string, string> = {};
  value = ''; hidden = false; disabled = false; title = ''; type = ''; open = false; scrollTop = 0;
  scrolledIntoView = false;
  private text = ''; listeners: Record<string, Array<(event: any) => any>> = {};
  constructor(public tag = 'div', private onFocus: (element: Element) => void = () => {}) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(n => n.textContent).join(''); }
  get classList() { return { toggle: (name: string, on: boolean) => {
    const classes = new Set(this.className.split(' ').filter(Boolean));
    if (on) classes.add(name); else classes.delete(name); this.className = [...classes].join(' ');
  } }; }
  appendChild(child: Element) { this.children.push(child); return child; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  addEventListener(name: string, listener: (event: any) => any) { (this.listeners[name] ||= []).push(listener); }
  async fire(name: string, event: Record<string, unknown> = {}) {
    await Promise.all((this.listeners[name] || []).map(fn => fn({ type: name, preventDefault() {}, ...event }))); await flush();
  }
  focus() { this.onFocus(this); }
  querySelectorAll(selector: string) { return this.all(e => selector === '[data-focus-key]' ? !!e.dataset.focusKey : selector === '[data-record-id]' && !!e.dataset.recordId); }
  scrollIntoView() { this.scrolledIntoView = true; }
  setPointerCapture() {} hasPointerCapture() { return false; } releasePointerCapture() {}
  all(predicate: (e: Element) => boolean): Element[] { return [this, ...this.children.flatMap(child => child.all(predicate))].filter(predicate); }
}
const record = (id = 'edit:0', filePath = 'src/a.ts'): ChangeReviewRecord => ({ id, requestId: 'edit', path: filePath,
  operation: 'replace', status: 'applied', before: 'old\nkeep\n', after: 'new\nkeep\n', diff: diffTexts('old\nkeep\n', 'new\nkeep\n') });
const state = (records: ChangeReviewRecord[], generation = 1): ChangeReviewState => ({ generation,
  scope: { root: 'C:/project', session: 'chat', batchId: 'batch-' + generation, contentKey: 'contents-' + generation }, records });
function setup(overrides: Record<string, unknown> = {}) {
  let activeElement: Element | null = null;
  const onFocus = (element: Element) => { activeElement = element; };
  const nodes: Record<string, Element> = {};
  for (const name of ['meta', 'status', 'list', 'collapse', 'undo', 'filter', 'detail', 'resizer', 'navigation', 'navigate', 'wrap', 'expand']) nodes[name] = new Element('div', onFocus);
  nodes.navigation.hidden = true; nodes.wrap.attrs['aria-pressed'] = 'true'; nodes.detail.className = 'pv-detail wrap';
  const listeners: Record<string, (value: any) => void> = {}; const widths: number[] = []; const temporary: boolean[] = []; let undoCalls = 0;
  const bridge = {
    onReviewState(fn: (v: any) => void) { listeners.review = fn; },
    async getReviewState() { return state([]); },
    onChromeState(fn: (v: any) => void) { listeners.chrome = fn; },
    async undoToolChange() { undoCalls++; return { ok: true }; },
    async setPreviewPanel(width: number, transient = false) { widths.push(width); temporary.push(transient); return { width, visible: width > 0 }; }, ...overrides,
  };
  const sandbox = { window: { previewBridge: bridge, innerWidth: 300 }, document: {
    get activeElement() { return activeElement; }, getElementById: (id: string) => nodes[id.slice(3)],
    createElement: (tag: string) => new Element(tag, onFocus),
  } };
  vm.runInNewContext(read('preview.js'), sandbox);
  return { nodes, widths, temporary, bridge, focused: () => activeElement, undoCalls: () => undoCalls,
    publish: (value: ChangeReviewState) => listeners.review(value), chrome: (width: number, maxWidth?: number) => listeners.chrome({ previewWidth: width, previewMaxWidth: maxWidth }),
    rows: () => nodes.list.all(e => e.className.split(' ').includes('pv-file')),
    button: (text: string) => nodes.detail.all(e => e.tag === 'button' && e.textContent === text)[0],
  };
}

it('变更查看没有重复应用或改路径入口；无写入工具时明确显示本批无文件修改', async () => {
  const ui = setup(); await flush();
  assert.match(ui.nodes.list.textContent, /本批没有文件修改/); assert.equal(ui.nodes.undo.disabled, true);
  const html = read('preview.html'); assert.doesNotMatch(html, /pv-apply-all|全部应用|changeTree.js/);
  assert.doesNotMatch(read('preview.js'), /applyChange|showDiffInEditor|改路径/);
});
it('按目录与文件聚合，筛选不改变记录身份，实际增删行和快照均可查看', async () => {
  const ui = setup(); ui.publish(state([record(), record('edit:1'), record('docs:0', 'docs/readme.md')]));
  assert.equal(ui.nodes.list.all(e => e.className === 'pv-folder').length, 2);
  assert.equal(ui.nodes.list.all(e => e.className === 'pv-file-group').length, 1);
  assert.equal(ui.nodes.meta.textContent, '2 文件');
  ui.nodes.filter.value = 'README'; await ui.nodes.filter.fire('input');
  assert.equal(ui.rows().length, 1); assert.equal(ui.rows()[0]?.dataset.id, 'docs:0');
  await ui.rows()[0]!.children[0]!.fire('click');
  assert.match(ui.nodes.detail.textContent, /readme.md/); assert.ok(ui.nodes.detail.all(e => e.className === 'pv-line add').length);
  assert.match(ui.rows()[0]!.textContent, /\+1−1/);
  await ui.button('修改前')!.fire('click'); assert.match(ui.nodes.detail.textContent, /old\nkeep\n/);
  await ui.button('修改后')!.fire('click'); assert.match(ui.nodes.detail.textContent, /new\nkeep\n/);
});
it('失败和未执行逐文件显示原因，不伪造差异或提供应用按钮', async () => {
  const ui = setup(); const failed: ChangeReviewRecord = { id: 'edit:0', requestId: 'edit', path: 'a.ts', operation: 'replace', status: 'failed', error: '原文不匹配' };
  ui.publish(state([failed, { ...failed, id: 'edit:1', path: 'b.ts', status: 'skipped', error: '权限拒绝' }]));
  await ui.rows()[0]!.children[0]!.fire('click'); assert.match(ui.nodes.detail.textContent, /失败.*原文不匹配/s);
  assert.equal(ui.button('差异'), undefined); assert.equal(ui.nodes.undo.disabled, true);
  await ui.rows()[1]!.children[0]!.fire('click'); assert.match(ui.nodes.detail.textContent, /未执行.*权限拒绝/s);
});
it('广播保留用户选中项、快照选项及滚动位置，且不会抢走编辑器或网页焦点', async () => {
  const ui = setup(); ui.publish(state([record()]));
  assert.equal(ui.focused(), null); const button = ui.rows()[0]!.children[0]!; button.focus(); await button.fire('click');
  assert.equal(ui.focused(), ui.nodes.navigate);
  await ui.button('修改前')!.fire('click'); ui.button('修改前')!.focus();
  ui.nodes.list.scrollTop = 20; ui.nodes.detail.scrollTop = 70;
  ui.publish(state([record(), record('edit:1', 'b.ts')]));
  assert.equal(ui.focused(), ui.button('修改前')); assert.equal(ui.nodes.list.scrollTop, 20); assert.equal(ui.nodes.detail.scrollTop, 70);
  assert.equal(ui.button('修改前')!.attrs['aria-pressed'], 'true');
});
it('新批次清理选择并直接展示新批快照，旧广播及延迟初次读取不能覆盖新状态', async () => {
  let resolve: (state: ChangeReviewState) => void = () => {};
  const ui = setup({ getReviewState: () => new Promise(yes => { resolve = yes; }) });
  ui.publish(state([record()], 2)); await ui.rows()[0]!.children[0]!.fire('click');
  ui.nodes.detail.scrollTop = 70;
  ui.publish(state([record('next:0', 'next.ts')], 3)); assert.match(ui.nodes.detail.textContent, /next.ts/);
  assert.equal(ui.nodes.detail.scrollTop, 0); assert.equal(ui.nodes.detail.all(e => e.className === 'pv-record applied active').length, 0);
  ui.publish(state([record()], 2)); resolve(state([record()], 1)); await flush();
  assert.equal(ui.rows()[0]?.dataset.id, 'next:0');
});
it('撤销复用工具入口，广播更新状态且保留实际快照，失败清楚反馈并可重试', async () => {
  const ui = setup(); ui.publish(state([record()])); await ui.rows()[0]!.children[0]!.fire('click');
  await ui.nodes.undo.fire('click'); assert.equal(ui.undoCalls(), 1); assert.match(ui.nodes.status.textContent, /已撤销/);
  ui.publish(state([{ ...record(), status: 'undone' }])); assert.equal(ui.nodes.undo.disabled, true);
  assert.match(ui.nodes.detail.textContent, /已撤销/); assert.ok(ui.button('修改前'));
  const failed = setup({ undoToolChange: async () => ({ ok: false, error: '文件已在应用后修改' }) });
  failed.publish(state([record()])); await failed.nodes.undo.fire('click');
  assert.match(failed.nodes.status.textContent, /文件已在应用后修改/); assert.equal(failed.nodes.undo.disabled, false);
});
it('列宽方向键、拖动与收起沿用真实主进程返回值', async () => {
  const ui = setup(); ui.chrome(320);
  await ui.nodes.resizer.fire('keydown', { key: 'ArrowLeft' }); assert.equal(ui.widths[0], 340);
  await ui.nodes.resizer.fire('pointerdown', { button: 0, pointerId: 1, screenX: 800 });
  await ui.nodes.resizer.fire('pointermove', { pointerId: 1, screenX: 760 }); await ui.nodes.resizer.fire('pointerup', { pointerId: 1, screenX: 750 });
  assert.equal(ui.widths.at(-1), 390); assert.equal(ui.nodes.resizer.attrs['aria-valuenow'], '390');
  await ui.nodes.collapse.fire('click'); assert.equal(ui.widths.at(-1), 0);
});
it('文件夹折叠在同批广播中保留，新批次重置；空筛选有明确反馈', async () => {
  const ui = setup(); ui.publish(state([record()]));
  const folder = ui.nodes.list.all(e => e.className === 'pv-folder')[0]!; folder.open = false; await folder.fire('toggle');
  ui.publish(state([record()])); assert.equal(ui.nodes.list.all(e => e.className === 'pv-folder')[0]?.open, false);
  ui.publish(state([record()], 2)); assert.equal(ui.nodes.list.all(e => e.className === 'pv-folder')[0]?.open, true);
  ui.nodes.filter.value = 'missing'; await ui.nodes.filter.fire('input'); assert.match(ui.nodes.list.textContent, /没有匹配的文件/);
});
it('脚本样例按纯文本展示，只有换行变化时不误称完全相同', async () => {
  const ui = setup(); const value = { ...record(), before: '<script>old()</script>\n', after: '<script>new()</script>\n' };
  ui.publish(state([{ ...value, diff: diffTexts(value.before, value.after) }])); await ui.rows()[0]!.children[0]!.fire('click');
  assert.match(ui.nodes.detail.textContent, /<script>new\(\)<\/script>/); assert.equal(ui.nodes.detail.all(e => e.tag === 'script').length, 0);
  ui.publish(state([{ ...record(), before: 'same\r\n', after: 'same\n', diff: diffTexts('same\r\n', 'same\n') }]));
  assert.match(ui.nodes.detail.textContent, /仅换行格式/);
});

it('正文直接连续展示本批所有记录，文件导航只滚到目标并可收起', async () => {
  const ui = setup(); ui.publish(state([record(), record('edit:1', 'docs/long.md')]));
  assert.equal(ui.nodes.navigation.hidden, true);
  assert.equal(ui.nodes.detail.all(e => !!e.dataset.recordId).length, 2);
  assert.match(ui.nodes.detail.textContent, /src\/a.ts.*docs\/long.md/s);
  assert.equal(ui.focused(), null);
  await ui.nodes.navigate.fire('click'); assert.equal(ui.nodes.navigation.hidden, false);
  await ui.rows()[1]!.children[0]!.fire('click');
  const target = ui.nodes.detail.all(e => e.dataset.recordId === 'edit:1')[0]!;
  assert.equal(target.scrolledIntoView, true); assert.equal(ui.nodes.navigation.hidden, true);
  assert.equal(ui.nodes.navigate.attrs['aria-expanded'], 'false'); assert.equal(ui.focused(), ui.nodes.navigate);
  await ui.nodes.navigate.fire('click'); await ui.nodes.navigation.fire('keydown', { key: 'Escape' });
  assert.equal(ui.nodes.navigation.hidden, true); assert.equal(ui.focused(), ui.nodes.navigate);
});

it('每个文件的修改前后选项独立保留，筛选后恢复仍显示真实快照', async () => {
  const ui = setup(); ui.publish(state([record(), record('edit:1', 'b.ts')]));
  await ui.button('修改前')!.fire('click');
  const sections = ui.nodes.detail.all(e => !!e.dataset.recordId);
  assert.ok(sections[0]!.all(e => e.tag === 'pre').length);
  assert.ok(sections[1]!.all(e => e.className === 'pv-line add').length);
  ui.nodes.filter.value = 'b.ts'; await ui.nodes.filter.fire('input');
  assert.equal(ui.nodes.detail.all(e => !!e.dataset.recordId).length, 1);
  assert.equal(ui.nodes.navigate.textContent, '文件 · 筛选中');
  ui.nodes.filter.value = ''; await ui.nodes.filter.fire('input');
  assert.equal(ui.button('修改前')!.attrs['aria-pressed'], 'true');
});

it('长文件未改上下文默认不挂载，主动展开恢复完整行号；同批广播保留展开状态', async () => {
  const ui = setup(); const oldLines = Array.from({ length: 60 }, (_, i) => 'unchanged-' + (i + 1));
  const newLines = [...oldLines]; newLines.splice(10, 0, 'inserted'); newLines[41] = 'changed';
  const before = oldLines.join('\r\n') + '\r\n'; const after = newLines.join('\n') + '\n';
  const value = { ...record(), before, after, diff: diffTexts(before, after) };
  ui.publish(state([value]));
  const blocks = ui.nodes.detail.all(e => e.className === 'pv-context'); assert.equal(blocks.length, 3);
  assert.ok(blocks.every(e => !e.open)); assert.doesNotMatch(ui.nodes.detail.textContent, /unchanged-1\b/);
  for (const block of blocks) { block.open = true; await block.fire('toggle'); }
  const lines = ui.nodes.detail.all(e => e.className.startsWith('pv-line '));
  const original = lines.filter(e => e.children[0]!.textContent !== '').map(e => [Number(e.children[0]!.textContent), e.children[3]!.textContent]);
  const updated = lines.filter(e => e.children[1]!.textContent !== '').map(e => [Number(e.children[1]!.textContent), e.children[3]!.textContent]);
  assert.deepEqual(original, oldLines.map((text, i) => [i + 1, text]));
  assert.deepEqual(updated, newLines.map((text, i) => [i + 1, text]));
  ui.nodes.detail.scrollTop = 200; ui.publish(state([value, record('edit:1', 'b.ts')]));
  assert.equal(ui.nodes.detail.scrollTop, 200);
  assert.ok(ui.nodes.detail.all(e => e.className === 'pv-context').every(e => e.open));
  ui.publish(state([value], 2)); assert.ok(ui.nodes.detail.all(e => e.className === 'pv-context').every(e => !e.open));
});

it('默认自动换行可主动关闭，切换不重建快照或改变阅读位置', async () => {
  const ui = setup(); const value = { ...record(), after: 'very long code '.repeat(300) };
  ui.publish(state([{ ...value, diff: diffTexts(value.before, value.after) }])); ui.nodes.detail.scrollTop = 81;
  const section = ui.nodes.detail.children[0];
  await ui.nodes.wrap.fire('click'); assert.equal(ui.nodes.wrap.attrs['aria-pressed'], 'false');
  assert.doesNotMatch(ui.nodes.detail.className, /\bwrap\b/);
  await ui.nodes.wrap.fire('click'); assert.match(ui.nodes.detail.className, /\bwrap\b/);
  assert.equal(ui.nodes.detail.children[0], section); assert.equal(ui.nodes.detail.scrollTop, 81);
});

it('展开查看遵守窗口最大宽度并以临时模式恢复；无额外空间时禁用', async () => {
  const ui = setup(); assert.equal(ui.nodes.expand.disabled, true);
  ui.chrome(300, 620); assert.equal(ui.nodes.expand.disabled, false);
  await ui.nodes.expand.fire('click'); assert.equal(ui.widths.at(-1), 620); assert.equal(ui.temporary.at(-1), true);
  assert.equal(ui.nodes.expand.textContent, '恢复宽度'); assert.equal(ui.nodes.expand.attrs['aria-pressed'], 'true');
  await ui.nodes.expand.fire('click'); assert.equal(ui.widths.at(-1), 300); assert.equal(ui.temporary.at(-1), true);
  assert.equal(ui.nodes.expand.textContent, '展开查看');
  ui.chrome(300, 300); assert.equal(ui.nodes.expand.disabled, true);
  const count = ui.widths.length; await ui.nodes.expand.fire('click'); assert.equal(ui.widths.length, count);
  ui.chrome(300, 320); await ui.nodes.resizer.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(ui.widths.at(-1), 320); assert.equal(ui.temporary.at(-1), false);
});

it('正文占据余下全高，自动换行样式不允许长行撑宽变更列', () => {
  const html = read('preview.html'); const css = read('preview.css');
  assert.match(html, /id="pv-navigation"[^>]*hidden/); assert.match(html, /id="pv-detail" class="pv-detail wrap"/);
  assert.doesNotMatch(css, /max-height:\s*62%/);
  assert.match(css, /\.pv-detail\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;/);
  assert.match(css, /\.pv-detail\.wrap \.pv-line\s*\{[^}]*min-width:\s*0;/);
});
