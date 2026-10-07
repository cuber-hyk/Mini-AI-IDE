/** 网页顶部工具条：只读采集入口，不写入 AI 网页。 */
(function () {
  'use strict';
  const bridge = window.webbarBridge;
  const el = {
    collect: document.getElementById('btn-collect'), status: document.getElementById('collect-status'),
  };
  if (!bridge || Object.values(el).some(function (node) { return !node; })) return;
  const restore = document.getElementById('btn-file-restore');
  restore.addEventListener('click', function () { void bridge.restoreFileWorkspace(); });
  bridge.onChromeState(function (state) { restore.hidden = state.fileVisible !== false; });
  let collecting = false;

  function feedback(message, warn) {
    el.status.textContent = message;
    el.status.title = message;
    el.status.classList.toggle('warn', Boolean(warn));
    // 窄栏的按钮仍提供完整诊断。
    el.collect.title = message;
  }
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
})();
