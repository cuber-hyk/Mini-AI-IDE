/* 主界面只展示版本与更新提示，更新详情和操作归独立窗口。 */
(function () {
  'use strict';
  window.setupApplicationUpdate = function (bridge, setInfo) {
    const trigger = document.getElementById('btn-update');
    const version = document.getElementById('app-version');
    let revision = -1;
    function receive(state) {
      if (state.revision < revision) return;
      revision = state.revision;
      version.textContent = state.currentVersion ? 'v' + state.currentVersion : '';
      version.hidden = !state.currentVersion;
      version.title = state.currentVersion ? '当前版本 v' + state.currentVersion : '当前版本';
      const ready = ['ready', 'confirming', 'installing'].includes(state.status);
      trigger.classList.toggle('has-update', Boolean(state.release));
      trigger.classList.toggle('is-ready', ready);
      trigger.classList.toggle('is-busy', ['checking', 'downloading'].includes(state.status));
      trigger.title = ready ? '更新已下载，点击查看' : state.release ? '发现新版本，点击查看' : '软件更新';
      trigger.setAttribute('aria-label', trigger.title);
    }
    trigger.addEventListener('click', function () {
      void bridge.openUpdatePanel().catch(function (error) {
        setInfo('打开软件更新失败：' + (error instanceof Error ? error.message : String(error)), true);
      });
    });
    bridge.onUpdateState(receive);
    bridge.onUpdatePanelClosed(function () { trigger.focus(); });
    bridge.getUpdateState().then(receive).catch(function (error) {
      if (revision < 0) setInfo('读取更新状态失败：' + (error instanceof Error ? error.message : String(error)), true);
    });
  };
})();
