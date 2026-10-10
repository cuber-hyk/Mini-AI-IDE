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
    info: document.getElementById('info'),
    dirty: document.getElementById('dirty-flag'),
    editorTabs: document.getElementById('editor-tabs'),
    // 注意：这里**不要**用键名 `monaco`，否则会遮蔽全局的 `window.monaco`（AMD 模块对象），
    // 导致 `window.monaco.editor.createModel` / `createDecorationsCollection` 之类的调用难以排查。
    monacoHost: document.getElementById('monaco'),
    resizer: document.getElementById('resizer'),
    requirement: document.getElementById('requirement'),
    btnSendPrompt: document.getElementById('btn-send-prompt'),
    // 采集入口在 AI 网页顶部，变更列表在右侧独立视图。
    // 面板显示控制
    sidebar: document.getElementById('sidebar'),
    sidebarResizer: document.getElementById('sidebar-resizer'),
    btnSidebar: document.getElementById('btn-sidebar'),
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

  const toolbar = window.setupEditorToolbar();
  window.setupApplicationUpdate(bridge, setInfo);

  const state = {
    root: null,
    currentPath: null,
    currentText: '',
    savedText: '',
    /** Monaco 编辑器实例（整个进程只有这一个，从不销毁重建） */
    editor: null,
    selectionBubbleReady: false, // 选区浮层复制按钮是否已挂载（幂等保护）
    /** 右侧 AI 网页当前是否显示（由主进程广播同步） */
    /** 回程预览面板当前是否显示 */
    previewVisible: false,
  };

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

  /**
   * 界面几何探针（`--ui-probe` 使用）：**真的把预览面板显示出来**，测量各区块位置，
   * 判断"应用按钮是否真的可见"。
   *
   * 为什么必须这样验：布局是否被裁掉只能靠测量，源码层面看不出来。
   * 实测踩过：`.layout` 用 calc 硬编码高度，预览面板一出现就把底部挤出视口，
   * 表现是"预览里看不到应用按钮"。
   */
  window.__uiGeometryProbe = function () {
    const viewportH = window.innerHeight;
    const rectOf = function (node) {
      const r = node.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) };
    };

    /*
     * 编辑器区必须占满"工具栏与需求输入区之间"的高度，且底部输入区要在视口内。
     * 回程预览已移到右下角独立面板，因此这里不再测量预览面板。
     */
    const editorRect = rectOf(el.monacoHost);
    const requirementPanel = document.getElementById('requirement-panel');
    const promptRect = rectOf(requirementPanel.open ? el.btnSendPrompt : requirementPanel.querySelector('summary'));
    const toolbarRect = rectOf(document.getElementById('workspace-add'));

    const promptVisible = promptRect.height > 0 && promptRect.bottom <= viewportH;
    const editorFills = editorRect.height > 200;
    const noOverlap = promptRect.top >= editorRect.top;

    return {
      viewportH,
      editorArea: editorRect,
      toolbar: toolbarRect,
      sendPromptButton: promptRect,
      promptVisible,
      editorFills,
      noOverlap,
      ok: promptVisible && editorFills && noOverlap,
    };
  };

  /**
   * 选区浮层复制按钮**实测探针**（`--ui-probe --test-bubble` 使用）。
   *
   * 为什么需要：这个按钮前后修了三次都"看起来对、实际不出现"，靠肉眼截图判断
   * 效率极低。这里**真的在编辑器里设一个跨折行的选区**，然后读回按钮的真实
   * 计算样式与几何矩形 —— 把"出现没有"从主观判断变成可读的数字。
   *
   * 只读 + 临时：设选区是为了量位置，量完立刻恢复原选区。
   * 不写文件、不发网络请求。
   */
  window.__uiSelectionProbe = function () {
    const ed = state.editor;
    if (!ed) return { ok: false, reason: '编辑器尚未创建' };
    const model = ed.getModel();
    if (!model) return { ok: false, reason: '编辑器没有模型（未打开文件）' };

    if (!state.currentPath) {
      // 没打开文件时，getPosition() 必然返回 null（这是设计如此），
      // 探针要如实报告，而不是伪装成"按钮坏了"。
      return {
        ok: false,
        reason: '当前未打开文件，state.currentPath 为空 —— 浮层按设计不出现',
        currentPath: state.currentPath,
      };
    }

    const savedSelection = ed.getSelection();
    // 选一段**必然跨视觉行**的内容：优先挑最长的行，确保 wordWrap 真的折行，
    // 这正是用户截图里"长段落 md 选 4 个视觉行"的情形。
    let targetLine = 1;
    let maxLen = -1;
    for (let ln = 1; ln <= model.getLineCount(); ln += 1) {
      const len = model.getLineLength(ln);
      if (len > maxLen) {
        maxLen = len;
        targetLine = ln;
      }
    }
    const lineMax = model.getLineMaxColumn(targetLine);
    const endColumn = Math.max(2, Math.floor(lineMax / 2));

    ed.setSelection({
      startLineNumber: targetLine,
      startColumn: 1,
      endLineNumber: targetLine,
      endColumn: endColumn,
    });

    ed.render(true);
    const bubble = document.querySelector('.selection-copy');
    if (!bubble) {
      ed.setSelection(savedSelection);
      return { ok: false, reason: '页面里找不到 .selection-copy 节点（未挂载？）' };
    }

    const cs = window.getComputedStyle(bubble);
    const rect = bubble.getBoundingClientRect();
    const node = ed.getDomNode();
    const nodeRect = node ? node.getBoundingClientRect() : null;

    /**
     * 【是否被折成竖排】—— 用户实测截图里「复制」变成上下两个字的细长条。
     *
     * 判据不能只看宽高比，因为「复制」两字横排本就接近方形。改用**更直接的**两条：
     *   1. 计算样式的 `white-space` 必须是 `nowrap`（我们锁死了它）；
     *   2. 节点高度不超过 `line-height + 上下 padding` 的合理上限 ——
     *      一旦折行，高度会翻倍。
     * 两者合起来即可判定"没有竖排"。
     */
    const lineHeight = parseFloat(cs.lineHeight) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
    // 单行时应有的高度（含 padding 与 border）
    const singleLineHeight = lineHeight + padTop + padBottom + borderTop + borderBottom;
    const isSingleLine = cs.whiteSpace === 'nowrap' && rect.height <= singleLineHeight + 1.5;

    // 是否落在编辑器可视区内
    const inView = Boolean(
      nodeRect &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > nodeRect.top &&
        rect.top < nodeRect.bottom &&
        rect.right > nodeRect.left &&
        rect.left < nodeRect.right
    );

    const result = {
      ok: true,
      // 这几项是判断"到底为什么不出现"的关键
      display: cs.display,
      visibility: cs.visibility,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      // Monaco 是否给它打了"已显示"标记（render() 里 setAttribute 的那个）
      hasVisibleMarker: bubble.hasAttribute('monaco-visible-content-widget'),
      customHoverAttr: bubble.getAttribute('custom-hover'),
      testLine: targetLine,
      testLineLength: maxLen,
      inView,
      // 排版自检：不是竖排（单行、无换行）
      whiteSpace: cs.whiteSpace,
      singleLineHeight: Math.round(singleLineHeight),
      isSingleLine,
    };
    // 判定：display 不是 none、尺寸 > 0、且落在编辑器视口内，才算"真的出现了"
    result.visible =
      result.display !== 'none' && result.visibility !== 'hidden' && result.width > 0 && result.height > 0 && inView;
    ed.setSelection(savedSelection);
    return result;
  };

  /**
   * 查找框 hover「闪烁」归属探针（只读诊断，不修任何东西）。
   *
   * 【为什么要它】这个"闪"报告了三轮、修了两轮都没解决，根因是**前两轮都在猜机制**。
   * 本轮把 Monaco 源码读到行号之后，得到两条**互斥**的假设，必须靠实测二选一：
   *   H1（SimpleButton 共性）：prev / next / close 三个按钮构造逐字相同
   *      （都是 `new SimpleButton({..., hoverLifecycleOptions})`），若三者**都闪**，
   *      补丁应打在共用的 `_setupDelayedHover`（把 delayed 改 instant）。
   *   H2（close 独有）：close 比另两个多一个 `onKeyDown`（只处理 Tab）。若
   *      **只有 close 闪**，说明触发源是它独有的东西，补丁落点完全不同。
   *
   * 【怎么测】不模拟鼠标（那需要注入，违反项目硬约束）。改为：
   *   1. 打开查找框，把三类按钮找出来，读它们的 hover 相关状态；
   *   2. 在编辑器根节点上挂 MutationObserver，**统计 hover 浮层节点的增删次数**；
   *   3. 用 `dispatchEvent` 在**文档层**派发合成 Alt keydown/keyup。
   *      注意：这是给**我们自己**的页面派发合成事件用于**观测**，不触碰网页、
   *      不写任何 DOM，与"零注入网页"（ADR-0003）无关；且只读计数，不修行为。
   *   4. 报出每个按钮对应的浮层重建次数 —— **谁重建次数高，谁就是闪烁源**。
   *
   * 本函数**只读**：除了派发事件与挂观察器，不改任何 DOM/样式。
   */
  window.__uiFindHoverProbe = function () {
    if (!state.editor) return { ok: false, reason: '编辑器尚未创建' };
    const dom = state.editor.getDomNode();
    if (!dom) return { ok: false, reason: '编辑器根节点不存在' };

    // 1) 打开查找框（走 Monaco 自己的 action，不合成键盘事件）
    const findAction = state.editor.getAction('actions.find');
    if (!findAction) return { ok: false, reason: '找不到 actions.find 动作' };
    findAction.run();

    const findDom = dom.querySelector('.find-widget');
    if (!findDom) return { ok: false, reason: '查找框未出现（actions.find 未生效）' };

    /**
     * 2) 找出三个按钮。判据用 aria-label 前缀，且**要求它同时是 SimpleButton**
     *    （class 里含 `button`，且是 codicon 图标按钮）——避免把其它同名按钮抓进来。
     */
    const buttons = [];
    const allButtons = findDom.querySelectorAll('.button');
    for (let i = 0; i < allButtons.length; i += 1) {
      const node = allButtons[i];
      const label = node.getAttribute('aria-label') || '';
      let kind = null;
      if (/^Close/i.test(label)) kind = 'close';
      else if (/^Previous/i.test(label)) kind = 'prev';
      else if (/^Next/i.test(label)) kind = 'next';
      if (kind) buttons.push({ kind, node, label });
    }
    if (buttons.length === 0) return { ok: false, reason: '查找框里没找到 Close/Previous/Next 按钮' };

    const sleep = function (ms) {
      return new Promise(function (r) {
        window.setTimeout(r, ms);
      });
    };

    /**
     * 3) 悬停某个按钮，等浮层出现，然后**直接测量浮层**。
     *
     * 这是本轮最重要的判据升级：不再靠"数重建次数"这种间接信号，
     * 而是直接量浮层的**宽度、高度、行数、white-space**。
     * 用户截图里的现象就是"提示被折成两行"，那么只要量出**行数 > 1**，
     * 就说明根因仍在；量出行数为 1 且宽度稳定，就说明修好了。
     *
     * 用 `mouseover`（Monaco 的 `_setupDelayedHover` 监听 `MOUSE_OVER`）
     * 触发，再等 `delay + 余量`。只派发事件、不写 DOM，符合零注入约束。
     */
    const hoverOne = async function (b) {
      const r = b.node.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left + r.width / 2),
        clientY: Math.round(r.top + r.height / 2),
        relatedTarget: null,
      };
      b.node.dispatchEvent(new MouseEvent('mouseover', opts));
      // workbench.hover.delay 默认 300ms，多等一点确保浮层已完全渲染
      await sleep(700);

      const hovers = document.querySelectorAll('.monaco-hover');
      // 取最后一个（最新的那个）
      const hover = hovers.length > 0 ? hovers[hovers.length - 1] : null;
      if (!hover) {
        b.node.dispatchEvent(new MouseEvent('mouseout', opts));
        return { kind: b.kind, label: b.label, hoverShown: false };
      }

      const contents = hover.querySelector('.hover-contents');
      const cs = contents ? window.getComputedStyle(contents) : null;
      const rect = hover.getBoundingClientRect();
      const lineHeight = cs ? parseFloat(cs.lineHeight) || 16 : 16;
      const padTop = cs ? parseFloat(cs.paddingTop) || 0 : 0;
      const padBottom = cs ? parseFloat(cs.paddingBottom) || 0 : 0;
      const singleLine = lineHeight + padTop + padBottom;
      // 行数 ≈ 内容高 / 行高，四舍五入
      const lines = cs ? Math.max(1, Math.round(contents.getBoundingClientRect().height / lineHeight)) : 1;

      b.node.dispatchEvent(new MouseEvent('mouseout', opts));
      return {
        kind: b.kind,
        label: b.label,
        hoverShown: true,
        hoverWidth: Math.round(rect.width),
        hoverHeight: Math.round(rect.height),
        contentsWhiteSpace: cs ? cs.whiteSpace : null,
        lineHeight: Math.round(lineHeight),
        singleLineHeight: Math.round(singleLine),
        lines,
        // 单行 = 不折行 = 尺寸稳定 = 不抖。这是"闪烁是否被治好"的直接判据。
        isSingleLine: lines === 1,
      };
    };

    return (async function () {
      const results = [];
      for (let i = 0; i < buttons.length; i += 1) {
        // 逐个悬停，中间留间隔让上一个浮层收掉
        results.push(await hoverOne(buttons[i]));
        await sleep(250);
      }
      const anyMultiLine = results.some(function (r) {
        return r.hoverShown && r.isSingleLine === false;
      });
      return {
        ok: true,
        buttons: results,
        // 判定：任一按钮的提示折成多行 ⇒ 仍会抖 ⇒ 仍会闪
        anyMultiLineHover: anyMultiLine,
        verdict: anyMultiLine ? '仍有折行提示（会抖）' : '所有提示均为单行（尺寸稳定）',
      };
    })();
  };

  /* ---------------- Monaco 初始化 ----------------
   * 可读性选项集中在此，便于对照主流编辑器调整。
   * 注意：**不设 readOnly** —— 默认即可编辑；保存走 Ctrl+S，未保存由状态点提示。
   */
  const EDITOR_OPTIONS = {
    language: 'plaintext',
    theme: 'workspace-dark',
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
  let resolveMonacoReady;
  const monacoReady = new Promise(function (resolve) { resolveMonacoReady = resolve; });
  let emptyModel;
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
      const themeTokens = getComputedStyle(document.documentElement);
      const themeColor = (name) => themeTokens.getPropertyValue(name).trim();
      window.monaco.editor.defineTheme('workspace-dark', {
        base: 'vs-dark', inherit: true, rules: [],
        colors: {
          'editor.background': themeColor('--ui-bg'),
          'editor.foreground': themeColor('--ui-text'),
          'editorGutter.background': themeColor('--ui-bg'),
          'editor.lineHighlightBackground': themeColor('--ui-surface'),
          'editorLineNumber.foreground': themeColor('--ui-muted'),
          'editor.selectionBackground': themeColor('--ui-selected'),
          'editorWidget.background': themeColor('--ui-surface'),
          'editorWidget.border': themeColor('--ui-border'),
          'editorHoverWidget.background': themeColor('--ui-surface'),
          'editorHoverWidget.border': themeColor('--ui-border'),
          'minimap.background': themeColor('--ui-bg'),
        },
      });
      // 显式持有空白模型；create(value) 的内置模型会在首次 setModel 时被 Monaco 释放。
      emptyModel = window.monaco.editor.createModel('', 'plaintext');
      state.editor = window.monaco.editor.create(el.monacoHost, { model: emptyModel, ...EDITOR_OPTIONS });
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
      // 选区浮层复制按钮必须等state.editor 就绪后才能建（见 setupSelectionCopyBubble 注释）
      setupSelectionCopyBubble();
      resolveMonacoReady();
    });
  }

  const workspaceNavigation = window.setupWorkspaceNavigation(bridge);
  const workspaceLayout = window.setupWorkspaceLayout(bridge);
  const fileWorkspace = window.setupFileWorkspace(bridge);
  document.addEventListener('workspace-layout-changed', function () {
    if (state.editor) state.editor.layout();
  });

  // 快捷键通过主进程打开独立提示词编辑视图。
  async function openPromptSettings() {
    try {
      await bridge.openPromptPanel();
    } catch (err) {
      setInfo(`打开提示词设置失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  bridge.onOpenPromptPanel(function () {
    // 面板已在主进程侧显示；这里只做视觉反馈（否则点了没反应的观感很差）
    setInfo('已在提示词设置面板里编辑「输出格式要求」——Esc 关闭');
  });

  // Ctrl+B 显示或隐藏本地目录树。
  document.addEventListener('keydown', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      el.btnSidebar.click();
    }
  });

  bridge.onFileChanged(async function (filePath, change, revision, discardDraft) {
    if (typeof filePath !== 'string' || filePath.length === 0) return;
    if (revision !== workspaceRevision) return;
    if (change === 'deleted') {
      editorWorkspace.entryChanged({ kind: 'deleted', oldRelPath: filePath, isDirectory: false });
      await loadTree(); return;
    }
    /*
     * 磁盘被回程链路改写了。若这个文件正打开在编辑器里，必须重新读盘 ——
     * 落盘在主进程、编辑在另一个渲染进程，不主动刷新就一直显示旧内容
     * （用户实测：应用后仍是旧代码，关闭文件重开才对）。
     */

    if (change === 'created') {
      await loadTree();
      if (revision !== workspaceRevision) return;
      if (!await editorWorkspace.reload(filePath, false, false, discardDraft) && revision === workspaceRevision) await editorWorkspace.open(filePath);
    } else await editorWorkspace.reload(filePath, false, false, discardDraft);
  });

  bridge.onChromeState(function (s) {
    if (!s) return;
    state.previewVisible = Boolean(s.previewVisible);

  });

  /* ---------------- 界面渲染 ---------------- */
  function renderRoot() {
    toolbar.renderRoot(state.root);
    el.treeNote.style.display = state.root ? 'none' : 'block';
  }

  /** 未保存状态：与主流编辑器一致——有改动才显示标记（工具栏文字 + 文件头右侧白点） */
  function renderDirty() {
    const dirty = state.currentText !== state.savedText;
    el.dirty.textContent = dirty ? '● 未保存' : '';
    el.dirty.classList.toggle('is-dirty', dirty);
    if (typeof editorWorkspace !== 'undefined') editorWorkspace.report();
  }

  function setInfo(text, warn) {
    el.info.textContent = text;
    el.info.classList.toggle('warn', Boolean(warn));
  }

  /* 当前缓冲与文件树由独立 owner 管理，入口只适配 Monaco。 */
  let recentRoots = [];
  let workspaceRevision = null;
  const editorWorkspace = window.createEditorWorkspace({
    state, bridge, setInfo,
    ready: function () { return monacoReady; },
    createModel: function (path, text) { return window.monaco.editor.createModel(text, languageFor(path)); },
    captureViewState: function () { return state.editor && state.editor.saveViewState(); },
    showDocument: function (doc, focus) {
      if (state.editor) {
        state.editor.setModel(doc ? doc.model : emptyModel);
        if (doc && doc.viewState) state.editor.restoreViewState(doc.viewState);
        if (focus) state.editor.focus();
      }
    },
    replaceContent: function (doc, text) { doc.model.setValue(text); },
    renameModel: function (doc) { window.monaco.editor.setModelLanguage(doc.model, languageFor(doc.path)); },
    disposeModel: function (model) { model.dispose(); },
    renderTabs: function (documents, activePath) { tabs.render(documents, activePath); },
    changed: function () { renderDirty(); explorer.welcome(recentRoots); },
    highlight: function (path) { explorer.highlight(path); },
  });
  const tabs = window.createEditorTabs(el.editorTabs, {
    open: function (path) { return openFile(path); },
    close: function (path) { return editorWorkspace.close(path); },
    openReview: fileWorkspace.openReview, closeReview: fileWorkspace.closeReview,
    openTools: fileWorkspace.openTools, closeTools: fileWorkspace.closeTools,
  });
  fileWorkspace.attachTabs(tabs);
  const explorer = window.createFileExplorer({
    bridge, tree: el.tree, editor: el.monacoHost,
    getRoot: function () { return state.root; }, currentPath: function () { return state.currentPath; },
    newFile: document.getElementById('file-new'), newFolder: document.getElementById('folder-new'),
    refresh: document.getElementById('file-refresh'), welcome: document.getElementById('workspace-welcome'),
    setInfo, openFile: function (path) { return openFile(path, null); },
  });
  function loadTree() { return explorer.refresh(false); }
  async function openFile(relPath) {
    const root = state.root; const revision = workspaceRevision;
    await fileWorkspace.showEditor();
    if (root !== state.root || revision !== workspaceRevision) return false;
    return editorWorkspace.open(relPath);
  }
  function save() { return editorWorkspace.save(); }
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
  /** 选区浮动入口仅复制真实选中原文，无全文回退。 */
  async function copyNumberedSelection() {
    if (!state.currentPath) {
      setInfo('请先打开一个文件，再选中要交给模型修改的代码', true);
      return false;
    }
    const editor = state.editor;
    if (!editor) {
      setInfo('编辑器尚未就绪，无法取选区', true);
      return false;
    }

    const model = editor.getModel();
    const selection = editor.getSelection();
    const hasSelection = Boolean(selection) && !selection.isEmpty();
    if (!hasSelection) {
      return false;
    }

    const text = model.getValueInRange(selection);
    const startLine = selection.startLineNumber;

    if (text.length === 0) {
      setInfo('选中内容为空，没有可复制的片段', true);
      return false;
    }

    const result = await bridge.copyNumberedSnippet({
      root: state.root,
      relPath: state.currentPath,
      text: text,
      startLine: startLine,
    });
    if (!result.ok) {
      setInfo('复制片段失败：' + (result.error ?? '未知错误'), true);
      return false;
    }
    setInfo(
      '已复制原文片段（' + result.startLine + '-' + result.endLine + ' 行，' + result.length + ' 字符）—— 粘贴给模型作为上下文，修改以 SEARCH／REPLACE 精确匹配'
    );
    return true;
  }

  /* ---------------- 选区右上角的浮动复制按钮 ----------------
   *
   * 用户建议（比顶部常驻按钮更顺手）：选中代码后，在**选区右上角**冒一个小按钮，
   * 点它即无损复制选中的原文上下文。
   *
   * 用绝对定位贴在选区右端行的右上角（跟随选区、随滚动移动）；
   * 没有选区时隐藏 —— 没有选区可复制，出现就是误导。
   * 注意：仍**只写剪贴板**，不碰网页（ADR-0003 零注入）。
   *
   * 【必须在 state.editor 就绪之后调用】Monaco 是 `window.require` 异步加载的，
   * 本函数若写成顶层 IIFE，就会在 state.editor 还是 null 时执行并静默 return，
   * 表现为「代码在逻辑里写了、按钮却永远不出现」。所以由 initMonaco 的回调触发。
   */
  function setupSelectionCopyBubble() {
    if (!state.editor || !window.monaco) return;
    if (state.selectionBubbleReady) return; // 幂等：require 回调万一重入不重复挂
    state.selectionBubbleReady = true;

    /**
     * 【必须在这里把编辑器实例**取到本地**再往下用】
     *
     * 上一版整段代码里写的是裸 `editor.getSelection()` / `editor.getModel()`，
     * 但本函数**没有 `editor` 这个绑定** —— 同名的 `editor` 只是别的函数的局部变量，
     * 不构成闭包。于是这些引用要么命中未定义全局、要么直接抛 ReferenceError。
     *
     * 而 `getPosition()` 是**由 Monaco 在它自己的渲染循环里回调**的：
     * 里面抛出的异常被 Monaco 内部吞掉，外部看不到任何报错，
     * 表现就只是"按钮永远不出现"—— 正是最难查的那种"静默失败"。
     * 这与上面注释里记的"顶层 IIFE 静默 return"是同一类缺陷的两个变体：
     * **都不是逻辑写错，而是这段代码压根没正常跑起来。**
     */
    const editor = state.editor;

    const bubble = document.createElement('div');
    bubble.className = 'selection-copy';
    /**
     * 【不要用 `hidden` 属性、也不要自己写 `display`】
     *
     * Monaco 的 ContentWidget 包装器（`l4` 类）**独占**这个节点的 `display` 与 `visibility`：
     *   - 挂载时它自己 `setDisplay("none")` + `setVisibility("hidden")`；
     *   - 每次 `setPosition()` 它按"有锚点 + preference 非空"决定 `setDisplay("block"|"none")`；
     *   - 每次 `render()` 它按是否离屏决定 `setVisibility("inherit"|"hidden")`。
     *
     * 这三处写的都是**内联样式**，级别高于任何样式表规则。
     * 所以以前 `.selection-copy{display:none}` + `hidden` 属性 + `.visible{display:inline-block}`
     * 全都是在跟 Monaco 抢同一个属性 —— 谁最后写谁赢，表现就是"有时出现有时不出现"。
     * 正解：**我们一次都不碰 `display`**，显隐完全由 `getPosition()` 的返回值表达：
     * 返回 `null` → Monaco 判定无锚点 → 它自己收起来；返回合法锚点 → 它自己显示。
     *
     * 同理**不要用 `title`**：原生 title 提示在元素位置变化时失效重建，
     * 浮层又随选区/滚动不断重定位，会表现为 hover 提示一闪一闪。
     * 用 `aria-label`：不产生原生 tooltip，语义与无障碍信息仍保留。
     */
    bubble.setAttribute('aria-label', '复制这段原文上下文');
    bubble.textContent = '复制';

    /**
     * 【定位交给 Monaco 的 content widget，而不是自己算绝对坐标】
     *
     * 前一版自己算 `style.left/top`，在 markdown 上按钮始终不出现。三个原因叠加：
     *
     * 1. **两套坐标系脱节**。`getTopForLineNumber` / `getOffsetForColumn` 返回的是
     *    **编辑器视口内**坐标，而浮层挂在 `.editor-wrap` 上（编辑器**外面**）。
     *    编辑器一旦滚动，两者就对不上。
     * 2. **wordWrap 折行**。`end.lineNumber` 是选区末端的**逻辑行**，
     *    但该行可能折成多个**视觉行**，`getTopForLineNumber` 给的是它**第一视觉行**的 top。
     *    长段落 md（用户截图里那段选了 4 个视觉行）必然错位。
     * 3. 选区为空/未打开文件时静默 `hidden`，与"定位失败"表现一样，看不出区别。
     *
     * `IContentWidget` 由 Monaco 自己定位：滚动、折行、视口裁剪、被编辑内容遮挡
     * （`preference` 里的 `ABOVE`/`BELOW`）全都自动处理，**不需要我们算任何坐标**。
     */
    let hideTimer = 0;
    let dismissed = false; // 用户点了"已复制"后短暂抑制，别让按钮立刻又冒出来
    const ContentWidgetPositionPreference = window.monaco.editor.ContentWidgetPositionPreference;

    const contentWidget = {
      getId: function () {
        return 'selection-copy-widget';
      },
      getDomNode: function () {
        return bubble;
      },
      /**
       * 【这里是唯一的显隐真源】
       *
       * 返回 `null` = "现在没有可复制的选区" → Monaco 自己把节点 display:none / visibility:hidden。
       * 返回合法锚点 = "显示在这里" → Monaco 自己把它摆出来。
       *
       * 三个前置条件缺一不可，缺任何一个都返回 null：
       *   1. 编辑器有模型（没打开文件时 getModel() 为 null）；
       *   2. 已打开某个文件（state.currentPath 非空）；
       *   3. 选区非空。
       */
      getPosition: function () {
        if (!editor.getModel() || !state.currentPath || dismissed) return null;
        const selection = editor.getSelection();
        if (!selection || selection.isEmpty()) return null;

        /**
         * 【锚在选区**首行**的右端，而不是末行】
         *
         * 用户反馈（第十一轮）："这个复制按钮……好像是最后一行的右上角，
         * 不是整体的区域的右上角"。上一版锚在 `getEndPosition()`，
         * 于是按钮跟着**选区最后一行**跑，视觉上像是"贴着选区底边"。
         *
         * 用户要的是**外接矩形的右上角**，那就是首行的右端：
         *   - `getStartPosition()` 在 Monaco 里恒指向**文档序更靠前**的那一端
         *     （从上往下拖、从下往上拖，返回值都一样），所以它天然就是矩形上缘；
         *   - 再取该行的**行尾列**，水平上就落在矩形右缘。
         *
         * 注意与 `ABOVE` 的配合：锚在首行行尾 + 浮在锚点上方，
         * 按钮就盖在"整体选区框的右上角外侧"，不遮挡选区第一行文字。
         */
        const start = selection.getStartPosition();
        const lineCount = editor.getModel().getLineCount();
        // 首行行号越界（文件被外部改短等）：不猜位置，直接收起。
        if (start.lineNumber < 1 || start.lineNumber > lineCount) return null;

        // 折行时该逻辑行会折成多个视觉行；positionAffinity=Left 让 Monaco 把锚
        // 解析到该视觉行的左缘，避免锚点飘到折行的下一视觉行去。
        const column = editor.getModel().getLineMaxColumn(start.lineNumber);
        return {
          position: { lineNumber: start.lineNumber, column: column },
          // ABOVE 优先：按钮浮在选区**上缘**外侧，不遮挡选区文字；空间不足时退到 BELOW。
          preference: [ContentWidgetPositionPreference.ABOVE, ContentWidgetPositionPreference.BELOW],
          positionAffinity: window.monaco.editor.PositionAffinity
            ? window.monaco.editor.PositionAffinity.Left
            : undefined,
        };
      },
      // 关键：告诉 Monaco 在我身上拦截 mousedown。
      // 否则编辑器会立刻抢走焦点、选区消失，随后 getSelection() 拿到空值，
      // 复制到的就是整篇文件而不是选中的那段。
      suppressMouseDown: true,
      // 注意：**不要设 useDisplayNone**。设成 true 会让 Monaco 的 setPosition()
      // 永远走 else 分支、把节点钉死在 display:none（见 l4.setPosition 的三元表达式），
      // 反而必须由我们自己去写 display —— 那就又回到"两方抢同一属性"的老问题。
      // 保持默认（false），display 与 visibility 完整交给 Monaco。
    };

    /**
     * 让 Monaco 重算位置。
     *
     * 必须传**原始 widget 对象**（带 getPosition 的那个），不能传别的：
     * 公开层 `editor.layoutContentWidget(w)` 会执行 `w.getPosition()`，
     * 把结果写进它内部包装器的 `position` 字段，再转交视图层。
     * 传错对象 → `w.getPosition()` 抛错或拿到 undefined → 锚点丢失。
     */
    function layoutWidget() {
      if (!editor.getModel()) return;
      editor.layoutContentWidget(contentWidget);
    }

    editor.addContentWidget(contentWidget);

    function scheduleHide() {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(function () {
        dismissed = true; // 收起：getPosition 返回 null，Monaco 随即隐藏
        layoutWidget();
      }, 4000);
    }

    function updateVisibility() {
      // 重新出现选区就把"已收起"状态解除
      const selection = editor.getSelection();
      if (selection && !selection.isEmpty()) dismissed = false;
      // 只让 Monaco 重算，显隐由 getPosition() 的返回值决定
      layoutWidget();
    }

    // 选区变化：Monaco 会自动重算 content widget 位置，**我们不写任何 style**
    editor.onDidChangeCursorSelection(function () {
      updateVisibility();
      const selection = editor.getSelection();
      if (selection && !selection.isEmpty() && !dismissed) scheduleHide();
    });
    // 滚动 / 内容变化：同样只需让 Monaco 重新布局
    editor.onDidScrollChange(function () {
      layoutWidget();
    });

    bubble.addEventListener('mousedown', function (e) {
      // 双保险：widget 已声明 suppressMouseDown，这里再拦一次，
      // 确保选区不丢（复制的是"选中的那段"而不是整篇文件）。
      e.preventDefault();
      e.stopPropagation();
    });
    bubble.addEventListener('click', async function (e) {
      e.preventDefault();
      e.stopPropagation();
      const ok = await copyNumberedSelection();
      if (!ok) return;
      bubble.textContent = '已复制 ✓';
      bubble.classList.add('done');
      scheduleHide();
      window.setTimeout(function () {
        bubble.textContent = '复制';
        bubble.classList.remove('done');
      }, 1800);
    });
  }
  // 注：这里原本挂着一个「保存」按钮的 click 监听，已随按钮一起移除。
  // 保存现在只有一个入口 —— **Ctrl+S**（注册在 Monaco 上，见 initMonaco）；
  // 未保存状态由工具栏「● 未保存」与文件名旁的白点提示。

  const localPrompt = window.setupLocalPrompt(bridge, setInfo);
  window.setupPromptComposer(bridge, setInfo, localPrompt);

  function updateRoot(info) {
    const changed = state.root !== info.root || (workspaceRevision !== null && workspaceRevision !== info.revision);
    state.root = info.root;
    workspaceRevision = info.revision;
    recentRoots = info.recentRoots || recentRoots;
    if (changed) { fileWorkspace.resetReview(); editorWorkspace.clear(); }
    workspaceNavigation.update(info);
    renderRoot(); renderDirty(); explorer.welcome(recentRoots);
    if (changed) void explorer.refresh(true);
  }
  bridge.onRootChanged(updateRoot);
  bridge.onEntryChanged(function (event) {
    if (event.revision !== workspaceRevision) return;
    editorWorkspace.entryChanged(event); explorer.entryChanged(event);
    setInfo('目标已' + (event.kind === 'renamed' ? '重命名' : '移入回收站') + '；相关 AI 变更和撤销记录已失效。');
  });
  bridge.onRootStale(function (info) {
    updateRoot({ root: null, recentRoots, revision: workspaceRevision });
    setInfo('恢复目录失败：' + (info.error || '上次打开的目录不可用，请重新选择目录'), true);
  });

  /* ---------------- 启动 ---------------- */
  async function main() {
    initMonaco();
    renderRoot();
    renderDirty();
    const info = await bridge.getRoot();
    recentRoots = info.recentRoots || await bridge.getRecentRoots();
    updateRoot(info);
    await loadTree();
  }

  void main();
})();
