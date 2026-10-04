/** 网页顶部工具条：只读采集入口与本地板块显隐，不写入 AI 网页。 */
(function () {
  'use strict';
  const bridge = window.webbarBridge;
  const el = {
    bar: document.getElementById('bar'), web: document.getElementById('btn-web'),
    preview: document.getElementById('btn-preview-toggle'), restore: document.getElementById('btn-restore'),
    collect: document.getElementById('btn-collect'), status: document.getElementById('collect-status'),
  };
  if (!bridge || Object.values(el).some(function (node) { return !node; })) return;
  let webVisible = true;
  let previewVisible = false;
  let previewWidth = 300;
  let hintTimer = null;
  let collecting = false;

  function feedback(message, warn) {
    el.status.textContent = message;
    el.status.title = message;
    el.status.classList.toggle('warn', Boolean(warn));
    // 窄网页栏隐藏状态文字，按钮仍提供完整诊断。
    el.collect.title = message;
  }
  function paint(hint) {
    el.bar.classList.toggle('handle-mode', !webVisible);
    el.web.classList.toggle('active', webVisible);
    el.preview.classList.toggle('active', previewVisible);
    const label = previewVisible ? '隐藏变更列表' : '显示变更列表';
    el.preview.title = label;
    el.preview.setAttribute('aria-label', label);
    el.preview.setAttribute('aria-pressed', String(previewVisible));
    if (!webVisible && hint) {
      window.clearTimeout(hintTimer);
      el.bar.classList.add('just-hidden');
      hintTimer = window.setTimeout(function () { el.bar.classList.remove('just-hidden'); }, 3000);
    }
    if (webVisible) el.bar.classList.remove('just-hidden');
  }
  async function toggleWeb(visible) {
    try {
      const wasVisible = webVisible;
      const result = await bridge.setWebVisible(visible);
      webVisible = Boolean(result && result.visible);
      paint(wasVisible && !webVisible);
    } catch (err) {
      feedback('切换 AI 网页失败：' + (err instanceof Error ? err.message : String(err)), true);
    }
  }
  el.web.addEventListener('click', function () { void toggleWeb(false); });
  el.restore.addEventListener('click', function () { void toggleWeb(true); });
  el.preview.addEventListener('click', async function () {
    el.preview.disabled = true;
    try {
      const result = await bridge.setPreviewPanel(previewVisible ? 0 : previewWidth);
      previewVisible = Boolean(result && result.visible);
      if (result && result.width > 0) previewWidth = result.width;
      paint(false);
    } catch (err) {
      feedback('切换变更列表失败：' + (err instanceof Error ? err.message : String(err)), true);
    } finally {
      el.preview.disabled = false;
    }
  });
  el.collect.addEventListener('click', async function () {
    if (collecting) return;
    collecting = true;
    el.collect.disabled = true;
    el.collect.textContent = '采集中…';
    feedback('正在只读采集最新回复');
    try {
      const result = await bridge.collectReply();
      if (result && result.ok && result.noNewContent) feedback('最新回复已采集，无新内容');
      else if (result && result.ok) feedback('已采集 ' + (result.blocks || []).length + ' 个变更');
      else feedback('采集失败：' + ((result && result.error) || '未采集到回复'), true);
    } catch (err) {
      feedback('采集失败：' + (err instanceof Error ? err.message : String(err)), true);
    } finally {
      collecting = false;
      el.collect.disabled = false;
      el.collect.textContent = '采集回复';
    }
  });
  bridge.onChromeState(function (state) {
    if (!state) return;
    const wasVisible = webVisible;
    webVisible = state.webVisible !== false;
    previewVisible = Boolean(state.previewVisible);
    if (state.previewWidth > 0) previewWidth = state.previewWidth;
    paint(wasVisible && !webVisible);
  });
  paint(false);
})();
