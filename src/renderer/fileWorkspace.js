/* 编辑与 Diff 仅切换可见内容，不重建 Monaco 或文件模型。 */
(function () {
  'use strict';
  window.setupFileWorkspace = function (bridge) {
    let previewVisible = false;
    let reviewOpen = false;
    let tabs = null;
    function renderReview() { if (tabs) tabs.setReview(reviewOpen, previewVisible); }
    async function select(visible) {
      await bridge.setWorkspaceLayout({ previewVisible: visible });
    }
    async function openReview() {
      await bridge.setWorkspaceLayout({ previewVisible: true, fileVisible: true });
    }
    async function closeReview() {
      await select(false);
      reviewOpen = false; previewVisible = false; renderReview();
    }
    document.getElementById('tool-view-changes').addEventListener('click', function () { void openReview(); });
    document.getElementById('btn-update').addEventListener('click', function () { void select(false); });
    // 原生预览高于本地 DOM；等退出完成后再让既有菜单 owner 处理原动作。
    function localMenu(node, type, EventType, accepts) {
      node.addEventListener(type, async function (event) {
        if (!previewVisible || (accepts && !accepts(event))) return;
        event.preventDefault(); event.stopImmediatePropagation();
        try {
          await select(false);
          previewVisible = false;
          event.target.dispatchEvent(new EventType(type, event));
        } catch (error) {
          const info = document.getElementById('info');
          info.textContent = '打开菜单失败：' + error.message;
          info.classList.add('warn');
        }
      }, true);
    }
    localMenu(document.getElementById('sidebar'), 'contextmenu', MouseEvent);
    localMenu(document.getElementById('sidebar'), 'keydown', KeyboardEvent, function (event) { return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'); });
    bridge.onChromeState(function (state) {
      const visible = Boolean(state.previewVisible);
      previewVisible = visible;
      if (visible) reviewOpen = true;
      renderReview();
      document.body.classList.toggle('file-diff-visible', visible);
      document.getElementById('monaco').inert = visible;
      document.getElementById('workspace-welcome').inert = visible;

    });
    return {
      showEditor: function () { return select(false); }, openReview, closeReview,
      attachTabs: function (owner) { tabs = owner; renderReview(); },
      resetReview: function () { reviewOpen = false; previewVisible = false; renderReview(); }
    };
  };
})();
