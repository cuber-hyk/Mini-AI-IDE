/**
 * 右下角回程预览面板（渲染进程脚本）
 *
 * 职责：**只罗列被改动的文件**，不再渲染 diff。
 *
 * 为什么不再画逐行 diff（2026-10-03 调整）：用户要的是
 * 「diff 与原文件整合一起显示，而不是分两个板块」——
 * 差异一律内联渲染在左侧编辑器里（删除行标红删除线、新增行插在旁边）。
 * 本面板若继续画一份表格化diff，就等于把同一件事在界面上呈现两遍：
 * 既占空间，又让人误以为有两套"差异"在看。
 *
 * 所以每个条目只回答三件事：**改哪个文件、改哪一段、加了几行删了几行**；
 * 点它 → 左侧编辑器打开该文件并内联标记。应用 / 撤销仍留在这里。
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
    applyAll: document.getElementById('pv-apply-all'),
  };
  if (!bridge || !el.meta || !el.notes || !el.list) {
    return;
  }

  /** 最近一次采集结果（供应用时引用批次与序号） */
  let lastPreview = null;

  function setNotes(lines) {
    el.notes.textContent = (lines || []).filter(Boolean).join('\n');
  }

  /** 把某个条目标为「正在编辑器里预览」 */
  function setActive(index) {
    const items = el.list.querySelectorAll('.pv-file');
    for (let i = 0; i < items.length; i += 1) {
      items[i].classList.toggle('active', index !== null && Number(items[i].dataset.index) === Number(index));
    }
  }

  /**
   * 一个文件 = 一行。
   *
   * 交互分工：
   *  - **单击整行** → 在左侧编辑器内联预览这个文件的 diff（不再有"在编辑器中对比"按钮）
   *  - **右侧「应用」** → 直接落盘，跳过预览（批量快速应用时省一次点击）
   *  - **改路径**   → 收在次级位置。模型偶尔给错路径，这是唯一的纠错入口不能丢，
   *    但多数路径是对的，默认不该占视觉。
   */
  function renderBlock(block) {
    const li = document.createElement('li');
    li.className = 'pv-file' + (block.applicable ? '' : ' blocked');
    li.dataset.index = String(block.index);

    const path = block.filePath || '';
    const row = document.createElement('div');
    row.className = 'pv-file-row';

    /* ---- 左侧：文件名 + 副标题（范围 / 增删）---- */
    const main = document.createElement('div');
    main.className = 'pv-file-main';

    const name = document.createElement('span');
    name.className = 'pv-file-name';
    // 只显示文件名，完整路径放 title —— 面板窄，长路径会挤掉增删统计
    name.textContent = path ? path.split(/[\\/]/).pop() : '（未指定文件）';
    if (path) name.title = path;
    main.appendChild(name);

    const sub = document.createElement('span');
    sub.className = 'pv-file-sub';
    const bits = [];
    bits.push(block.range ? ('行 ' + block.range.start + '-' + block.range.end) : '整文件');
    if (block.diff) {
      if (block.diff.added > 0) bits.push('+' + block.diff.added);
      if (block.diff.removed > 0) bits.push('−' + block.diff.removed);
    }
    sub.textContent = bits.join(' · ');
    main.appendChild(sub);

    row.appendChild(main);

    /* ---- 右侧：增删统计（正负分色）---- */
    if (block.diff && (block.diff.added > 0 || block.diff.removed > 0)) {
      const stat = document.createElement('span');
      stat.className = 'pv-file-stat';
      if (block.diff.added > 0) {
        const a = document.createElement('span');
        a.className = 'pv-stat-add';
        a.textContent = '+' + block.diff.added;
        stat.appendChild(a);
      }
      if (block.diff.removed > 0) {
        const d = document.createElement('span');
        d.className = 'pv-stat-del';
        d.textContent = '−' + block.diff.removed;
        stat.appendChild(d);
      }
      row.appendChild(stat);
    }

    /* ---- 应用按钮：不看预览直接落盘 ---- */
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pv-file-apply';
    btn.textContent = block.applicable ? '应用' : '不可用';
    btn.disabled = !block.applicable;
    if (!block.applicable) btn.dataset.blocked = '1';
    btn.title = block.applicable ? '不看预览，直接把这个文件写入磁盘' : '不满足校验条件，无法应用';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      void applyBlock(block, path, btn);
    });
    row.appendChild(btn);

    li.appendChild(row);

    /* ---- 次级：路径修正 + 提示 / 阻塞原因 ---- */
    const details = document.createElement('div');
    details.className = 'pv-file-details';

    const hints = (block.hints || []).slice();
    if (block.blockedReason) hints.push('阻塞：' + block.blockedReason);
    if (hints.length > 0) {
      const hint = document.createElement('div');
      hint.className = 'pv-hint';
      hint.textContent = hints.join('；');
      details.appendChild(hint);
    }

    if (block.applicable && path) {
      const pathRow = document.createElement('div');
      pathRow.className = 'pv-path-row';

      const pathInput = document.createElement('input');
      pathInput.className = 'pv-path';
      pathInput.type = 'text';
      pathInput.spellcheck = false;
      pathInput.placeholder = '目标文件相对路径';
      pathInput.value = path;
      pathInput.hidden = true;
      // 输入框要阻止冒泡，否则键盘事件会被整行的点击处理抢走
      pathInput.addEventListener('click', function (e) {
        e.stopPropagation();
      });
      pathInput.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') pathInput.hidden = true;
        if (e.key === 'Escape') {
          pathInput.value = path;
          pathInput.hidden = true;
        }
      });
      pathRow.appendChild(pathInput);

      const editPath = document.createElement('button');
      editPath.type = 'button';
      editPath.className = 'pv-link';
      editPath.textContent = '改路径';
      editPath.title = '模型给出的路径不对时点这里改成正确的相对路径';
      editPath.addEventListener('click', function (e) {
        e.stopPropagation();
        pathInput.hidden = !pathInput.hidden;
        if (!pathInput.hidden) pathInput.focus();
      });
      details.appendChild(editPath);
      details.appendChild(pathRow);

      /* 应用时用输入框里的路径（可能已被人工修正） */
      li.__pathInput = pathInput;
    }

    if (details.childNodes.length > 0) li.appendChild(details);

    /* ---- 整行点击 = 在编辑器内联预览 ---- */
    if (block.applicable) {
      li.classList.add('clickable');
      li.title = '点击在左侧编辑器里内联预览这个文件的变更';
      li.addEventListener('click', function () {
        setActive(block.index);
        void bridge.showDiffInEditor(lastPreview.collectionId, block.index);
      });
    }

    return li;
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
    if (preview.noNewContent) {
      el.meta.textContent = '已采集过 · 无新内容 · 原文 ' + (preview.replyText || '').length + ' 字符';
    } else {
      el.meta.textContent =
        '批次 ' + preview.collectionId + ' · ' + blocks.length + ' 个文件 · 原文 ' + (preview.replyText || '').length + ' 字符';
    }

    if (blocks.length === 0) {
      setNotes(preview.notes || []);
      const li = document.createElement('li');
      li.className = 'pv-empty';
      li.textContent = preview.noNewContent
        ? '最新回复与上次采集相同，未产生新的待应用变更。若模型已重新生成，等页面输出完成后再次采集。'
        : '解析出 0 个代码块 —— 见上方诊断信息。';
      el.list.appendChild(li);
      return;
    }

    blocks.forEach(function (block) {
      el.list.appendChild(renderBlock(block));
    });

    setNotes(['点一个文件 → 左侧编辑器内联显示它的变更；确认无误再点「应用此变更」。']);
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
      btn.disabled = true;
      btn.closest('.pv-file')?.classList.add('done');
      setNotes(['已应用 ' + result.filePath + '（模式 ' + result.mode + '）—— 可点右上「撤销」回退']);
      return;
    }
    btn.disabled = false;
    btn.textContent = '应用';
    setNotes(['应用失败：' + ((result && result.error) || '未知错误')]);
  }

  /**
   * 全部应用：把本批次里所有可用的变更依次写入。
   *
   * 为什么顺序执行而不是并发：每个变更都要**单独做三向校验**，
   * 而校验基线是"读文件那一刻的原文"。并发应用会让两次写入基于同一份基线，
   * 后一个可能覆盖前一个的结果 —— 顺序执行才能保证每一步都基于上一步之后的磁盘内容。
   *
   * 单个失败**不中断**整体：某个文件校验不过（文件已变、区间非法），
   * 其余文件仍应能应用，最后统一汇总成功/失败与原因。
   */
  async function applyAllBlocks() {
    if (!lastPreview || lastPreview.ok !== true) return;
    const blocks = (lastPreview.blocks || []).filter(function (b) {
      return b.applicable;
    });
    if (blocks.length === 0) {
      setNotes(['没有可应用的变更']);
      return;
    }

    const btn = el.applyAll;
    btn.disabled = true;
    const originalText = btn.textContent;

    const applied = [];
    const failed = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      const path = block.filePath || '';
      btn.textContent = '应用中 ' + (i + 1) + '/' + blocks.length;
      const result = await bridge.applyChange({
        collectionId: lastPreview.collectionId,
        index: block.index,
        filePath: path,
      });
      if (result && result.ok) applied.push({ index: block.index, filePath: result.filePath || path });
      else failed.push(path + '（' + ((result && result.error) || '未知错误') + '）');
    }

    btn.disabled = false;
    btn.textContent = originalText;

    const names = applied.map(function (a) {
      return a.filePath;
    });
    const notes = ['已应用 ' + applied.length + ' / ' + blocks.length + ' 个文件'];
    if (names.length > 0) notes.push('成功：' + names.join('、'));
    if (failed.length > 0) notes.push('失败：' + failed.join('；'));
    notes.push('可点右上「撤销」逐次回退');
    setNotes(notes);

    markApplied(applied);
  }

  /**
   * 把已成功应用的条目标成「已应用 ✓」。
   * 按 **block.index** 匹配（而不是文件名）—— 用户可能刚用「改路径」修正过路径，
   * 按名字匹配会漏掉；而 index 是这一批里唯一的稳定标识。
   */
  function markApplied(applied) {
    const idx = new Set(applied.map(function (a) {
      return Number(a.index);
    }));
    const items = el.list.querySelectorAll('.pv-file');
    for (let i = 0; i < items.length; i += 1) {
      const node = items[i];
      if (!idx.has(Number(node.dataset.index))) continue;
      const btn = node.querySelector('.pv-file-apply');
      if (btn) {
        btn.textContent = '已应用 ✓';
        btn.disabled = true;
      }
      node.classList.add('done');
    }
  }

  el.applyAll.addEventListener('click', function () {
    void applyAllBlocks();
  });

  /**
   * 把某个条目标成「已应用 ✓」（按 block.index 匹配）。
   * 供**本面板自己的**应用按钮，以及主进程广播（编辑器入口应用成功）共用。
   */
  function markAppliedIndex(index) {
    const items = el.list.querySelectorAll('.pv-file');
    for (let i = 0; i < items.length; i += 1) {
      const node = items[i];
      if (Number(node.dataset.index) !== Number(index)) continue;
      const btn = node.querySelector('.pv-file-apply');
      if (btn) {
        btn.textContent = '已应用 ✓';
        btn.disabled = true;
      }
      node.classList.add('done');
    }
  }

  /**
   * 撤销后把条目**恢复成可应用**。
   *
   * 快照栈是主进程全局的、不含 collectionId，因此广播只知道 filePath。
   * 先按路径反查条目；查不到（例如路径被改过）就**保守地把全部条目复位** ——
   * 宁可多显示一次"可应用"，也不要让面板停留在"已应用 ✓"的假状态。
   */
  function markUnapplied(filePath) {
    const items = el.list.querySelectorAll('.pv-file');
    let matched = 0;
    if (filePath) {
      for (let i = 0; i < items.length; i += 1) {
        const node = items[i];
        const input = node.__pathInput;
        const shown = (input && input.value) || '';
        const full = node.querySelector('.pv-file-name');
        const name = full ? full.title || full.textContent || '' : '';
        if (shown === filePath || name === filePath || (name && filePath.indexOf(name) >= 0)) {
          resetItem(node);
          matched += 1;
        }
      }
    }
    if (matched === 0) {
      for (let i = 0; i < items.length; i += 1) resetItem(items[i]);
    }
  }

  /** 把一个条目复位成「可应用」 */
  function resetItem(node) {
    const btn = node.querySelector('.pv-file-apply');
    if (btn && !btn.dataset.blocked) {
      btn.textContent = '应用';
      btn.disabled = false;
    }
    node.classList.remove('done');
  }

  el.collapse.addEventListener('click', function () {
    void bridge.setPreviewPanel(0);
  });

  el.undo.addEventListener('click', async function () {
    const result = await bridge.undoSave();
    setNotes([
      result && result.ok
        ? '已撤销对 ' + result.filePath + ' 的上一次应用'
        : '撤销失败：' + ((result && result.error) || '没有可撤销的变更'),
    ]);
    // 主进程也会广播 appliedChange，这里主动复位一次，避免广播未到时的短暂假状态
    if (result && result.ok) markUnapplied(result.filePath);
  });

  bridge.onPreviewData(function (preview) {
    render(preview);
  });

  /**
   * 主进程广播：某个变更已被应用 / 被撤销。
   *
   * 覆盖**编辑器入口**的应用（本面板不知情的那条路）与撤销，
   * 让面板状态与磁盘保持一致（用户实测："在左侧编辑器中应用代码后，
   * 右下角的采集应用状态没有同步更新"）。
   */
  bridge.onAppliedChange(function (event) {
    if (!event || typeof event !== 'object') return;
    if (event.kind === 'applied' && typeof event.index === 'number') {
      markAppliedIndex(event.index);
      return;
    }
    if (event.kind === 'undone') markUnapplied(event.filePath);
  });

  /**
   * 同步"当前正在编辑器里预览的是哪个文件"的高亮。
   *
   * 编辑器与本面板是**两个独立渲染进程**（进程边界见 ADR-0002），彼此不能直接调用，
   * 因此由主进程在编辑器切换 diff 目标时转发过来。
   * 若没有这条通道，点文件后的高亮就只存在于本面板，
   * 用「上一个/下一个」在编辑器里跳走之后就对不上了。
   */
  bridge.onActiveDiff(function (index) {
    setActive(index === null || index === undefined ? null : Number(index));
  });
})();