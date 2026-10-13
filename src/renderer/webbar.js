/** 网页顶部工具条：只读采集入口，不写入 AI 网页。 */
(function () {
  'use strict';
  const bridge = window.webbarBridge;
  const el = {
    collect: document.getElementById('btn-collect'), status: document.getElementById('collect-status'),
    workspaceToggle: document.getElementById('btn-workspace-toggle'),
    toolStatus: document.getElementById('tool-workspace-status'),
    toolOpen: document.getElementById('btn-tool-workspace'),
    platform: document.getElementById('web-platform'),
    platformControl: document.getElementById('web-platform-control'),
    platformHint: document.getElementById('web-platform-hint'),
    reload: /** @type {HTMLButtonElement} */ (document.getElementById('btn-reload-web-platform')),
  };
  if (!bridge || Object.values(el).some(function (node) { return !node; })) return;
  const restore = document.getElementById('btn-file-restore');
  el.workspaceToggle.addEventListener('click', function () { void bridge.toggleWorkspace(); });
  restore.addEventListener('click', function () { void bridge.restoreFileWorkspace(); });
  let summary;
  let countdownTimer;
  let statusReceived = false;
  let platform = null;
  let platformVersion = 0;
  let platformStateVersion = 0;
  let switching = false;
  let collecting = false;
  let switchError = '';
  let switchErrorTimer;
  let platformReadError = '';
  let reloadRequest = 0;
  let reloadPendingPlatform = null;
  let reloadError = '';
  function reloading() { return platform && (platform.reloading || reloadPendingPlatform === platform.platform); }
  function supported() { return platform && ['deepseek', 'chatgpt'].includes(platform.platform) && !platform.switching && !switching && !platform.error && !reloading(); }
  function platformReason() {
    return !platform ? '平台状态读取失败，采集暂不可用' : platform.switching || switching ? '正在切换官网平台…'
      : reloading() ? '正在重新加载官网…' : platform.error || '';
  }
  function renderPlatform(keepFeedback = false) {
    const blocked = platform && platform.switchBlockedReason;
    el.platform.disabled = !platform || platform.switching || switching || Boolean(blocked);
    el.platform.value = platform ? platform.platform : 'deepseek';
    const error = switchError || reloadError || platformReadError || platform && platform.error;
    el.platform.title = blocked || error || platformReason() || '切换 AI 官网平台';
    el.platformControl.title = el.platform.title;
    el.platformControl.tabIndex = el.platform.disabled ? 0 : -1;
    el.platformHint.textContent = blocked || platformReason() || '';
    el.collect.disabled = collecting || !supported();
    el.reload.hidden = !platform || !platform.error;
    el.reload.disabled = !platform || platform.switching || switching || Boolean(blocked) || Boolean(reloading());
    el.reload.textContent = reloading() ? '重新加载中…' : '重新加载';
    el.reload.title = blocked || (reloading() ? '正在重新加载官网，请稍候' : '重新加载当前失败的官网页面');
    if (!collecting) el.collect.title = error || platformReason() || '只读采集最新回复，结果显示在工具区';
    if (!keepFeedback) {
      if (error) feedback(error, true);
      else if (platformReason()) feedback(platformReason(), !platform);
      else if (!collecting) feedback('');
    }
    el.status.classList.toggle('switch-notice', Boolean(switchError));
    el.status.classList.toggle('load-notice', Boolean(reloadError || platform && (platform.error || platform.reloading)));
    renderToolStatus();
  }
  function receivePlatform(next, keepFeedback = false) {
    if (platform && platform.platform !== next.platform) { reloadRequest += 1; reloadPendingPlatform = null; reloadError = ''; }
    if (!next.error) reloadError = '';
    platform = next; platformReadError = ''; renderPlatform(keepFeedback);
  }
  function renderToolStatus() {
    if (countdownTimer !== undefined) window.clearTimeout(countdownTimer);
    countdownTimer = undefined;
    if (!supported()) {
      const text = platformReason(); el.toolStatus.textContent = text; el.toolStatus.title = text;
      el.toolStatus.classList.toggle('warn', !platform || Boolean(platform.error)); el.toolStatus.classList.toggle('running', Boolean(platform && platform.switching || switching || reloading()));
      return;
    }
    if (!summary) { el.toolStatus.textContent = '正在读取工具状态'; el.toolStatus.title = el.toolStatus.textContent; return; }
    const countdown = summary.phase === 'countdown' && Number.isFinite(summary.dueAt)
      ? ' · ' + Math.max(0, Math.ceil((summary.dueAt - Date.now()) / 1000)) + ' 秒后回传' : '';
    const count = summary.count > 0 ? ' · ' + summary.count + ' 项' : '';
    const message = summary.message + count + countdown;
    el.toolStatus.textContent = message;
    el.toolStatus.title = message + '；自动继续：' + (summary.automatic ? '开' : '关');
    el.toolStatus.classList.toggle('warn', ['approval', 'failed', 'paused'].includes(summary.phase));
    el.toolStatus.classList.toggle('running', ['running', 'countdown', 'sending'].includes(summary.phase));
    el.toolOpen.title = '查看工具：' + message;
    if (summary.phase === 'countdown' && Number.isFinite(summary.dueAt) && summary.dueAt > Date.now())
      countdownTimer = window.setTimeout(renderToolStatus, 250);
  }
  bridge.onToolWorkspaceStatus(function (state) { statusReceived = true; summary = state; renderToolStatus(); });
  bridge.onWebPlatformState(function (next) {
    platformStateVersion += 1;
    const changed = !platform || platform.platform !== next.platform || platform.switching !== next.switching || platform.error !== next.error || platform.reloading !== next.reloading;
    const keepFeedback = !changed;
    if (changed) platformVersion += 1;
    receivePlatform(next, keepFeedback);
  });
  const initialPlatformVersion = platformStateVersion;
  renderPlatform();
  void bridge.getWebPlatform().then(function (next) { if (initialPlatformVersion === platformStateVersion) receivePlatform(next); })
    .catch(function (error) { console.error('[web-platform] 读取状态失败', error); if (initialPlatformVersion === platformStateVersion) { platformReadError = '读取平台状态失败，请稍后重试'; renderPlatform(); } });
  function clearSwitchError() {
    if (switchErrorTimer !== undefined) window.clearTimeout(switchErrorTimer);
    switchErrorTimer = undefined; switchError = '';
    el.status.classList.toggle('switch-notice', false);
  }
  function showSwitchError(message) {
    clearSwitchError(); switchError = message;
    switchErrorTimer = window.setTimeout(function () {
      const keepFeedback = el.status.textContent !== switchError;
      switchErrorTimer = undefined; switchError = '';
      renderPlatform(keepFeedback);
    }, 3000);
  }
  el.reload.addEventListener('click', async function () {
    if (el.reload.disabled || !platform || !platform.error) return;
    const request = ++reloadRequest;
    const version = platformStateVersion;
    reloadPendingPlatform = platform.platform; reloadError = ''; clearSwitchError(); renderPlatform();
    try {
      const next = await bridge.reloadWebPlatform();
      if (request === reloadRequest && version === platformStateVersion) receivePlatform(next);
    } catch (error) {
      console.error('[web-platform] 重新加载失败', error);
      if (request === reloadRequest && platform && platform.error && !platform.reloading) reloadError = '重新加载失败，请稍后重试；' + platform.error;
    } finally {
      if (request === reloadRequest) { reloadPendingPlatform = null; renderPlatform(); }
    }
  });
  el.platform.addEventListener('change', async function () {
    if (el.platform.disabled || !platform || switching) { renderPlatform(); return; }
    const requested = el.platform.value;
    if (!['deepseek', 'chatgpt'].includes(requested) || requested === platform.platform) { renderPlatform(); return; }
    const version = platformVersion; switching = true; clearSwitchError(); renderPlatform();
    try { const next = await bridge.setWebPlatform(requested); if (version === platformVersion) receivePlatform(next); }
    catch (error) {
      console.error('[web-platform] 切换失败', error);
      const refreshVersion = platformStateVersion;
      try { const next = await bridge.getWebPlatform(); if (refreshVersion === platformStateVersion) receivePlatform(next); }
      catch (refreshError) { console.error('[web-platform] 切换后状态读取失败', refreshError); if (refreshVersion === platformStateVersion) platform = null; }
      showSwitchError(platform && platform.switchBlockedReason || '暂时无法切换，请稍后重试');
    } finally { switching = false; renderPlatform(); }
  });
  void bridge.getToolWorkspaceStatus().then(function (state) {
    if (!statusReceived) { summary = state; renderToolStatus(); }
  }).catch(function () {
    if (!statusReceived && supported()) { el.toolStatus.textContent = '工具状态读取失败'; el.toolStatus.classList.add('warn'); }
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

  function feedback(message, warn) {
    el.status.textContent = message;
    el.status.title = message;
    el.status.classList.toggle('warn', Boolean(warn));
    // 窄栏的按钮仍提供完整诊断。
    el.collect.title = message;
  }
  el.collect.addEventListener('click', async function () {
    if (collecting || !supported()) return;
    clearSwitchError();
    const version = platformVersion;
    collecting = true;
    el.collect.disabled = true;
    el.collect.textContent = '采集中…';
    feedback('正在只读采集最新回复');
    try {
      const result = await bridge.collectReply();
      if (version !== platformVersion || !supported()) return;
      if (result && result.ok && result.noNewContent) feedback('最新回复已采集，无新内容');
      else if (result && result.ok) feedback('已采集 ' + (result.blocks || []).length + ' 个变更');
      else feedback('采集失败：' + ((result && result.error) || '未采集到回复'), true);
    } catch (err) {
      if (version === platformVersion && supported()) feedback('采集失败：' + (err instanceof Error ? err.message : String(err)), true);
    } finally {
      collecting = false;
      el.collect.disabled = !supported();
      el.collect.textContent = '采集回复';
      if (!supported()) renderPlatform();
    }
  });
})();
