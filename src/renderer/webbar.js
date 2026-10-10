/** 网页顶部工具条：只读采集入口，不写入 AI 网页。 */
(function () {
  'use strict';
  const bridge = window.webbarBridge;
  const el = {
    collect: document.getElementById('btn-collect'), status: document.getElementById('collect-status'),
    workspaceToggle: document.getElementById('btn-workspace-toggle'),
    toolStatus: document.getElementById('tool-workspace-status'),
    toolOpen: document.getElementById('btn-tool-workspace'),
  };
  if (!bridge || Object.values(el).some(function (node) { return !node; })) return;
  const restore = document.getElementById('btn-file-restore');
  el.workspaceToggle.addEventListener('click', function () { void bridge.toggleWorkspace(); });
  restore.addEventListener('click', function () { void bridge.restoreFileWorkspace(); });
  let summary;
  let countdownTimer;
  let statusReceived = false;
  function renderToolStatus() {
    if (!summary) return;
    const countdown = summary.phase === 'countdown' && Number.isFinite(summary.dueAt)
      ? ' · ' + Math.max(0, Math.ceil((summary.dueAt - Date.now()) / 1000)) + ' 秒后回传' : '';
    const count = summary.count > 0 ? ' · ' + summary.count + ' 项' : '';
    const message = summary.message + count + countdown;
    el.toolStatus.textContent = message;
    el.toolStatus.title = message + '；自动继续：' + (summary.automatic ? '开' : '关');
    el.toolStatus.classList.toggle('warn', ['approval', 'failed', 'paused'].includes(summary.phase));
    el.toolStatus.classList.toggle('running', ['running', 'countdown', 'sending'].includes(summary.phase));
    el.toolOpen.title = '查看工具：' + message;
    if (countdownTimer !== undefined) window.clearTimeout(countdownTimer);
    countdownTimer = undefined;
    if (summary.phase === 'countdown' && Number.isFinite(summary.dueAt) && summary.dueAt > Date.now())
      countdownTimer = window.setTimeout(renderToolStatus, 250);
  }
  bridge.onToolWorkspaceStatus(function (state) { statusReceived = true; summary = state; renderToolStatus(); });
  void bridge.getToolWorkspaceStatus().then(function (state) {
    if (!statusReceived) { summary = state; renderToolStatus(); }
  }).catch(function () {
    if (!statusReceived) { el.toolStatus.textContent = '工具状态读取失败'; el.toolStatus.classList.add('warn'); }
  });
  el.toolOpen.addEventListener('click', async function () {
    try { await bridge.openToolWorkspace(); }
    catch (error) { feedback('打开工具失败：' + (error instanceof Error ? error.message : String(error)), true); }
  });
  bridge.onChromeState(function (state) {
    restore.hidden = state.fileVisible !== false;
    const workspaceVisible = !state.layout || state.layout.workspaceVisible !== false;
    el.workspaceToggle.title = workspaceVisible ? '收起工作区' : '展开工作区';
    el.workspaceToggle.setAttribute('aria-label', el.workspaceToggle.title);
    el.workspaceToggle.setAttribute('aria-pressed', String(workspaceVisible));
  });
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
