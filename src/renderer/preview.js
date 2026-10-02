/**
 * 右下角回程预览面板（渲染进程脚本）
 *
 * 职责：把主进程推来的解析结果渲染成**逐行 diff**，并提供「应用 / 撤销」。
 *
 * 边界：本面板**不能**读写文件、不能访问 Node、不能向网页写入任何内容；
 * 一切落盘都由主进程在收到 apply 请求后、**先做三向校验**再执行。
 */
(function () {
  'use strict';

  const bridge = window.previewBridge;
  const el = {
    meta: document.getElementById('pv-meta'),
    notes: document.getElementById('pv-notes'),
    list: document.getElementById('pv-list'),
    collapse: document.getElementById('pv-collapse'),
    undo: document.getElementById('pv-undo'),
  };
  if (!bridge || !el.meta || !el.notes || !el.list) {
    return;
  }

  /** 最近一次采集结果（供应用时引用批次与序号） */
  let lastPreview = null;

  function tag(text, cls) {
    const s = document.createElement('span');
    s.className = 'pv-tag' + (cls ? ' ' + cls : '');
    s.textContent = text;
    return s;
  }

  function setNotes(lines) {
    el.notes.textContent = (lines || []).filter(Boolean).join('\n');
  }

  /** 渲染一条 hunk（主流编辑器风格：左侧行号 + 增删底色与符号） */
  function renderHunk(hunk) {
    const wrap = document.createElement('div');
    wrap.className = 'pv-hunk';

    const head = document.createElement('div');
    head.className = 'pv-hunk-head';
    head.textContent =
      '@@ -' + hunk.oldStart + ' +' + hunk.newStart + ' @@' + (hunk.added ? '  +' + hunk.added : '') + (hunk.removed ? '  −' + hunk.removed : '');
    wrap.appendChild(head);

    for (const line of hunk.lines) {
      const row = document.createElement('div');
      row.className = 'pv-line ' + line.kind;

      const oldNo = document.createElement('span');
      oldNo.className = 'pv-no';
      oldNo.textContent = line.oldLine === null ? '' : String(line.oldLine);
      row.appendChild(oldNo);

      const newNo = document.createElement('span');
      newNo.className = 'pv-no new';
      newNo.textContent = line.newLine === null ? '' : String(line.newLine);
      row.appendChild(newNo);

      const sign = document.createElement('span');
      sign.className = 'pv-sign';
      sign.textContent = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
      row.appendChild(sign);

      const text = document.createElement('span');
      text.className = 'pv-text';
      text.textContent = line.text.length > 0 ? line.text : ' ';
      row.appendChild(text);

      wrap.appendChild(row);
    }
    return wrap;
  }

  function render(preview) {
    lastPreview = preview;
    el.list.textContent = '';

    if (!preview || preview.ok !== true) {
      el.meta.textContent = '采集失败';
      setNotes([(preview && preview.error) || '未采集到回复'].concat((preview && preview.notes) || []));
      const li = document.createElement('li');
      li.className = 'pv-empty';
      li.textContent = '没有可应用的变更。检查右侧是否已输出代码块，或点工具栏「采集回复」重试。';
      el.list.appendChild(li);
      return;
    }

    const blocks = preview.blocks || [];
    el.meta.textContent =
      '批次 ' + preview.collectionId + ' · ' + blocks.length + ' 个变更 · 原文 ' + (preview.replyText || '').length + ' 字符';
    setNotes(preview.notes || []);

    if (blocks.length === 0) {
      const li = document.createElement('li');
      li.className = 'pv-empty';
      li.textContent = '解析出 0 个代码块 —— 见上方诊断信息。';
      el.list.appendChild(li);
      return;
    }

    blocks.forEach(function (block) {
      const li = document.createElement('li');
      li.className = 'pv-item' + (block.applicable ? '' : ' blocked');

      /* ---- 头部：路径输入 + 标签 + 应用按钮 ---- */
      const head = document.createElement('div');
      head.className = 'pv-item-head';

      const pathInput = document.createElement('input');
      pathInput.className = 'pv-path';
      pathInput.type = 'text';
      pathInput.spellcheck = false;
      pathInput.placeholder = '目标文件相对路径';
      pathInput.value = block.filePath || '';
      head.appendChild(pathInput);

      head.appendChild(tag(block.range ? '替换 ' + block.range.start + '-' + block.range.end + ' 行' : '整文件替换'));
      if (block.pathSource === 'unique-mention' || block.pathSource === 'none') {
        head.appendChild(tag(block.pathSource, 'weak'));
      }
      if (block.diff) {
        if (block.diff.added > 0) head.appendChild(tag('+' + block.diff.added, 'stat-add'));
        if (block.diff.removed > 0) head.appendChild(tag('−' + block.diff.removed, 'stat-del'));
      }

      const btnCompare = document.createElement('button');
      btnCompare.type = 'button';
      btnCompare.className = 'pv-btn-compare';
      btnCompare.textContent = '在编辑器中对比';
      btnCompare.title = '在左侧编辑器里以差异视图打开（先看 diff 再决定是否应用）';
      btnCompare.addEventListener('click', function () {
        void bridge.showDiffInEditor(lastPreview.collectionId, block.index);
      });
      head.appendChild(btnCompare);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = block.applicable ? '应用' : '不可应用';
      btn.disabled = !block.applicable;
      btn.addEventListener('click', function () {
        void applyBlock(block, pathInput.value.trim(), btn);
      });
      head.appendChild(btn);

      li.appendChild(head);

      /* ---- 提示 / 阻塞原因 ---- */
      const hints = (block.hints || []).slice();
      if (block.blockedReason) hints.push('阻塞：' + block.blockedReason);
      if (hints.length > 0) {
        const hint = document.createElement('div');
        hint.className = 'pv-hint';
        hint.textContent = hints.join('；');
        li.appendChild(hint);
      }

      /* ---- 逐行 diff ---- */
      if (block.diff && block.diff.hunks && block.diff.hunks.length > 0) {
        const hunks = document.createElement('div');
        hunks.className = 'pv-hunks';
        block.diff.hunks.forEach(function (h) {
          hunks.appendChild(renderHunk(h));
        });
        li.appendChild(hunks);
      } else if (block.diff && block.diff.identical) {
        const same = document.createElement('div');
        same.className = 'pv-hint';
        same.textContent = '应用后内容与当前文件完全相同（无差异）';
        li.appendChild(same);
      } else if (!block.applicable) {
        const blocked = document.createElement('div');
        blocked.className = 'pv-hint';
        blocked.textContent = '无法计算差异：' + (block.blockedReason || '目标文件不可用');
        li.appendChild(blocked);
      }

      el.list.appendChild(li);
    });
  }

  async function applyBlock(block, filePath, btn) {
    if (!lastPreview || !lastPreview.collectionId) return;
    if (!filePath) {
      setNotes(['请先填写目标文件路径再应用']);
      return;
    }
    btn.disabled = true;
    btn.textContent = '应用中…';
    const result = await bridge.applyChange({
      collectionId: lastPreview.collectionId,
      index: block.index,
      filePath: filePath,
    });
    if (result && result.ok) {
      btn.textContent = '已应用 ✓';
      setNotes(['已应用 ' + result.filePath + '（模式 ' + result.mode + '）—— 可点右上「撤销」回退']);
      return;
    }
    btn.disabled = false;
    btn.textContent = '应用';
    setNotes(['应用失败：' + ((result && result.error) || '未知错误')]);
  }

  el.collapse.addEventListener('click', function () {
    void bridge.setPreviewPanel(0);
  });

  el.undo.addEventListener('click', async function () {
    const result = await bridge.undoSave();
    setNotes([result && result.ok ? '已撤销对 ' + result.filePath + ' 的上一次应用' : '撤销失败：' + ((result && result.error) || '没有可撤销的变更')]);
  });

  bridge.onPreviewData(function (preview) {
    render(preview);
  });
})();
