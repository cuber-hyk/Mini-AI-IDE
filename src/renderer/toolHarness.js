/* 主进程拥有权限、执行与结果；本地 UI 只提交用户选择。 */
(function () {
  'use strict';
  let initialized = false;

  window.setupToolHarness = function (bridge) {
    if (initialized) return;
    initialized = true;
    const layout = window.setupToolPanelLayout();
    const clock = window.createToolExecutionClock();
    const permission = document.getElementById('tool-permission');
    const automatic = document.getElementById('tool-automatic');
    const sendInterval = document.getElementById('tool-send-interval');
    const intervalDown = document.getElementById('tool-interval-down');
    const intervalUp = document.getElementById('tool-interval-up');
    const continueNotice = document.getElementById('tool-continue-notice');
    const dirtyPolicy = document.getElementById('tool-dirty-policy');
    const hint = document.getElementById('tool-permission-hint');
    const count = document.getElementById('tool-count');
    const activity = document.getElementById('tool-activity');
    const message = document.getElementById('tool-message');
    const results = document.getElementById('tool-results');
    const copy = document.getElementById('tool-copy');
    const undo = document.getElementById('tool-undo');
    const clearRules = document.getElementById('tool-clear-rules');
    const more = document.getElementById('tool-more-toggle');
    const sound = document.getElementById('tool-completion-sound');
    const autoCopy = document.getElementById('tool-auto-copy');
    const copyNotice = document.getElementById('tool-copy-notice');
    const panel = document.getElementById('tool-panel');
    const completionNotice = document.getElementById('tool-completion-notice');
    const soundNotice = document.getElementById('tool-sound-notice');
    let state = null;
    let eventVersion = 0;
    let configuring = false;
    let copying = false;
    const stopping = new Set();
    let undoing = false;
    let localMessage = '';
    let localError = false;
    let resultSignature = '';
    let completionBaseline = false;
    let lastCompletionId;
    let feedbackTimer;
    let audioContext;
    let lastBatchError = '';
    let continuationTimer;
    const statusLabels = {
      running: '执行中', pending_permission: '等待授权', done: '完成', failed: '失败',
      permission_denied: '权限拒绝', cancelled: '已停止', skipped_dependency: '依赖失败，已跳过', unknown: '执行结果未知',
    };

    function clearFeedback() {
      if (feedbackTimer !== undefined) { clearTimeout(feedbackTimer); feedbackTimer = undefined; }
      panel.classList.toggle('has-completion', false);
      panel.classList.toggle('completion-error', false);
      completionNotice.textContent = '';
    }

    function soundFailure() {
      // 声音提示失败独立显示，不覆盖工具输出或执行状态。
      soundNotice.textContent = '音效未播放，可重新开启音效后重试。';
    }

    async function prepareSound() {
      if (!audioContext) audioContext = new window.AudioContext();
      if (audioContext.state === 'suspended') await audioContext.resume();
      if (audioContext.state !== 'running') throw new Error('Audio is unavailable');
      return audioContext;
    }

    function playTone(context) {
      const tone = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      tone.type = 'sine'; tone.frequency.setValueAtTime(660, now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.035, now + 0.015);
      gain.gain.linearRampToValueAtTime(0, now + 0.15);
      tone.connect(gain); gain.connect(context.destination);
      tone.onended = function () { tone.disconnect(); gain.disconnect(); };
      tone.start(now); tone.stop(now + 0.15);
      soundNotice.textContent = '';
    }

    async function playCompletionSound(id) {
      try {
        const context = await prepareSound();
        if (!state.config.completionSound || !state.completion || state.completion.id !== id || lastCompletionId !== id) return;
        playTone(context);
      } catch (_error) {
        if (state.config.completionSound && state.completion && state.completion.id === id) soundFailure();
      }
    }

    function receiveCompletion() {
      const completion = state.completion;
      if (!completionBaseline) {
        completionBaseline = true;
        lastCompletionId = completion ? completion.id : undefined;
        return;
      }
      if (!completion || state.busy) { clearFeedback(); soundNotice.textContent = ''; return; }
      if (completion.id === lastCompletionId) return;
      lastCompletionId = completion.id;
      clearFeedback();
      soundNotice.textContent = '';
      panel.classList.toggle('has-completion', true);
      panel.classList.toggle('completion-error', completion.outcome === 'error');
      completionNotice.textContent = completion.outcome === 'error'
        ? '⚠ 本批存在失败或未执行请求，请查看结果' : '✓ 结果已就绪';
      feedbackTimer = setTimeout(clearFeedback, 3200);
      if (state.config.completionSound) void playCompletionSound(completion.id);
    }

    function renderResults() {
      const nextSignature = JSON.stringify([state.results, state.batchError, Array.from(stopping)]);
      if (nextSignature === resultSignature) return;
      resultSignature = nextSignature;
      const openItems = new Set(Array.from(results.children).filter(function (item) { return item.open; }).map(function (item) { return item.dataset.key; }));
      results.replaceChildren();
      const timedItems = [];
      if (state.batchError) {
        const item = document.createElement('details');
        item.className = 'tool-result tool-batch-error'; item.dataset.key = 'batch-error'; item.open = true;
        const summary = document.createElement('summary');
        const label = document.createElement('span'); label.className = 'tool-result-label'; label.textContent = '批次校验';
        const status = document.createElement('span'); status.className = 'tool-result-status'; status.dataset.status = 'failed'; status.textContent = '格式错误';
        const detail = document.createElement('span'); detail.className = 'tool-result-detail'; detail.textContent = '未执行任何工具';
        summary.appendChild(label); summary.appendChild(status); summary.appendChild(detail);
        const body = document.createElement('pre'); body.textContent = JSON.stringify({ batch_error: state.batchError }, null, 2);
        item.appendChild(summary); item.appendChild(body); results.appendChild(item);
      }
      state.results.forEach(function (result) {
        const item = document.createElement('details');
        item.className = 'tool-result';
        item.dataset.key = JSON.stringify([result.batch_id, result.request_id]);
        item.open = openItems.has(item.dataset.key);
        const summary = document.createElement('summary');
        const status = document.createElement('span');
        status.className = 'tool-result-status';
        const processStatus = result.tool === 'run_command' && result.status === 'done' && result.data && result.data.status;
        const displayedStatus = processStatus === 'stopped' ? (result.data.timed_out ? 'failed' : 'cancelled') : ['running', 'failed'].includes(processStatus) ? processStatus : result.status;
        status.dataset.status = displayedStatus;
        status.textContent = statusLabels[displayedStatus] || displayedStatus;
        const time = document.createElement('span'); time.className = 'tool-result-time';
        status.appendChild(time); timedItems.push({ result: result, node: time });
        const description = window.describeToolResult(result);
        const tool = document.createElement('span'); tool.className = 'tool-result-label';
        tool.textContent = description.label;
        const target = document.createElement('span'); target.className = 'tool-result-target';
        target.textContent = description.target; target.title = description.target;
        const detail = document.createElement('span'); detail.className = 'tool-result-detail';
        detail.textContent = description.detail; detail.title = description.detail;
        summary.appendChild(tool); summary.appendChild(target); summary.appendChild(status); summary.appendChild(detail);
        if (result.tool === 'run_command' && result.data && result.data.process_id && (result.data.status === 'running' || result.data.cleanup_pending)) {
          const stop = document.createElement('button');
          stop.type = 'button'; stop.className = 'ui-button tool-command-stop';
          stop.title = '强制中断此命令及其子进程';
          stop.disabled = stopping.has(JSON.stringify([result.batch_id, result.request_id, result.data.process_id])); stop.textContent = stop.disabled ? '中断中…' : '中断';
          stop.addEventListener('click', function (event) {
            event.preventDefault(); event.stopPropagation();
            return stopCommand(result);
          });
          summary.appendChild(stop);
        }
        const body = document.createElement('pre');
        // 文件内容、命令输出与报错均为不可信普通文本，不解析 HTML 或触发工具。
        body.textContent = JSON.stringify(result, null, 2);
        item.appendChild(summary); item.appendChild(body); results.appendChild(item);
      });
      clock.replace(timedItems);
    }

    function render() {
      permission.disabled = configuring || !state;
      automatic.disabled = configuring || !state;
      sendInterval.disabled = configuring || !state;
      intervalDown.disabled = configuring || !state || Number(state.config.sendIntervalSeconds) <= 0;
      intervalUp.disabled = configuring || !state || Number(state.config.sendIntervalSeconds) >= 300;
      dirtyPolicy.disabled = configuring || !state;
      sound.disabled = configuring || !state;
      autoCopy.disabled = configuring || !state;
      copy.disabled = copying || !state || (!state.results.length && !state.batchError);
      undo.disabled = undoing || !state || state.busy || !state.canUndo;
      clearRules.disabled = configuring || !state || state.busy;
      undo.hidden = !state || (!state.canUndo && !undoing);
      more.hidden = false;
      copy.textContent = copying ? '正在复制…' : '复制本批结果';
      const notice = localMessage || (state ? state.message : '正在读取工具状态…');
      const awaitingContinuation = /等待继续生成/.test(notice);
      const needsAttention = !awaitingContinuation && /未执行|无法|失败|停止|没有|无效|变化|等待确认|权限拒绝/.test(notice);
      const incomplete = state && state.results.some(function (item) { return !['done', 'running', 'pending_permission'].includes(item.status) || item.tool === 'run_command' && item.data && ['failed', 'stopped'].includes(item.data.status); });
      message.textContent = notice;
      message.hidden = !localMessage && (Boolean(state && state.batchError) || !needsAttention && !awaitingContinuation);
      message.classList.toggle('is-error', localError);
      activity.textContent = localError ? '操作失败' : localMessage ? (localMessage.startsWith('结果已复制') ? '已复制' : '操作完成')
        : !state ? '读取状态…' : state.busy ? (state.results.some(function (item) { return item.status === 'pending_permission'; }) ? '等待授权' : '执行中')
        : state.hasRunningProcesses ? '进程运行中' : state.batchError ? '格式错误' : awaitingContinuation ? '等待续写' : needsAttention ? '需检查' : incomplete ? '有未完成项' : state.results.length ? '已返回' : state.config.automatic ? '等待回复' : '手动采集';
      activity.title = notice;
      activity.classList.toggle('is-error', Boolean(localError || incomplete || needsAttention));
      if (continuationTimer !== undefined) { clearTimeout(continuationTimer); continuationTimer = undefined; }
      continueNotice.textContent = '';
      if (!state) { layout.refresh(); return; }
      permission.value = state.config.permission;
      // 主进程先停止回传再保存配置；显示实际停止状态，避免保存期间开关反跳。
      automatic.checked = state.config.automatic && (!state.continuation || state.continuation.phase !== 'off');
      sendInterval.value = String(state.config.sendIntervalSeconds === undefined ? 3 : state.config.sendIntervalSeconds);
      const continuing = state.continuation;
      if (continuing && !localMessage) {
        const labels = { sending: '正在发送结果', waiting_reply: '等待 AI 回复', waiting_user: '等待你回答', paused: '自动已暂停' };
        if (state.config.automatic && labels[continuing.phase]) activity.textContent = labels[continuing.phase];
        if (continuing.phase === 'countdown') {
          const remaining = Math.max(0, Math.ceil((continuing.dueAt - Date.now()) / 1000));
          activity.textContent = remaining + 's 后发送';
          if (remaining > 0) continuationTimer = setTimeout(render, Math.min(1000, continuing.dueAt - Date.now()));
        }
        activity.title = continuing.message;
        if (continuing.phase === 'paused') continueNotice.textContent = continuing.message;
        continueNotice.classList.toggle('is-error', continuing.phase === 'paused');
      }
      dirtyPolicy.value = state.config.dirtyPolicy;
      sound.checked = state.config.completionSound === true;
      autoCopy.checked = state.config.autoCopyResults === true;
      copyNotice.textContent = !state.clipboard || state.config.automatic && state.clipboard.ok ? '' : state.clipboard.ok ? '已自动复制本批结果，可粘贴给 AI' : '自动复制失败，请手动重试：' + state.clipboard.error;
      copyNotice.classList.toggle('is-error', Boolean(state.clipboard && !state.clipboard.ok));
      hint.textContent = {
        ask: '项目内读取与搜索自动执行；修改与命令由 IDE 请求批准。',
        rules: '按本项目已记住的规则执行；未覆盖的调用由 IDE 请求批准。',
        full: '在当前 Windows 账户权限内执行，可访问项目外文件并运行联网命令。',
      }[state.config.permission];
      permission.title = hint.textContent;
      const finished = state.results.filter(function (item) { return !['running', 'pending_permission'].includes(item.status); }).length;
      count.textContent = state.batchError ? '1 项校验失败' : state.results.length + ' 项' + (state.busy ? ' · 已返回 ' + finished : '');
      renderResults();
      layout.refresh();
    }

    function receive(next) {
      state = next;
      localMessage = ''; localError = false;
      render();
      const batchError = state.batchError ? state.batchError.error : '';
      if (batchError && batchError !== lastBatchError) panel.open = true;
      lastBatchError = batchError;
      receiveCompletion();
      layout.refresh();
    }

    async function configure(patch) {
      if (configuring || !state) return;
      configuring = true; localMessage = ''; localError = false; render();
      const version = eventVersion;
      try {
        const next = await bridge.setToolConfig(patch);
        if (version === eventVersion) receive(next);
      } catch (error) {
        localMessage = '工具设置未保存：' + (error instanceof Error ? error.message : String(error)); localError = true;
      } finally { configuring = false; render(); }
    }

    permission.addEventListener('change', function () { return configure({ permission: permission.value }); });
    automatic.addEventListener('change', function () { return configure({ automatic: automatic.checked }); });
    sendInterval.addEventListener('change', function () {
      const seconds = Number(sendInterval.value);
      if (!sendInterval.value.trim() || !Number.isInteger(seconds) || seconds < 0 || seconds > 300) {
        localMessage = '发送间隔须为 0–300 秒的整数'; localError = true; render(); return;
      }
      return configure({ sendIntervalSeconds: seconds });
    });
    [intervalDown, intervalUp].forEach(function (button, index) {
      button.addEventListener('pointerdown', function (event) { event.preventDefault(); });
      button.addEventListener('click', function () {
        if (button.disabled) return;
        sendInterval.stepUp(index === 0 ? -1 : 1);
        return configure({ sendIntervalSeconds: Number(sendInterval.value) });
      });
    });
    dirtyPolicy.addEventListener('change', function () { return configure({ dirtyPolicy: dirtyPolicy.value }); });
    autoCopy.addEventListener('change', function () { return configure({ autoCopyResults: autoCopy.checked }); });
    sound.addEventListener('change', async function () {
      if (configuring || !state) return;
      const enabled = sound.checked;
      // 在开启手势内准备，保存成功后预听一次；启动读取配置不播放。
      const prepared = enabled && !state.config.completionSound ? prepareSound().catch(function () { return null; }) : null;
      if (!enabled) soundNotice.textContent = '';
      await configure({ completionSound: enabled });
      if (prepared) {
        const context = await prepared;
        if (!state.config.completionSound) return;
        try { if (!context) throw new Error('Audio is unavailable'); playTone(context); }
        catch (_error) { soundFailure(); }
      }
    });
    clearRules.addEventListener('click', async function () {
      if (clearRules.disabled || configuring) return;
      configuring = true; localMessage = ''; localError = false; render();
      const version = eventVersion;
      try {
        const next = await bridge.clearToolRules();
        if (version === eventVersion) receive(next);
        localMessage = '已清除本项目记住的规则；未覆盖的调用会请求批准。';
      } catch (error) { localMessage = '清除规则失败：' + (error instanceof Error ? error.message : String(error)); localError = true; }
      finally { configuring = false; render(); }
    });
    undo.addEventListener('click', async function () {
      if (undo.disabled || undoing) return;
      undoing = true; localMessage = ''; localError = false; render();
      try {
        const outcome = await bridge.undoToolChange();
        if (!outcome.ok) throw new Error(outcome.error || '撤销失败');
        localMessage = '已撤销最近一次工具文件修改。';
      } catch (error) { localMessage = '撤销工具修改失败：' + (error instanceof Error ? error.message : String(error)); localError = true; }
      finally { undoing = false; render(); }
    });
    copy.addEventListener('click', async function () {
      if (copy.disabled || copying) return;
      copying = true; localMessage = ''; localError = false; render();
      try {
        const outcome = await bridge.copyToolResults();
        if (!outcome.ok) throw new Error(outcome.error || '复制失败');
        localMessage = '结果已复制，请粘贴并发送给 AI。';
      } catch (error) { localMessage = '复制结果失败：' + (error instanceof Error ? error.message : String(error)); localError = true; }
      finally { copying = false; render(); }
    });
    async function stopCommand(result) {
      const key = JSON.stringify([result.batch_id, result.request_id, result.data.process_id]);
      if (stopping.has(key)) return;
      stopping.add(key); localMessage = ''; localError = false; render();
      const version = eventVersion;
      try {
        const next = await bridge.stopToolCommand({ batch_id: result.batch_id, request_id: result.request_id, process_id: result.data.process_id });
        if (version === eventVersion) receive(next);
      } catch (error) {
        if (state && state.results.some(function (item) { return item.batch_id === result.batch_id && item.request_id === result.request_id && item.data && item.data.process_id === result.data.process_id; })) {
          localMessage = '中断命令失败：' + (error instanceof Error ? error.message : String(error)); localError = true;
        }
      } finally { stopping.delete(key); render(); }
    }

    if (!bridge || typeof bridge.getToolState !== 'function') {
      localMessage = '工具服务不可用，请重启应用。'; localError = true; render(); return;
    }
    bridge.onToolState(function (next) { eventVersion += 1; receive(next); });
    render();
    const initialVersion = eventVersion;
    bridge.getToolState().then(function (next) {
      if (initialVersion === eventVersion) receive(next);
    }).catch(function (error) {
      if (!state) { localMessage = '读取工具状态失败：' + (error instanceof Error ? error.message : String(error)); localError = true; render(); }
    });
  };

  function initialize() { window.setupToolHarness(window.editorBridge); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
