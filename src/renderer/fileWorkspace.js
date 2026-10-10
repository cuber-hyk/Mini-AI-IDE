/* 文件、工具与 Diff 共用正文；切换只改变展示，不重建文件模型或执行工具。 */
(function () {
  'use strict';
  window.setupFileWorkspace = function (bridge) {
    let previewVisible = false;
    let reviewOpen = false;
    let toolsVisible = false;
    let toolsOpen = false;
    let navigationVersion = 0;
    let tabs = null;
    function renderReview() {
      if (tabs) {
        tabs.setReview(reviewOpen, previewVisible);
        tabs.setTools(toolsOpen, toolsVisible);
      }
    }
    async function select(visible) {
      navigationVersion += 1;
      await bridge.setWorkspaceLayout({ previewVisible: visible, toolsVisible: false });
    }
    async function openReview() {
      navigationVersion += 1;
      await bridge.setWorkspaceLayout({ previewVisible: true, fileVisible: true });
    }
    async function closeReview() {
      navigationVersion += 1;
      if (previewVisible) await select(false);
      reviewOpen = false; previewVisible = false; renderReview();
    }
    async function openTools() {
      navigationVersion += 1;
      await bridge.setWorkspaceLayout({ toolsVisible: true, previewVisible: false, fileVisible: true });
    }
    async function closeTools() {
      navigationVersion += 1;
      if (toolsVisible) await select(false);
      toolsOpen = false; toolsVisible = false; renderReview();
    }
    document.addEventListener('tool-attention', function (event) {
      const batch = event.detail && event.detail.kind === 'batch';
      if (batch && toolsVisible) return;
      const opened = toolsVisible ? Promise.resolve() : openTools();
      const version = navigationVersion;
      void opened.then(function () {
        if (version !== navigationVersion || !toolsVisible || batch) return;
        const target = event.detail && event.detail.key;
        const item = Array.from(document.getElementById('tool-results').children).find(function (node) { return node.dataset.key === target; });
        if (item) { item.open = true; item.scrollIntoView({ block: 'nearest' }); }
        else document.getElementById('tool-message').scrollIntoView({ block: 'nearest' });
      }).catch(function (error) {
        if (version !== navigationVersion) return;
        const info = document.getElementById('info');
        info.textContent = '打开工具失败：' + error.message; info.classList.add('warn');
      });
    });
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
      toolsVisible = Boolean(state.toolsVisible);
      if (visible) reviewOpen = true;
      if (toolsVisible) toolsOpen = true;
      renderReview();
      document.body.classList.toggle('file-diff-visible', visible);
      document.getElementById('monaco').inert = visible || toolsVisible;
      document.getElementById('workspace-welcome').inert = visible || toolsVisible;

    });
    return {
      showEditor: function () { return select(false); }, openReview, closeReview, openTools, closeTools,
      attachTabs: function (owner) { tabs = owner; renderReview(); },
      resetReview: function () { navigationVersion += 1; reviewOpen = false; previewVisible = false; toolsOpen = false; toolsVisible = false; renderReview(); }
    };
  };
})();
