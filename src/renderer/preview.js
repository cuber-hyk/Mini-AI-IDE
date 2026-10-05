/* 右列变更树。仅显示本地数据并请求用户明确选择的操作，diff 留在编辑器。 */
(function () {
  'use strict';
  const bridge = window.previewBridge;
  const model = window.changeTree;
  const el = {};
  for (const name of ['meta', 'notes', 'diagnostics', 'status', 'list', 'collapse', 'undo', 'apply-all', 'filter', 'detail', 'resizer']) {
    el[name] = document.getElementById('pv-' + name);
  }
  if (!bridge || !model || Object.values(el).some(function (node) { return !node; })) return;

  let lastPreview = null;
  let activeIndex = null;
  let pathEditingIndex = null;
  let busy = false;
  let diagnosticLines = [];
  const applied = new Set();
  const paths = new Map();
  const unpreviewedPaths = new Set();
  const closed = new Set();
  let previewWidth = window.innerWidth || 300;

  function node(tag, className, text) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  }
  function setNotes(lines) {
    const messages = (lines || []).filter(Boolean);
    el.status.textContent = messages[0] || '';
    el.status.hidden = messages.length === 0;
    el.status.title = messages.join('\n');
    el.notes.textContent = diagnosticLines.concat(messages).join('\n');
    el.diagnostics.hidden = !el.notes.textContent;
  }
  function errorText(error) { return error && error.message ? error.message : String(error || '未知错误'); }
  function stateOf(block) { return block.kind === 'other' ? '只读' : applied.has(block.index) ? '已应用' : block.applicable ? '待应用' : '阻塞'; }
  function pathOf(block) { return paths.has(block.index) ? paths.get(block.index).trim() : block.filePath || ''; }
  function updateButtons() {
    el['apply-all'].disabled = busy || pathEditingIndex !== null || unpreviewedPaths.size > 0 || !lastPreview || !(lastPreview.blocks || []).some(function (b) { return b.applicable && !applied.has(b.index); });
    el.undo.disabled = busy;
  }
  function stats(added, removed) {
    const stat = node('span', 'pv-file-stat');
    if (added) stat.appendChild(node('span', 'pv-stat-add', '+' + added));
    if (removed) stat.appendChild(node('span', 'pv-stat-del', '−' + removed));
    return stat;
  }
  function details(label, key, className) {
    const box = node('details', className);
    box.open = !closed.has(key);
    const title = node('summary');
    title.appendChild(node('span', 'pv-file-label', label));
    const children = node('ul');
    box.appendChild(title); box.appendChild(children);
    box.addEventListener('toggle', function () { if (box.open) closed.delete(key); else closed.add(key); });
    return { box, title, children };
  }
  function blockRow(block, label) {
    const li = node('li', 'pv-file'); li.dataset.index = String(block.index);
    li.classList.toggle('active', block.index === activeIndex);
    li.classList.toggle('done', applied.has(block.index));
    li.classList.toggle('blocked', !block.applicable && block.kind !== 'other');
    const button = node('button', 'pv-select'); button.type = 'button';
    button.dataset.focusKey = 'block:' + block.index;
    button.title = block.kind === 'other' ? '其他内容（只读）' : block.filePath || '未指定文件';
    button.setAttribute('aria-pressed', String(block.index === activeIndex));
    const row = node('span', 'pv-file-row');
    row.appendChild(node('span', 'pv-file-name', label));
    row.appendChild(node('span', 'pv-state', stateOf(block)));
    row.appendChild(stats(block.diff ? block.diff.added : 0, block.diff ? block.diff.removed : 0));
    button.appendChild(row);
    button.appendChild(node('span', 'pv-file-sub', model.rangeLabel(block)));
    button.addEventListener('click', function () { void selectBlock(block); });
    li.appendChild(button); return li;
  }
  function renderTree() {
    el.list.textContent = '';
    const blocks = lastPreview && lastPreview.ok ? lastPreview.blocks || [] : [];
    const files = model.groupFiles(blocks, el.filter.value);
    const other = blocks.filter(function (b) { return b.kind === 'other'; });
    if (!files.length && !other.length) {
      const text = blocks.length ? '没有匹配的文件。' : lastPreview && lastPreview.noNewContent
        ? '回复已采集过，等待新的回复。' : lastPreview && !lastPreview.ok
          ? '采集失败，请查看诊断后重试。' : '采集 AI 回复后，变更会显示在这里。';
      el.list.appendChild(node('li', 'pv-empty', text));
      return;
    }
    const folders = new Map();
    for (const file of files) {
      const parts = file.path.split('/'); const name = parts.pop();
      let parent = el.list; let prefix = '';
      for (const part of parts) {
        prefix += part + '/';
        if (!folders.has(prefix)) {
          const branch = details(part, 'dir:' + prefix, 'pv-folder');
          const wrapper = node('li'); wrapper.appendChild(branch.box); parent.appendChild(wrapper);
          folders.set(prefix, branch.children);
        }
        parent = folders.get(prefix);
      }
      if (file.blocks.length === 1) parent.appendChild(blockRow(file.blocks[0], name));
      else {
        const branch = details(name, 'file:' + file.path, 'pv-file-group');
        branch.title.title = file.path;
        branch.title.appendChild(node('span', 'pv-file-count', String(file.blocks.length) + ' 段'));
        branch.title.appendChild(stats(file.added, file.removed));
        file.blocks.forEach(function (block, i) { branch.children.appendChild(blockRow(block, '片段 ' + (i + 1))); });
        const wrapper = node('li'); wrapper.appendChild(branch.box); parent.appendChild(wrapper);
      }
    }
    if (other.length) {
      const branch = details('其他内容（只读）', 'other', 'pv-other');
      branch.title.appendChild(node('span', 'pv-file-count', other.length + ' 段'));
      other.forEach(function (block, i) { branch.children.appendChild(blockRow(block, '内容 ' + (i + 1))); });
      const wrapper = node('li'); wrapper.appendChild(branch.box); el.list.appendChild(wrapper);
    }
  }
  function renderDetail() {
    el.detail.textContent = '';
    const block = lastPreview && (lastPreview.blocks || []).find(function (b) { return b.index === activeIndex; });
    el.detail.hidden = !block;
    if (!block) return;
    el.detail.appendChild(node('div', 'pv-detail-title', block.kind === 'other' ? '其他内容（只读）' : block.filePath || '未指定文件'));
    el.detail.appendChild(node('div', 'pv-detail-range', model.rangeLabel(block) + ' · ' + stateOf(block)));
    const hints = applied.has(block.index) ? [] : (block.hints || []).slice();
    if (block.locations && block.locations.length > 1) block.locations.forEach(function (location, index) {
      const from = location.oldRange; const to = location.newRange;
      hints.push('替换 ' + (index + 1) + '：原 ' + (from ? from.start + '–' + from.end : '无') + ' → 新 ' + (to ? to.start + '–' + to.end : '删除'));
    });
    if (block.blockedReason && !applied.has(block.index)) hints.push('阻塞：' + block.blockedReason);
    if (hints.length) el.detail.appendChild(node('div', 'pv-hint', hints.join('\n')));
    if (block.kind === 'other') {
      el.detail.appendChild(node('pre', 'pv-content', block.contentText || (block.firstLines || []).map(function (line) { return line.text; }).join('\n')));
      return;
    }
    if (!block.applicable) return;
    const actions = node('div', 'pv-detail-actions');
    const apply = node('button', 'ui-button primary', applied.has(block.index) ? '已应用' : block.operation === 'create' ? '创建文件' : block.operation === 'overwrite' ? '覆盖全文' : '应用此片段');
    apply.dataset.focusKey = 'apply:' + block.index;
    apply.type = 'button'; apply.disabled = busy || applied.has(block.index) || pathEditingIndex === block.index || unpreviewedPaths.has(block.index);
    apply.addEventListener('click', function () { void applyOne(block); }); actions.appendChild(apply);
    const edit = node('button', 'ui-button', '改路径'); edit.type = 'button'; edit.disabled = busy || applied.has(block.index);
    edit.dataset.focusKey = 'edit-path:' + block.index;
    const input = node('input', 'pv-path'); input.type = 'text'; input.spellcheck = false;
    input.dataset.focusKey = 'path:' + block.index;
    input.value = pathOf(block); input.hidden = pathEditingIndex !== block.index; input.setAttribute('aria-label', '目标文件相对路径');
    input.addEventListener('input', function () {
      paths.set(block.index, input.value); unpreviewedPaths.add(block.index); updateButtons();
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { pathEditingIndex = null; input.hidden = true; edit.focus(); void selectBlock(block); }
      if (event.key === 'Escape') {
        paths.delete(block.index); unpreviewedPaths.delete(block.index); input.value = block.filePath || '';
        pathEditingIndex = null; input.hidden = true; updateButtons();
        apply.disabled = busy || applied.has(block.index); edit.focus();
      }
    });
    edit.addEventListener('click', function () {
      input.hidden = !input.hidden; pathEditingIndex = input.hidden ? null : block.index;
      if (!input.hidden) input.focus();
      else void selectBlock(block);
      updateButtons(); apply.disabled = busy || applied.has(block.index) || !input.hidden || unpreviewedPaths.has(block.index);
    });
    actions.appendChild(edit); el.detail.appendChild(actions); el.detail.appendChild(input);
  }
  function refresh() {
    // 广播只更新显示；重建节点后恢复正在操作的同一控件与输入光标。
    const focused = document.activeElement;
    const focusKey = focused && focused.dataset ? focused.dataset.focusKey : null;
    const selectionStart = focused && focused.selectionStart;
    const selectionEnd = focused && focused.selectionEnd;
    renderTree(); renderDetail(); updateButtons();
    if (!focusKey) return;
    const candidates = Array.from(el.list.querySelectorAll('[data-focus-key]'))
      .concat(Array.from(el.detail.querySelectorAll('[data-focus-key]')));
    const target = candidates.find(function (value) { return value.dataset.focusKey === focusKey; });
    if (!target || target.hidden || target.disabled) return;
    target.focus();
    if (typeof selectionStart === 'number' && typeof selectionEnd === 'number' && typeof target.setSelectionRange === 'function') {
      target.setSelectionRange(selectionStart, selectionEnd);
    }
  }
  async function selectBlock(block) {
    const preview = lastPreview;
    activeIndex = block.index; refresh();
    if (!block.applicable || applied.has(block.index)) return;
    const target = pathOf(block);
    try {
      const result = await bridge.showDiffInEditor(preview.collectionId, block.index, target);
      if (lastPreview !== preview || pathOf(block) !== target) return;
      if (!result || !result.ok) setNotes(['预览失败：' + ((result && result.error) || '未知错误')]);
      else if (pathOf(block) === target) { unpreviewedPaths.delete(block.index); refresh(); }
    } catch (error) { if (lastPreview === preview && pathOf(block) === target) setNotes(['预览失败：' + errorText(error)]); }
  }
  function render(preview) {
    if (!lastPreview || !preview || lastPreview.collectionId !== preview.collectionId) {
      applied.clear(); paths.clear(); unpreviewedPaths.clear(); closed.clear(); closed.add('other'); el.diagnostics.open = false; activeIndex = null; pathEditingIndex = null;
    }
    if (lastPreview && preview && lastPreview.collectionId === preview.collectionId) {
      Object.assign(lastPreview, preview); preview = lastPreview;
    }
    lastPreview = preview;
    const blocks = preview && preview.ok ? preview.blocks || [] : [];
    const count = model.groupFiles(blocks.filter(function (b) { return b.filePath && b.kind !== 'other'; }), '').length;
    const others = blocks.filter(function (b) { return b.kind === 'other'; }).length;
    const unresolved = blocks.filter(function (b) { return !b.filePath && b.kind !== 'other'; }).length;
    el.meta.textContent = preview && preview.ok ? count + ' 文件' + (others ? ' · ' + others + ' 段其他内容' : '') + (unresolved ? ' · ' + unresolved + ' 段待补充' : '') : preview ? '采集失败' : '尚未采集';
    el.meta.title = preview ? '批次 ' + preview.collectionId + ' · ' + blocks.length + ' 个片段' : '';
    diagnosticLines = (preview && preview.notes) || [];
    setNotes(preview && preview.error ? ['采集失败：' + preview.error] : []);
    refresh();
  }
  async function requestApply(preview, block) {
    const path = pathOf(block);
    if (!path) return { ok: false, error: '请先填写目标文件路径' };
    try { return await bridge.applyChange({ collectionId: preview.collectionId, index: block.index, filePath: path }); }
    catch (error) { return { ok: false, error: errorText(error) }; }
  }
  async function applyOne(block) {
    if (busy || !lastPreview || !block.applicable || applied.has(block.index) || pathEditingIndex === block.index || unpreviewedPaths.has(block.index)) return;
    const preview = lastPreview;
    busy = true; refresh();
    try {
      const result = await requestApply(preview, block);
      if (lastPreview !== preview) return;
      if (result && result.ok) {
        applied.add(block.index); setNotes(['已应用 ' + result.filePath + '，可撤销。']);
      } else setNotes(['应用失败：' + ((result && result.error) || '未知错误')]);
    } finally { busy = false; refresh(); }
  }
  async function applyAllBlocks() {
    if (busy || !lastPreview || !lastPreview.ok || pathEditingIndex !== null || unpreviewedPaths.size > 0) return;
    const preview = lastPreview;
    const blocks = (preview.blocks || []).filter(function (b) { return b.applicable && !applied.has(b.index); });
    if (!blocks.length) {
      setNotes(['没有待应用片段。'].concat((preview.blocks || []).filter(function (b) { return !b.applicable && b.kind !== 'other'; })
        .map(function (b) { return (b.filePath || '未指定文件') + '：' + (b.blockedReason || '不满足应用条件'); })));
      return;
    }
    busy = true; refresh(); const failed = []; let succeeded = 0;
    try {
      for (let i = 0; i < blocks.length; i += 1) {
        // 采集已更换批次时停止，避免继续应用用户当前看不到的旧批次。
        if (lastPreview !== preview) break;
        const queued = blocks[i];
        const block = (preview.blocks || []).find(function (item) { return item.index === queued.index; });
        if (!block || applied.has(block.index)) continue;
        if (!block.applicable) { failed.push((block.filePath || '未指定文件') + '：' + (block.blockedReason || '不满足应用条件')); continue; }
        el['apply-all'].textContent = '应用中 ' + (i + 1) + '/' + blocks.length;
        const result = await requestApply(preview, block);
        if (result && result.ok) { succeeded += 1; if (lastPreview === preview) applied.add(block.index); }
        else failed.push((block.filePath || '未指定文件') + '：' + ((result && result.error) || '未知错误'));
      }
      if (lastPreview === preview) setNotes(['已应用 ' + succeeded + ' / ' + blocks.length + ' 个片段。'].concat(failed));
    } finally { busy = false; el['apply-all'].textContent = '全部应用'; refresh(); }
  }
  el.filter.addEventListener('input', renderTree);
  el['apply-all'].addEventListener('click', function () { void applyAllBlocks(); });
  el.collapse.addEventListener('click', async function () {
    try { await bridge.setPreviewPanel(0); } catch (error) { setNotes(['收起失败：' + errorText(error)]); }
  });
  el.undo.addEventListener('click', async function () {
    if (busy) return; busy = true; refresh();
    try {
      const result = await bridge.undoSave();
      if (result && result.ok) {
        model.applyEvent(lastPreview, applied, { ...result, kind: 'undone' });
        setNotes(['已撤销 ' + result.filePath + ' 的上一次应用。'].concat(result.warning ? [result.warning] : []));
      } else setNotes(['撤销失败：' + ((result && result.error) || '没有可撤销的变更')]);
    } catch (error) { setNotes(['撤销失败：' + errorText(error)]); }
    finally { busy = false; refresh(); }
  });
  bridge.onPreviewData(render);
  if (bridge.onInvalidateChanges) bridge.onInvalidateChanges(function (event) {
    if (event.all) { render(null); setNotes(['目录已切换，旧目录的变更和撤销记录已清空。']); return; }
    if (!lastPreview || lastPreview.collectionId !== event.collectionId) return;
    (lastPreview.blocks || []).forEach(function (block) {
      const target = pathOf(block).replace(/\\/g, '/').toLowerCase();
      const changedPath = (event.oldRelPath || '').replace(/\\/g, '/').toLowerCase();
      if ((event.indices || []).includes(block.index) || (changedPath && (target === changedPath || (event.isDirectory && target.startsWith(changedPath + '/'))))) {
        block.applicable = false; block.blockedReason = '目标已重命名或删除，请重新采集'; applied.delete(block.index);
        if (activeIndex === block.index) activeIndex = null;
      }
    });
    setNotes(['相关目标已变化，受影响的变更和撤销记录已失效，请重新采集。']); refresh();
  });
  bridge.onAppliedChange(function (event) { if (model.applyEvent(lastPreview, applied, event)) refresh(); });
  bridge.onActiveDiff(function (index) {
    activeIndex = index === null || index === undefined ? null : Number(index);
    if (lastPreview) {
      const block = (lastPreview.blocks || []).find(function (b) { return b.index === activeIndex; });
      if (block) {
        let prefix = ''; const parts = (block.filePath || '').replace(/\\/g, '/').split('/'); parts.pop();
        for (const part of parts) { prefix += part + '/'; closed.delete('dir:' + prefix); }
        closed.delete('file:' + (block.filePath || '').replace(/\\/g, '/'));
      }
    }
    refresh();
  });
  if (bridge.onChromeState) bridge.onChromeState(function (state) {
    if (state && state.previewMaxWidth > 0) el.resizer.setAttribute('aria-valuemax', String(Math.round(state.previewMaxWidth)));
    if (state && state.previewWidth > 0) {
      previewWidth = state.previewWidth;
      el.resizer.setAttribute('aria-valuenow', String(Math.round(previewWidth)));
    }
  });

  // 串行合并拖动请求，最终宽度以主进程返回值为准。
  let pendingWidth = null; let resizing = false;
  async function requestWidth(width) {
    pendingWidth = Math.max(260, width);
    if (resizing) return;
    resizing = true;
    try {
      while (pendingWidth !== null) {
        const next = pendingWidth; pendingWidth = null;
        const result = await bridge.setPreviewPanel(next);
        if (result && result.width > 0) {
          previewWidth = result.width; el.resizer.setAttribute('aria-valuenow', String(Math.round(previewWidth)));
        }
      }
    } catch (error) { pendingWidth = null; setNotes(['调整宽度失败：' + errorText(error)]); }
    finally { resizing = false; }
  }
  let drag = null;
  el.resizer.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.screenX, width: previewWidth };
    el.resizer.setPointerCapture(event.pointerId); event.preventDefault();
  });
  el.resizer.addEventListener('pointermove', function (event) {
    if (drag && drag.id === event.pointerId) void requestWidth(drag.width + drag.x - event.screenX);
  });
  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    if (event.type === 'pointerup') void requestWidth(drag.width + drag.x - event.screenX);
    drag = null;
    if (el.resizer.hasPointerCapture(event.pointerId)) el.resizer.releasePointerCapture(event.pointerId);
  }
  el.resizer.addEventListener('pointerup', endDrag);
  el.resizer.addEventListener('pointercancel', endDrag);
  el.resizer.addEventListener('lostpointercapture', function () { drag = null; });
  el.resizer.addEventListener('keydown', function (event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); void requestWidth(previewWidth + (event.key === 'ArrowLeft' ? 20 : -20));
  });
  updateButtons();
})();
