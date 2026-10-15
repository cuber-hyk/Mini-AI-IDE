/** 文件树呈现与名称输入，磁盘操作只经 editorBridge。 */
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
    let restoreDraft = null;
    const containers = new Map([['', tree]]);
    const records = new Map();
    const requests = new Map();

    function node(tag, className, text) {
      const el = document.createElement(tag);
      if (className) el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    }
    function info(message, error) { options.setInfo(message, Boolean(error)); }
    function fail(result) { if (!result || !result.ok) { info(result && result.error || '操作失败', true); return true; } return false; }
    function hideMenu() { if (menu) menu.remove(); menu = null; }
    function rowFor(path) { const record = records.get(path); return record && tree.contains(record.row) ? record.row : null; }
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
    function parentOf(path) { return path.split('/').slice(0, -1).join('/'); }
    function within(path, ancestor) { return path === ancestor || path.startsWith(ancestor + '/'); }
    function current(record) { return records.get(record.entry.relPath) === record && tree.contains(record.row); }
    function invalidate(path) {
      requests.forEach(function (_value, key) { if (within(key, path)) requests.delete(key); });
    }
    function removeBranch(path) {
      invalidate(path);
      records.forEach(function (record, key) {
        if (!within(key, path)) return;
        record.li.remove(); records.delete(key); containers.delete(key); expanded.delete(key);
      });
    }
    function visible(path) {
      let current = '';
      for (const part of path.split('/').filter(Boolean)) {
        current = current ? current + '/' + part : part;
        if (!expanded.has(current)) return false;
      }
      return true;
    }
    function nearestParent(path) {
      let target = ''; let candidate = '';
      for (const part of parentOf(path).split('/').filter(Boolean)) {
        candidate = candidate ? candidate + '/' + part : part;
        if (!expanded.has(candidate) || !containers.has(candidate) || !tree.contains(containers.get(candidate))) break;
        target = candidate;
      }
      return target;
    }
    function syncDirectory(record) {
      if (!record.children) return;
      const open = expanded.has(record.entry.relPath);
      record.row.setAttribute('aria-expanded', String(open)); record.twisty.textContent = open ? '▾' : '▸'; record.children.hidden = !open;
      if (record.open !== open) { window.fileIcons.render(record.icon, record.entry.name, true, open); record.open = open; }
    }
    function createRow(entry) {
      const li = node('li', entry.isDirectory ? 'tree-dir' : 'tree-file'); li.dataset.relPath = entry.relPath;
      const row = node('div', 'tree-row'); row.dataset.relPath = entry.relPath;
      row.draggable = !entry.isDirectory;
      row.tabIndex = 0; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-selected', 'false'); row.title = entry.relPath;
      const twisty = node('span', 'tree-twisty', entry.isDirectory ? '▸' : '');
      const icon = node('span'); window.fileIcons.render(icon, entry.name, entry.isDirectory, expanded.has(entry.relPath));
      row.appendChild(twisty); row.appendChild(icon); row.appendChild(node('span', 'tree-label', entry.name)); li.appendChild(row);
      const record = { entry, li, row, twisty, icon, children: null, open: expanded.has(entry.relPath) };
      records.set(entry.relPath, record);
      if (entry.isDirectory) {
        record.children = node('ul', 'tree-children'); record.children.setAttribute('role', 'group'); li.appendChild(record.children);
        containers.set(entry.relPath, record.children); syncDirectory(record);
      }
      async function toggle() {
        if (!current(record)) return;
        const open = !expanded.has(entry.relPath);
        if (open) expanded.add(entry.relPath); else { expanded.delete(entry.relPath); invalidate(entry.relPath); }
        syncDirectory(record);
        if (open) await load(entry.relPath, record.children, generation, options.getRoot(), true);
      }
      row.addEventListener('click', async function () {
        if (!current(record)) return;
        if (entry.isDirectory) { select(entry); await toggle(); }
        else {
          const epoch = generation; const root = options.getRoot();
          if (await options.openFile(entry.relPath) && epoch === generation && root === options.getRoot() && current(record)) select(entry);
        }
      });
      row.addEventListener('contextmenu', function (event) { event.preventDefault(); if (!current(record)) return; select(entry, true); showMenu(entry, event.clientX, event.clientY); });
      row.addEventListener('keydown', function (event) {
        if (!current(record)) return;
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
      return record;
    }
    // false 表示请求已撤回；普通目录读取失败不撤回其他展开分支。
    async function load(parent, container, epoch, root, deep) {
      const request = {}; requests.set(parent, request);
      const valid = function () { return epoch === generation && root === options.getRoot() && requests.get(parent) === request &&
        containers.get(parent) === container && tree.contains(container) && visible(parent); };
      const result = await bridge.listDir(parent);
      if (!valid()) return false;
      if (fail(result)) return null;
      const wanted = new Map(result.entries.map(function (entry) { return [entry.relPath, entry]; }));
      Array.from(container.children).forEach(function (child) {
        const path = child.dataset.relPath;
        if (!path) { if (child.classList.contains('tree-empty') && !result.truncated) child.remove(); return; }
        const entry = wanted.get(path); const record = records.get(path);
        if (!entry || !record || record.entry.isDirectory !== entry.isDirectory) removeBranch(path);
      });
      const reload = [];
      result.entries.forEach(function (entry, index) {
        let record = records.get(entry.relPath); const fresh = !record;
        if (!record) record = createRow(entry); else Object.assign(record.entry, entry);
        if (container.children[index] !== record.li) container.insertBefore(record.li, container.children[index] || null);
        syncDirectory(record);
        if (record.children && expanded.has(entry.relPath) && (deep || fresh)) reload.push(record);
      });
      if (result.truncated && !Array.from(container.children).some(function (child) { return child.classList.contains('tree-empty'); })) container.appendChild(node('li', 'tree-empty', '条目过多，已显示前 500 项'));
      if (selected && records.has(selected.relPath)) select(records.get(selected.relPath).entry);
      for (const record of reload) {
        if (!valid()) return false;
        if (current(record) && visible(record.entry.relPath) && await load(record.entry.relPath, record.children, epoch, root, true) === false) return false;
      }
      return valid();
    }
    async function refresh(reset, changedPath) {
      hideMenu(); cancelDraft();
      if (reset) { generation++; expanded.clear(); selected = null; tree.textContent = ''; records.clear(); containers.clear(); requests.clear(); containers.set('', tree); }
      else if (changedPath === undefined) { generation++; requests.clear(); }
      const epoch = generation; const root = options.getRoot();
      if (!root) { tree.textContent = ''; return; }
      const focused = document.activeElement;
      const focus = focused && focused.dataset && focused.dataset.relPath;
      const parent = changedPath === undefined ? '' : nearestParent(changedPath.replace(/\\/g, '/'));
      const loaded = await load(parent, containers.get(parent), epoch, root, changedPath === undefined);
      if (!loaded || epoch !== generation || root !== options.getRoot()) return;
      if (selected && !rowFor(selected.relPath)) selected = null;
      if (focus && (document.activeElement === focused || document.activeElement === document.body)) {
        const row = rowFor(focus) || (selected && rowFor(selected.relPath)); if (row && row !== document.activeElement) row.focus();
      }
    }
    function cancelDraft(restoreFocus = true) {
      if (!draft) return;
      const current = draft; const focused = current.contains(document.activeElement); draft = null; current.remove();
      if (restoreDraft) { restoreDraft(); restoreDraft = null; }
      if (restoreFocus && focused && selected && rowFor(selected.relPath)) rowFor(selected.relPath).focus();
    }
    function inputName(container, initial, submit, record) {
      cancelDraft();
      const epoch = generation; const root = options.getRoot();
      const li = node(record ? 'span' : 'li', record ? 'tree-name-entry tree-rename-entry' : 'tree-name-entry');
      const input = node('input', 'tree-name-input'); input.value = initial;
      let pending = false;
      input.setAttribute('aria-label', initial ? '重命名' : '新条目名称'); input.spellcheck = false;
      const error = node('div', 'tree-name-error'); error.setAttribute('role', 'alert'); li.appendChild(input); li.appendChild(error);
      function showError(message) {
        error.textContent = message; pending = false; input.readOnly = false; input.disabled = false;
        if (record) {
          const bounds = tree.getBoundingClientRect(); const outer = (tree.parentNode || tree).getBoundingClientRect(); const row = record.row.getBoundingClientRect();
          const above = row.top - Math.max(bounds.top, outer.top); const below = Math.min(bounds.bottom, outer.bottom) - row.bottom;
          const up = below < error.getBoundingClientRect().height + 4 && above > below;
          error.style.top = up ? 'auto' : '100%'; error.style.bottom = up ? '100%' : 'auto';
          error.style.maxHeight = Math.max(24, (up ? above : below) - 4) + 'px';
        }
        if (!record || document.activeElement === input) input.focus();
      }
      if (record) {
        const label = record.row.children[2]; label.hidden = true; record.row.draggable = false;
        record.row.appendChild(li);
        restoreDraft = function () { label.hidden = false; record.row.draggable = !record.entry.isDirectory; };
        for (const type of ['click', 'dblclick', 'contextmenu']) li.addEventListener(type, function (event) { event.stopPropagation(); });
        input.addEventListener('blur', function () { if (draft === li && !pending) cancelDraft(false); });
      } else container.prepend(li);
      draft = li; input.focus();
      const dot = initial.lastIndexOf('.'); input.setSelectionRange(0, (!record || !record.entry.isDirectory) && dot > 0 ? dot : initial.length);
      input.addEventListener('keydown', async function (event) {
        event.stopPropagation();
        if (event.isComposing || event.keyCode === 229) return;
        if (pending) return;
        if (event.key === 'Escape') { event.preventDefault(); cancelDraft(); }
        if (event.key !== 'Enter' || pending || draft !== li || epoch !== generation || root !== options.getRoot()) return;
        if (record && input.value === initial) { event.preventDefault(); cancelDraft(); return; }
        event.preventDefault(); pending = true;
        if (record) input.readOnly = true; else input.disabled = true;
        try {
          const result = await submit(input.value);
          if (draft !== li || epoch !== generation || root !== options.getRoot()) return;
          if (fail(result)) { showError(result && result.error || '操作失败'); return; }
          cancelDraft();
          if (result.relPath) {
            if (result.isDirectory) expanded.add(result.relPath);
            await refresh(false, result.relPath);
            if (epoch !== generation || root !== options.getRoot()) return;
            if (result.isDirectory) { select({ name: input.value, relPath: result.relPath, isDirectory: true }, true); }
            else if (await options.openFile(result.relPath)) highlight(result.relPath);
            else info('文件已创建；当前编辑内容保留，未打开新文件。');
          }
        } catch (failure) { if (draft !== li) return; showError(String(failure)); }
      });
    }
    async function create(isDirectory) {
      hideMenu(); if (!options.getRoot()) return info('请先打开目录', true);
      const root = options.getRoot(); const epoch = generation;
      const parent = selected ? selected.isDirectory ? selected.relPath : selected.relPath.split('/').slice(0, -1).join('/') : '';
      if (parent) { expanded.add(parent); const record = records.get(parent); if (record) syncDirectory(record); }
      const container = containers.get(parent);
      if (!container || !await load(parent, container, epoch, root, false)) return;
      if (epoch !== generation || root !== options.getRoot() || !tree.contains(container)) return;
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
      inputName(row, entry.name, async function (name) {
        if (root !== options.getRoot()) return { ok: false, error: '目录已切换' };
        const result = await bridge.renameEntry(entry.relPath, name, root);
        // 改名只更新路径，不重新读盘替换未保存缓冲。
        return result.ok ? { ok: true } : result;
      }, records.get(entry.relPath));
    }
    function showMenu(entry, x, y) {
      const root = options.getRoot(); const epoch = generation;
      if (!root) return;
      select(entry);
      hideMenu(); menu = node('div', 'file-menu'); menu.setAttribute('role', 'menu');
      const actions = [ ['新建文件', function () { void create(false); }], ['新建文件夹', function () { void create(true); }] ];
      const relative = entry ? entry.relPath : '';
      actions.push(null,
        ['在文件资源管理器中显示', async function () { fail(await bridge.revealEntry(relative, root)); }],
        ['在默认应用中打开', async function () { fail(await bridge.openEntry(relative, root)); }],
        ['复制绝对路径', async function () { if (!fail(await bridge.copyEntryPath(relative, false, root))) info('已复制绝对路径'); }],
        ['复制相对路径', async function () { if (!fail(await bridge.copyEntryPath(relative, true, root))) info('已复制相对路径'); }]);
      if (entry) actions.push(null, ['重命名', function () { void rename(entry); }],
        ['移入回收站', async function () { fail(await bridge.trashEntry(entry.relPath, root)); }],
        ['永久删除…', async function () { fail(await bridge.deleteEntry(entry.relPath, root)); }, 'file-menu-danger']);
      else actions.push(null, ['刷新目录', function () { void refresh(false); }]);
      actions.forEach(function (item) {
        if (!item) { const separator = node('div', 'file-menu-separator'); separator.setAttribute('role', 'separator'); menu.appendChild(separator); return; }
        const button = node('button', item[2] || '', item[0]); button.type = 'button'; button.setAttribute('role', 'menuitem');
        button.addEventListener('click', function () { hideMenu();
          if (root !== options.getRoot() || epoch !== generation) return info('目录已切换，请重新操作', true);
          Promise.resolve(item[1]()).catch(function (error) { info(String(error), true); }); }); menu.appendChild(button); });
      document.body.appendChild(menu); const rect = menu.getBoundingClientRect();
      menu.style.left = Math.max(0, Math.min(x, window.innerWidth - rect.width)) + 'px';
      menu.style.top = Math.max(0, Math.min(y, window.innerHeight - rect.height)) + 'px';
      menu.firstChild.focus(); menu.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' || event.key === 'Tab') { hideMenu(); const row = entry && rowFor(entry.relPath); (row || tree).focus(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const buttons = Array.from(menu.children).filter(function (item) { return item.tagName === 'BUTTON'; }); const at = buttons.indexOf(document.activeElement); buttons[(at + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); }
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
    tree.addEventListener('dragstart', function (event) {
      event.preventDefault();
      const row = event.target.closest('.tree-row');
      const root = options.getRoot();
      if (!event.isTrusted || !row || !tree.contains(row) || !row.draggable || !root) return;
      void options.bridge.startWorkspaceFileDrag(row.dataset.relPath, root).then(function (result) {
        if (!result.ok) options.setInfo(result.error || '无法拖拽文件', true);
      }).catch(function (error) { options.setInfo('无法拖拽文件：' + String(error), true); });
    });
    options.newFile.addEventListener('click', function () { void create(false); });
    options.newFolder.addEventListener('click', function () { void create(true); });
    options.refresh.addEventListener('click', function () { void refresh(false); });

    function welcome() {
      // 项目仅由左侧工作区选择；文件正文没有目录选择入口。
      options.welcome.textContent = ''; options.welcome.hidden = true;
      options.editor.classList.toggle('empty-editor', !options.currentPath());
      options.newFile.disabled = options.newFolder.disabled = options.refresh.disabled = !options.getRoot();
    }
    async function entryChanged(event) {
      const epoch = generation; const root = options.getRoot();
      const focusRename = event.kind === 'renamed' && draft && draft.contains(document.activeElement) && draft.parentNode === rowFor(event.oldRelPath);
      const affected = function (path) { return path === event.oldRelPath || (event.isDirectory && path.startsWith(event.oldRelPath + '/')); };
      const next = new Set(); expanded.forEach(function (path) { if (!affected(path)) next.add(path); else if (event.kind === 'renamed') next.add(event.relPath + path.slice(event.oldRelPath.length)); });
      expanded.clear(); next.forEach(function (path) { expanded.add(path); });
      if (selected && affected(selected.relPath)) selected = event.kind === 'deleted' ? null : { ...selected, relPath: event.relPath + selected.relPath.slice(event.oldRelPath.length), name: event.relPath.split('/').pop() };
      await refresh(false, event.oldRelPath);
      if (focusRename && epoch === generation && root === options.getRoot() && document.activeElement === document.body) {
        const row = rowFor(event.relPath); if (row) row.focus();
      }
    }
    return { refresh, highlight, welcome, entryChanged };
  };
})();
