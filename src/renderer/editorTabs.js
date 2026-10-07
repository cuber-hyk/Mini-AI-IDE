/** 标签呈现和键盘导航；草稿及模型由 editorWorkspace 管理。 */
(function () {
  'use strict';
  window.createEditorTabs = function (host, options) {
    let signature = '';
    let files = [];
    let filePath = null;
    let reviewOpen = false;
    let reviewActive = false;
    function open(doc) { return Promise.resolve(doc.review ? options.openReview() : options.open(doc.path)); }
    function close(doc) { return doc.review ? options.closeReview() : options.close(doc.path); }
    host.addEventListener('wheel', function (event) {
      if (event.ctrlKey || host.scrollWidth <= host.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientWidth : 1;
      const next = Math.max(0, Math.min(host.scrollWidth - host.clientWidth, host.scrollLeft + delta * unit));
      if (next === host.scrollLeft) return;
      host.scrollLeft = next; event.preventDefault();
    }, { passive: false });
    function render(documents, activePath) {
      files = documents; filePath = activePath;
      const entries = reviewOpen ? documents.concat([{ path: null, review: true, dirty: false }]) : documents;
      paint(entries, reviewActive ? null : activePath);
    }
    function paint(documents, activePath) {
      const next = JSON.stringify([documents, activePath, reviewActive]);
      if (next === signature) return;
      signature = next;
      const focused = host.contains(document.activeElement) && document.activeElement.dataset.path;
      host.textContent = ''; host.hidden = documents.length === 0;
      documents.forEach(function (doc, index) {
        const item = document.createElement('div'); item.className = 'editor-tab';
        const selected = doc.review ? reviewActive : !reviewActive && doc.path === activePath;
        item.classList.toggle('active', selected); item.classList.toggle('dirty', doc.dirty);
        const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'editor-tab-label';
        tab.dataset.path = doc.path || ''; tab.dataset.kind = doc.review ? 'review' : 'file';
        const label = doc.review ? '本批改动' : doc.path;
        tab.textContent = doc.review ? label : doc.path.split('/').pop(); tab.title = label + (doc.dirty ? '（未保存）' : '');
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(selected));
        if (!doc.review) tab.setAttribute('aria-controls', 'monaco');
        tab.setAttribute('aria-label', label + (doc.dirty ? '，未保存' : ''));
        tab.tabIndex = selected || (!activePath && !reviewActive && index === 0) ? 0 : -1;
        tab.addEventListener('click', function () { void open(doc); });
        tab.addEventListener('keydown', function (event) {
          let target;
          if (event.key === 'ArrowLeft') target = documents[(index + documents.length - 1) % documents.length];
          if (event.key === 'ArrowRight') target = documents[(index + 1) % documents.length];
          if (event.key === 'Home') target = documents[0];
          if (event.key === 'End') target = documents[documents.length - 1];
          if (target) { event.preventDefault(); void open(target).then(function () {
            const button = Array.from(host.querySelectorAll('[role=tab]')).find(function (el) { return el.dataset.path === (target.path || ''); });
            if (button) button.focus();
          }); }
          if (event.key === 'Delete') { event.preventDefault(); void close(doc); }
        });
        const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'ui-icon editor-tab-close';
        closeButton.dataset.path = doc.path || ''; closeButton.textContent = '×'; closeButton.title = '关闭 ' + label;
        closeButton.setAttribute('aria-label', '关闭 ' + label);
        closeButton.addEventListener('click', function () { void close(doc); });
        item.appendChild(tab); item.appendChild(closeButton); host.appendChild(item);
      });
      const tabs = Array.from(host.querySelectorAll('[role=tab]'));
      const restore = tabs.find(function (tab) { return tab.dataset.path === focused; });
      if (restore) restore.focus();
      const active = tabs.find(function (tab) { return tab.dataset.path === (activePath || ''); });
      if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return { render, setReview: function (opened, active) { reviewOpen = opened; reviewActive = active; render(files, filePath); } };
  };
})();
