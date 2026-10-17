import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { buildMarkdownDecorations, markdownLive, selectionTouches } from '../src/renderer/markdownPresentation.js';

function fixture(text: string, anchor = text.length, live = true) {
  const state = EditorState.create({ doc: text, selection: { anchor },
    extensions: [markdown({ base: markdownLanguage }), markdownLive.of(live)] });
  const ranges: any[] = [];
  buildMarkdownDecorations(state, { model: { path: 'notes/test.md' }, isCurrent: () => true })
    .between(0, text.length, (from: number, to: number, value: any) => { ranges.push({ from, to, spec: value.spec }); });
  return { state, ranges, widgets: ranges.filter(range => range.spec.widget) };
}

it('实时模式排版常规语法，源码模式保持相同原文且无隐藏装饰', () => {
  const text = '# 中文标题\n\n**重要** _倾斜_ ~~完成~~ `const x` [文档](guide.md)\n\n- [x] 已做\n\n尾段';
  const live = fixture(text);
  assert.equal(live.state.doc.toString(), text);
  assert.ok(live.ranges.some(range => range.spec.class === 'markdown-heading markdown-heading-1'));
  assert.ok(live.ranges.some(range => range.spec.class === 'markdown-strong'));
  assert.ok(live.ranges.some(range => range.spec.class === 'markdown-link'));
  assert.ok(live.widgets.some(range => range.spec.widget.checked === true));
  assert.equal(fixture(text, text.length, false).ranges.length, 0);
});

it('光标进入表格或代码块后对应块显示源码，其余块仍渲染', () => {
  const text = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```\n\n尾段';
  const rendered = fixture(text);
  assert.deepEqual(rendered.widgets.map(range => range.spec.widget.kind), ['table', 'mermaid']);
  const table = fixture(text, 3);
  assert.deepEqual(table.widgets.map(range => range.spec.widget.kind), ['mermaid']);
  const graph = fixture(text, text.indexOf('graph'));
  assert.deepEqual(graph.widgets.map(range => range.spec.widget.kind), ['table']);
  assert.equal(graph.state.doc.toString(), text);
});

it('跨块选区保持真实源码范围，不留下遮挡选区的渲染块', () => {
  const text = '| A |\n| --- |\n| 1 |\n\n```js\nconst x = 1;\n```\n\n尾段';
  const f = fixture(text);
  const selected = f.state.update({ selection: { anchor: 0, head: text.length } }).state;
  const decorations = buildMarkdownDecorations(selected, { model: { path: 'a.md' }, isCurrent: () => true });
  let widgetCount = 0;
  decorations.between(0, text.length, (_from: number, _to: number, value: any) => { if (value.spec.widget) widgetCount++; });
  assert.equal(widgetCount, 0);
  assert.equal(selected.sliceDoc(selected.selection.main.from, selected.selection.main.to), text);
});

it('原始 HTML 和 frontmatter 保留原文；公式不与代码装饰重叠', () => {
  const text = '---\ntitle: **raw**\n---\n\n<script>alert(1)</script>\n\n$x^2$\n\n```js\n$x^2$\n```\n\n尾段';
  const f = fixture(text);
  assert.equal(f.state.doc.toString(), text);
  assert.ok(!f.ranges.some(range => range.from < text.indexOf('<script>')));
  assert.equal(f.widgets.filter(range => range.spec.widget.kind === 'math-inline').length, 1);
  assert.equal(f.widgets.filter(range => range.spec.widget.kind === 'code').length, 1);
  assert.ok(!f.widgets.some(range => range.spec.widget.kind === 'html'));
});

it('任务与图片小部件只保存原文位置和原始src，不建立资源导航', () => {
  const text = '- [ ] todo\n\n![图](https://example.com/p.png)\n\n尾段';
  const f = fixture(text);
  const task = f.widgets.find(range => 'checked' in range.spec.widget);
  const image = f.widgets.find(range => range.spec.widget.kind === 'image');
  assert.equal(task.spec.widget.from, 2);
  assert.equal(task.spec.widget.checked, false);
  assert.equal(image.spec.widget.data.src, 'https://example.com/p.png');
  assert.equal(image.spec.widget.path, 'notes/test.md');
  assert.ok(selectionTouches(f.state, text.length, text.length));
});

it('表格内公式归表格DOM渲染，不生成与表格交叠的独立替换范围', () => {
  const text = '| 公式 | 值 |\n| --- | --- |\n| $x^2$ | 4 |\n\n尾段';
  const f = fixture(text);
  assert.deepEqual(f.widgets.map(range => range.spec.widget.kind), ['table']);
  const cells = f.widgets[0].spec.widget.data.flat(2);
  assert.ok(cells.some((part: any) => part.tex === 'x^2'));
  assert.equal(f.state.doc.toString(), text);
});

it('表格单元格以安全DOM渲染强调、代码、删除线、链接及嵌套公式，点击仍编辑原文', () => {
  const text = '| 粗体 | 强调 | 代码 | 删除 | 链接 | 公式 | 图片 |\n| --- | --- | --- | --- | --- | --- | --- |\n'
    + '| **重点** | _强调_ | `const x` | ~~删除~~ | [**文档**](javascript:alert(1)) | **$x^2$** | ![图片](https://example.invalid/x.png) |\n\n尾段';
  const f = fixture(text);
  const widget = f.widgets.find(range => range.spec.widget.kind === 'table').spec.widget;
  const before = globalThis.document;
  const created: string[] = [];
  function element(tag: string, text = ''): any {
    created.push(tag);
    const node: any = { tag, children: [], attributes: {}, handlers: {}, className: '',
      append(...values: any[]) { this.children.push(...values); },
      replaceChildren(...values: any[]) { this.children = values; text = ''; },
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      addEventListener(name: string, callback: any) { this.handlers[name] = callback; },
    };
    node.classList = { add(value: string) { node.className += ' ' + value; } };
    Object.defineProperty(node, 'textContent', {
      get() { return text + node.children.map((child: any) => child.textContent).join(''); },
      set(value) { text = value; node.children = []; },
    });
    return node;
  }
  let transaction: any; let focused = false;
  Object.assign(globalThis, { document: { createElement: element, createTextNode: (text: string) => element('#text', text) } });
  try {
    const dom = widget.toDOM({ dispatch(value: any) { transaction = value; }, focus() { focused = true; } });
    const nodes: any[] = [];
    (function visit(node: any) { nodes.push(node); node.children.forEach(visit); })(dom);
    assert.ok(nodes.some(node => node.tag === 'strong' && node.textContent === '重点'));
    assert.ok(nodes.some(node => node.tag === 'em' && node.textContent === '强调'));
    assert.ok(nodes.some(node => node.tag === 'code' && node.textContent === 'const x'));
    assert.ok(nodes.some(node => node.tag === 'del' && node.textContent === '删除'));
    const link = nodes.find(node => node.className === 'markdown-link');
    assert.equal(link.tag, 'span'); assert.equal(link.textContent, '文档');
    assert.ok(link.children.some((child: any) => child.tag === 'strong'));
    assert.equal(link.attributes.href, undefined);
    assert.ok(nodes.some(node => node.className.includes('markdown-math')));
    assert.ok(!created.some(tag => ['a', 'img', 'script', 'iframe'].includes(tag)));
    assert.ok(nodes.some(node => node.tag === 'code' && node.title?.includes('图片保留源码')));
    assert.ok(!dom.textContent.includes('**重点**')); assert.ok(!dom.textContent.includes('javascript:alert'));
    dom.handlers.mousedown({ button: 0, preventDefault() {}, stopPropagation() {} });
    assert.equal(transaction.selection.anchor, widget.position); assert.equal(focused, true);
    assert.equal(f.state.doc.toString(), text);
  } finally { Object.assign(globalThis, { document: before }); }
});
