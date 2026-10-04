/** 编辑器顶部复制菜单：只负责交互，复制内容仍由原有编辑器链路处理。 */
(function () {
  'use strict';

  window.setupEditorToolbar = function () {
    const wrap = document.getElementById('context-menu-wrap');
    const trigger = document.getElementById('btn-copy-context');
    const menu = document.getElementById('context-menu');
    const root = document.getElementById('root-label');
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));

    function close(restoreFocus) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus();
    }

    function open(focusIndex) {
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      if (typeof focusIndex === 'number') items[focusIndex].focus();
    }

    trigger.addEventListener('click', function () {
      if (menu.hidden) open(0);
      else close(false);
    });
    trigger.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      open(event.key === 'ArrowDown' ? 0 : items.length - 1);
    });
    wrap.addEventListener('keydown', function (event) {
      if (menu.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      } else if (event.key === 'Tab') {
        // 允许浏览器按正常顺序移出工具条；不要把焦点留在隐藏的菜单项。
        if (event.shiftKey && items.includes(event.target)) {
          event.preventDefault();
          close(true);
        } else {
          window.setTimeout(function () { close(false); }, 0);
        }
      } else if (items.includes(event.target)) {
        const current = items.indexOf(event.target);
        let next;
        if (event.key === 'ArrowDown') next = (current + 1) % items.length;
        if (event.key === 'ArrowUp') next = (current + items.length - 1) % items.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = items.length - 1;
        if (next !== undefined) {
          event.preventDefault();
          items[next].focus();
        }
      }
    });
    items.forEach(function (item) {
      item.addEventListener('click', function () { close(true); });
    });
    document.addEventListener('pointerdown', function (event) {
      if (!wrap.contains(event.target)) close(false);
    });
    wrap.addEventListener('focusout', function (event) {
      if (!wrap.contains(event.relatedTarget)) close(false);
    });

    return {
      renderRoot: function (absolutePath) {
        const parts = String(absolutePath || '').split(/[\\/]/).filter(Boolean);
        root.textContent = absolutePath ? parts.slice(-2).join(' / ') || absolutePath : '未打开目录';
        root.title = absolutePath || '';
      },
    };
  };
})();
