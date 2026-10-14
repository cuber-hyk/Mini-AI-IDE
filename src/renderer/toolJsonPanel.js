/* 手动原文提交；主进程拥有协议校验、权限及工具执行。 */
(function () {
  'use strict';
  let owner;
  window.setupToolJsonPanel = function (bridge) {
    if (owner) return owner;
    const el = {};
    ['open', 'panel', 'input', 'status', 'execute', 'cancel'].forEach(function (name) {
      el[name] = document.getElementById('tool-json-' + name);
    });
    let blocked = true;
    let localSending = false;
    let executing = false;
    let version = 0;
    let platformId;
    const MAX_LENGTH = 200000;
    function notice(text, error) {
      el.status.textContent = text;
      el.status.classList.toggle('is-error', Boolean(error));
    }
    function paint() {
      el.open.disabled = blocked || localSending || executing;
      el.input.disabled = executing;
      el.execute.disabled = blocked || localSending || executing || el.panel.hidden || !el.input.value.trim() || el.input.value.length > MAX_LENGTH;
      el.cancel.disabled = executing;
      el.execute.setAttribute('aria-busy', String(executing));
      el.execute.setAttribute('title', executing ? '正在提交工具请求' : '执行');
      el.execute.setAttribute('aria-label', executing ? '正在提交工具请求' : '执行工具 JSON');
      el.open.setAttribute('aria-expanded', String(!el.panel.hidden));
    }
    function changed(text) {
      version += 1;
      if (text && !el.panel.hidden) notice(text);
      paint();
    }
    function close() {
      changed(); el.panel.hidden = true; notice(''); paint(); el.open.focus();
    }
    el.open.addEventListener('click', function () {
      if (el.open.disabled) return;
      if (!el.panel.hidden) { close(); return; }
      el.panel.hidden = false; document.getElementById('tool-panel').open = true;
      changed(); notice(''); paint(); el.input.focus();
    });
    el.input.addEventListener('input', function () {
      changed(); notice(el.input.value.length > MAX_LENGTH ? '输入超过 200000 个字符，请减少正文。' : '', el.input.value.length > MAX_LENGTH); paint();
    });
    el.execute.addEventListener('click', async function () {
      if (el.execute.disabled) return;
      const requested = version, text = el.input.value;
      executing = true;
      notice('正在提交工具请求…'); paint();
      try {
        const result = await bridge.executeToolJson(text);
        if (requested !== version || text !== el.input.value) return;
        if (result && result.ok) { executing = false; close(); return; }
        notice(result && result.error || '请求未被接纳，请查看工具状态。', true);
      } catch (error) {
        if (requested === version) notice('执行状态未确认，请查看工具列表；请勿重复提交：' + (error && error.message || String(error)), true);
      } finally { executing = false; paint(); }
    });
    el.cancel.addEventListener('click', function () { if (!executing) close(); });
    el.panel.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !executing) { event.preventDefault(); close(); } });
    if (bridge.onRootChanged) bridge.onRootChanged(function () { changed('项目已变化，请核对当前项目后执行。'); });
    paint();
    owner = { setPromptBusy: function (value) {
      localSending = Boolean(value);
      if (localSending && !executing && !el.panel.hidden) notice('需求正在准备或发送，请完成后执行。');
      paint();
    }, update: function (state, platform) {
      if (platformId !== undefined && platformId !== (platform && platform.platform)) changed('平台已变化，请核对当前平台后执行。');
      platformId = platform && platform.platform;
      const next = !state || Boolean(state.storageError || state.busy || state.hasRunningProcesses || state.resultReturn && state.resultReturn.phase === 'sending' || state.continuation && ['sending', 'countdown'].includes(state.continuation.phase) || !platform || !['deepseek', 'chatgpt'].includes(platform.platform) || platform.switching);
      if (next && !blocked && !executing && !el.panel.hidden) notice('工具、需求或回传正在处理，请完成后执行。');
      blocked = next; paint();
    } };
    return owner;
  };
})();
