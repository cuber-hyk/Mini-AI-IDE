/** 本地更新入口：状态来自主进程，网络和安装只由用户点击触发。 */
(function () {
  'use strict';

  window.setupApplicationUpdate = function (bridge) {
    const wrap = document.getElementById('update-wrap');
    const trigger = document.getElementById('btn-update');
    const panel = document.getElementById('update-panel');
    const heading = document.getElementById('update-heading');
    const versions = document.getElementById('update-versions');
    const message = document.getElementById('update-message');
    const notesSection = document.getElementById('update-notes-section');
    const notes = document.getElementById('update-notes');
    const notesToggle = document.getElementById('update-notes-toggle');
    const progressWrap = document.getElementById('update-progress-wrap');
    const progress = document.getElementById('update-progress');
    const percent = document.getElementById('update-percent');
    const hint = document.getElementById('update-hint');
    const action = document.getElementById('update-action');
    let state = null;
    let pending = false;
    let expanded = false;
    let visibleNotes = '';
    let localError = '';

    function close(restoreFocus) {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus();
    }

    function open() {
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      panel.focus();
    }

    function renderNotes() {
      // 远程说明始终是普通文本，绝不解析为 HTML。
      const lines = visibleNotes.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
      const summary = lines.slice(0, 3).join('\n');
      const shortened = lines.length > 3 || summary.length > 160;
      notes.textContent = expanded ? visibleNotes : summary.slice(0, 160).trimEnd() + (shortened ? '…' : '');
      notes.classList.toggle('is-expanded', expanded);
      notesToggle.hidden = !shortened;
      notesToggle.textContent = expanded ? '收起完整说明' : '展开完整说明';
      notesToggle.setAttribute('aria-expanded', String(expanded));
    }

    function render() {
      if (!state) {
        action.disabled = pending || !localError;
        action.textContent = localError ? '重试读取' : '正在读取…';
        message.textContent = localError || '正在读取更新状态…';
        message.classList.toggle('is-error', Boolean(localError));
        return;
      }
      const status = state.status;
      const release = state.release;
      const ready = status === 'ready' || status === 'confirming' || status === 'installing';
      const hasUpdate = Boolean(release);
      trigger.classList.toggle('has-update', hasUpdate);
      trigger.classList.toggle('is-ready', ready);
      trigger.classList.toggle('is-busy', status === 'checking' || status === 'downloading');
      trigger.title = ready ? '更新已下载，点击查看' : hasUpdate ? '发现新版本，点击查看' : '软件更新';
      trigger.setAttribute('aria-label', trigger.title);
      const titles = { checking: '正在检查更新', available: '有新版本可用', downloading: '正在下载更新', ready: '更新已准备就绪', confirming: '安装前确认', installing: '正在重启安装', error: '更新未完成' };
      heading.textContent = state.disabledReason ? '软件更新' : titles[status] || (state.checked ? '已是最新版本' : '检查新版本');
      versions.replaceChildren();
      function versionTag(value, isNew) {
        const tag = document.createElement('span');
        tag.className = 'update-version' + (isNew ? ' update-version-new' : '');
        tag.textContent = value;
        versions.appendChild(tag);
      }
      versionTag(state.currentVersion, false);
      if (release) {
        const arrow = document.createElement('span'); arrow.textContent = '→'; versions.appendChild(arrow);
        versionTag(release.version, true);
      }
      const messages = { checking: '正在查找可用的稳定版本。', available: '查看更新内容，准备好后开始下载。', downloading: '关闭此面板后，下载仍会继续。', ready: '重启后完成更新。安装前会确认未保存的文件。', confirming: '请处理未保存的文件，确认后继续安装。', installing: '安装器正在启动，请稍候。' };
      message.textContent = state.disabledReason || localError || state.error || messages[status] || (state.checked ? '当前已安装最新的稳定版本。' : '检查是否有新的稳定版本。');
      message.classList.toggle('is-error', Boolean(localError || state.error));
      const nextNotes = release && release.notes ? String(release.notes).trim() : '';
      if (nextNotes !== visibleNotes) { visibleNotes = nextNotes; expanded = false; }
      notesSection.hidden = !release;
      renderNotes();
      if (release && !visibleNotes) notes.textContent = '此版本未提供更新说明。';
      progressWrap.hidden = status !== 'downloading';
      const value = Number.isFinite(state.percent) ? Math.max(0, Math.min(100, state.percent)) : 0;
      progress.value = value;
      percent.textContent = Math.round(value) + '%';
      const labels = { checking: '正在检查…', available: '下载更新', downloading: '正在下载…', ready: '重启并安装', confirming: '等待确认…', installing: '正在安装…', error: '重试' };
      action.textContent = localError ? '重试' : labels[status] || '检查更新';
      action.disabled = Boolean(pending || state.busy || state.disabledReason || ['checking', 'downloading', 'confirming', 'installing'].includes(status));
      hint.textContent = ready ? '普通退出不会安装' : status === 'downloading' ? '可继续编辑' : '由你选择何时更新';
    }

    function receive(nextState) {
      if (state && nextState.revision < state.revision) return;
      state = nextState;
      localError = '';
      render();
    }

    trigger.addEventListener('click', function () { if (panel.hidden) open(); else close(false); });
    document.getElementById('update-close').addEventListener('click', function () { close(true); });
    notesToggle.addEventListener('click', function () { expanded = !expanded; renderNotes(); });
    wrap.addEventListener('keydown', function (event) {
      if (!panel.hidden && event.key === 'Escape') { event.preventDefault(); close(true); }
    });
    document.addEventListener('pointerdown', function (event) { if (!wrap.contains(event.target)) close(false); });
    wrap.addEventListener('focusout', function (event) { if (!wrap.contains(event.relatedTarget)) close(false); });
    window.addEventListener('blur', function () { close(false); });
    action.addEventListener('click', async function () {
      if (action.disabled || pending) return;
      const operation = !state ? 'getUpdateState' : state.status === 'ready' ? 'installUpdate' : state.status === 'available' || (state.status === 'error' && state.release) ? 'downloadUpdate' : 'checkForUpdate';
      pending = true;
      localError = '';
      render();
      try { receive(await bridge[operation]()); }
      catch (error) { localError = error instanceof Error ? error.message : String(error); }
      finally { pending = false; render(); }
    });

    // 先订阅再拉快照，revision 保证迟到快照不覆盖新状态。
    bridge.onUpdateState(receive);
    bridge.onOpenUpdatePanel(open);
    render();
    bridge.getUpdateState().then(receive).catch(function (error) {
      if (!state) { localError = error instanceof Error ? error.message : String(error); render(); }
    });
    return { open: open, close: close };
  };
})();
