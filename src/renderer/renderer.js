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
    fileName: document.getElementById('file-name'),
    fileDot: document.getElementById('file-dot'),
    btnOpen: document.getElementById('btn-open'),
    btnSave: document.getElementById('btn-save'),
    btnSnippet: document.getElementById('btn-snippet'),
    btnWholeFile: document.getElementById('btn-whole-file'),
    monacoHost: document.getElementById('monaco'),
    resizer: document.getElementById('resizer'),
    requirement: document.getElementById('requirement'),
    btnCopyPrompt: document.getElementById('btn-copy-prompt'),
    // 回程预览面板（此前遗漏，导致下面绑定时 TypeError 并中断整个脚本）
    btnCollect: document.getElementById('btn-collect'),
    preview: document.getElementById('preview'),
    previewMeta: document.getElementById('preview-meta'),
    previewNotes: document.getElementById('preview-notes'),
    previewList: document.getElementById('preview-list'),
    btnApplyAll: document.getElementById('btn-apply-all'),
    btnUndo: document.getElementById('btn-undo'),
    btnClosePreview: document.getElementById('btn-close-preview'),
  };

  /**
   * 启动自检：**每个引用的元素都必须存在**。
   *
   * 为什么必须有这道检查：`getElementById` 取不到只返回 `null`，直到后面 `null.addEventListener`
   * 才抛异常，而那时脚本已中断 —— 表现是"界面看着正常但编辑器/按钮全都不工作"，极难定位。
   * 与其等运行时炸，不如在脚本开头一次性报出所有缺失项。
   */
  (function assertElements() {
    const missing = Object.keys(el).filter(function (k) {
      return !el[k];
    });
    if (missing.length > 0) {
      const msg = '[renderer] 缺少 DOM 元素：' + missing.join(', ') + '（index.html 与 renderer.js 不一致）';
      console.error(msg);
      const host = document.getElementById('info');
      if (host) {
        host.textContent = msg;
        host.classList.add('warn');
      }
      throw new Error(msg);
    }
  })();

  const state = {
    root: null,
    currentPath: null,
    currentText: '',
    savedText: '',
    editor: null,
  };

  /**
   * 最近一次「采集回复」的解析结果（供"应用"时引用主进程缓存的代码块）。
   * **必须在此声明** —— 曾经只在下面赋值而忘了声明，导致
   * `lastPreview = preview` 抛 `ReferenceError`，整个采集功能失效。
   */
  let lastPreview = null;

  /**
   * 暴露给主进程的**只读诊断入口**（`--ui-probe` 使用）。
   *
   * 为什么需要：界面问题（能否编辑、是否换行）在源码层面看不出来 —— 只有读回 Monaco 的
   * **实际生效选项**并真的尝试改文本，才能判断。这个对象不写文件、不发网络请求，
   * 只回答"编辑器当前处于什么状态"。
   */
  window.__uiProbe = function () {
    const ed = state.editor;
    if (!ed) return { ready: false, reason: '编辑器尚未创建' };
    const opts = ed.getOptions();
    const model = ed.getModel();

    // 真的试一次修改：若能写入，说明编辑器可编辑（不受 readOnly 限制）
    let editTest = { attempted: false, changed: false, error: null };
    if (model) {
      const original = model.getValue();
      const probeText = original + '\n__probe__';
      try {
        ed.executeEdits('ui-probe', [
          { range: model.getFullModelRange(), text: probeText, forceMoveMarkers: true },
        ]);
        const after = model.getValue();
        editTest = { attempted: true, changed: after !== original, error: null };
        // 复原，避免污染
        ed.executeEdits('ui-probe', [{ range: model.getFullModelRange(), text: original, forceMoveMarkers: true }]);
      } catch (err) {
        editTest = { attempted: true, changed: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    return {
      ready: true,
      readOnly: ed.getOption(window.monaco.editor.EditorOption.readOnly),
      wordWrap: ed.getOption(window.monaco.editor.EditorOption.wordWrap),
      fontFamily: opts.get(window.monaco.editor.EditorOption.fontFamily),
      fontSize: opts.get(window.monaco.editor.EditorOption.fontSize),
      lineHeight: opts.get(window.monaco.editor.EditorOption.lineHeight),
      lineNumbers: ed.getOption(window.monaco.editor.EditorOption.lineNumbers),
      editTest,
      currentPath: state.currentPath,
      textLength: model ? model.getValueLength() : 0,
      hasFocus: ed.hasTextFocus(),
    };
  };

  /* ---------------- Monaco 初始化 ----------------
   * 可读性选项集中在此，便于对照主流编辑器调整。
   * 注意：**不设 readOnly** —— 默认即可编辑；保存走 Ctrl+S，未保存由状态点提示。
   */
  const EDITOR_OPTIONS = {
    language: 'plaintext',
    theme: 'vs-dark',
    automaticLayout: true,
    // 字体：优先 Cascadia Code（Win11 自带），依次回退；中文回退到等宽字体
    fontFamily:
      "'Cascadia Code', 'Cascadia Mono', Consolas, 'JetBrains Mono', 'Sarasa Mono SC', 'Microsoft YaHei Mono', 'Courier New', monospace",
    fontSize: 14,
    lineHeight: 22,
    letterSpacing: 0.2,
    // 长行换行（用户明确要求）：默认 off，导致必须横向滚动
    wordWrap: 'on',
    wrappingIndent: 'same',
    // 观感：缩进参考线 / 括号配色 / 当前行 / 行号宽度
    guides: { indentation: true, bracketPairs: true, highlightActiveIndentation: true },
    bracketPairColorization: { enabled: true },
    renderLineHighlight: 'all',
    renderWhitespace: 'selection',
    lineNumbersMinChars: 4,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    tabSize: 2,
    padding: { top: 8, bottom: 8 },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    stickyScroll: { enabled: false },
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
      state.editor = window.monaco.editor.create(el.monacoHost, { value: '', ...EDITOR_OPTIONS });
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
    });
  }

  /* ---------------- 界面渲染 ---------------- */
  function renderRoot() {
    el.rootLabel.textContent = state.root ?? '未打开目录';
    el.rootLabel.title = state.root ?? '';
    el.treeNote.style.display = state.root ? 'none' : 'block';
  }

  /** 未保存状态：与主流编辑器一致——有改动才显示标记（文件头右侧白点 + 工具栏提示） */
  function renderDirty() {
    const dirty = state.currentText !== state.savedText;
    el.dirty.textContent = dirty ? '● 未保存' : '';
    el.dirty.classList.toggle('is-dirty', dirty);
    el.btnSave.disabled = !dirty || !state.currentPath;
    el.fileDot.hidden = !dirty;
    el.fileName.textContent = state.currentPath ?? '未打开文件';
    el.fileName.title = state.currentPath ?? '';
  }

  function setInfo(text, warn) {
    el.info.textContent = text;
    el.info.classList.toggle('warn', Boolean(warn));
  }

  /* ---------------- 目录树（可展开，展开状态保持） ----------------
   * 与主流编辑器一致：点击文件夹=原地展开/收起，点击文件=打开。
   * 展开状态按根目录分别记忆（Map: relPath -> isOpen），切换根目录时重置。
   */
  const expanded = new Set();

  function renderTree(entries) {
    el.tree.textContent = '';
    for (const entry of entries) {
      el.tree.appendChild(buildTreeItem(entry));
    }
  }

  function buildTreeItem(entry) {
    const li = document.createElement('li');
    li.className = entry.isDirectory ? 'tree-dir' : entry.textLike === false ? 'tree-nontext' : 'tree-file';
    li.dataset['relPath'] = entry.relPath;

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.title = entry.isDirectory ? '目录（点击展开/收起）' : entry.textLike === false ? '可能不是文本文件' : '文本文件';

    const twisty = document.createElement('span');
    twisty.className = 'tree-twisty';
    twisty.textContent = entry.isDirectory ? '▸' : '';
    row.appendChild(twisty);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = entry.name;
    row.appendChild(label);

    li.appendChild(row);

    if (!entry.isDirectory) {
      row.addEventListener('click', function () {
        void openFile(entry.relPath, row);
      });
      return li;
    }

    // 目录：子容器懒加载，展开状态保持
    const children = document.createElement('ul');
    children.className = 'tree-children';
    li.appendChild(children);

    const setOpen = function (open, load) {
      if (open) {
        expanded.add(entry.relPath);
        li.classList.add('open');
        twisty.textContent = '▾';
        children.hidden = false;
        if (load && children.childElementCount === 0) {
          void loadChildren(entry.relPath, children);
        }
      } else {
        expanded.delete(entry.relPath);
        li.classList.remove('open');
        twisty.textContent = '▸';
        children.hidden = true;
      }
    };

    row.addEventListener('click', function () {
      setOpen(!li.classList.contains('open'), true);
    });

    // 初次渲染时按记忆恢复展开态（并懒加载其子项）
    if (expanded.has(entry.relPath)) setOpen(true, true);

    return li;
  }

  async function loadChildren(relPath, container) {
    const result = await bridge.listDir(relPath);
    if (!result.ok) {
      setInfo('展开目录失败：' + (result.error ?? '未知错误'), true);
      return;
    }
    container.textContent = '';
    for (const child of result.entries) {
      container.appendChild(buildTreeItem(child));
    }
    if (result.entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'tree-empty';
      empty.textContent = '（空目录）';
      container.appendChild(empty);
    }
  }

  /** 定位并高亮某个路径（便于打开文件后把树滚到它那里） */
  function highlightTreeItem(relPath) {
    document.querySelectorAll('#tree .tree-row.active').forEach((n) => n.classList.remove('active'));
    const node = document.querySelector('#tree li[data-rel-path="' + CSS.escape(relPath) + '"] > .tree-row');
    if (node) {
      node.classList.add('active');
      node.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ---------------- 数据操作（全部经 bridge） ---------------- */
  /** 展开根目录第一层 */
  async function loadTree() {
    const result = await bridge.listDir('');
    if (!result.ok) {
      setInfo('列目录失败：' + (result.error ?? '未知错误'), true);
      return;
    }
    renderTree(result.entries);
    setInfo('目录：. · ' + result.entries.length + ' 项' + (result.truncated ? '（已截断）' : ''));
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
      state.editor.focus();
    } else {
      el.monacoHost.textContent = state.savedText.slice(0, 4000);
    }

    highlightTreeItem(relPath);

    renderDirty();
    const meta = result.meta;
    const enc = result.encoding + (result.fellBack ? '（UTF-8 校验失败，已回退）' : '');
    setInfo(
      relPath + ' · ' + enc + ' · ' + (meta ? meta.charCount + ' 字符 / ' + meta.lineCount + ' 行' : '') + ' · 可直接编辑，Ctrl+S 保存'
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
      await loadTree();
    }
  });

  /**
   * 「复制整个文件」：把当前打开的整个文件（`这个文件是 <路径>` + 围栏 + 全文）
   * 写入剪贴板，作为**上下文**交给模型。
   *
   * 与「复制选中片段」的分工：
   *   - 整个文件 → 上下文/大改（不带行号，不带行区间）
   *   - 选中片段 → 局部修改（带真实行号 + 行区间，应用前三向校验）
   */
  el.btnWholeFile.addEventListener('click', async function () {
    if (!state.currentPath) {
      setInfo('请先打开一个文件，再复制', true);
      return;
    }
    const result = await bridge.copyWholeFile(state.currentPath);
    if (!result.ok) {
      setInfo('复制整个文件失败：' + (result.error ?? '未知错误'), true);
      return;
    }
    setInfo(
      '已复制整个文件（' + state.currentPath + ' · ' + (result.lineCount ?? 0) + ' 行 · ' + result.length +
        ' 字符 · 围栏 ' + (result.fence ?? '```') + '）—— 到右侧粘贴即可'
    );
    el.btnWholeFile.textContent = '已复制 ✓';
    setTimeout(function () {
      el.btnWholeFile.textContent = '复制整个文件';
    }, 1800);
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
   *
   * 注意这里**不再传"要改的文件"**：路径与代码内容一起给出（参见「复制整个文件」/
   * 「复制选中片段」）。单独给一个路径、不给内容，模型无法据此改文件。
   */
  el.btnCopyPrompt.addEventListener('click', async function () {
    const requirement = el.requirement.value.trim();
    if (requirement.length === 0) {
      setInfo('请先写下你的需求，再点「复制 prompt」', true);
      el.requirement.focus();
      return;
    }

    const result = await bridge.copyPrompt(requirement, []);
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

      // 行号预览：显示代码块前几行，行号是应用后会落在文件里的真实行号
      if (block.firstLines && block.firstLines.length > 0) {
        const pre = document.createElement('pre');
        pre.className = 'preview-code';
        const width = String(block.firstLines[block.firstLines.length - 1].lineNo).length;
        block.firstLines.forEach(function (l) {
          const row = document.createElement('div');
          const no = document.createElement('span');
          no.className = 'preview-code-no';
          no.textContent = String(l.lineNo).padStart(width, ' ');
          const tx = document.createElement('span');
          tx.className = 'preview-code-text';
          tx.textContent = l.text.length > 0 ? l.text : ' ';
          row.appendChild(no);
          row.appendChild(tx);
          pre.appendChild(row);
        });
        if (block.moreLines > 0) {
          const more = document.createElement('div');
          more.className = 'preview-code-more';
          more.textContent = '… 其余 ' + block.moreLines + ' 行';
          pre.appendChild(more);
        }
        li.appendChild(pre);
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

  bridge.onRootChanged(function (info) {
    state.root = info.root;
    expanded.clear();
    renderRoot();
    void loadTree();
  });

  bridge.onRootStale(function () {
    state.root = null;
    state.currentPath = null;
    expanded.clear();
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
      await loadTree();
    }
  }

  void main();
})();
