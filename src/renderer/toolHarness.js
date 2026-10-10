/* 主进程拥有权限、执行与结果；本地 UI 只提交用户选择。 */
(function () {
  'use strict';
  let initialized = false;

  window.setupToolHarness = function (bridge) {
    if (initialized) return;
    initialized = true;
    const layout = window.setupToolPanelLayout();
    const clock = window.createToolExecutionClock();
    const attention = window.createToolAttention();
    const permission = document.getElementById('tool-permission');
    const permissionControl = document.getElementById('tool-permission-control');
    const automatic = document.getElementById('tool-automatic');
    const settingsToggle = document.getElementById('tool-settings-toggle');
    const continueNotice = document.getElementById('tool-continue-notice');
    const count = document.getElementById('tool-count');
    const activity = document.getElementById('tool-activity');
    const message = document.getElementById('tool-message');
    const results = document.getElementById('tool-results');
    const copy = document.getElementById('tool-copy');
    const returnNotice = document.getElementById('tool-return-notice');
    const undo = document.getElementById('tool-undo');
    const more = document.getElementById('tool-more-toggle');
    const copyNotice = document.getElementById('tool-copy-notice');
    const panel = document.getElementById('tool-panel');
    const completionNotice = document.getElementById('tool-completion-notice');
    const soundNotice = document.getElementById('tool-sound-notice');
    let state = null;
    let eventVersion = 0;
    let configuring = false;
    let copying = false;
    let sending = false;
    let returnedIdentity;
    let returnMessage = '';
    let returnError = false;
    const stopping = new Set();
    let undoing = false;
    let localMessage = '';
    let localError = false;
    let resultSignature = '';
    let completionBaseline = false;
    let lastCompletionId;
    let feedbackTimer;
    const audio = window.createToolCompletionSound();
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
      completionNotice.title = '';
      renderStatusFeedback();
    }

    function renderStatusFeedback() {
      const notices = [
        { element: returnNotice, priority: returnError || returnNotice.classList.contains('is-error') ? 0 : 4 },
        { element: continueNotice, priority: continueNotice.classList.contains('is-error') ? 1 : 5 },
        { element: copyNotice, priority: copyNotice.classList.contains('is-error') ? 2 : 6 },
        { element: completionNotice, priority: 3 },
        { element: soundNotice, priority: 7 },
      ].filter(function (item) { return item.element.textContent; });
      notices.forEach(function (item) { item.element.classList.remove('is-visible'); });
      if (!notices.length) return;
      notices.sort(function (left, right) { return left.priority - right.priority; });
      const active = notices[0].element;
      active.classList.add('is-visible');
      active.title = notices.map(function (item) { return item.element.textContent; }).join(' · ');
    }

    function soundFailure() {
      // 声音提示失败独立显示，不覆盖工具输出或执行状态。
      soundNotice.textContent = '音效未播放，可重新开启音效后重试。';
      soundNotice.title = soundNotice.textContent;
      renderStatusFeedback();
    }

    async function prepareSound() {
      return audio.prepare();
    }

    function playTone(context) {
      audio.play(context);
      soundNotice.textContent = '';
      soundNotice.title = '';
      renderStatusFeedback();
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
      if (!completion || state.busy) { clearFeedback(); soundNotice.textContent = ''; soundNotice.title = ''; renderStatusFeedback(); return; }
      if (completion.id === lastCompletionId) return;
      lastCompletionId = completion.id;
      clearFeedback();
      soundNotice.textContent = '';
      panel.classList.toggle('has-completion', true);
      panel.classList.toggle('completion-error', completion.outcome === 'error');
      completionNotice.textContent = completion.outcome === 'error'
        ? '⚠ 本批存在失败或未执行请求，请查看结果' : '✓ 结果已就绪';
      completionNotice.title = completionNotice.textContent;
      renderStatusFeedback();
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
      const unavailable = Boolean(state && state.storageError);
      panel.classList.toggle('has-results', Boolean(state && (state.results.length || state.batchError)));
      permission.disabled = configuring || !state || unavailable;
      automatic.disabled = configuring || !state || unavailable;
      const returned = state && state.resultReturn;
      const hasAttachments = Boolean(returned && returned.attachmentCount > 0);
      const sendAttachments = Boolean(hasAttachments && !configuring && !state.busy && !state.config.automatic && returned.canSend && returnedIdentity !== returnIdentity());
      const showSendAction = sendAttachments || sending && hasAttachments;
      copy.dataset.action = showSendAction ? 'send' : 'copy';
      copy.title = copying ? (sending ? '正在复制并发送本批结果与附件…' : '正在复制本批结果…') : showSendAction ? '发送本批结果与附件，并复制结果到剪贴板' : '复制本批结果到剪贴板';
      copy.setAttribute('aria-label', copy.title);
      copy.disabled = copying || !state || (!state.results.length && !state.batchError);
      undo.disabled = undoing || !state || state.busy || !state.canUndo;
      undo.hidden = !state || (!state.canUndo && !undoing);
      more.hidden = undo.hidden;
      panel.classList.toggle('has-attachments', hasAttachments);
      returnNotice.textContent = hasAttachments ? returnMessage || returned.message : '';
      returnNotice.title = returnNotice.textContent;
      returnNotice.classList.toggle('is-error', returnError || Boolean(hasAttachments && returned.phase === 'paused'));
      const notice = unavailable ? state.message : localMessage || (state ? state.message : '正在读取工具状态…');
      const awaitingContinuation = /等待继续生成/.test(notice);
      const needsAttention = !awaitingContinuation && /未执行|无法|失败|停止|没有|无效|变化|等待确认|权限拒绝/.test(notice);
      const incomplete = state && state.results.some(function (item) { return !['done', 'running', 'pending_permission'].includes(item.status) || item.tool === 'run_command' && item.data && ['failed', 'stopped'].includes(item.data.status); });
      message.textContent = notice;
      message.hidden = !unavailable && !localMessage && (Boolean(state && state.batchError) || !needsAttention && !awaitingContinuation && Boolean(state && state.results.length));
      message.classList.toggle('is-error', localError || unavailable);
      activity.textContent = unavailable ? '工具不可用' : localError ? '操作失败' : localMessage ? (localMessage.startsWith('结果已复制') ? '已复制' : '操作完成')
        : !state ? '读取状态…' : state.busy ? (state.results.some(function (item) { return item.status === 'pending_permission'; }) ? '等待授权' : '执行中')
        : state.hasRunningProcesses ? '进程运行中' : state.batchError ? '格式错误' : awaitingContinuation ? '等待续写' : needsAttention ? '需检查' : incomplete ? '有未完成项' : state.results.length ? '已返回' : state.config.automatic ? '等待回复' : '手动采集';
      activity.title = notice;
      activity.classList.toggle('is-error', Boolean(localError || incomplete || needsAttention));
      if (continuationTimer !== undefined) { clearTimeout(continuationTimer); continuationTimer = undefined; }
      continueNotice.textContent = '';
      if (!state) { layout.refresh(); return; }
      permission.value = state.config.permission;
      permissionControl.dataset.permission = state.config.permission;
      // 主进程先停止回传再保存配置；显示实际停止状态，避免保存期间开关反跳。
      automatic.checked = state.config.automatic && (!state.continuation || state.continuation.phase !== 'off');
      const continuing = state.continuation;
      if (continuing && !localMessage && !unavailable) {
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
      continueNotice.title = continueNotice.textContent;
      copyNotice.textContent = !state.clipboard || state.config.automatic && state.clipboard.ok ? '' : state.clipboard.ok ? '已自动复制本批结果，可粘贴给 AI' : '自动复制失败，请手动重试：' + state.clipboard.error;
      copyNotice.title = copyNotice.textContent;
      copyNotice.classList.toggle('is-error', Boolean(state.clipboard && !state.clipboard.ok));
      permission.title = unavailable ? '工具记录未加载，权限设置不可用；编辑文件和访问官网仍可使用。' : {
        ask: '项目内读取与搜索自动执行；修改与命令由 IDE 请求批准。',
        rules: '按本项目已记住的规则执行；未覆盖的调用由 IDE 请求批准。',
        full: '在当前 Windows 账户权限内执行，可访问项目外文件并运行联网命令。',
      }[state.config.permission];
      const finished = state.results.filter(function (item) { return !['running', 'pending_permission'].includes(item.status); }).length;
      count.textContent = state.batchError ? '1 项校验失败' : state.results.length + ' 项' + (state.busy ? ' · 已返回 ' + finished : '');
      renderStatusFeedback();
      renderResults();
      layout.refresh();
    }

    function receive(next, baseline) {
      state = next;
      returnMessage = ''; returnError = false;
      localMessage = ''; localError = false;
      render();
      const fresh = attention.receive(state, baseline);
      if (fresh.length) {
        panel.open = true;
        document.dispatchEvent(new CustomEvent('tool-attention', { detail: fresh[0] }));
      }
      receiveCompletion();
      layout.refresh();
    }

    function returnIdentity() {
      return state ? JSON.stringify([state.completion, state.results.filter(function (item) { return item.tool === 'attach_file'; }).map(function (item) { return [item.batch_id, item.request_id, item.data && item.data.id]; })]) : '';
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
      const identity = returnIdentity();
      const sendAttachments = copy.dataset.action === 'send';
      copying = true; sending = sendAttachments; returnMessage = ''; returnError = false; localMessage = ''; localError = false; render();
      let copied = false;
      try {
        const outcome = await bridge.copyToolResults();
        if (!outcome.ok) throw new Error(outcome.error || '复制失败');
        copied = true;
        localMessage = '结果已复制，请粘贴并发送给 AI。';
        render();
      } catch (error) {
        localMessage = '复制结果失败：' + (error instanceof Error ? error.message : String(error)); localError = true;
        render();
      }
      try {
        const stillCanSendAttachments = identity === returnIdentity() && state && !configuring && !state.busy && !state.config.automatic &&
          state.resultReturn && state.resultReturn.canSend && returnedIdentity !== identity;
        if (sendAttachments && stillCanSendAttachments) {
          returnMessage = '正在提交本批结果与附件…'; render();
          const outcome = await bridge.sendToolResults();
          if (identity !== returnIdentity()) return;
          if (outcome.ok) { returnedIdentity = identity; returnMessage = '本批结果与附件已发送，等待 AI 回复。'; }
          else {
            if (outcome.uncertain) returnedIdentity = identity;
            returnMessage = (outcome.uncertain ? '发送状态未知，请检查官网，未重复发送：' : '本批结果与附件发送未完成：') + (outcome.error || '请查看官网状态');
            returnError = true;
          }
        } else if (sendAttachments && identity === returnIdentity() && state && state.config.automatic) {
          returnMessage = '自动继续已开启，由 IDE 负责回传。';
        }
      } catch (error) {
        if (identity === returnIdentity()) {
          // IPC 断开不能判断是否已点击官网发送按钮，由用户检查后处理。
          returnedIdentity = identity;
          returnMessage = '发送状态未知，请检查官网，未重复发送：' + (error instanceof Error ? error.message : String(error)); returnError = true;
        }
      } finally {
        if (copied && !sendAttachments) localMessage = '结果已复制，请粘贴并发送给 AI。';
        copying = false; sending = false; render();
      }
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
    settingsToggle.addEventListener('click', async function () {
      if (settingsToggle.disabled) return;
      settingsToggle.disabled = true;
      // 触发手势内准备主编辑器的完成音效；预听由独立浮层播放。
      void prepareSound().catch(function () {});
      const anchor = settingsToggle.getBoundingClientRect();
      try { await bridge.openToolSettings({ x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }); }
      catch (error) { localMessage = '打开设置失败：' + (error instanceof Error ? error.message : String(error)); localError = true; render(); }
      finally { settingsToggle.disabled = false; }
    });
    bridge.onToolSettingsVisibility(function (visibility) {
      settingsToggle.setAttribute('aria-expanded', String(visibility.open));
      if (visibility.restoreFocus) settingsToggle.focus();
    });
    window.addEventListener('beforeunload', function () { audio.dispose(); });
    bridge.onToolState(function (next) { eventVersion += 1; receive(next, !state); });
    render();
    const initialVersion = eventVersion;
    bridge.getToolState().then(function (next) {
      if (initialVersion === eventVersion) receive(next, true);
    }).catch(function (error) {
      if (!state) { localMessage = '读取工具状态失败：' + (error instanceof Error ? error.message : String(error)); localError = true; render(); }
    });
  };

  function initialize() { window.setupToolHarness(window.editorBridge); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
