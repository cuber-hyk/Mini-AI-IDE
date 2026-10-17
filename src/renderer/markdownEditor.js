/** Markdown 原文与历史的唯一内核；排版不参与文件保存。 */
import { Compartment, EditorState, Text } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { markdownLive, markdownPresentation } from './markdownPresentation.js';

export function createMarkdownEditor(options) {
  const host = options.host;
  host.classList.add('markdown-editor');
  const toolbar = document.createElement('div');
  toolbar.className = 'markdown-editor-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Markdown 编辑模式');
  const surface = document.createElement('div');
  surface.className = 'markdown-editor-surface';
  const liveButton = button('实时编辑', () => setMode('live'));
  const sourceButton = button('源码', () => setMode('source'));
  const copyButton = button('复制选区', async () => {
    const selection = getSelection();
    if (!selection) return;
    try { await options.onCopy(selection); }
    catch (error) { options.setInfo('复制失败：' + String(error), true); }
  });
  copyButton.classList.add('markdown-copy-selection');
  toolbar.append(liveButton, sourceButton, copyButton);
  host.append(toolbar, surface);
  let current = null;
  let view = null;
  let composing = false;

  function button(label, action) {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label;
    node.addEventListener('click', action);
    return node;
  }
  function updateToolbar() {
    liveButton.setAttribute('aria-pressed', String(current?.mode === 'live'));
    sourceButton.setAttribute('aria-pressed', String(current?.mode === 'source'));
    liveButton.disabled = sourceButton.disabled = !current || composing;
    copyButton.disabled = !getSelection();
    host.classList.toggle('markdown-source-mode', current?.mode === 'source');
  }
  function dispatch(transactions) {
    if (!current || !view) return;
    const model = current;
    model.state = transactions[transactions.length - 1].state;
    view.update(transactions);
    updateToolbar();
    if (transactions.some(transaction => transaction.docChanged)) options.onChange(model);
  }
  function setMode(mode) {
    if (!current || current.mode === mode || composing || view.compositionStarted) return;
    current.mode = mode;
    view.dispatch({ effects: current.presentation.reconfigure(markdownLive.of(mode === 'live')) });
    view.focus();
  }
  function createState(model, text) {
    const separator = /\r\n/.test(text) ? '\r\n' : /\r/.test(text) ? '\r' : '\n';
    return EditorState.create({
      doc: Text.of(text.split(/\r\n|\r|\n/)),
      extensions: [
        EditorState.lineSeparator.of(separator),
        history(), drawSelection(), bracketMatching(), highlightActiveLine(), lineNumbers(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Markdown 正文', spellcheck: 'false' }),
        EditorView.clipboardInputFilter.of((value, state) => value.replace(/\r\n|\r|\n/g, state.lineBreak)),
        syntaxHighlighting(defaultHighlightStyle),
        markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
        search({ top: true }),
        keymap.of([{ key: 'Mod-s', run() { options.onSave(); return true; } },
          ...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        model.presentation.of(markdownLive.of(model.mode === 'live')),
        markdownPresentation({
          model,
          readImage: options.readImage,
          isCurrent(doc) { return current === model && !model.disposed && model.state.doc === doc; },
        }),
        EditorView.domEventHandlers({
          compositionstart() { composing = true; updateToolbar(); },
          compositionend() { composing = false; updateToolbar(); },
        }),
        EditorView.updateListener.of(update => {
          if (update.selectionSet) updateToolbar();
        }),
      ],
    });
  }
  function createModel(path, text) {
    const model = {
      markdown: true, path, mode: 'live', disposed: false, state: null,
      presentation: new Compartment(), scrollTop: 0, scrollLeft: 0,
      getValue() {
        return model.state.doc.eq(model.originalDoc) ? model.originalText : model.state.sliceDoc();
      },
      getValueLength() {
        if (model.state.doc.eq(model.originalDoc)) return model.originalText.length;
        return model.state.doc.length + (model.state.doc.lines - 1) * (model.state.lineBreak.length - 1);
      },
      setValue(value) {
        if (model.disposed) return;
        const changed = model.getValue() !== value;
        model.state = createState(model, value);
        model.originalDoc = model.state.doc; model.originalText = value;
        model.scrollTop = model.scrollLeft = 0;
        if (current === model) { view.setState(model.state); updateToolbar(); }
        if (changed) options.onChange(model);
      },
      replaceRange(from, to, value) {
        if (model.disposed) return;
        const transaction = model.state.update({ changes: { from, to, insert: Text.of(value.split(/\r\n|\r|\n/)) }, userEvent: 'input' });
        if (current === model) dispatch([transaction]);
        else { model.state = transaction.state; if (transaction.docChanged) options.onChange(model); }
      },
      dispose() {
        if (model.disposed) return;
        if (current === model) clear();
        model.disposed = true; model.state = model.originalDoc = null; model.originalText = '';
      },
    };
    model.state = createState(model, text);
    model.originalDoc = model.state.doc; model.originalText = text;
    return model;
  }
  function captureViewState() {
    if (!current || !view) return null;
    current.scrollTop = view.scrollDOM.scrollTop;
    current.scrollLeft = view.scrollDOM.scrollLeft;
    return { scrollTop: current.scrollTop, scrollLeft: current.scrollLeft };
  }
  function show(model, focus = true) {
    if (!model || model.disposed) { clear(); return; }
    if (current === model && view) { host.hidden = false; layout(); if (focus) view.focus(); return; }
    captureViewState(); current = model; composing = false;
    host.hidden = false;
    if (!view) view = new EditorView({ state: model.state, parent: surface, dispatchTransactions: dispatch });
    else view.setState(model.state);
    view.scrollDOM.scrollTop = model.scrollTop;
    view.scrollDOM.scrollLeft = model.scrollLeft;
    updateToolbar(); layout(); if (focus) view.focus();
  }
  function clear() {
    captureViewState(); current = null; composing = false;
    if (view) { view.destroy(); view = null; }
    host.hidden = true; updateToolbar();
  }
  function getSelection() {
    if (!current || current.disposed) return null;
    const range = current.state.selection.main;
    if (range.empty) return null;
    return { text: current.state.sliceDoc(range.from, range.to), startLine: current.state.doc.lineAt(range.from).number };
  }
  function layout() { if (view && current) view.requestMeasure(); }
  function diagnostics() {
    if (!view || !current) return { ready: false, reason: 'Markdown 编辑器未显示' };
    const style = getComputedStyle(view.contentDOM);
    return { ready: true, mode: current.mode, textLength: current.getValueLength(), hasFocus: view.hasFocus,
      readOnly: current.state.readOnly, wordWrap: 'on', fontFamily: style.fontFamily,
      fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) };
  }
  updateToolbar(); host.hidden = true;
  return { createModel, show, clear, captureViewState, renameModel(model, path) {
    if (model.disposed || model.path === path) return;
    model.path = path;
    const transaction = model.state.update({ effects: model.presentation.reconfigure(markdownLive.of(model.mode === 'live')) });
    if (current === model) dispatch([transaction]); else model.state = transaction.state;
  },
    active() { return current; }, getSelection, focus() { view?.focus(); }, layout,
    find() { if (view) openSearchPanel(view); }, diagnostics };
}
