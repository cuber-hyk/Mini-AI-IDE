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
    btnSnippet: document.getElementById('btn-snippet'),
    btnWholeFile: document.getElementById('btn-whole-file'),
    // 注意：这里**不要**用键名 `monaco`，否则会遮蔽全局的 `window.monaco`（AMD 模块对象），
    // 导致 `window.monaco.editor.createModel` / `createDecorationsCollection` 之类的调用难以排查。
    // 另：这个键是**普通编辑器**的唯一宿主。内联 diff 的标记也画在它上面，
    // 本进程不再有第二个 Monaco 实例（见 renderInlineDiff）。
    monacoHost: document.getElementById('monaco'),
    resizer: document.getElementById('resizer'),
    requirement: document.getElementById('requirement'),
    btnCopyPrompt: document.getElementById('btn-copy-prompt'),
    // 提示词版本双段开关（开=完整版 / 关=简洁版），状态持久化在主进程设置里
    variantSwitch: document.getElementById('variant-switch'),
    // 采集入口在 AI 网页顶部，变更列表在右侧独立视图。
    // 面板显示控制与 diff 视图
    sidebar: document.getElementById('sidebar'),
    sidebarResizer: document.getElementById('sidebar-resizer'),
    btnSidebar: document.getElementById('btn-sidebar'),
    diffActions: document.getElementById('diff-actions'),
    diffLabel: document.getElementById('diff-label'),
    btnDiffApply: document.getElementById('btn-diff-apply'),
    btnDiffClose: document.getElementById('btn-diff-close'),
    btnDiffPrev: document.getElementById('btn-diff-prev'),
    btnDiffNext: document.getElementById('btn-diff-next'),
    // 提示词设置入口（齿轮）：面板本体是独立视图，这里只是"打开"的入口
    btnSettings: document.getElementById('btn-settings'),
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

  const state = {
    root: null,
    currentPath: null,
    currentText: '',
    savedText: '',
    /** Monaco 编辑器实例（整个进程只有这一个，从不销毁重建） */
    editor: null,
    /**
     * 内联 diff 的行内标记装饰集合。
     *
     * 为什么是 decorations 而不是 Monaco 的 DiffEditor：**用户要的是「diff 与原文件整合显示」**——
     * 文件还是那份真实内容，变更行原地标红/ 标绿。若改用 DiffEditor，界面会变成
     * 左边「当前文件」、右边「应用后」两个独立板块，正是用户明确不要的形态。
     *
     * Monaco 0.57.0 **没有**官方内联 diff API（`monaco.d.ts` 与 `editor.api.d.ts` 中
     * `InlineDiff` 命中数为 0），因此这里用公开的 `createDecorationsCollection` + `changeViewZones` 自行实现。
     */
    diffDecorations: null,
    selectionBubbleReady: false, // 选区浮层复制按钮是否已挂载（幂等保护）
    /** 内联 diff 中"插入的新增行"用 view zone 画出（它们不是真实文本，见 renderInlineDiff） */
    diffZoneIds: [],
    /** 当前正在预览的变更（退出预览时清理） */
    diffTarget: null,
    /** 当前批次全部变更的定位信息，供「上一个 / 下一个」导航 */
    diffNav: null,
    /** 右侧 AI 网页当前是否显示（由主进程广播同步） */
    webVisible: true,
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
    const promptRect = rectOf(el.btnCopyPrompt);
    const toolbarRect = rectOf(document.getElementById('btn-open'));

    const promptVisible = promptRect.height > 0 && promptRect.bottom <= viewportH;
    const editorFills = editorRect.height > 200;
    const noOverlap = promptRect.top >= editorRect.top;

    return {
      viewportH,
      editorArea: editorRect,
      toolbar: toolbarRect,
      copyPromptButton: promptRect,
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

    ed.setSelection(savedSelection);

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
      // 选区浮层复制按钮必须等state.editor 就绪后才能建（见 setupSelectionCopyBubble 注释）
      setupSelectionCopyBubble();
    });
  }

  /* ---------------- 目录树宽度与可见性 ---------------- */
  function applySidebar(width, visible) {
    if (typeof width === 'number' && Number.isFinite(width)) {
      el.sidebar.style.width = Math.round(width) + 'px';
    }
    el.sidebar.hidden = !visible;
    el.sidebarResizer.hidden = !visible;
    el.btnSidebar.classList.toggle('active', visible);
  }

/* ---------------- 内联 diff（差异与原文件整合显示）----------------
 *
 * 用户要的是「diff 与原文件整合一起显示，而不是分两个板块」——
 * 因此编辑器里放的**始终是磁盘上那份真实文件**（一个字符都没改过），
 * 变更以行内标记叠加在上面：
 *   - 删除行：淡红底 + 文字删除线 + 行号标红
 *   - 新增行：淡绿底 + 行号 `+`，**插在变更位置的紧后面**
 *
 * 为什么不改用 Monaco 的 DiffEditor：那会把界面变成左边「当前文件」、
 * 右边「应用后」两个独立板块，正是用户明确否掉的形态。
 *
 * 为什么全部自己画：Monaco 0.57.0 未导出官方内联 diff API
 * （`monaco.d.ts` 与 `esm/vs/editor/editor.api.d.ts` 搜 `InlineDiff` 命中 0），
 * VS Code 的内联 diff 依赖编辑器内部协议，第三方拿不到。
 * `createDecorationsCollection` 与 `changeViewZones` 都是公开 API，够用。
 */

/**
 * 计算两侧文本的行级映射（与主进程 src/shared/diff.ts 同算法：行级 LCS）。
 * 返回按原文顺序排列的 { kind:'del'|'add', oldLine, newLine, afterLine, text }。
 * 新增行的 afterLine 是已走过的原文行数（0 表示首行之前）。
 */
  function lineMap(original, modified) {
    const a = original.split(/\r\n|\r|\n/);
    const b = modified.split(/\r\n|\r|\n/);
    if (a.length > 1 && a[a.length - 1] === '') a.pop();
    if (b.length > 1 && b[b.length - 1] === '') b.pop();

    // 行数过大时不做 LCS（O(n²) 会卡住 UI），退化为「整文件替换」：全删 + 全增。
    const ops = [];
    if (a.length > 4000 || b.length > 4000) {
      a.forEach(function (text, i) { ops.push({ kind: 'del', oldLine: i + 1, text: text }); });
      b.forEach(function (text, j) { ops.push({ kind: 'add', newLine: j + 1, afterLine: a.length, text: text }); });
      return ops;
    }

    const rows = a.length + 1;
    const cols = b.length + 1;
    const table = [];
    for (let i = 0; i < rows; i += 1) table.push(new Uint32Array(cols));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      const row = table[i];
      const next = table[i + 1];
      for (let j = b.length - 1; j >= 0; j -= 1) {
        row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
      }
    }

    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        ops.push({ kind: 'del', oldLine: i + 1, text: a[i] });
        i += 1;
      } else {
        ops.push({ kind: 'add', newLine: j + 1, afterLine: i, text: b[j] });
        j += 1;
      }
    }
    while (i < a.length) {
      ops.push({ kind: 'del', oldLine: i + 1, text: a[i] });
      i += 1;
    }
    while (j < b.length) {
      ops.push({ kind: 'add', newLine: j + 1, afterLine: i, text: b[j] });
      j += 1;
    }
    return ops;
  }

  /** 清掉所有内联标记（decoration + view zone），恢复成普通可编辑编辑器 */
  function clearInlineDiff() {
    if (state.editor && state.diffZoneIds.length > 0) {
      state.editor.changeViewZones(function (accessor) {
        state.diffZoneIds.forEach(function (id) {
          accessor.removeZone(id);
        });
      });
    }
    state.diffZoneIds = [];
    if (state.diffDecorations) {
      state.diffDecorations.clear();
    }
    state.diffTarget = null;
    state.diffNav = null;
    el.diffActions.hidden = true;
    el.diffLabel.textContent = '';
    // 预览期间是只读的，退出后必须恢复可编辑
    if (state.editor) {
      state.editor.updateOptions({ readOnly: false });
    }
  }

  /**
   * 在**当前已打开的编辑器**上叠加内联标记。
   *
   * 关键前提：主进程 buildEditorDiff 返回的 original 必须就是编辑器里现在这份内容
   * （三向校验保证「显示得出来就一定应用得成功」）。若不一致（用户中途改过文件），
   * 宁可不画 —— 画错位置的标记比不画更糟。
   */
  function renderInlineDiff(payload) {
    const editor = state.editor;
    if (!editor || !window.monaco) {
      setInfo('编辑器尚未就绪，无法显示变更标记', true);
      return;
    }

    clearInlineDiff();

    const model = editor.getModel();
    if (!model) {
      setInfo('编辑器中没有内容，无法显示变更标记', true);
      return;
    }

    const original = payload.original || '';
    if (model.getValue() !== original) {
      setInfo('文件内容已变化，请重新采集后再预览变更', true);
      return;
    }

    const ops = lineMap(original, payload.modified || '');
    const decorations = [];
    const total = model.getLineCount();

    /* ---- 1) 删除行：整行标红+ 左侧留删除标记 ---- */
    ops.forEach(function (op) {
      if (op.kind !== 'del') return;
      decorations.push({
        range: new window.monaco.Range(op.oldLine, 1, op.oldLine, 1),
        options: {
          isWholeLine: true,
          className: 'inline-deleted',
          linesDecorationsClassName: 'inline-deleted-gutter',
          lineNumberClassName: 'inline-deleted-ln',
        },
      });
    });

    /* ---- 2) 插入行：同一原文锚点的 add 合并成一个 view zone ----
     *
     * 插入点由行映射的原文游标决定；即便前面只有未改动的行，也能正确定位。
     */
    const groups = [];
    ops.forEach(function (op) {
      if (op.kind !== 'add') return;
      const last = groups[groups.length - 1];
      if (last && last.afterLine === op.afterLine) last.lines.push(op);
      else groups.push({ afterLine: op.afterLine, lines: [op] });
    });

    state.editor.changeViewZones(function (accessor) {
      groups.forEach(function (group) {
        const box = document.createElement('div');
        box.className = 'inline-added-group';

        group.lines.forEach(function (line) {
          const row = document.createElement('div');
          row.className = 'inline-added';

          const no = document.createElement('span');
          no.className = 'inline-added-ln';
          no.textContent = String(line.newLine);
          row.appendChild(no);

          const sign = document.createElement('span');
          sign.className = 'inline-added-sign';
          sign.textContent = '+';
          row.appendChild(sign);

          const text = document.createElement('span');
          text.className = 'inline-added-text';
          text.textContent = line.text.length > 0 ? line.text : ' ';
          row.appendChild(text);

          box.appendChild(row);
        });

        // afterLineNumber 表示插到该原文行之后；0 表示首行之前
        const id = accessor.addZone({
          afterLineNumber: Math.min(group.afterLine, total),
          heightInPx: group.lines.length * 22 + 2,
          domNode: box,
        });
        state.diffZoneIds.push(id);
      });
    });

    state.diffDecorations = editor.createDecorationsCollection(decorations);

    /* ---- 3) 进入预览态：只读 + 操作条 ---- */
    editor.updateOptions({ readOnly: true });
    el.diffActions.hidden = false;
    el.diffLabel.textContent =
      (payload.filePath || '') + (payload.identical ? '（无差异，应用后内容与当前文件相同）' : '');

    // 滚到第一处变更，避免「标记画了但没看见」
    const firstDel = ops.find(function (op) { return op.kind === 'del'; });
    if (firstDel) {
      editor.revealLineInCenter(firstDel.oldLine);
    }

    setInfo('变更预览：红色删除线是要被替换的行，绿色是应用后新增的行 —— 确认无误后点「应用此变更」');
  }

  /** 进入某个变更的预览（打开对应文件 + 叠加内联标记） */
  async function enterDiff(payload) {
    /* renderInlineDiff 内部会先 clearInlineDiff（要清掉上一个文件的标记），
       而 clearInlineDiff 会把 diffNav 一起清掉。所以在**渲染之前**把导航上下文
       存到局部变量，渲染后再放回去 —— 否则同批次跳转能力会在每次预览时丢失。 */
    const keepNav = state.diffNav;
    if (payload.filePath && state.currentPath !== payload.filePath) {
      await openFile(payload.filePath, null);
    }
    renderInlineDiff(payload);
    state.diffTarget = {
      collectionId: payload.collectionId,
      index: payload.index,
      filePath: payload.filePath,
    };
    if (keepNav) {
      state.diffNav = keepNav;
      if (state.diffNav.files.length > 1 && state.diffTarget) {
        const at = state.diffNav.files.findIndex(function (f) {
          return f.index === state.diffTarget.index;
        });
        if (at >= 0) state.diffNav.position = at;
      }
    }
  }

  function exitDiff() {
    clearInlineDiff();
    setInfo('已退出变更预览');
  }

  el.btnDiffClose.addEventListener('click', function () {
    exitDiff();
  });

  /* ---- 上一处 / 下一处：多文件变更时在批次内跳转 ---- */
  async function stepDiff(delta) {
    const nav = state.diffNav;
    if (!nav || !nav.files || nav.files.length <= 1) return;
    let idx = nav.position;
    for (let step = 0; step < nav.files.length; step += 1) {
      idx = (idx + delta + nav.files.length) % nav.files.length;
      const next = nav.files[idx];
      if (!next) continue;
      if (state.diffTarget && next.index === state.diffTarget.index && nav.files.length > 1) continue;
      const result = await bridge.stepDiff(next.collectionId, next.index);
      if (result && result.ok) {
        nav.position = idx;
        return;
      }
    }
  }

  el.btnDiffPrev.addEventListener('click', function () {
    void stepDiff(-1);
  });
  el.btnDiffNext.addEventListener('click', function () {
    void stepDiff(1);
  });

  el.btnDiffApply.addEventListener('click', async function () {
    const target = state.diffTarget;
    if (!target) return;
    const nav = state.diffNav;
    el.btnDiffApply.disabled = true;
    el.btnDiffApply.textContent = '应用中…';
    const result = await bridge.applyChange({
      collectionId: target.collectionId,
      index: target.index,
      filePath: target.filePath,
    });
    el.btnDiffApply.disabled = false;
    el.btnDiffApply.textContent = '应用此变更';
    if (!result.ok) {
      setInfo('应用失败：' + (result.error || '未知错误'), true);
      return;
    }
    clearInlineDiff();
    setInfo('已应用' + result.filePath + '（模式 ' + result.mode + '）—— 可在右下角预览面板点「撤销」回退');

    /*
     * 这里**不再自己 openFile**：主进程在落盘成功后会广播 `fileChanged`，
     * 刷新统一由 onFileChanged 处理（否则应用按钮与右下角面板两条路径
     * 各刷一次，既重复又可能出现先后竞态）。
     */

    // 自动跳到下一个变更，一路看一路应用
    if (nav && nav.files && nav.files.length > 1) {
      const rest = nav.files.filter(function (f) {
        return f.index !== target.index;
      });
      if (rest.length > 0) {
        const next = rest[0];
        const applied = await bridge.stepDiff(next.collectionId, next.index);
        /*
         * 注意：跳转后主进程会推来**新文件**的 payload（带它自己的 siblings），
         * onDiffData 会据此重建 state.diffNav。所以这里不能去改旧的 nav ——
         * 只需要保证"新 nav 的 position 指向刚跳过去的这个变更"。
         */
        if (applied && applied.ok && state.diffNav) {
          const at = state.diffNav.files.findIndex(function (f) {
            return f.index === next.index;
          });
          state.diffNav.position = at >= 0 ? at : 0;
        }
      }
    }
  });

  /* ---------------- 目录树与编辑器之间的拖拽 ---------------- */
  (function setupSidebarResizer() {
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    el.sidebarResizer.addEventListener('pointerdown', function (e) {
      dragging = true;
      startX = e.clientX;
      startWidth = el.sidebar.getBoundingClientRect().width;
      el.sidebarResizer.classList.add('dragging');
      el.sidebarResizer.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    el.sidebarResizer.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const next = Math.round(startWidth + (e.clientX - startX));
      el.sidebar.style.width = next + 'px';
      if (state.editor) state.editor.layout();
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      el.sidebarResizer.classList.remove('dragging');
      try {
        el.sidebarResizer.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* 指针可能已释放 */
      }
      void bridge.setSidebarWidth(el.sidebar.getBoundingClientRect().width);
    }
    el.sidebarResizer.addEventListener('pointerup', end);
    el.sidebarResizer.addEventListener('pointercancel', end);

    // 双击复位
    el.sidebarResizer.addEventListener('dblclick', function () {
      el.sidebar.style.width = '230px';
      if (state.editor) state.editor.layout();
      void bridge.setSidebarWidth(230);
    });
  })();

  /* ---------------- 面板开关 ---------------- */
  el.btnSidebar.addEventListener('click', function () {
    const next = el.sidebar.hidden;
    applySidebar(undefined, next);
    void bridge.setSidebarVisible(next);
  });

  /*
   * 提示词设置（齿轮）。
   *
   * 面板本体是**独立视图**，本渲染进程拿不到它、也不该去操作它 ——
   * 这里只把"用户想打开面板"这个意图交给主进程（面板由主进程显示并居中摆放）。
   * 打开后主进程会广播 `ui:open-prompt-panel`，据此把齿轮点亮成激活态。
   */
  el.btnSettings.addEventListener('click', function () {
    void openPromptSettings();
  });

  async function openPromptSettings() {
    try {
      await bridge.openPromptPanel();
    } catch (err) {
      setInfo(`打开提示词设置失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  bridge.onOpenPromptPanel(function () {
    // 面板已在主进程侧显示；这里只做视觉反馈（否则点了没反应的观感很差）
    el.btnSettings.classList.add('active');
    setInfo('已在提示词设置面板里编辑「输出格式要求」——Esc 关闭');
    window.setTimeout(function () {
      el.btnSettings.classList.remove('active');
    }, 1200);
  });

  /*
   * 「AI 网页」的显隐按钮已移到**网页区自己的顶部工具条**（webbar.html）——
   * 折叠/展开应在被折叠的那块板上操作，而不是挤在左侧编辑器工具栏里。
   * 因此这里没有按钮，只有快捷键与主进程状态同步。
   */
  async function toggleWeb() {
    const result = await bridge.setWebVisible(!state.webVisible);
    state.webVisible = Boolean(result && result.visible);
    setInfo(state.webVisible ? '已显示右侧 AI 网页' : '已隐藏 AI 网页 —— 编辑器占满全窗口');
  }

  // 注：这里**不再有**「回程预览」的开关按钮。
  // 它原先在编辑器工具栏里，与网页区右上角那个图标按钮**功能完全重复**
  // （两处逐行相同的 setPreviewPanel 调用，连面板高度算法都一样）。
  // 现在只保留网页区右上角那一个：
  //   - 预览面板属于「右侧那一列」，开关就该跟着那一列走；
  //   - 编辑器工具栏是编辑器的顶栏，放右侧区域的开关属于越界；
  //   - 网页隐藏时预览会一并隐藏，此时那一列的控制也跟着消失，语义自洽。
  // 本进程仍保留 state.previewVisible 作为状态镜像（主进程会广播），
  // 只是不再由本进程发起切换。

  // 快捷键：Ctrl+B 目录树 / Ctrl+Shift+A AI 网页（编辑器获得焦点时也能用）
  document.addEventListener('keydown', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      el.btnSidebar.click();
    } else if (e.shiftKey && (e.key === 'A' || e.key === 'a')) {
      e.preventDefault();
      void toggleWeb();
    }
  });

  bridge.onDiffData(function (payload) {
    if (!payload || !payload.active) {
      exitDiff();
      return;
    }
    // 批次内导航上下文：给「上一个 / 下一个」用
    if (payload.siblings && payload.siblings.length > 0) {
      state.diffNav = { files: payload.siblings, position: payload.position ?? 0 };
      el.btnDiffPrev.disabled = state.diffNav.files.length <= 1;
      el.btnDiffNext.disabled = state.diffNav.files.length <= 1;
    }
    void enterDiff(payload);
  });

  bridge.onFileChanged(async function (filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) return;
    /*
     * 磁盘被回程链路改写了。若这个文件正打开在编辑器里，必须重新读盘 ——
     * 落盘在主进程、编辑在另一个渲染进程，不主动刷新就一直显示旧内容
     * （用户实测：应用后仍是旧代码，关闭文件重开才对）。
     */
    if (state.currentPath !== filePath) return;

    // 正在预览该文件的变更：标记已失效（original 不再等于磁盘内容），先退出
    if (state.diffTarget && state.diffTarget.filePath === filePath) {
      clearInlineDiff();
      setInfo('已应用变更，文件内容已刷新');
    }
    await openFile(filePath, null);
  });

  bridge.onSidebarChanged(function (s) {
    applySidebar(s && s.width, !(s && s.visible === false));
  });

  // 网页可见性也可能被网页区工具条那个按钮改掉，这里只同步状态（无本地按钮要paint）
  bridge.onChromeState(function (s) {
    if (!s) return;
    state.webVisible = s.webVisible !== false;
    state.previewVisible = Boolean(s.previewVisible);

  });

  /**
   * 内联 diff 视图探针（`--ui-probe --test-diff` 使用）。
   *
   * 为什么需要：内联标记是靠`createDecorationsCollection` + `changeViewZones`
   * 自绘的（Monaco 0.57 无官方内联 diff API），"标记到底画上去没有"只能实测 ——
   * 曾经吃过"配置写了但运行期没生效"的亏（多项）。
   *
   * 注意：探针会**先把编辑器内容替换成 sample**（内联标记要求编辑器里就是原文），
   * 所以必须在没有打开真实文件时调用。
   */
  window.__uiDiffProbe = async function (original, modified) {
    try {
      const editor = state.editor;
      if (!editor) return { ok: false, error: '编辑器尚未创建' };

      // 内联标记画在**当前编辑器内容**上，因此先把它设成 original
      editor.setValue(original);

      await enterDiff({
        active: true,
        filePath: 'probe.ts',
        original: original,
        modified: modified,
        language: 'typescript',
        collectionId: 'probe',
        index: 0,
        identical: false,
      });

      const ops = lineMap(original, modified);
      const expectedDel = ops.filter(function (o) { return o.kind === 'del'; }).length;
      const expectedAdd = ops.filter(function (o) { return o.kind === 'add'; }).length;
      const zonesDrawn = state.diffZoneIds.length;
      const decorationsDrawn = state.diffDecorations
        ? state.diffDecorations.length
        : 0;
      const readOnlyNow = Boolean(editor.getOption(window.monaco.editor.EditorOption.readOnly));
      const actionsVisible = !el.diffActions.hidden;
      const label = el.diffLabel.textContent;

      // 复原，避免影响后续测量
      exitDiff();

      return {
        /* 装饰数量应等于删除行数；插入行数等于view zone 里的行数 */
        decorationsDrawn,
        expectedDel,
        zonesDrawn,
        expectedAdd,
        readOnlyNow,
        actionsVisible,
        label,
        ok: decorationsDrawn === expectedDel && zonesDrawn >= 1 && readOnlyNow && actionsVisible,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

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
/**
   * 复制「带真实行号的片段」到剪贴板。
   *
   * 有选区就取选区，没有就取整个文件。**只写剪贴板**，由用户自己粘贴给模型
   *（ADR-0003 零注入：程序不向网页写入任何内容）。
   *
   * @param fallbackToWholeFile 无选区时是否退回整文件。
   *   顶部按钮传 true（保留原行为）；选区浮层按钮传 false —— 没有选区时它根本不该出现。
   * @returns 是否成功复制
   */
  async function copyNumberedSelection(fallbackToWholeFile) {
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
    if (!hasSelection && !fallbackToWholeFile) {
      return false;
    }

    const text = hasSelection ? model.getValueInRange(selection) : model.getValue();
    const startLine = hasSelection ? selection.startLineNumber : 1;

    if (text.trim().length === 0) {
      setInfo('选中内容为空，没有可复制的片段', true);
      return false;
    }

    const result = await bridge.copyNumberedSnippet({
      relPath: state.currentPath,
      text: text,
      startLine: startLine,
    });
    if (!result.ok) {
      setInfo('复制片段失败：' + (result.error ?? '未知错误'), true);
      return false;
    }
    setInfo(
      '已复制片段（' + result.startLine + '-' + result.endLine + ' 行，' + result.length + ' 字符，含### 文件： 与 ### 范围： 头）—— 到右侧粘贴给模型，它会按同一行区间回显'
    );
    return true;
  }

  el.btnSnippet.addEventListener('click', async function () {
    const ok = await copyNumberedSelection(true);
    if (!ok) return;
    el.btnSnippet.textContent = '已复制 ✓';
    setTimeout(function () {
      el.btnSnippet.textContent = '复制选中片段';
    }, 1800);
  });

  /* ---------------- 选区右上角的浮动复制按钮 ----------------
   *
   * 用户建议（比顶部常驻按钮更顺手）：选中代码后，在**选区右上角**冒一个小按钮，
   * 点它即复制带真实行号的片段。
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
    bubble.setAttribute('aria-label', '复制这段（带真实行号）');
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
      const ok = await copyNumberedSelection(false);
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

  window.setupPromptComposer(bridge, setInfo);

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
