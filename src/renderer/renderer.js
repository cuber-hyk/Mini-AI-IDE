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
    monacoHost: document.getElementById('monaco'),
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

  el.btnSave.addEventListener('click', function () {
    void save();
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
