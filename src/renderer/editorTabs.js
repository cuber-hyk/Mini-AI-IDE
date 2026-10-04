/** 标签呈现和键盘导航；草稿及模型由 editorWorkspace 管理。 */
(function () {
  'use strict';
  window.createEditorTabs = function (host, options) {
    let signature = '';
    function render(documents, activePath) {
      const next = JSON.stringify([documents, activePath]);
      if (next === signature) return;
      signature = next;
      const focused = host.contains(document.activeElement) && document.activeElement.dataset.path;
      host.textContent = ''; host.hidden = documents.length === 0;
      documents.forEach(function (doc, index) {
        const item = document.createElement('div'); item.className = 'editor-tab';
        item.classList.toggle('active', doc.path === activePath); item.classList.toggle('dirty', doc.dirty);
        const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'editor-tab-label';
        tab.dataset.path = doc.path; tab.textContent = doc.path.split('/').pop(); tab.title = doc.path + (doc.dirty ? '（未保存）' : '');
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(doc.path === activePath));
        tab.setAttribute('aria-controls', 'monaco'); tab.setAttribute('aria-label', doc.path + (doc.dirty ? '，未保存' : ''));
        tab.tabIndex = doc.path === activePath ? 0 : -1;
        tab.addEventListener('click', function () { void options.open(doc.path); });
        tab.addEventListener('keydown', function (event) {
          let target;
          if (event.key === 'ArrowLeft') target = documents[(index + documents.length - 1) % documents.length];
          if (event.key === 'ArrowRight') target = documents[(index + 1) % documents.length];
          if (event.key === 'Home') target = documents[0];
          if (event.key === 'End') target = documents[documents.length - 1];
          if (target) { event.preventDefault(); void options.open(target.path).then(function () {
            const button = Array.from(host.querySelectorAll('[role=tab]')).find(function (el) { return el.dataset.path === target.path; });
            if (button) button.focus();
          }); }
          if (event.key === 'Delete') { event.preventDefault(); void options.close(doc.path); }
        });
        const close = document.createElement('button'); close.type = 'button'; close.className = 'ui-icon editor-tab-close';
        close.dataset.path = doc.path; close.textContent = '×'; close.title = '关闭 ' + doc.path;
        close.setAttribute('aria-label', '关闭 ' + doc.path);
        close.addEventListener('click', function () { void options.close(doc.path); });
        item.appendChild(tab); item.appendChild(close); host.appendChild(item);
      });
      const tabs = Array.from(host.querySelectorAll('[role=tab]'));
      const restore = tabs.find(function (tab) { return tab.dataset.path === focused; });
      if (restore) restore.focus();
      const active = tabs.find(function (tab) { return tab.dataset.path === activePath; });
      if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return { render };
  };
})();
