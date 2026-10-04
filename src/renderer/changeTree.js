/* 变更树的纯显示模型：保留批次索引，筛选不改变应用目标。 */
(function () {
  'use strict';
  function groupFiles(blocks, query) {
    const files = new Map();
    const needle = (query || '').trim().toLowerCase();
    for (const block of blocks || []) {
      const path = (block.filePath || '（未指定文件）').replace(/\\/g, '/');
      if (needle && !path.toLowerCase().includes(needle)) continue;
      if (!files.has(path)) files.set(path, { path, blocks: [], added: 0, removed: 0 });
      const file = files.get(path);
      file.blocks.push(block);
      file.added += block.diff ? block.diff.added : 0;
      file.removed += block.diff ? block.diff.removed : 0;
    }
    return Array.from(files.values());
  }
  function rangeLabel(block) {
    if (!block.range) return '整文件 · ' + block.codeLines + ' 行';
    const old = block.range;
    const delta = block.codeLines - (old.end - old.start + 1);
    const next = block.codeLines > 0 ? old.start + '–' + (old.start + block.codeLines - 1) : '删除该区域';
    return '原 ' + old.start + '–' + old.end + ' → 新 ' + next +
      '（' + (delta > 0 ? '+' : '') + delta + ' 行）';
  }
  function applyEvent(preview, applied, event) {
    if (!preview || !event || event.collectionId !== preview.collectionId || typeof event.index !== 'number') return false;
    if (!(preview.blocks || []).some(function (b) { return b.index === event.index; })) return false;
    if (event.kind === 'applied') applied.add(event.index);
    else if (event.kind === 'undone') applied.delete(event.index);
    else return false;
    return true;
  }
  window.changeTree = { groupFiles, rangeLabel, applyEvent };
})();
