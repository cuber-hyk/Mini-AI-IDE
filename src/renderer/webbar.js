/**
 * 网页区顶部工具条 / 右边缘把手（渲染进程脚本）
 *
 * 一个视图、两种形态（由主进程的几何决定，见 webbar.html 顶部注释）：
 *  - 网页可见：顶部横条，放网页与预览的显隐开关；
 *  - 网页隐藏：右边缘竖把手，只有一个「展开 AI 网页」按钮。
 *
 * ⚠️ 本视图**必须始终可见**（哪怕网页已隐藏）。它上面的按钮是
 * "把网页叫回来"的唯一常驻入口——早期实现跟着网页一起隐藏，
 * 用户点完隐藏就再也回不来（本项目已犯过一次，写进了能力文档的陷阱表）。
 *
 * 边界：本视图**不能**读写文件、不能访问 Node、不能向网页写入任何内容；
 * 它只发"切换显隐"的意图给主进程，几何由主进程重算。
 */
(function () {
  'use strict';

  const bridge = window.webbarBridge;
  const el = {
    bar: document.getElementById('bar'),
    web: document.getElementById('btn-web'),
    preview: document.getElementById('btn-preview-toggle'),
    restore: document.getElementById('btn-restore'),
  };
  if (!bridge || !el.bar || !el.web || !el.preview || !el.restore) {
    return;
  }

  /** 与编辑器渲染进程一致的状态镜像，仅用于按钮高亮 */
  let webVisible = true;
  let previewVisible = false;

  /** 刚隐藏后的高亮提示时长（ms）——用户需要知道"去哪找" */
  const HINT_MS = 3000;

  /**
   * 切换形态。
   *
   * 静置时只露 5px 窄条（不干扰阅读），hover / 刚隐藏时展开成 28px 带图标与文字。
   * `hint` 用于刚隐藏后的那 3 秒：强制展开并高亮，告诉用户入口在这里。
   */
  function paint(hint) {
    el.bar.classList.toggle('handle-mode', !webVisible);
    el.web.classList.toggle('active', webVisible);
    el.preview.classList.toggle('active', previewVisible);
    el.web.title = '隐藏 AI 网页（编辑器占满全窗口）· Ctrl+Shift+A';
    el.preview.title = previewVisible ? '隐藏右下角回程预览面板' : '显示右下角回程预览面板';

    if (!webVisible && hint) {
      el.bar.classList.add('just-hidden');
      window.setTimeout(function () {
        el.bar.classList.remove('just-hidden');
      }, HINT_MS);
    }
  }

  el.web.addEventListener('click', async function () {
    const result = await bridge.setWebVisible(false);
    webVisible = Boolean(result && result.visible);
    // 网页隐藏时预览随之一并隐藏（主进程的几何规则），这里同步高亮
    previewVisible = false;
    paint(false);
  });

  el.restore.addEventListener('click', async function () {
    const result = await bridge.setWebVisible(true);
    webVisible = Boolean(result && result.visible);
    paint(false);
  });

  el.preview.addEventListener('click', async function () {
    const next = !previewVisible;
    const height = next ? Math.max(220, Math.round(window.innerHeight * 0.4)) : 0;
    const result = await bridge.setPreviewPanel(height);
    previewVisible = Boolean(result && result.visible);
    paint(false);
  });

  /**
   * 主进程广播当前状态。
   * 刚从"可见"变为"隐藏"时给一次高亮提示，让用户知道右边缘出现了把手
   * （否则 5px 窄条很容易被当成边框忽略）。
   */
  bridge.onChromeState(function (s) {
    if (!s) return;
    const wasVisible = webVisible;
    webVisible = s.webVisible !== false;
    previewVisible = Boolean(s.previewVisible);
    paint(wasVisible && !webVisible);
  });

  paint(false);
})();