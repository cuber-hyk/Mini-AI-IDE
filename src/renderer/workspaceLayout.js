/* 主进程几何是布局真源；这里只消费矩形、上报 dock 高度和用户拖动意图。 */
(function () {
  'use strict';
  window.setupWorkspaceLayout = function (bridge) {
    let latest;
    let scale = 1;
    const dock = document.getElementById('collaboration-dock');
    const navigation = document.getElementById('workspace-navigation');
    const restore = document.getElementById('workspace-restore');
    const tree = document.getElementById('sidebar');
    const treeButton = document.getElementById('btn-sidebar');
    function rectangle(element, bounds) {
      if (!bounds) return;
      Object.assign(element.style, { left: bounds.x * scale + 'px', top: bounds.y * scale + 'px', width: bounds.width * scale + 'px', height: bounds.height * scale + 'px' });
    }
    function divider(id, x, height, visible) {
      const node = document.getElementById(id); node.hidden = !visible;
      Object.assign(node.style, { left: (x * scale - 3) + 'px', top: '0px', height: height * scale + 'px' });
    }
    function apply(state) {
      if (!state || !state.layout) return;
      latest = state;
      const layout = state.layout; const content = layout.contentBounds; const file = layout.fileBounds;
      scale = layout.editorBounds.width ? window.innerWidth / layout.editorBounds.width : 1;
      document.documentElement.style.setProperty('--layout-scale', String(scale));
      rectangle(navigation, layout.workspaceBounds); navigation.hidden = !layout.workspaceVisible;
      const workspaceCollapse = document.getElementById('workspace-collapse');
      workspaceCollapse.hidden = !state.fileMaximized || !layout.workspaceVisible;
      restore.hidden = !navigation.hidden || !state.fileMaximized;
      rectangle(tree, layout.treePaneBounds); tree.hidden = !layout.treeBounds.width;
      treeButton.classList.toggle('active', !tree.hidden);
      treeButton.setAttribute('aria-pressed', String(!tree.hidden));
      treeButton.setAttribute('aria-label', tree.hidden ? '展开目录树' : '收起目录树');
      const maximize = document.getElementById('file-maximize');
      maximize.classList.toggle('maximized', Boolean(state.fileMaximized));
      maximize.setAttribute('aria-pressed', String(Boolean(state.fileMaximized)));
      maximize.title = state.fileMaximized ? '退出文件区全屏' : '文件区全屏';
      maximize.setAttribute('aria-label', maximize.title);
      rectangle(document.querySelector('.toolbar'), { x: file.x, y: file.y, width: content.width, height: 36 });
      rectangle(document.querySelector('.editor-wrap'), { x: file.x, y: file.y + 36, width: content.width, height: Math.max(0, file.height - 36) });
      document.querySelector('.toolbar').hidden = !layout.fileVisible;
      document.querySelector('.editor-wrap').hidden = !layout.fileVisible;
      rectangle(dock, layout.dockBounds);
      dock.style.minHeight = layout.dockBounds.height * scale + 'px';
      dock.style.maxHeight = layout.dockBounds.height * scale + 'px';
      dock.hidden = !layout.dockBounds.width;
      divider('workspace-resizer', layout.workspaceBounds.width, file.height, !navigation.hidden);
      divider('resizer', file.x, file.height, layout.fileVisible && !state.fileMaximized);
      divider('sidebar-resizer', layout.treeBounds.x, file.height, !tree.hidden);
      document.dispatchEvent(new Event('workspace-layout-changed'));
    }
    function patch(value) { return bridge.setWorkspaceLayout(value).then(apply); }
    function drag(id, key, boundsKey, direction, reset) {
      const node = document.getElementById(id); let start;
      node.setAttribute('role', 'separator'); node.setAttribute('aria-orientation', 'vertical'); node.tabIndex = 0;
      node.addEventListener('pointerdown', function (event) {
        if (!latest || event.button !== 0) return;
        start = { id: event.pointerId, x: event.clientX, width: latest.layout[boundsKey].width };
        node.setPointerCapture(event.pointerId); node.classList.add('dragging'); event.preventDefault();
      });
      node.addEventListener('pointermove', function (event) { if (start && start.id === event.pointerId) void patch({ [key]: Math.max(0, Math.round(start.width + direction * (event.clientX - start.x) / scale)) }); });
      function finish() { if (!start) return; const id = start.id; start = null; node.classList.remove('dragging'); if (node.hasPointerCapture(id)) node.releasePointerCapture(id); }
      node.addEventListener('pointerup', finish); node.addEventListener('pointercancel', finish); node.addEventListener('lostpointercapture', finish);
      node.addEventListener('dblclick', function () { void patch({ [key]: reset }); });
      node.addEventListener('keydown', function (event) { if (!latest || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return; event.preventDefault(); void patch({ [key]: event.key === 'Home' ? reset : Math.max(0, latest.layout[boundsKey].width + (event.key === 'ArrowRight' ? 24 : -24) * direction) }); });
    }
    drag('workspace-resizer', 'workspaceWidth', 'workspaceBounds', 1, 240);
    drag('resizer', 'fileWidth', 'fileBounds', -1, 700);
    drag('sidebar-resizer', 'treeWidth', 'treeBounds', -1, 190);
    document.getElementById('workspace-collapse').addEventListener('click', function () { void patch({ workspaceVisible: false }); });
    restore.addEventListener('click', function () { void patch({ workspaceVisible: true }); });
    document.getElementById('file-collapse').addEventListener('click', function () { void patch({ fileVisible: false }); });
    document.getElementById('tree-collapse').addEventListener('click', function () { void patch({ treeVisible: false }); });
    document.getElementById('file-maximize').addEventListener('click', function () { if (latest) void patch({ fileMaximized: !latest.fileMaximized }); });
    treeButton.addEventListener('click', function () { void patch({ treeVisible: tree.hidden }); });
    bridge.onChromeState(apply);
    window.addEventListener('resize', function () { if (latest) apply(latest); });
    void patch({});
    let measured = -1;
    function measureDock() {
      if (dock.hidden || !dock.clientWidth) return;
      let needed = Array.from(dock.children).reduce(function (total, child) {
        return total + child.getBoundingClientRect().height;
      }, 1);
      // 固定浮层不计入子元素高度，另预留原生官网视图不能遮挡的显示预算。
      const dockBottom = dock.getBoundingClientRect().bottom;
      for (const [surfaceId, triggerId] of [['tool-settings-panel', 'tool-settings-toggle'], ['tool-more', 'tool-more-toggle']]) {
        const surface = document.getElementById(surfaceId);
        if (!surface.hidden) needed = Math.max(needed, surface.getBoundingClientRect().height + dockBottom - document.getElementById(triggerId).getBoundingClientRect().top + 16);
      }
      const height = Math.ceil(needed / scale);
      if (height === measured) return; measured = height; void patch({ dockHeight: height });
    }
    const observer = new ResizeObserver(measureDock);
    document.addEventListener('prompt-size-changed', measureDock);
    dock.addEventListener('toggle', measureDock, true);
    dock.addEventListener('click', function () { queueMicrotask(measureDock); });
    observer.observe(dock);
    ['tool-panel', 'prompt-actions', 'requirement-panel', 'local-prompt-options', 'skill-menu', 'skill-chips', 'skill-preview', 'tool-settings-panel', 'tool-more'].forEach(function (id) { observer.observe(document.getElementById(id)); });
    return { apply: apply };
  };
})();
