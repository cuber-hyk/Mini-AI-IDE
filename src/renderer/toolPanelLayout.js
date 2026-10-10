/* 本地工具面板尺寸与浮层；不读取工具正文或请求本地能力。 */
(function () {
  'use strict';
  window.setupToolPanelLayout = function () {
    const workspace = document.getElementById('tool-workspace');
    const popups = [];

    function popup(wrapId, triggerId, panelId, closeId) {
      const wrap = document.getElementById(wrapId);
      const trigger = document.getElementById(triggerId);
      const surface = document.getElementById(panelId);
      function close(restore) {
        if (surface.hidden) return;
        surface.hidden = true; trigger.setAttribute('aria-expanded', 'false');
        if (restore) trigger.focus();
      }
      function position() {
        if (surface.hidden) return;
        const anchor = trigger.getBoundingClientRect(); const region = workspace.getBoundingClientRect();
        surface.style.maxHeight = Math.max(0, region.height - 16) + 'px';
        surface.style.maxWidth = Math.max(0, region.width - 16) + 'px';
        const size = surface.getBoundingClientRect();
        const left = Math.max(region.left + 8, Math.min(anchor.right - size.width, region.right - size.width - 8));
        const above = anchor.top - size.height - 8;
        const top = Math.max(region.top + 8, above);
        surface.style.left = left + 'px'; surface.style.top = Math.min(top, Math.max(region.top + 8, region.bottom - size.height - 8)) + 'px';
      }
      trigger.addEventListener('click', function () {
        if (!surface.hidden) { close(false); return; }
        popups.forEach(function (item) { item.close(false); });
        surface.hidden = false; trigger.setAttribute('aria-expanded', 'true'); position();
        const first = surface.querySelector('button:not(:disabled):not([hidden]),select:not(:disabled),input:not(:disabled)');
        (first || surface).focus();
      });
      if (closeId) document.getElementById(closeId).addEventListener('click', function () { close(true); });
      wrap.addEventListener('focusout', function (event) { if (!wrap.contains(event.relatedTarget)) close(false); });
      document.addEventListener('pointerdown', function (event) { if (!wrap.contains(event.target)) close(false); });
      const item = { close: close, isOpen: function () { return !surface.hidden; }, refresh: function () { if (trigger.hidden || workspace.hidden) close(false); else position(); } };
      popups.push(item);
    }
    popup('tool-more-wrap', 'tool-more-toggle', 'tool-more');
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      const active = popups.find(function (item) { return item.isOpen(); });
      if (active) { event.preventDefault(); active.close(true); }
    });

    function refresh() { popups.forEach(function (item) { item.refresh(); }); }
    window.addEventListener('resize', refresh);
    document.addEventListener('workspace-layout-changed', refresh);
    window.addEventListener('blur', function () { popups.forEach(function (item) { item.close(false); }); });
    return { refresh };
  };
})();
