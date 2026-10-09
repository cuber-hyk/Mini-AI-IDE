/** 本地更新入口：状态来自主进程，网络和安装只由用户点击触发。 */
(function () {
  'use strict';

  function buildStatusIcon(key) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const paths = { ok: ['M4 8.5 6.6 11 12 5.4'], available: ['M8 2v8m0 0 3-3m-3 3L5 7', 'M3 13h10'], downloading: ['M8 2v7m0 0 3-3m-3 3L5 9', 'M3 13h10'], warn: ['M8 2.6 14 13H2z', 'M8 6.4v3.2M8 11.4h.01'] };
    for (const d of paths[key] || []) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  window.setupUpdateDialog = function (bridge) {
    const heading = document.getElementById('update-heading');
    const statusIcon = document.getElementById('update-status-icon');
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

    function close() {
      void bridge.closeUpdatePanel().catch(function (error) {
        localError = error instanceof Error ? error.message : String(error); render();
      });
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
      const titles = { checking: '正在检查更新', available: '有新版本可用', downloading: '正在下载更新', ready: '更新已准备就绪', confirming: '安装前确认', installing: '正在重启安装', error: '更新未完成' };
      heading.textContent = state.disabledReason ? '软件更新' : titles[status] || (state.checked ? '已是最新版本' : '检查新版本');
      let iconKey = 'checking';
      if (state.disabledReason || status === 'error') iconKey = 'warn';
      else if (ready) iconKey = 'ok';
      else if (status === 'available') iconKey = 'available';
      else if (status === 'downloading') iconKey = 'downloading';
      else if (state.checked) iconKey = 'ok';
      statusIcon.replaceChildren();
      statusIcon.className = 'update-status-icon' + (iconKey === 'ok' ? ' is-ok' : iconKey === 'warn' ? ' is-warn' : '');
      if (iconKey !== 'checking') statusIcon.appendChild(buildStatusIcon(iconKey));
      versions.replaceChildren();
      function versionTag(value, isNew) {
        const tag = document.createElement('span');
        tag.className = 'update-version' + (isNew ? ' update-version-new' : '');
        tag.textContent = value;
        versions.appendChild(tag);
      }
      versionTag(state.currentVersion, false);
      if (release) {
        const arrow = document.createElement('span'); arrow.className = 'update-version-arrow'; arrow.textContent = '→'; versions.appendChild(arrow);
        versionTag(release.version, true);
      }
      const verLabels = { available: '可更新至', downloading: '正在获取', ready: '待安装', confirming: '待安装', installing: '待安装', error: release ? '目标版本' : '' };
      const verLabel = release ? (verLabels[status] || '最新版本') : '当前版本';
      if (verLabel) {
        const label = document.createElement('span'); label.className = 'update-version-label'; label.textContent = verLabel; versions.appendChild(label);
      }
      const messages = { checking: '正在查找可用的稳定版本。', available: '查看更新内容，准备好后开始下载。', downloading: '关闭此窗口后，下载仍会继续。', ready: '重启后完成更新。安装前会确认未保存的文件。', confirming: '请处理未保存的文件，确认后继续安装。', installing: '安装器正在启动，请稍候。' };
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
      action.classList.toggle('primary', Boolean(release) && (status === 'available' || status === 'ready' || status === 'error'));
      hint.textContent = ready ? '普通退出不会安装' : status === 'downloading' ? '可继续编辑' : '由你选择何时更新';
    }

    function receive(nextState) {
      if (state && nextState.revision < state.revision) return;
      state = nextState;
      localError = '';
      render();
    }

    document.getElementById('update-close').addEventListener('click', function () { close(); });
    notesToggle.addEventListener('click', function () { expanded = !expanded; renderNotes(); });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
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
    render();
    bridge.getUpdateState().then(receive).catch(function (error) {
      if (!state) { localError = error instanceof Error ? error.message : String(error); render(); }
    });
    return { close: close };
  };
  window.addEventListener('DOMContentLoaded', function () { window.setupUpdateDialog(window.updateBridge); });
})();
