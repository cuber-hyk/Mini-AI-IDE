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
      if (current && !current.previewOnly) current.text = state.currentText;
    }
    function report() {
      sync();
      const tabs = Array.from(documents.values()).map(function (doc) { return { path: doc.path, dirty: !doc.previewOnly && doc.text !== doc.savedText, previewOnly: Boolean(doc.previewOnly) }; });
      bridge.reportEditorState({ root: state.root, path: state.previewOnly ? null : state.currentPath, documents: tabs.filter(function (doc) { return !doc.previewOnly; }).map(function (doc) { return { path: doc.path, dirty: doc.dirty }; }) });
      options.renderTabs(tabs, state.currentPath);
    }
    function activate(doc, focus) {
      sync();
      const current = documents.get(key(state.currentPath));
      if (current) current.viewState = options.captureViewState();
      const previews = Array.from(documents.values()).filter(function (value) { return value.previewOnly && value !== doc; });
      previews.forEach(function (value) { documents.delete(key(value.path)); });
      options.clearDiff();
      state.currentPath = doc ? doc.path : null;
      state.previewOnly = Boolean(doc && doc.previewOnly);
      state.currentText = doc ? doc.text : '';
      state.savedText = doc ? doc.savedText : '';
      options.showDocument(doc, focus);
      previews.forEach(function (value) { options.disposeModel(value.model); });
      options.changed();
      if (doc) options.highlight(doc.path);
    }
    function sameDocument(doc, root, epoch) { return epoch === generation && root === state.root && documents.get(key(doc.path)) === doc; }

    async function open(relPath) {
      if (!state.root) return false;
      relPath = relPath.replace(/\\/g, '/');
      const request = ++openRequest;
      const root = state.root;
      const epoch = generation;
      const existing = documents.get(key(relPath));
      if (existing) { if (!existing.previewOnly) activate(existing, true); return true; }
      try {
        await options.ready();
        if (epoch !== generation || request !== openRequest || root !== state.root) return false;
        const result = await bridge.readFile(relPath);
        if (epoch !== generation || request !== openRequest || root !== state.root) return false;
        if (!result.ok || result.tooLarge) {
          options.setInfo(result.tooLarge ? '文件过大，未载入（上限 ' + result.limit + ' 字符）' : '读取失败：' + (result.error || '未知错误'), true);
          return false;
        }
        const text = result.text || '';
        const doc = { path: relPath, text, savedText: text, model: options.createModel(relPath, text), viewState: null, saving: null, reading: 0 };
        documents.set(key(relPath), doc);
        activate(doc, true);
        options.setInfo(relPath + ' · ' + result.encoding + ' · Ctrl+S 保存');
        return true;
      } catch (error) {
        if (epoch === generation) options.setInfo('打开失败：' + String(error), true);
        return false;
      }
    }

    async function previewNewFile(relPath) {
      if (!state.root) return false;
      relPath = relPath.replace(/\\/g, '/');
      const existing = documents.get(key(relPath));
      if (existing && !existing.previewOnly) { options.setInfo('目标文件已在标签页中打开，请先确认文件状态后重新采集', true); return false; }
      const root = state.root; const epoch = generation; const request = ++openRequest;
      await options.ready();
      if (root !== state.root || epoch !== generation || request !== openRequest) return false;
      const doc = existing || { path: relPath, text: '', savedText: '', model: options.createModel(relPath, ''), viewState: null, saving: null, reading: 0, previewOnly: true };
      documents.set(key(relPath), doc); activate(doc, true); return true;
    }
    function exitPreview() {
      const doc = documents.get(key(state.currentPath));
      if (doc && doc.previewOnly) remove(doc);
    }

    async function save(path) {
      sync();
      const doc = documents.get(key(path || state.currentPath));
      if (!doc || !state.root) return true;
      if (doc.previewOnly) { options.setInfo('新增文件预览尚未写入磁盘，请点击「创建文件」', true); return false; }
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
      options.disposeModel(doc.model);
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

    async function reload(path, confirm, focus) {
      sync(); const doc = documents.get(key(path));
      if (!doc) return focus ? open(path) : false;
      const root = state.root; const epoch = generation; const request = ++doc.reading;
      const navigation = focus ? ++openRequest : openRequest;
      try {
        if (doc.text !== doc.savedText) {
          if (!confirm || !(await bridge.confirmLeave(doc.path, root)).ok) return false;
          if (!sameDocument(doc, root, epoch)) return false;
        }
        sync(); const before = doc.text;
        const result = await bridge.readFile(doc.path);
        sync();
        if (!sameDocument(doc, root, epoch) || request !== doc.reading || doc.text !== before || (focus && navigation !== openRequest)) return false;
        if (!result.ok || result.tooLarge) { options.setInfo('读取失败：' + (result.error || '文件过大'), true); return false; }
        doc.previewOnly = false; doc.text = doc.savedText = result.text || '';
        if (state.currentPath === doc.path) state.previewOnly = false;
        if (state.currentPath === doc.path) { options.clearDiff(); state.currentText = state.savedText = doc.text; }
        options.replaceContent(doc, doc.text);
        if (focus) activate(doc, true); else options.changed();
        return true;
      } catch (error) { if (epoch === generation) options.setInfo('读取失败：' + String(error), true); return false; }
    }
    function clear() {
      generation++; openRequest++;
      const previous = Array.from(documents.values()); documents.clear();
      activate(null, false);
      previous.forEach(function (doc) { options.disposeModel(doc.model); });
    }
    function entryChanged(event) {
      sync(); generation++; openRequest++;
      const affected = Array.from(documents.values()).filter(function (doc) {
        return key(doc.path) === key(event.oldRelPath) || (event.isDirectory && key(doc.path).startsWith(key(event.oldRelPath) + '/'));
      });
      if (!affected.length) return;
      options.clearDiff();
      const ordered = Array.from(documents.values());
      affected.forEach(function (doc) {
        if (event.kind === 'deleted') remove(doc);
        else {
          const wasActive = state.currentPath === doc.path;
          documents.delete(key(doc.path)); doc.path = event.relPath + doc.path.slice(event.oldRelPath.length);
          documents.set(key(doc.path), doc); options.renameModel(doc);
          if (wasActive) state.currentPath = doc.path;
        }
      });
      if (event.kind === 'renamed') { documents.clear(); ordered.forEach(function (doc) { documents.set(key(doc.path), doc); }); }
      options.changed();
    }
    bridge.onEditorRequest(async function (request) {
      if (request.kind === 'save') await bridge.editorReply(request.id, await save(request.path));
    });
    return { open, save, close, reload, clear, entryChanged, report, previewNewFile, exitPreview };
  };
})();
