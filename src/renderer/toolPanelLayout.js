/* 本地工具面板尺寸与浮层；不读取工具正文或请求本地能力。 */
(function () {
  'use strict';
  window.setupToolPanelLayout = function () {
    const panel = document.getElementById('tool-panel');
    const body = document.getElementById('tool-panel-body');
    const handle = document.getElementById('tool-resizer');
    const heading = panel.querySelector('summary');
    const prompt = document.querySelector('.prompt-bar');
    const toolbar = document.querySelector('.toolbar');
    let wanted = 160;
    let maximum = 260;
    let minimum = 80;
    let dragging;
    const popups = [];

    function popup(wrapId, triggerId, panelId, closeId) {
      const wrap = document.getElementById(wrapId);
      const trigger = document.getElementById(triggerId);
      const surface = document.getElementById(panelId);
      function close(restore) {
        surface.hidden = true; trigger.setAttribute('aria-expanded', 'false');
        if (restore) trigger.focus();
      }
      function position() {
        if (surface.hidden) return;
        surface.style.maxHeight = Math.max(0, window.innerHeight - 16) + 'px';
        const anchor = trigger.getBoundingClientRect(); const size = surface.getBoundingClientRect();
        const left = Math.max(8, Math.min(anchor.right - size.width, window.innerWidth - size.width - 8));
        const above = anchor.top - size.height - 8;
        const top = above >= 8 ? above : Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - size.height - 8));
        surface.style.left = left + 'px'; surface.style.top = top + 'px';
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
      const item = { close: close, refresh: function () { if (trigger.hidden) close(false); else position(); } };
      popups.push(item);
    }
    popup('tool-settings-wrap', 'tool-settings-toggle', 'tool-settings-panel', 'tool-settings-close');
    popup('tool-more-wrap', 'tool-more-toggle', 'tool-more');
    document.getElementById('btn-settings').addEventListener('click', function () { popups[0].close(false); });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      const active = popups.find(function (_item, index) {
        return !document.getElementById(index === 0 ? 'tool-settings-panel' : 'tool-more').hidden;
      });
      if (active) { event.preventDefault(); active.close(true); }
    });

    function fit() {
      maximum = Math.max(0, Math.min(Math.floor(window.innerHeight * .42),
        window.innerHeight - toolbar.getBoundingClientRect().height - prompt.getBoundingClientRect().height - heading.getBoundingClientRect().height - 120));
      minimum = Math.min(80, maximum);
      const height = Math.round(Math.max(minimum, Math.min(wanted, maximum)));
      body.style.height = height + 'px';
      handle.hidden = !panel.open;
      handle.setAttribute('aria-valuemin', String(minimum));
      handle.setAttribute('aria-valuemax', String(maximum));
      handle.setAttribute('aria-valuenow', String(height));
      popups.forEach(function (item) { item.refresh(); });
    }
    function finish() {
      if (!dragging) return;
      const id = dragging.id; dragging = undefined; handle.classList.remove('dragging');
      if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    }
    handle.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || !panel.open) return;
      dragging = { id: event.pointerId, y: event.clientY, height: body.getBoundingClientRect().height };
      handle.classList.add('dragging'); handle.setPointerCapture(event.pointerId); event.preventDefault();
    });
    handle.addEventListener('pointermove', function (event) {
      if (!dragging || event.pointerId !== dragging.id) return;
      wanted = Math.max(minimum, Math.min(maximum, dragging.height + dragging.y - event.clientY)); fit();
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('dblclick', function () { wanted = 160; fit(); });
    handle.addEventListener('keydown', function (event) {
      const next = { ArrowUp: Number(body.style.height.slice(0, -2)) + 24, ArrowDown: Number(body.style.height.slice(0, -2)) - 24, Home: minimum, End: maximum };
      if (!(event.key in next)) return;
      event.preventDefault(); wanted = Math.max(minimum, Math.min(maximum, next[event.key])); fit();
    });
    panel.addEventListener('toggle', function () { if (!panel.open) finish(); fit(); });
    window.addEventListener('resize', fit);
    document.addEventListener('prompt-size-changed', fit);
    window.addEventListener('blur', function () { finish(); popups.forEach(function (item) { item.close(false); }); });
    const observer = new ResizeObserver(fit); observer.observe(heading);
    fit();
    return { refresh: fit };
  };
})();
