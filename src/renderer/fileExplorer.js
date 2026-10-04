/** 文件树呈现、名称输入及最近目录入口，磁盘操作只经 editorBridge。 */
(function () {
  'use strict';
  window.createFileExplorer = function (options) {
    const bridge = options.bridge;
    const tree = options.tree;
    const expanded = new Set();
    let selected = null;
    let generation = 0;
    let menu = null;
    let draft = null;
    const containers = new Map();

    function node(tag, className, text) {
      const el = document.createElement(tag);
      if (className) el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    }
    function info(message, error) { options.setInfo(message, Boolean(error)); }
    function fail(result) { if (!result || !result.ok) { info(result && result.error || '操作失败', true); return true; } return false; }
    function hideMenu() { if (menu) menu.remove(); menu = null; }
    function rowFor(path) { return Array.from(tree.querySelectorAll('.tree-row')).find(function (row) { return row.dataset.relPath === path; }); }
    function select(entry, focus) {
      selected = entry;
      tree.querySelectorAll('.tree-row.active').forEach(function (row) { row.classList.remove('active'); row.setAttribute('aria-selected', 'false'); });
      const row = entry && rowFor(entry.relPath);
      if (row) { row.classList.add('active'); row.setAttribute('aria-selected', 'true'); if (focus) row.focus(); }
    }
    function highlight(path) {
      const row = rowFor(path);
      if (row) select({ relPath: path, name: path.split('/').pop(), isDirectory: false });
    }
    async function load(parent, container, epoch, root) {
      const result = await bridge.listDir(parent);
      if (epoch !== generation || root !== options.getRoot()) return;
      if (fail(result)) return;
      container.textContent = '';
      containers.set(parent, container);
      for (const entry of result.entries) {
        if (epoch !== generation || root !== options.getRoot()) return;
        const li = node('li', entry.isDirectory ? 'tree-dir' : 'tree-file'); li.dataset.relPath = entry.relPath;
        const row = node('div', 'tree-row'); row.dataset.relPath = entry.relPath;
        row.tabIndex = 0; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-selected', 'false');
        row.title = entry.relPath;
        const twisty = node('span', 'tree-twisty', entry.isDirectory ? '▸' : '');
        row.appendChild(twisty); row.appendChild(node('span', 'tree-label', entry.name)); li.appendChild(row);
        container.appendChild(li);
        let children;
        async function toggle() {
          const open = !expanded.has(entry.relPath);
          if (open) expanded.add(entry.relPath); else expanded.delete(entry.relPath);
          row.setAttribute('aria-expanded', String(open)); twisty.textContent = open ? '▾' : '▸'; children.hidden = !open;
          if (open) await load(entry.relPath, children, epoch, root);
        }
        if (entry.isDirectory) {
          children = node('ul', 'tree-children'); children.setAttribute('role', 'group'); children.hidden = !expanded.has(entry.relPath); li.appendChild(children);
          row.setAttribute('aria-expanded', String(!children.hidden));
          if (!children.hidden) {
            twisty.textContent = '▾'; await load(entry.relPath, children, epoch, root);
            if (epoch !== generation || root !== options.getRoot()) return;
          }
        }
        row.addEventListener('click', async function () {
          if (entry.isDirectory) { select(entry); await toggle(); }
          else if (await options.openFile(entry.relPath)) select(entry);
        });
        row.addEventListener('contextmenu', function (event) { event.preventDefault(); select(entry, true); showMenu(entry, event.clientX, event.clientY); });
        row.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
          if (event.key === 'F2') { event.preventDefault(); void rename(entry); }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const rows = Array.from(tree.querySelectorAll('.tree-row')).filter(function (r) { return r.offsetParent !== null; });
            const index = rows.indexOf(row); const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
            if (next) { event.preventDefault(); next.focus(); }
          }
          if ((event.key === 'ArrowRight' && !expanded.has(entry.relPath)) || (event.key === 'ArrowLeft' && expanded.has(entry.relPath))) {
            if (entry.isDirectory) { event.preventDefault(); void toggle(); }
          }
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = row.getBoundingClientRect(); showMenu(entry, rect.left, rect.bottom); }
        });
        if (selected && selected.relPath === entry.relPath) select(entry);
      }
      if (result.truncated) container.appendChild(node('li', 'tree-empty', '条目过多，已显示前 500 项'));
    }
    async function refresh(reset) {
      hideMenu(); cancelDraft();
      if (reset) { expanded.clear(); selected = null; tree.textContent = ''; }
      const epoch = ++generation; const root = options.getRoot(); containers.clear();
      if (!root) { tree.textContent = ''; return; }
      const focus = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.relPath;
      await load('', tree, epoch, root);
      if (epoch !== generation) return;
      if (selected && !rowFor(selected.relPath)) selected = null;
      if (focus && rowFor(focus)) rowFor(focus).focus();
    }
    function cancelDraft() {
      if (!draft) return;
      const current = draft; draft = null; current.remove();
      if (selected && rowFor(selected.relPath)) rowFor(selected.relPath).focus();
    }
    function inputName(container, initial, submit) {
      cancelDraft();
      const li = node('li', 'tree-name-entry'); const input = node('input', 'tree-name-input'); input.value = initial;
      input.setAttribute('aria-label', initial ? '重命名' : '新条目名称'); input.spellcheck = false;
      const error = node('div', 'tree-name-error'); error.setAttribute('role', 'alert'); li.appendChild(input); li.appendChild(error);
      container.prepend(li); draft = li; input.focus();
      const dot = initial.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : initial.length);
      input.addEventListener('keydown', async function (event) {
        if (event.key === 'Escape') { event.preventDefault(); cancelDraft(); }
        if (event.key !== 'Enter' || input.disabled) return;
        event.preventDefault(); input.disabled = true;
        try {
          const result = await submit(input.value);
          if (draft !== li) return;
          if (fail(result)) { error.textContent = result && result.error || '操作失败'; input.disabled = false; input.focus(); return; }
          cancelDraft(); await refresh(false);
          if (result.relPath) {
            if (result.isDirectory) { expanded.add(result.relPath); await refresh(false); select({ name: input.value, relPath: result.relPath, isDirectory: true }, true); }
            else if (await options.openFile(result.relPath)) highlight(result.relPath);
            else info('文件已创建；当前编辑内容保留，未打开新文件。');
          }
        } catch (failure) { error.textContent = String(failure); input.disabled = false; input.focus(); }
      });
    }
    async function create(isDirectory) {
      hideMenu(); if (!options.getRoot()) return info('请先打开目录', true);
      const root = options.getRoot();
      if (root !== options.getRoot()) return;
      const parent = selected ? selected.isDirectory ? selected.relPath : selected.relPath.split('/').slice(0, -1).join('/') : '';
      if (parent) expanded.add(parent); await refresh(false);
      if (root !== options.getRoot()) return;
      inputName(containers.get(parent) || tree, '', async function (name) {
        if (root !== options.getRoot()) return { ok: false, error: '目录已切换' };
        return bridge.createEntry(parent, name, isDirectory, root);
      });
    }
    async function rename(entry) {
      hideMenu(); if (!entry) return;
      const row = rowFor(entry.relPath); if (!row) return;
      select(entry);
      const root = options.getRoot();
      inputName(row.parentNode.parentNode, entry.name, async function (name) {
        if (root !== options.getRoot()) return { ok: false, error: '目录已切换' };
        const result = await bridge.renameEntry(entry.relPath, name, root);
        // 改名只更新路径，不重新读盘替换未保存缓冲。
        return result.ok ? { ok: true } : result;
      });
    }
    function showMenu(entry, x, y) {
      const root = options.getRoot();
      if (!root) return;
      select(entry);
      hideMenu(); menu = node('div', 'file-menu'); menu.setAttribute('role', 'menu');
      const actions = [ ['新建文件', function () { void create(false); }], ['新建文件夹', function () { void create(true); }] ];
      if (entry) actions.push(['重命名', function () { void rename(entry); }], ['移入回收站', async function () { if (!fail(await bridge.trashEntry(entry.relPath, root))) await refresh(false); }]);
      else actions.push(['刷新目录', function () { void refresh(false); }]);
      actions.forEach(function (item) { const button = node('button', '', item[0]); button.type = 'button'; button.setAttribute('role', 'menuitem');
        button.addEventListener('click', function () { hideMenu(); Promise.resolve(item[1]()).catch(function (error) { info(String(error), true); }); }); menu.appendChild(button); });
      document.body.appendChild(menu); const rect = menu.getBoundingClientRect();
      menu.style.left = Math.max(0, Math.min(x, window.innerWidth - rect.width)) + 'px';
      menu.style.top = Math.max(0, Math.min(y, window.innerHeight - rect.height)) + 'px';
      menu.firstChild.focus(); menu.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' || event.key === 'Tab') { hideMenu(); const row = entry && rowFor(entry.relPath); (row || tree).focus(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const buttons = Array.from(menu.children); const at = buttons.indexOf(document.activeElement); buttons[(at + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); }
      });
    }
    document.addEventListener('pointerdown', function (event) { if (menu && !menu.contains(event.target)) hideMenu(); });
    tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', '文件和文件夹');
    tree.tabIndex = 0;
    const surface = tree.parentNode || tree;
    surface.addEventListener('contextmenu', function (event) {
      if (event.target !== surface && !tree.contains(event.target)) return;
      if (event.target.closest('.tree-row, .tree-name-entry')) return;
      event.preventDefault(); showMenu(null, event.clientX, event.clientY);
    });
    tree.addEventListener('keydown', function (event) {
      if (event.target !== tree) return;
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); const rect = tree.getBoundingClientRect(); showMenu(null, rect.left, rect.top);
      }
    });
    tree.addEventListener('click', function (event) { if (event.target === tree) selected = null; });
    options.newFile.addEventListener('click', function () { void create(false); });
    options.newFolder.addEventListener('click', function () { void create(true); });
    options.refresh.addEventListener('click', function () { void refresh(false); });

    function welcome(roots) {
      const host = options.welcome; host.textContent = ''; host.hidden = Boolean(options.currentPath());
      options.editor.classList.toggle('empty-editor', !options.currentPath());
      if (host.hidden) return;
      host.appendChild(node('h2', '', options.getRoot() ? '选择文件开始编辑' : '打开一个目录开始工作'));
      const open = node('button', 'ui-button primary', '打开目录…'); open.type = 'button';
      open.addEventListener('click', async function () { const result = await bridge.chooseRoot(); if (result.error) info(result.error, true); }); host.appendChild(open);
      if (options.getRoot()) { const file = node('button', 'ui-button', '新建文件'); file.type = 'button'; file.addEventListener('click', function () { void create(false); }); host.appendChild(file); }
      if (roots.length) { host.appendChild(node('h3', '', '最近目录')); const list = node('ul', 'recent-folders');
        roots.forEach(function (root, index) { const li = node('li'); const button = node('button', '', root); button.type = 'button'; button.title = root;
          button.addEventListener('click', async function () { const result = await bridge.openRecentRoot(index); if (result.error) info(result.error, true); }); li.appendChild(button); list.appendChild(li); }); host.appendChild(list); }
      options.newFile.disabled = options.newFolder.disabled = options.refresh.disabled = !options.getRoot();
    }
    function entryChanged(event) {
      const affected = function (path) { return path === event.oldRelPath || (event.isDirectory && path.startsWith(event.oldRelPath + '/')); };
      const next = new Set(); expanded.forEach(function (path) { if (!affected(path)) next.add(path); else if (event.kind === 'renamed') next.add(event.relPath + path.slice(event.oldRelPath.length)); });
      expanded.clear(); next.forEach(function (path) { expanded.add(path); });
      if (selected && affected(selected.relPath)) selected = event.kind === 'deleted' ? null : { ...selected, relPath: event.relPath + selected.relPath.slice(event.oldRelPath.length), name: event.relPath.split('/').pop() };
      void refresh(false);
    }
    return { refresh, highlight, welcome, entryChanged };
  };
})();
