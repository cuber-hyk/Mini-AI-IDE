/** 多文件缓冲、独立模型生命周期与异步读写；Monaco 呈现由入口适配。 */
(function () {
  'use strict';
  window.createEditorWorkspace = function (options) {
    const state = options.state;
    const bridge = options.bridge;
    const documents = new Map();
    let generation = 0;
    let openRequest = 0;
    let closing = false;
    function key(path) { return (path || '').replace(/\\/g, '/').toLowerCase(); }

    function sync() {
      const current = documents.get(key(state.currentPath));
      if (current && !current.kind) current.text = state.currentText;
    }
    function report() {
      sync();
      const tabs = Array.from(documents.values()).map(function (doc) {
        const tab = { path: doc.path, dirty: !doc.kind && doc.text !== doc.savedText };
        if (doc.kind) tab.kind = doc.kind;
        return tab;
      });
      bridge.reportEditorState({ root: state.root, path: state.currentPath, documents: tabs });
      options.renderTabs(tabs, state.currentPath);
    }
    function activate(doc, focus) {
      sync();
      const current = documents.get(key(state.currentPath));
      if (current) current.viewState = options.captureViewState(current);
      state.currentPath = doc ? doc.path : null;
      state.currentKind = doc ? doc.kind : null;
      state.currentText = doc ? doc.text : '';
      state.savedText = doc ? doc.savedText : '';
      options.showDocument(doc, focus);
      options.changed();
      if (doc) options.highlight(doc.path);
    }
    function sameDocument(doc, root, epoch) { return epoch === generation && root === state.root && documents.get(key(doc.path)) === doc; }

    async function read(path, root, kind) {
      if (!kind) return bridge.readFile(path);
      if (kind === 'unsupported') return { ok: true, preview: { ok: false, error: '旧版 Word（.doc）请用系统应用打开' } };
      try { return { ok: true, preview: await bridge.readFilePreview(path, root) }; }
      catch (error) { return { ok: true, preview: { ok: false, error: '预览读取失败：' + String(error) } }; }
    }

    async function open(relPath, focus = true) {
      if (!state.root) return false;
      relPath = relPath.replace(/\\/g, '/');
      const request = ++openRequest;
      const root = state.root;
      const epoch = generation;
      const existing = documents.get(key(relPath));
      if (existing) { activate(existing, focus); return true; }
      try {
        await options.ready();
        if (epoch !== generation || request !== openRequest || root !== state.root) return false;
        const kind = options.kindForPath ? options.kindForPath(relPath) : null;
        const result = await read(relPath, root, kind);
        if (epoch !== generation || request !== openRequest || root !== state.root) return false;
        if (!result.ok || result.tooLarge) {
          options.setInfo(result.tooLarge ? '文件过大，未载入（上限 ' + result.limit + ' 字符）' : '读取失败：' + (result.error || '未知错误'), true);
          return false;
        }
        const text = result.text || '';
        const doc = { path: relPath, kind, preview: result.preview, text, savedText: text, model: kind ? null : options.createModel(relPath, text), viewState: null, saving: null, reading: 0 };
        documents.set(key(relPath), doc);
        activate(doc, focus);
        options.setInfo(relPath + (kind ? ' · 只读预览' : ' · ' + result.encoding + ' · Ctrl+S 保存'));
        return true;
      } catch (error) {
        if (epoch === generation) options.setInfo('打开失败：' + String(error), true);
        return false;
      }
    }

    async function save(path) {
      sync();
      const doc = documents.get(key(path || state.currentPath));
      if (!doc || !state.root || doc.kind) return true;
      if (doc.saving) return doc.saving;
      const root = state.root; const epoch = generation; const target = doc.path; const text = doc.text;
      doc.saving = (async function () {
        try {
          const result = await bridge.writeFile(target, text, root);
          if (!sameDocument(doc, root, epoch) || doc.path !== target) return false;
          if (!result.ok) { options.setInfo('保存失败：' + (result.error || '未知错误'), true); return false; }
          sync(); doc.savedText = text;
          if (state.currentPath === doc.path) state.savedText = text;
          options.changed();
          options.setInfo('已保存 ' + target + ' · ' + (result.byteLength || 0) + ' 字节');
          return doc.text === text;
        } catch (error) {
          if (epoch === generation) options.setInfo('保存失败：' + String(error), true);
          return false;
        } finally { doc.saving = null; }
      })();
      return doc.saving;
    }

    function remove(doc) {
      const paths = Array.from(documents.keys()); const at = paths.indexOf(key(doc.path));
      const active = state.currentPath === doc.path;
      documents.delete(key(doc.path));
      if (active) activate(documents.get(paths[at + 1]) || documents.get(paths[at - 1]) || null, true);
      if (doc.model) options.disposeModel(doc.model);
      doc.preview = null;
      if (!active) options.changed();
    }
    async function close(path) {
      if (closing) return false;
      const doc = documents.get(key(path)); if (!doc) return false;
      closing = true;
      const root = state.root; const epoch = generation;
      sync(); report();
      try {
        if (doc.text !== doc.savedText && !(await bridge.confirmLeave(doc.path, root)).ok) return false;
        if (!sameDocument(doc, root, epoch)) return false;
        // 保存/确认期间切换到其他标签不会使目标草稿丢失。
        remove(doc); return true;
      } finally { closing = false; }
    }

    async function reload(path, confirm, focus, discardDraft) {
      sync(); const doc = documents.get(key(path));
      if (!doc) return focus ? open(path) : false;
      const root = state.root; const epoch = generation; const request = ++doc.reading;
      const navigation = focus ? ++openRequest : openRequest;
      try {
        if (doc.text !== doc.savedText && discardDraft !== true) {
          if (!confirm || !(await bridge.confirmLeave(doc.path, root)).ok) return false;
          if (!sameDocument(doc, root, epoch)) return false;
        }
        sync(); const before = doc.text;
        const result = await read(doc.path, root, doc.kind);
        sync();
        if (!sameDocument(doc, root, epoch) || request !== doc.reading || doc.text !== before || (focus && navigation !== openRequest)) return false;
        if (!result.ok || result.tooLarge) { options.setInfo('读取失败：' + (result.error || '文件过大'), true); return false; }
        doc.text = doc.savedText = result.text || '';
        doc.preview = result.preview;
        if (state.currentPath === doc.path) state.currentText = state.savedText = doc.text;
        options.replaceContent(doc, doc.text);
        if (focus) activate(doc, true); else options.changed();
        return true;
      } catch (error) { if (epoch === generation) options.setInfo('读取失败：' + String(error), true); return false; }
    }
    function clear() {
      generation++; openRequest++;
      const previous = Array.from(documents.values()); documents.clear();
      activate(null, false);
      previous.forEach(function (doc) { if (doc.model) options.disposeModel(doc.model); doc.preview = null; });
    }
    function entryChanged(event) {
      sync(); generation++; openRequest++;
      const affected = Array.from(documents.values()).filter(function (doc) {
        return key(doc.path) === key(event.oldRelPath) || (event.isDirectory && key(doc.path).startsWith(key(event.oldRelPath) + '/'));
      });
      if (!affected.length) return;
      const ordered = Array.from(documents.values());
      let typeChanged = false;
      affected.forEach(function (doc) {
        if (event.kind === 'deleted') remove(doc);
        else {
          const wasActive = state.currentPath === doc.path;
          documents.delete(key(doc.path)); doc.path = event.relPath + doc.path.slice(event.oldRelPath.length);
          documents.set(key(doc.path), doc);
          if (wasActive) state.currentPath = doc.path;
          if (doc.kind && options.kindForPath(doc.path) !== doc.kind) {
            // 只读标签没有草稿；关闭旧呈现，重新打开时按新类型读取。
            remove(doc); typeChanged = true;
          } else options.renameModel(doc);
        }
      });
      if (event.kind === 'renamed') {
        const remaining = new Set(documents.values()); documents.clear();
        ordered.forEach(function (doc) { if (remaining.has(doc)) documents.set(key(doc.path), doc); });
      }
      options.changed();
      if (typeChanged) options.setInfo('文件类型已改变，请重新打开预览');
    }
    bridge.onEditorRequest(async function (request) {
      if (request.kind === 'save') await bridge.editorReply(request.id, await save(request.path));
    });
    return { open, save, close, reload, clear, entryChanged, report };
  };
})();
