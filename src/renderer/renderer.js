/**
 * 编辑器渲染进程
 *
 * 能力边界（ADR-0002）：
 *  - 本进程**没有** Node、没有文件系统、没有网络（CSP 里 connect-src 'none'）；
 *  - 一切文件操作都通过 window.editorBridge（preload 注入的窄接口）；
 *  - 不向右侧网页写入任何内容 —— 实际上本进程与右侧视图无任何通道。
 *
 * Monaco 说明：从 file:// 加载时无法创建 Web Worker（Chromium 限制），
 * 因此这里显式禁用 worker，仅使用内置 tokenizer（语法高亮可用，语言服务不可用）。
 */
(function () {
  'use strict';

  /** @type {import('../shared/contract').EditorBridge} */
  const bridge = window.editorBridge;

  const el = {
    tree: document.getElementById('tree'),
    treeNote: document.getElementById('tree-note'),
    rootLabel: document.getElementById('root-label'),
    info: document.getElementById('info'),
    dirty: document.getElementById('dirty-flag'),
    btnOpen: document.getElementById('btn-open'),
    btnSave: document.getElementById('btn-save'),
    btnFormat: document.getElementById('btn-format'),
    btnSnippet: document.getElementById('btn-snippet'),
    monacoHost: document.getElementById('monaco'),
    resizer: document.getElementById('resizer'),
    requirement: document.getElementById('requirement'),
    targetFiles: document.getElementById('target-files'),
    btnCopyPrompt: document.getElementById('btn-copy-prompt'),
  };

  const state = {
    root: null,
    currentPath: null,
    currentText: '',
    savedText: '',
    editor: null,
    readOnly: true,
  };

  /* ---------------- Monaco 初始化 ---------------- */
  function initMonaco() {
    if (typeof window.require === 'undefined') {
      el.monacoHost.textContent = 'Monaco 未加载（vendor/monaco 缺失）';
      return;
    }
    // 禁用 worker：file:// 下无法创建 Web Worker，禁用后仅失去语言服务，语法高亮仍可用
    window.MonacoEnvironment = {
      getWorker: function () {
        return {
          postMessage: function () {},
          terminate: function () {},
          addEventListener: function () {},
          removeEventListener: function () {},
          onmessage: null,
          onerror: null,
        };
      },
      getWorkerUrl: function () {
        return 'data:text/javascript;charset=utf-8,';
      },
    };

    window.require.config({ paths: { vs: './vendor/monaco/vs' } });
    window.require(['vs/editor/editor.main'], function () {
      state.editor = window.monaco.editor.create(el.monacoHost, {
        value: '',
        language: 'plaintext',
        theme: 'vs-dark',
        readOnly: true,
        automaticLayout: true,
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        tabSize: 2,
      });
      state.editor.onDidChangeModelContent(function () {
        const text = state.editor.getValue();
        if (text !== state.currentText) {
          state.currentText = text;
          renderDirty();
        }
      });
      // Ctrl+S 保存
      state.editor.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyS, function () {
        void save();
      });
      applyReadOnly();
    });
  }

  function applyReadOnly() {
    if (state.editor) state.editor.updateOptions({ readOnly: state.readOnly });
  }

  /* ---------------- 界面渲染 ---------------- */
  function renderRoot() {
    el.rootLabel.textContent = state.root ?? '未打开目录';
    el.rootLabel.title = state.root ?? '';
    el.treeNote.style.display = state.root ? 'none' : 'block';
  }

  function renderDirty() {
    const dirty = state.currentText !== state.savedText;
    el.dirty.textContent = dirty ? '未保存' : '已保存';
    el.dirty.classList.toggle('is-dirty', dirty);
    el.btnSave.disabled = !dirty || !state.currentPath;
  }

  function setInfo(text, warn) {
    el.info.textContent = text;
    el.info.classList.toggle('warn', Boolean(warn));
  }

  function renderTree(entries) {
    el.tree.textContent = '';
    for (const entry of entries) {
      const li = document.createElement('li');
      li.textContent = (entry.isDirectory ? '▸ ' : '  ') + entry.name;
      li.className = entry.isDirectory ? 'dir' : entry.textLike === false ? 'nontext' : 'text';
      li.title = entry.isDirectory ? '目录' : entry.textLike === false ? '可能不是文本文件' : '文本文件';
      li.addEventListener('click', function () {
        if (entry.isDirectory) {
          void loadTree(entry.relPath);
        } else {
          void openFile(entry.relPath, li);
        }
      });
      el.tree.appendChild(li);
    }
  }

  /* ---------------- 数据操作（全部经 bridge） ---------------- */
  async function loadTree(relPath) {
    const result = await bridge.listDir(relPath);
    if (!result.ok) {
      setInfo('列目录失败：' + (result.error ?? '未知错误'), true);
      return;
    }
    renderTree(result.entries);
    setInfo(
      '目录：' + (relPath || '.') + ' · ' + result.entries.length + ' 项' + (result.truncated ? '（已截断）' : '')
    );
  }

  async function openFile(relPath, li) {
    const result = await bridge.readFile(relPath);
    if (!result.ok) {
      setInfo('读取失败：' + (result.error ?? '未知错误'), true);
      return;
    }
    if (result.tooLarge) {
      const meta = result.meta;
      setInfo(
        '文件过大，未载入：' + (meta ? meta.charCount + ' 字符 / ' + meta.lineCount + ' 行' : '') + '（上限 ' + result.limit + '）',
        true
      );
      return;
    }

    state.currentPath = relPath;
    state.savedText = result.text ?? '';
    state.currentText = state.savedText;

    if (state.editor) {
      const model = state.editor.getModel();
      window.monaco.editor.setModelLanguage(model, languageFor(relPath));
      state.editor.setValue(state.savedText);
    } else {
      el.monacoHost.textContent = state.savedText.slice(0, 4000);
    }

    document.querySelectorAll('#tree li.active').forEach((n) => n.classList.remove('active'));
    if (li) li.classList.add('active');

    renderDirty();
    const meta = result.meta;
    const enc = result.encoding + (result.fellBack ? '（UTF-8 校验失败，已回退）' : '');
    setInfo(
      relPath + ' · ' + enc + ' · ' + (meta ? meta.charCount + ' 字符 / ' + meta.lineCount + ' 行' : '') + ' · 只读（输入即进入编辑）'
    );
  }

  async function save() {
    if (!state.currentPath) return;
    const result = await bridge.writeFile(state.currentPath, state.currentText);
    if (!result.ok) {
      setInfo('保存失败：' + (result.error ?? '未知错误'), true);
      return;
    }
    state.savedText = state.currentText;
    renderDirty();
    setInfo('已保存 ' + state.currentPath + ' · ' + (result.byteLength ?? 0) + ' 字节');
  }

  function languageFor(p) {
    const ext = (p.split('.').pop() || '').toLowerCase();
    const map = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      json: 'json',
      md: 'markdown',
      markdown: 'markdown',
      py: 'python',
      go: 'go',
      rs: 'rust',
      java: 'java',
      c: 'c',
      h: 'c',
      cpp: 'cpp',
      cs: 'csharp',
      css: 'css',
      scss: 'scss',
      html: 'html',
      htm: 'html',
      xml: 'xml',
      yml: 'yaml',
      yaml: 'yaml',
      sh: 'shell',
      bash: 'shell',
      ps1: 'powershell',
      sql: 'sql',
      toml: 'ini',
      ini: 'ini',
    };
    return map[ext] || 'plaintext';
  }

  /* ---------------- 事件绑定 ---------------- */
  el.btnOpen.addEventListener('click', async function () {
    const info = await bridge.chooseRoot();
    if (info.root) {
      state.root = info.root;
      renderRoot();
      await loadTree('');
    }
  });

  /**
   * 「复制选中片段」：把当前选中的代码格式化为**带文件真实行号**的片段，
   * 头部自动附 `### 文件：` 与 `### 范围：N-M`，写入剪贴板。
   *
   * 用途：局部修改。模型回显同一行区间后，应用前会做三向校验
   * （区间有效 / 原内容匹配 / 上下文匹配），不一致即拒绝，不会因行号漂移改错地方。
   */
  el.btnSnippet.addEventListener('click', async function () {
    if (!state.currentPath) {
      setInfo('请先打开一个文件，再选中要交给模型修改的代码', true);
      return;
    }
    const editor = state.editor;
    let text = '';
    let startLine = 1;

    if (editor) {
      const model = editor.getModel();
      const selection = editor.getSelection();
      const hasSelection = selection && !selection.isEmpty();
      if (hasSelection) {
        text = model.getValueInRange(selection);
        startLine = selection.startLineNumber;
      } else {
        text = model.getValue();
        startLine = 1;
      }
    } else {
      setInfo('编辑器尚未就绪，无法取选区', true);
      return;
    }

    if (text.trim().length === 0) {
      setInfo('选中内容为空，没有可复制的片段', true);
      return;
    }

    const result = await bridge.copyNumberedSnippet({
      relPath: state.currentPath,
      text: text,
      startLine: startLine,
    });
    if (!result.ok) {
      setInfo('复制片段失败：' + (result.error ?? '未知错误'), true);
      return;
    }
    setInfo(
      '已复制片段（' + result.startLine + '-' + result.endLine + ' 行，' + result.length + ' 字符，含 ### 文件： 与 ### 范围： 头）—— 到右侧粘贴给模型，它会按同一行区间回显'
    );
    el.btnSnippet.textContent = '已复制 ✓';
    setTimeout(function () {
      el.btnSnippet.textContent = '复制选中片段';
    }, 1800);
  });

  el.btnSave.addEventListener('click', function () {
    void save();
  });

  /**
   * 「复制 prompt」：把你在应用内写的需求 + 工作环境 + 目录树 + 格式要求
   * 组装成完整 prompt 写入**系统剪贴板**，再由你自己 Ctrl+V 到右侧输入框。
   * 程序**不会**写入网页 —— 这是零注入边界（见 ADR-0003）。
   */
  el.btnCopyPrompt.addEventListener('click', async function () {
    const requirement = el.requirement.value.trim();
    if (requirement.length === 0) {
      setInfo('请先在上方输入框里写下你的需求，再点「复制 prompt」', true);
      el.requirement.focus();
      return;
    }
    const files = el.targetFiles.value
      .split(/[,，;；\s]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });

    const result = await bridge.copyPrompt(requirement, files);
    if (!result.ok) {
      setInfo('复制 prompt 失败：' + (result.error ?? '未知错误'), true);
      return;
    }
    setInfo(
      '已复制完整 prompt（' + result.length + ' 字符，含需求/工作环境/目录结构/格式要求）—— 请到右侧输入框 Ctrl+V 粘贴，然后自己按发送'
    );
    el.btnCopyPrompt.textContent = '已复制 ✓';
    setTimeout(function () {
      el.btnCopyPrompt.textContent = '复制 prompt';
    }, 1800);
  });

  // 复制"输出格式要求"到剪贴板：程序**只写剪贴板**，由用户自己粘贴到提示词（零注入边界）
  el.btnFormat.addEventListener('click', async function () {
    const result = await bridge.copyFormatSpec();
    if (!result.ok) {
      setInfo('复制格式要求失败：' + (result.error ?? '未知错误'), true);
      return;
    }
    setInfo('已复制格式要求（' + result.length + ' 字符）—— 请你在 DeepSeek 的提示词里自行粘贴，程序不会替你写入');
    el.btnFormat.textContent = '已复制 ✓';
    setTimeout(function () {
      el.btnFormat.textContent = '复制格式要求';
    }, 1800);
  });

  /* ---------------- 回程预览 ----------------
   * 流程：只读采集右侧最新回复 → 解析 → 逐条预览 → 你点"应用"才落盘（可撤销）。
   * 程序不修改网页、不自动落盘（ADR-0003/0004）。
   */
  function renderPreview(preview) {
    lastPreview = preview;
    el.preview.hidden = false;
    el.previewList.textContent = '';

    if (!preview.ok) {
      el.previewMeta.textContent = '采集失败';
      const attemptLines = (preview.attempts || [])
        .map(function (a) { return '· ' + a.strategyId + (a.ok ? '（命中 ' + a.length + ' 字符）' : '（未命中）') + (a.error ? ' 错误：' + a.error : ''); })
        .join('\n');
      const notes = (preview.notes || []).join('\n');
      el.previewNotes.textContent = (preview.error || '未采集到回复') + (notes ? '\n' + notes : '') + (attemptLines ? '\n各策略尝试记录：\n' + attemptLines : '');
      return;
    }

    el.previewMeta.textContent =
      '批次 ' + preview.collectionId + ' · 策略 ' + preview.strategyId + ' · 解析出 ' + preview.blocks.length +
      ' 个代码块 · 原文 ' + preview.replyText.length + ' 字符';
    el.previewNotes.textContent = (preview.notes || []).join('\n');

    preview.blocks.forEach(function (block) {
      const li = document.createElement('li');
      li.className = 'preview-item' + (block.applicable ? '' : ' blocked');

      const head = document.createElement('div');
      head.className = 'preview-item-head';

      const pathInput = document.createElement('input');
      pathInput.className = 'preview-path';
      pathInput.type = 'text';
      pathInput.placeholder = '目标文件相对路径（未确定时请填写）';
      pathInput.value = block.filePath || '';
      head.appendChild(pathInput);

      const tagSource = document.createElement('span');
      tagSource.className = 'preview-tag' + (block.pathSource === 'unique-mention' || block.pathSource === 'none' ? ' weak' : '');
      tagSource.textContent = block.pathSource;
      head.appendChild(tagSource);

      const tagRange = document.createElement('span');
      tagRange.className = 'preview-tag';
      tagRange.textContent = block.range ? '替换 ' + block.range.start + '-' + block.range.end + ' 行' : '整文件替换';
      head.appendChild(tagRange);

      const tagSize = document.createElement('span');
      tagSize.className = 'preview-tag';
      tagSize.textContent = block.codeLines + ' 行 / ' + block.codeChars + ' 字符' + (block.fileLines !== null ? ' → 文件 ' + block.fileLines + ' 行' : '');
      head.appendChild(tagSize);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '应用';
      btn.addEventListener('click', function () {
        void applyBlock(block, pathInput.value.trim(), btn);
      });
      head.appendChild(btn);

      li.appendChild(head);

      const hints = (block.hints || []).concat(block.blockedReason ? ['阻塞：' + block.blockedReason] : []);
      if (hints.length > 0) {
        const hint = document.createElement('div');
        hint.className = 'preview-hint';
        hint.textContent = hints.join('；');
        li.appendChild(hint);
      }
      el.previewList.appendChild(li);
    });
  }

  async function applyBlock(block, filePath, btn) {
    if (!lastPreview || !lastPreview.collectionId) {
      setInfo('采集结果不可用，请重新点「采集回复」', true);
      return;
    }
    if (!filePath) {
      setInfo('请先填写目标文件路径再应用', true);
      return;
    }

    btn.disabled = true;
    btn.textContent = '应用中…';
    const result = await bridge.applyChange({
      collectionId: lastPreview.collectionId,
      index: block.index,
      filePath: filePath,
    });
    btn.disabled = false;
    btn.textContent = result.ok ? '已应用 ✓' : '应用';
    if (!result.ok) {
      setInfo('应用失败：' + (result.error || '未知错误'), true);
      el.previewNotes.textContent =
        '应用失败：' + (result.error || '') +
        '\n（片段替换会在读文件时抓取该区间当前内容作为校验基线；若文件已被改动，或模型给的行区间与文件不符，会被拒绝——这是刻意的安全限制）';
      return;
    }
    setInfo('已应用 ' + result.filePath + '（模式 ' + result.mode + '；可点「撤销」回退）');
    if (state.currentPath === result.filePath) {
      await openFile(state.currentPath, null);
    }
  }

  el.btnCollect.addEventListener('click', async function () {
    el.btnCollect.disabled = true;
    el.btnCollect.textContent = '采集中…';
    try {
      const preview = await bridge.collectReply();
      renderPreview(preview);
    } finally {
      el.btnCollect.disabled = false;
      el.btnCollect.textContent = '采集回复';
    }
  });

  el.btnClosePreview.addEventListener('click', function () {
    el.preview.hidden = true;
  });

  el.btnUndo.addEventListener('click', async function () {
    const result = await bridge.undoSave();
    if (!result.ok) {
      setInfo('撤销失败：' + (result.error || '未知错误'), true);
      return;
    }
    setInfo('已撤销对 ' + result.filePath + ' 的上一次应用');
    if (state.currentPath === result.filePath) {
      await openFile(state.currentPath, null);
    }
  });

  el.btnApplyAll.addEventListener('click', function () {
    setInfo('「应用全部」需要逐条确认路径，请逐个点击「应用」—— 默认不批量落盘（ADR-0004 方案 A）', true);
  });

  /* ---------------- 分隔条拖动 ----------------
   * 本渲染进程只占左侧面板，因此拖动时用 window.screenX 推算窗口左边界的屏幕坐标，
   * 再算出"编辑器期望宽度 = 鼠标屏幕坐标 - 窗口左边界"，交给主进程做最小宽度约束后执行。
   * 主进程回传实际宽度，据此校准偏移，避免累计误差。
   */
  let dragging = false;
  let dragOffset = 0;

  function onDragMove(e) {
    if (!dragging) return;
    const windowLeft = window.screenX;
    const desired = e.screenX - windowLeft + dragOffset;
    void bridge.setSplit(desired).then(function (result) {
      dragOffset = result.editorWidth - (e.screenX - windowLeft);
    });
  }

  el.resizer.addEventListener('pointerdown', function (e) {
    dragging = true;
    dragOffset = 0;
    el.resizer.classList.add('dragging');
    el.resizer.setPointerCapture(e.pointerId);
    // 拖动期间提升指针事件频率
    e.preventDefault();
  });

  el.resizer.addEventListener('pointermove', onDragMove);

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    el.resizer.classList.remove('dragging');
    try {
      el.resizer.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* 指针可能已释放 */
    }
  }
  el.resizer.addEventListener('pointerup', endDrag);
  el.resizer.addEventListener('pointercancel', endDrag);

  // 双击分隔条：回到 45% 默认比例
  el.resizer.addEventListener('dblclick', function () {
    void bridge.setSplit(Math.round(window.outerWidth * 0.45));
  });

  // 输入即进入编辑（自动解除只读），避免多一个"编辑"开关
  document.addEventListener('keydown', function (e) {
    if (state.readOnly && state.editor && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
      state.readOnly = false;
      applyReadOnly();
    }
  });

  bridge.onRootChanged(function (info) {
    state.root = info.root;
    renderRoot();
    void loadTree('');
  });

  bridge.onRootStale(function () {
    state.root = null;
    state.currentPath = null;
    renderRoot();
    renderTree([]);
    setInfo('上次打开的目录已不存在，已清除记忆 —— 请重新选择目录', true);
  });

  /* ---------------- 启动 ---------------- */
  async function main() {
    initMonaco();
    renderRoot();
    renderDirty();
    const info = await bridge.getRoot();
    if (info.root) {
      state.root = info.root;
      renderRoot();
      await loadTree('');
    }
  }

  void main();
})();
