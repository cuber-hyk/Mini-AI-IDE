/** 从原文语法范围生成装饰；任何生成的 DOM 都不是文档数据。 */
import { Facet, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { mathRanges, renderMath } from './markdownMath.js';
import { renderMermaid } from './markdownMermaid.js';

export const markdownLive = Facet.define({ combine(values) { return values.length ? values[0] : true; } });

export function selectionTouches(state, from, to) {
  return state.selection.ranges.some(range => range.empty
    ? range.from >= from && range.from <= to
    : range.from < to && range.to > from);
}
function sourceVisible(state, node) {
  for (let parent = node; parent && parent.name !== 'Document'; parent = parent.parent) {
    if (/^(Paragraph|ATXHeading\d|SetextHeading\d|ListItem|Blockquote|Table|FencedCode|CodeBlock)$/.test(parent.name)
      && selectionTouches(state, parent.from, parent.to)) return true;
  }
  return false;
}
function children(node, name) {
  const result = [];
  for (let child = node.firstChild; child; child = child.nextSibling) if (!name || child.name === name) result.push(child);
  return result;
}
function tableInlineParts(state, cell, mathematics) {
  const formulas = mathematics.filter(range => range.from >= cell.from && range.to <= cell.to);
  const styles = [], hidden = [], atomic = formulas.map(math => ({ ...math, part: { tex: math.tex } }));
  function visit(node) {
    // TeX 内部的星号、下划线等归公式；不能让 Markdown 语法消耗它们。
    if (formulas.some(math => node.from >= math.from && node.to <= math.to)) return;
    if (node.name === 'Image') {
      atomic.push({ from: node.from, to: node.to, part: { text: state.doc.sliceString(node.from, node.to),
        styles: [{ tag: 'code', className: 'markdown-inline-code', title: '表格内图片保留源码；点击表格编辑，不自动加载图片' }] } });
      return;
    }
    const tag = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 'del', InlineCode: 'code' }[node.name];
    if (tag) {
      const markers = children(node, node.name === 'InlineCode' ? 'CodeMark' : node.name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark');
      const contentFrom = markers[0]?.to, contentTo = markers[markers.length - 1]?.from;
      // 与 TeX 边界交叉的标记不解释为 Markdown；完整包围公式的强调仍可显示。
      const crossesMath = formulas.some(math => node.from < math.to && node.to > math.from
        && !(contentFrom <= math.from && contentTo >= math.to));
      if (markers.length >= 2 && !crossesMath) {
        styles.push({ from: contentFrom, to: contentTo, tag,
          className: tag === 'code' ? 'markdown-inline-code' : '' });
        for (const marker of markers) hidden.push({ from: marker.from, to: marker.to });
      }
    } else if (node.name === 'Link') {
      const markers = children(node, 'LinkMark'), url = children(node, 'URL')[0];
      if (markers.length >= 2 && url) {
        styles.push({ from: markers[0].to, to: markers[1].from, tag: 'span', className: 'markdown-link',
          title: state.doc.sliceString(url.from, url.to) + ' · 点击表格编辑链接' });
        hidden.push({ from: node.from, to: markers[0].to }, { from: markers[1].from, to: node.to });
      }
    } else if (node.name === 'Escape') hidden.push({ from: node.from, to: node.from + 1 });
    // 行内代码正文不再解释转义或内联语法。
    if (node.name !== 'InlineCode') for (const child of children(node)) visit(child);
  }
  for (const node of children(cell)) visit(node);
  styles.sort((a, b) => a.from - b.from || b.to - a.to);
  atomic.sort((a, b) => a.from - b.from);
  const boundaries = [...new Set([cell.from, cell.to, ...styles.flatMap(range => [range.from, range.to]),
    ...hidden.flatMap(range => [range.from, range.to]), ...atomic.flatMap(range => [range.from, range.to])])].sort((a, b) => a - b);
  const parts = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index], to = boundaries[index + 1];
    const atom = atomic.find(range => range.from === from);
    if (atom) {
      parts.push({ ...atom.part, styles: [...styles.filter(range => range.from <= from && range.to >= atom.to), ...(atom.part.styles || [])] });
    } else if (!atomic.some(range => range.from < to && range.to > from)
      && !hidden.some(range => range.from <= from && range.to >= to)) {
      parts.push({ text: state.doc.sliceString(from, to), styles: styles.filter(range => range.from <= from && range.to >= to) });
    }
  }
  return parts;
}
function appendTablePart(host, part) {
  let content = part.tex === undefined ? document.createTextNode(part.text) : renderMath(part.tex, false);
  for (let index = (part.styles?.length || 0) - 1; index >= 0; index--) {
    const style = part.styles[index];
    const wrapper = document.createElement(style.tag);
    if (style.className) wrapper.className = style.className;
    if (style.title) wrapper.title = style.title;
    wrapper.append(content); content = wrapper;
  }
  host.append(content);
}
function containingRange(sorted, from, to) {
  let low = 0; let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle].from <= from) low = middle + 1; else high = middle;
  }
  const range = sorted[low - 1];
  return range && range.to >= to ? range : null;
}
function editWidget(dom, view, position) {
  dom.tabIndex = 0;
  dom.setAttribute('role', 'button');
  dom.setAttribute('aria-label', '编辑 Markdown 源码');
  dom.title = '点击编辑源码';
  function activate(event) {
    event.preventDefault(); event.stopPropagation();
    view.dispatch({ selection: { anchor: position() }, scrollIntoView: true }); view.focus();
  }
  dom.addEventListener('mousedown', event => { if (event.button === 0) activate(event); });
  dom.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') activate(event); });
  return dom;
}

const renderBinding = Symbol('markdown-render-binding');
class RenderWidget extends WidgetType {
  constructor(kind, source, position, state, context, data = null) {
    super(); this.kind = kind; this.source = source; this.position = position;
    this.doc = state.doc; this.context = context; this.data = data;
    this.path = context.model.path;
  }
  eq(other) {
    return this.kind === other.kind && this.source === other.source && this.position === other.position
      && this.doc === other.doc && this.context.model === other.context.model && this.path === other.path;
  }
  updateDOM(dom, _view, previous) {
    if (this.kind !== previous.kind || this.source !== previous.source
      || this.context.model !== previous.context.model || this.path !== previous.path) return false;
    // 同一个原文块在别处输入后仍有效；更新修订/位置绑定，保留已布局或排队中的 DOM。
    // 异步回调始终读取这个绑定，不能让复用的图表永久等待旧文档身份。
    if (!dom[renderBinding]) return false;
    dom[renderBinding].widget = this;
    return true;
  }
  toDOM(view) {
    const dom = document.createElement(this.kind === 'math-inline' || this.kind === 'image' ? 'span' : 'div');
    dom.className = 'markdown-rendered markdown-rendered-' + this.kind;
    const binding = { widget: this, url: null };
    dom[renderBinding] = binding;
    const isCurrent = () => {
      const widget = binding.widget;
      return dom.isConnected && widget.context.isCurrent(widget.doc) && widget.context.model.path === widget.path;
    };
    if (this.kind.startsWith('math-')) {
      dom.append(renderMath(this.source, this.kind === 'math-display'));
    } else if (this.kind === 'mermaid') {
      // 挂接之后才请求异步布局；关闭、改写和离开块会使宿主失效。
      queueMicrotask(async () => {
        if (!isCurrent()) return;
        await renderMermaid(this.source, dom, isCurrent);
        if (isCurrent()) view.requestMeasure();
      });
    } else if (this.kind === 'code') {
      const pre = document.createElement('pre'); const code = document.createElement('code');
      code.textContent = this.source; pre.append(code);
      if (this.data) { const label = document.createElement('div'); label.className = 'markdown-code-language'; label.textContent = this.data; dom.append(label); }
      dom.append(pre);
    } else if (this.kind === 'table') {
      const table = document.createElement('table');
      this.data.forEach((row, index) => {
        const tr = document.createElement('tr');
        row.forEach(cell => {
          const td = document.createElement(index === 0 ? 'th' : 'td');
          for (const part of cell) appendTablePart(td, part);
          tr.append(td);
        });
        table.append(tr);
      });
      dom.append(table);
    } else if (this.kind === 'image') {
      this.showImage(dom, isCurrent, binding, view);
    } else if (this.kind === 'rule') {
      dom.append(document.createElement('hr'));
    }
    return editWidget(dom, view, () => binding.widget.position);
  }
  showImage(dom, isCurrent, binding, view) {
    const { src, alt } = this.data;
    const fallback = document.createElement('span');
    fallback.className = 'markdown-image-message'; fallback.textContent = alt || '图片';
    dom.append(fallback);
    if (!src || /^(?:[a-z][a-z\d+.-]*:|\/\/|\/|\\)/i.test(src)) {
      fallback.textContent += '（仅显示项目内本地图片）'; return;
    }
    if (!this.context.readImage) { fallback.textContent += '（图片读取不可用）'; return; }
    queueMicrotask(async () => {
      if (!isCurrent()) return;
      try {
        const result = await this.context.readImage(src, this.path);
        if (!isCurrent()) return;
        if (!result.ok || !/^image\/(png|jpeg|gif|webp|bmp|x-icon)$/i.test(result.mimeType || '')) {
          fallback.textContent += '（无法显示此本地图片）'; return;
        }
        const bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes);
        const blob = new Blob([bytes], { type: result.mimeType });
        binding.url = URL.createObjectURL(blob);
        const image = document.createElement('img'); image.alt = alt; image.src = binding.url;
        image.addEventListener('load', () => { if (isCurrent()) { fallback.remove(); dom.append(image); view.requestMeasure(); } });
        image.addEventListener('error', () => { if (isCurrent()) fallback.textContent += '（图片解码失败）'; });
      } catch { if (isCurrent()) fallback.textContent += '（图片读取失败）'; }
    });
  }
  destroy(dom) {
    const binding = dom[renderBinding];
    if (binding?.url) { URL.revokeObjectURL(binding.url); binding.url = null; }
  }
  ignoreEvent() { return true; }
}

class MarkerWidget extends WidgetType {
  constructor(label) { super(); this.label = label; }
  eq(other) { return other.label === this.label; }
  toDOM() { const span = document.createElement('span'); span.className = 'markdown-list-marker'; span.textContent = this.label; return span; }
}
class TaskWidget extends WidgetType {
  constructor(from, checked) { super(); this.from = from; this.checked = checked; }
  eq(other) { return other.from === this.from && other.checked === this.checked; }
  toDOM(view) {
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.checked;
    input.className = 'markdown-task-checkbox'; input.setAttribute('aria-label', this.checked ? '标记任务未完成' : '标记任务完成');
    input.addEventListener('mousedown', event => event.stopPropagation());
    input.addEventListener('change', () => {
      view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: input.checked ? 'x' : ' ' }, userEvent: 'input' });
    });
    return input;
  }
  ignoreEvent() { return true; }
}

const mathCache = new WeakMap();
export function buildMarkdownDecorations(state, context) {
  if (!state.facet(markdownLive)) return Decoration.none;
  const ranges = [];
  const replaced = [];
  const tree = syntaxTree(state);
  let cachedMath = mathCache.get(state.doc);
  if (!cachedMath || cachedMath.tree !== tree) {
    cachedMath = { tree, ranges: mathRanges(state) }; mathCache.set(state.doc, cachedMath);
  }
  const mathematics = cachedMath.ranges;
  let frontmatterEnd = 0;
  const opening = state.doc.line(1).text.replace(/^\uFEFF/, '').trim();
  if (opening === '---' || opening === '+++') {
    for (let number = 2; number <= state.doc.lines; number++) {
      const line = state.doc.line(number);
      frontmatterEnd = line.to;
      if (line.text.trim() === opening) break;
    }
  }
  function mark(from, to, className, attributes) {
    if (from < to) ranges.push(Decoration.mark({ class: className, attributes }).range(from, to));
  }
  function hide(from, to) { if (from < to) ranges.push(Decoration.replace({}).range(from, to)); }
  function replace(from, to, kind, source, position, data, block) {
    ranges.push(Decoration.replace({ widget: new RenderWidget(kind, source, position, state, context, data), block }).range(from, to));
    replaced.push({ from, to });
  }
  const hiddenMath = [];
  for (const math of mathematics) {
    if (!selectionTouches(state, math.from, math.to)) {
      replace(math.from, math.to, math.display ? 'math-display' : 'math-inline', math.tex, math.contentFrom, null, math.display);
      hiddenMath.push(math);
    }
  }
  syntaxTree(state).iterate({ enter(cursor) {
    const node = cursor.node; const name = node.name;
    if (name !== 'Document' && node.from < frontmatterEnd) {
      if (node.to <= frontmatterEnd) return false;
      // 未知 frontmatter 与其语法边界交叠时保持整块源码。
      if (node.from === 0) return false;
    }
    if (name !== 'Document' && containingRange(hiddenMath, node.from, node.to)) return false;
    const active = sourceVisible(state, node);
    if (/^(ATX|Setext)Heading\d$/.test(name)) {
      const level = name.slice(-1);
      for (let line = state.doc.lineAt(node.from); line.from <= node.to;) {
        ranges.push(Decoration.line({ class: 'markdown-heading markdown-heading-' + level }).range(line.from));
        if (line.number === state.doc.lines || line.to >= node.to) break;
        line = state.doc.line(line.number + 1);
      }
    }
    if (name === 'Blockquote') {
      const first = state.doc.lineAt(node.from).number; const last = state.doc.lineAt(node.to).number;
      for (let number = first; number <= last; number++) ranges.push(Decoration.line({ class: 'markdown-quote' }).range(state.doc.line(number).from));
    }
    if (active) return;
    if (name === 'FencedCode' || name === 'CodeBlock') {
      const content = children(node, 'CodeText');
      const code = content.map(part => state.doc.sliceString(part.from, part.to)).join('\n');
      const info = children(node, 'CodeInfo')[0];
      const language = info ? state.doc.sliceString(info.from, info.to).trim() : '';
      const position = content[0]?.from ?? node.from;
      replace(node.from, node.to, /^mermaid(?:\s|$)/i.test(language) ? 'mermaid' : 'code', code, position, language, true);
      return false;
    }
    if (name === 'Table') {
      const rows = children(node).filter(child => child.name === 'TableHeader' || child.name === 'TableRow')
        .map(row => children(row, 'TableCell').map(cell => tableInlineParts(state, cell, mathematics)));
      replace(node.from, node.to, 'table', state.doc.sliceString(node.from, node.to), node.from, rows, true); return false;
    }
    if (name === 'HorizontalRule') { replace(node.from, node.to, 'rule', '', node.from, null, true); return false; }
    if (name === 'Image') {
      const url = children(node, 'URL')[0]; const marks = children(node, 'LinkMark');
      if (url && marks.length >= 2) {
        const src = state.doc.sliceString(url.from, url.to).replace(/^<|>$/g, '');
        const alt = state.doc.sliceString(marks[0].to, marks[1].from);
        replace(node.from, node.to, 'image', state.doc.sliceString(node.from, node.to), node.from + 2, { src, alt }, false);
        return false;
      }
    }
    if (name === 'Link') {
      const marks = children(node, 'LinkMark'); const url = children(node, 'URL')[0];
      if (marks.length >= 2 && url) {
        hide(node.from, marks[0].to); hide(marks[1].from, node.to);
        mark(marks[0].to, marks[1].from, 'markdown-link', { title: state.doc.sliceString(url.from, url.to) + ' · 点击编辑链接' });
        // 标签内部强调仍由语法树处理，URL 与尾部标记已整体隐藏。
      }
    }
    if (name === 'StrongEmphasis') mark(node.from, node.to, 'markdown-strong');
    if (name === 'Emphasis') mark(node.from, node.to, 'markdown-emphasis');
    if (name === 'Strikethrough') mark(node.from, node.to, 'markdown-strike');
    if (name === 'InlineCode') mark(node.from, node.to, 'markdown-inline-code');
    if (/^(HeaderMark|QuoteMark|EmphasisMark|StrikethroughMark|CodeMark)$/.test(name)) hide(node.from, node.to);
    if (name === 'ListMark') {
      const source = state.doc.sliceString(node.from, node.to);
      ranges.push(Decoration.replace({ widget: new MarkerWidget(/^\d/.test(source) ? source : '•') }).range(node.from, node.to));
    }
    if (name === 'TaskMarker') {
      ranges.push(Decoration.replace({ widget: new TaskWidget(node.from, /x/i.test(state.doc.sliceString(node.from, node.to))) }).range(node.from, node.to));
    }
  } });
  // 不透明块（公式、图片、代码等）不得与内部语法装饰交叠。
  const outermost = [];
  replaced.sort((a, b) => a.from - b.from || b.to - a.to);
  for (const block of replaced) {
    if (!outermost.length || block.to > outermost[outermost.length - 1].to) outermost.push(block);
  }
  const filtered = ranges.filter(range => {
    const rendered = range.value.spec.widget instanceof RenderWidget;
    const block = containingRange(outermost, range.from, range.to);
    return !block || (rendered && range.from === block.from && range.to === block.to);
  });
  return Decoration.set(filtered, true);
}

export function markdownPresentation(context) {
  return StateField.define({
    create(state) { return buildMarkdownDecorations(state, context); },
    update(value, transaction) {
      // 解析器的后台语法树更新也会产生事务，不能只监听 docChanged。
      if (transaction.docChanged || transaction.selection || transaction.reconfigured
        || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)) {
        return buildMarkdownDecorations(transaction.state, context);
      }
      return value;
    },
    provide(field) { return EditorView.decorations.from(field); },
  });
}
