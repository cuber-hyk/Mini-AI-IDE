/* 当前工具批次的真实变更，只读展示内存快照，不再提供应用入口。 */
(function () {
  'use strict';
  const bridge = window.previewBridge;
  const el = {};
  for (const name of ['meta', 'status', 'list', 'collapse', 'undo', 'filter', 'detail', 'resizer', 'navigation', 'navigate', 'wrap', 'expand']) el[name] = document.getElementById('pv-' + name);
  if (!bridge || Object.values(el).some(function (value) { return !value; })) return;
  let state = null; let activeId = null; let busy = false;
  let previewWidth = window.innerWidth || 300; let previewMaxWidth = null; let restoreWidth = null; let expanding = false;
  const closed = new Set(); const modes = new Map(); const openedContext = new Set();
  const statuses = { pending: '待执行', applied: '已修改', failed: '失败', skipped: '未执行', undone: '已撤销' };
  const operations = { create: '新建', replace: '局部修改', overwrite: '覆盖全文' };
  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function setStatus(text) { el.status.textContent = text || ''; el.status.hidden = !text; }
  function errorText(error) { return error && error.message ? error.message : String(error || '未知错误'); }
  function matchingRecords() {
    const query = el.filter.value.trim().toLowerCase();
    return (state ? state.records : []).filter(function (record) { return record.path.toLowerCase().includes(query); });
  }
  function stats(record) {
    const result = node('span', 'pv-file-stat');
    if (!record.diff) return result;
    if (record.diff.added) result.appendChild(node('span', 'pv-stat-add', '+' + record.diff.added));
    if (record.diff.removed) result.appendChild(node('span', 'pv-stat-del', '−' + record.diff.removed));
    return result;
  }
  function branch(label, key, className) {
    const box = node('details', className); box.open = !closed.has(key);
    const summary = node('summary'); summary.dataset.focusKey = key;
    summary.appendChild(node('span', 'pv-file-label', label));
    const children = node('ul'); box.appendChild(summary); box.appendChild(children);
    box.addEventListener('toggle', function () { if (box.open) closed.delete(key); else closed.add(key); });
    return { box, summary, children };
  }
  function setNavigation(open, restoreFocus) {
    el.navigation.hidden = !open; el.navigate.setAttribute('aria-expanded', String(open));
    if (!open && restoreFocus) el.navigate.focus();
  }
  function recordRow(record, label) {
    const li = node('li', 'pv-file ' + record.status); li.dataset.id = record.id;
    li.classList.toggle('active', record.id === activeId);
    const button = node('button', 'pv-select'); button.type = 'button'; button.dataset.focusKey = 'record:' + record.id;
    button.title = record.path; button.setAttribute('aria-pressed', String(record.id === activeId));
    const row = node('span', 'pv-file-row'); row.appendChild(node('span', 'pv-file-name', label));
    row.appendChild(node('span', 'pv-state', statuses[record.status])); row.appendChild(stats(record));
    button.appendChild(row); button.appendChild(node('span', 'pv-file-sub', operations[record.operation] + ' · ' + record.requestId));
    button.addEventListener('click', function () {
      activeId = record.id; refresh();
      const target = Array.from(el.detail.querySelectorAll('[data-record-id]')).find(function (value) { return value.dataset.recordId === record.id; });
      if (target) target.scrollIntoView({ block: 'start', inline: 'nearest' });
      if (window.innerWidth < 680) setNavigation(false, true);
    });
    li.appendChild(button); return li;
  }
  function renderTree(records) {
    el.list.textContent = '';
    const files = new Map();
    for (const record of records) {
      const filePath = record.path.replace(/\\/g, '/');
      if (!files.has(filePath)) files.set(filePath, []);
      files.get(filePath).push(record);
    }
    if (!files.size) {
      el.list.appendChild(node('li', 'pv-empty', state && state.records.length ? '没有匹配的文件。' : '本批没有文件修改。'));
      return;
    }
    const folders = new Map();
    for (const [filePath, recordsOfFile] of files) {
      const parts = filePath.split('/'); const label = parts.pop();
      let parent = el.list; let prefix = '';
      for (const part of parts.filter(Boolean)) {
        prefix += part + '/';
        if (!folders.has(prefix)) {
          const folder = branch(part, 'dir:' + prefix, 'pv-folder');
          const wrapper = node('li'); wrapper.appendChild(folder.box); parent.appendChild(wrapper); folders.set(prefix, folder.children);
        }
        parent = folders.get(prefix);
      }
      if (recordsOfFile.length === 1) parent.appendChild(recordRow(recordsOfFile[0], label));
      else {
        const group = branch(label, 'file:' + filePath, 'pv-file-group'); group.summary.title = filePath;
        group.summary.appendChild(node('span', 'pv-file-count', recordsOfFile.length + ' 次'));
        recordsOfFile.forEach(function (record, index) { group.children.appendChild(recordRow(record, '修改 ' + (index + 1))); });
        const wrapper = node('li'); wrapper.appendChild(group.box); parent.appendChild(wrapper);
      }
    }
  }
  function lineRow(line) {
    const row = node('div', 'pv-line ' + line.kind);
    row.appendChild(node('span', 'pv-line-number', line.oldLine === null ? '' : String(line.oldLine)));
    row.appendChild(node('span', 'pv-line-number', line.newLine === null ? '' : String(line.newLine)));
    row.appendChild(node('span', 'pv-line-mark', line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '));
    row.appendChild(node('span', 'pv-line-text', line.text)); return row;
  }
  function snapshotLines(text) {
    if (!text.length) return [];
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
  function contextBlock(diff, record, lines, oldStart, newStart, count) {
    if (count <= 0) return;
    const key = record.id + ':' + oldStart + ':' + newStart + ':' + count;
    const block = node('details', 'pv-context'); block.open = openedContext.has(key);
    const summary = node('summary', '', count + ' 行未改动 · 点击' + (block.open ? '收起' : '展开')); summary.dataset.focusKey = 'context:' + key;
    const content = node('div', 'pv-context-lines'); let filled = false;
    function fill() {
      if (filled) return; filled = true;
      for (let index = 0; index < count; index++) content.appendChild(lineRow({ kind: 'context', oldLine: oldStart + index, newLine: newStart + index, text: lines[oldStart + index - 1] }));
    }
    if (block.open) fill();
    block.appendChild(summary); block.appendChild(content);
    block.addEventListener('toggle', function () {
      if (block.open) { openedContext.add(key); fill(); } else openedContext.delete(key);
      summary.textContent = count + ' 行未改动 · 点击' + (block.open ? '收起' : '展开');
    });
    diff.appendChild(block);
  }
  function renderDiff(record, section) {
    if (!record.diff || record.before === record.after) { section.appendChild(node('div', 'pv-empty', '文件内容没有变化。')); return; }
    if (record.diff.identical) {
      section.appendChild(node('div', 'pv-hint', '仅换行格式或末尾换行发生变化，可在修改前／修改后查看完整文本。')); return;
    }
    const diff = node('div', 'pv-diff'); diff.setAttribute('aria-label', '实际文件差异');
    const oldLines = snapshotLines(record.before); let oldCursor = 1; let newCursor = 1;
    for (const hunk of record.diff.hunks) {
      const firstOld = hunk.lines.find(function (line) { return line.oldLine !== null; });
      const firstNew = hunk.lines.find(function (line) { return line.newLine !== null; });
      const gap = Math.min(firstOld ? firstOld.oldLine - oldCursor : 0, firstNew ? firstNew.newLine - newCursor : 0);
      contextBlock(diff, record, oldLines, oldCursor, newCursor, gap);
      diff.appendChild(node('div', 'pv-hunk', '@@ 原 ' + hunk.oldStart + ' · 新 ' + hunk.newStart + ' @@'));
      for (const line of hunk.lines) {
        diff.appendChild(lineRow(line));
        if (line.oldLine !== null) oldCursor = line.oldLine + 1;
        if (line.newLine !== null) newCursor = line.newLine + 1;
      }
    }
    contextBlock(diff, record, oldLines, oldCursor, newCursor, Math.min(record.diff.oldLineCount - oldCursor + 1, record.diff.newLineCount - newCursor + 1));
    section.appendChild(diff);
  }
  function renderDetail(records) {
    el.detail.textContent = '';
    if (!records.length) {
      el.detail.appendChild(node('div', 'pv-empty', state && state.records.length ? '没有匹配的文件。' : '本批没有文件修改。AI 执行新建或修改后可在此查看。')); return;
    }
    for (const record of records) {
      const section = node('article', 'pv-record ' + record.status); section.dataset.recordId = record.id;
      section.classList.toggle('active', record.id === activeId);
      const heading = node('div', 'pv-record-head'); const title = node('div', 'pv-detail-title', record.path); title.title = record.path;
      heading.appendChild(title); heading.appendChild(stats(record)); section.appendChild(heading);
      section.appendChild(node('div', 'pv-detail-range', operations[record.operation] + ' · ' + statuses[record.status] + ' · ' + record.requestId));
      if (record.error) section.appendChild(node('div', 'pv-hint', record.error));
      if (typeof record.before === 'string' && typeof record.after === 'string') {
        const detailMode = modes.get(record.id) || 'diff'; const tabs = node('div', 'pv-detail-tabs');
        for (const [key, label] of [['diff', '差异'], ['before', '修改前'], ['after', '修改后']]) {
          const button = node('button', 'ui-button' + (detailMode === key ? ' selected' : ''), label); button.type = 'button';
          button.dataset.focusKey = 'mode:' + record.id + ':' + key; button.setAttribute('aria-pressed', String(detailMode === key));
          button.addEventListener('click', function () { modes.set(record.id, key); refresh(); }); tabs.appendChild(button);
        }
        section.appendChild(tabs);
        if (detailMode === 'diff') renderDiff(record, section);
        else section.appendChild(node('pre', 'pv-content', record[detailMode]));
      }
      el.detail.appendChild(section);
    }
  }
  function refresh() {
    const focused = document.activeElement;
    const focusKey = focused && focused.dataset ? focused.dataset.focusKey : null;
    const listScroll = el.list.scrollTop; const detailScroll = el.detail.scrollTop;
    const records = matchingRecords(); renderTree(records); renderDetail(records);
    el.navigate.textContent = el.filter.value.trim() ? '文件 · 筛选中' : '文件';
    el.undo.disabled = busy || !state || !state.records.some(function (record) { return record.status === 'applied'; });
    el.list.scrollTop = listScroll; el.detail.scrollTop = detailScroll;
    if (!focusKey) return;
    const candidates = Array.from(el.list.querySelectorAll('[data-focus-key]')).concat(Array.from(el.detail.querySelectorAll('[data-focus-key]')));
    const target = candidates.find(function (value) { return value.dataset.focusKey === focusKey; });
    if (target && !target.hidden && !target.disabled) target.focus({ preventScroll: true });
  }
  function render(next) {
    if (state && next && next.generation < state.generation) return;
    const newBatch = !state || !next || state.generation !== next.generation;
    if (newBatch) { activeId = null; modes.clear(); closed.clear(); openedContext.clear(); setStatus(''); }
    state = next;
    const records = state ? state.records : [];
    el.meta.textContent = new Set(records.map(function (record) { return record.path; })).size + ' 文件';
    el.meta.title = state && state.scope ? '批次 ' + state.scope.batchId : '当前工具批次';
    refresh(); if (newBatch) { el.list.scrollTop = 0; el.detail.scrollTop = 0; }
  }
  el.filter.addEventListener('input', function () { refresh(); el.detail.scrollTop = 0; });
  el.navigate.addEventListener('click', function () { setNavigation(el.navigation.hidden, false); });
  el.navigation.addEventListener('keydown', function (event) { if (event.key === 'Escape') { event.preventDefault(); setNavigation(false, true); } });
  el.wrap.addEventListener('click', function () {
    const enabled = el.wrap.getAttribute('aria-pressed') !== 'true';
    el.wrap.setAttribute('aria-pressed', String(enabled)); el.detail.classList.toggle('wrap', enabled);
  });
  el.collapse.addEventListener('click', async function () {
    try { restoreWidth = null; updateExpand(); await bridge.setPreviewPanel(0); } catch (error) { setStatus('收起失败：' + errorText(error)); }
  });
  el.undo.addEventListener('click', async function () {
    if (busy || el.undo.disabled) return;
    const generation = state.generation; busy = true; refresh();
    try {
      const result = await bridge.undoToolChange();
      if (state && state.generation === generation) setStatus(result && result.ok ? '已撤销最近一次工具修改。' : '撤销失败：' + ((result && result.error) || '未知错误'));
    } catch (error) { if (state && state.generation === generation) setStatus('撤销失败：' + errorText(error)); }
    finally { busy = false; refresh(); }
  });
  function updateExpand() {
    el.expand.textContent = restoreWidth === null ? '展开查看' : '恢复宽度';
    el.expand.setAttribute('aria-pressed', String(restoreWidth !== null));
    el.expand.disabled = expanding || (restoreWidth === null && (previewMaxWidth === null || previewMaxWidth <= previewWidth + 1));
    el.expand.title = el.expand.disabled && !expanding ? '当前窗口没有可展开的宽度' : restoreWidth === null ? '临时拓宽变更列' : '恢复展开前的宽度';
  }
  el.expand.addEventListener('click', async function () {
    if (el.expand.disabled) return;
    const previous = previewWidth; const restoring = restoreWidth !== null;
    const target = restoring ? restoreWidth : Math.min(previewMaxWidth, Math.max(720, previewWidth + 240));
    expanding = true; updateExpand();
    try {
      const result = await bridge.setPreviewPanel(target, true);
      if (result && result.width > 0) previewWidth = result.width;
      restoreWidth = restoring || previewWidth <= previous + 1 ? null : previous;
      el.resizer.setAttribute('aria-valuenow', String(Math.round(previewWidth)));
    } catch (error) { setStatus('调整宽度失败：' + errorText(error)); }
    finally { expanding = false; updateExpand(); }
  });
  let receivedState = false;
  bridge.onReviewState(function (next) { receivedState = true; render(next); });
  bridge.getReviewState().then(function (next) { if (!receivedState) render(next); }).catch(function (error) { setStatus('读取变更失败：' + errorText(error)); });
  if (bridge.onChromeState) bridge.onChromeState(function (value) {
    if (value && value.previewMaxWidth > 0) { previewMaxWidth = value.previewMaxWidth; el.resizer.setAttribute('aria-valuemax', String(Math.round(previewMaxWidth))); }
    if (value && value.previewWidth > 0) { previewWidth = value.previewWidth; el.resizer.setAttribute('aria-valuenow', String(Math.round(previewWidth))); }
    updateExpand();
  });
  let pendingWidth = null; let resizing = false;
  async function requestWidth(width) {
    pendingWidth = Math.min(previewMaxWidth === null ? Infinity : previewMaxWidth, Math.max(260, width));
    if (resizing) return;
    resizing = true;
    try {
      while (pendingWidth !== null) {
        const next = pendingWidth; pendingWidth = null;
        const result = await bridge.setPreviewPanel(next);
        if (result && result.width > 0) { previewWidth = result.width; el.resizer.setAttribute('aria-valuenow', String(Math.round(previewWidth))); updateExpand(); }
      }
    } catch (error) { pendingWidth = null; setStatus('调整宽度失败：' + errorText(error)); }
    finally { resizing = false; }
  }
  let drag = null;
  el.resizer.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.screenX, width: previewWidth }; el.resizer.setPointerCapture(event.pointerId); event.preventDefault();
  });
  el.resizer.addEventListener('pointermove', function (event) { if (drag && drag.id === event.pointerId) void requestWidth(drag.width + drag.x - event.screenX); });
  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    if (event.type === 'pointerup') void requestWidth(drag.width + drag.x - event.screenX);
    drag = null; if (el.resizer.hasPointerCapture(event.pointerId)) el.resizer.releasePointerCapture(event.pointerId);
  }
  el.resizer.addEventListener('pointerup', endDrag); el.resizer.addEventListener('pointercancel', endDrag);
  el.resizer.addEventListener('lostpointercapture', function () { drag = null; });
  el.resizer.addEventListener('keydown', function (event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); void requestWidth(previewWidth + (event.key === 'ArrowLeft' ? 20 : -20));
  });
  updateExpand(); render(null);
})();
