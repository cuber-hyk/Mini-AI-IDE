/* 手动 JSON 预览与确认；主进程拥有解析、短期令牌及工具执行。 */
(function () {
  'use strict';
  let owner;
  window.setupToolJsonPanel = function (bridge) {
    if (owner) return owner;
    const el = {};
    ['open', 'panel', 'input', 'status', 'preview', 'project', 'batch', 'requests', 'validate', 'execute', 'cancel'].forEach(function (name) {
      el[name] = document.getElementById('tool-json-' + name);
    });
    let blocked = true;
    let localSending = false;
    let checking = false;
    let executing = false;
    let version = 0;
    let token = null;
    let source = '';
    let platformId;
    const MAX_LENGTH = 200000;
    function notice(text, error) {
      el.status.textContent = text;
      el.status.classList.toggle('is-error', Boolean(error));
    }
    function paint() {
      el.open.disabled = blocked || localSending || executing;
      el.input.disabled = executing;
      el.validate.disabled = blocked || localSending || executing || checking || !el.input.value.trim() || el.input.value.length > MAX_LENGTH;
      el.execute.disabled = blocked || localSending || executing || !token || source !== el.input.value;
      el.cancel.disabled = executing;
      el.validate.textContent = checking ? '正在校验…' : '校验并预览';
      el.execute.textContent = executing ? '正在提交…' : '确认执行';
      el.open.setAttribute('aria-expanded', String(!el.panel.hidden));
    }
    function invalidate(text) {
      version += 1; token = null; source = ''; checking = false;
      el.preview.hidden = true; el.requests.textContent = ''; el.project.textContent = ''; el.batch.textContent = '';
      if (text && !el.panel.hidden) notice(text);
      paint();
    }
    function close() {
      invalidate(); el.panel.hidden = true; notice(''); paint(); el.open.focus();
    }
    el.open.addEventListener('click', function () {
      if (el.open.disabled) return;
      if (!el.panel.hidden) { close(); return; }
      el.panel.hidden = false; document.getElementById('tool-panel').open = true;
      invalidate(); notice('请粘贴完整工具请求，再校验预览。'); paint(); el.input.focus();
    });
    el.input.addEventListener('input', function () {
      invalidate(); notice(el.input.value.length > MAX_LENGTH ? '输入超过 200000 个字符，请减少正文。' : '输入已修改，请重新校验预览。', el.input.value.length > MAX_LENGTH); paint();
    });
    el.validate.addEventListener('click', async function () {
      if (el.validate.disabled) return;
      invalidate(); checking = true;
      const requested = version, text = el.input.value;
      notice('正在校验完整请求…'); paint();
      try {
        const result = await bridge.previewToolJson(text);
        if (requested !== version || text !== el.input.value || el.panel.hidden || blocked || localSending) return;
        if (!result || !result.ok) { notice(result && result.error || '工具 JSON 校验失败', true); return; }
        el.project.textContent = '项目：' + result.project;
        el.batch.textContent = '批次：' + result.batch_id + ' · ' + result.requests.length + ' 项请求';
        el.requests.textContent = JSON.stringify(result.requests, null, 2);
        token = result.token; source = text;
        el.preview.hidden = false; notice('请核对项目和请求参数，再点击“确认执行”。');
      } catch (error) {
        if (requested === version && !el.panel.hidden) notice('校验失败：' + (error && error.message || String(error)), true);
      } finally { if (requested === version) { checking = false; paint(); } }
    });
    el.execute.addEventListener('click', async function () {
      if (el.execute.disabled) return;
      const confirmed = token;
      token = null; source = ''; executing = true;
      notice('正在提交已确认批次；执行结果将在工具列表显示。'); paint();
      try {
        const result = await bridge.executeToolJson(confirmed);
        if (result && result.ok) { executing = false; close(); return; }
        el.preview.hidden = true;
        notice(result && result.error || '批次未执行，请重新校验。', true);
      } catch (error) { el.preview.hidden = true; notice('执行状态未确认，请查看工具列表；请勿重复提交：' + (error && error.message || String(error)), true); }
      finally { executing = false; paint(); }
    });
    el.cancel.addEventListener('click', function () { if (!executing) close(); });
    el.panel.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !executing) { event.preventDefault(); close(); } });
    if (bridge.onRootChanged) bridge.onRootChanged(function () { invalidate('项目已变化，请重新校验。'); });
    paint();
    owner = { setPromptBusy: function (value) {
      localSending = Boolean(value);
      if (localSending) invalidate('需求正在准备或发送，请完成后重新校验。');
      paint();
    }, update: function (state, platform) {
      if (platformId !== undefined && platformId !== (platform && platform.platform)) invalidate('平台已变化，请重新校验。');
      platformId = platform && platform.platform;
      const next = !state || Boolean(state.storageError || state.busy || state.hasRunningProcesses || state.resultReturn && state.resultReturn.phase === 'sending' || state.continuation && ['sending', 'countdown'].includes(state.continuation.phase) || !platform || !['deepseek', 'chatgpt'].includes(platform.platform) || platform.switching);
      if (next && !blocked) invalidate('工具、需求或回传正在处理，请完成后重新校验。');
      blocked = next; paint();
    } };
    return owner;
  };
})();
