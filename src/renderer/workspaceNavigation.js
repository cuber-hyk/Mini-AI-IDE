/* 常驻项目与绑定会话导航；磁盘、网页导航和绑定校验归主进程 owner。 */
(function () {
  'use strict';
  window.setupWorkspaceNavigation = function (bridge) {
    const list = document.getElementById('workspace-list');
    const search = document.getElementById('workspace-search');
    const message = document.getElementById('workspace-message');
    let roots = [];
    let current = null;
    let busy = false;
    let errorMessage = '';
    let sessionError = '';
    let rootGeneration = 0;
    let sessions = { revision: -1, sessions: [], selectedId: null, current: null, canBind: false, busy: false };
    const collapsed = new Set();
    let menu = null;
    let menuAnchor = null;
    function glyph(name) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', {
        chevron: 'm6 4 4 4-4 4',
        link: 'm6 10 4-4M5.5 6.5 4 8a2.8 2.8 0 0 0 4 4l1.5-1.5M6.5 5.5 8 4a2.8 2.8 0 0 1 4 4l-1.5 1.5',
        more: 'M3 8h.01M8 8h.01M13 8h.01',
        chat: 'M3 2.5h10v8H7l-4 3zM5.5 5.5h5M5.5 7.5h3',
      }[name]);
      svg.appendChild(path); return svg;
    }
    function key(path) { return path.toLocaleLowerCase(); }
    function parts(path) { return path.split(/[\\/]/).filter(Boolean); }
    function groupName(session) { return (session.platform === 'chatgpt' ? 'ChatGPT' : 'DeepSeek') + ' · ' + session.accountName; }
    function displayTitle(session) {
      const platform = session.platform === 'chatgpt' ? 'ChatGPT' : 'DeepSeek';
      const stripped = session.title.replace(new RegExp('\\s+[-–—|]\\s*' + platform + '\\s*$', 'i'), '').trim();
      return stripped || session.title;
    }
    function bindingHint() {
      if (busy || sessions.busy) return '正在处理，请稍候';
      if (sessions.error) return sessions.error;
      if (!sessions.current) return '请先在官网打开正式会话，再绑定到此项目';
      const bound = sessions.sessions.find(function (session) {
        return session.platform === sessions.current.platform && session.accountId === sessions.current.accountId && session.conversationId === sessions.current.conversationId;
      });
      return bound ? '当前网页会话已绑定项目：' + (parts(bound.root).pop() || bound.root) : '当前网页会话正在准备，请稍候';
    }
    function button(className, text, label, disabled, action, focusKey) {
      const node = document.createElement('button');
      node.type = 'button'; node.className = className; node.textContent = text;
      node.title = label; node.setAttribute('aria-label', label); node.disabled = disabled;
      node.setAttribute('data-workspace-focus', focusKey || className + ':' + label);
      node.addEventListener('click', action);
      return node;
    }
    function restoreFocus(focusKey) {
      if (!focusKey) return;
      const target = Array.from(list.querySelectorAll('button')).find(function (node) { return node.getAttribute('data-workspace-focus') === focusKey; });
      if (target && !target.disabled) target.focus();
    }
    function hideMenu(restore) {
      const anchor = menuAnchor;
      if (menu) menu.remove();
      menu = menuAnchor = null;
      if (anchor) {
        anchor.setAttribute('aria-expanded', 'false');
        anchor.parentNode.classList.remove('menu-open');
        if (restore && list.contains(anchor) && !anchor.disabled) anchor.focus();
      }
    }
    function showMenu(anchor, className, label, operation, sessionOperation) {
      if (menuAnchor === anchor) { hideMenu(true); return; }
      hideMenu(false);
      if (busy || sessions.busy) return;
      menuAnchor = anchor; anchor.setAttribute('aria-expanded', 'true'); anchor.parentNode.classList.add('menu-open');
      menu = document.createElement('div'); menu.className = 'file-menu workspace-action-menu';
      menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', anchor.title);
      const action = button(className, label, label, false, function () {
        if (!menu || !menu.contains(action)) return;
        hideMenu(true); void act(operation, sessionOperation);
      });
      action.setAttribute('role', 'menuitem'); menu.appendChild(action);
      document.body.appendChild(menu);
      const bounds = anchor.getBoundingClientRect();
      const navigation = document.getElementById('workspace-navigation').getBoundingClientRect();
      menu.style.maxWidth = Math.max(80, navigation.width - 8) + 'px';
      const size = menu.getBoundingClientRect();
      menu.style.left = Math.max(navigation.left + 4, Math.min(bounds.right - size.width, navigation.right - size.width - 4)) + 'px';
      menu.style.top = Math.max(4, Math.min(bounds.bottom + 3, window.innerHeight - size.height - 4)) + 'px';
      action.focus();
      menu.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { event.preventDefault(); hideMenu(true); }
        else if (event.key === 'Tab') hideMenu(true);
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); action.focus(); }
      });
    }
    function moreButton(className, label, blocked, actionClass, actionLabel, operation, sessionOperation, focusKey) {
      const more = button(className, '', label, blocked, function () {
        showMenu(more, actionClass, actionLabel, operation, sessionOperation);
      }, focusKey);
      more.appendChild(glyph('more')); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
      more.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowDown') { event.preventDefault(); showMenu(more, actionClass, actionLabel, operation, sessionOperation); }
      });
      return more;
    }
    function render() {
      const menuFocus = menu && menu.contains(document.activeElement) ? menuAnchor.getAttribute('data-workspace-focus') : null;
      hideMenu(false);
      const focused = document.activeElement && list.contains(document.activeElement) ? document.activeElement.getAttribute('data-workspace-focus') : null;
      list.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase();
      const blocked = busy || sessions.busy;
      const currentBinding = sessions.current && sessions.sessions.find(function (session) {
        return session.platform === sessions.current.platform && session.accountId === sessions.current.accountId && session.conversationId === sessions.current.conversationId;
      });
      document.getElementById('workspace-add').disabled = blocked;
      roots.forEach(function (path, index) {
        const projectMatches = !query || key(path).includes(query);
        const bound = sessions.sessions.filter(function (session) {
          return key(session.root) === key(path) && (projectMatches || key(session.title + ' ' + groupName(session)).includes(query));
        });
        if (!projectMatches && !bound.length) return;
        const names = parts(path);
        const name = names[names.length - 1] || path;
        const item = document.createElement('li'); item.className = 'workspace-item';
        const row = document.createElement('div'); row.className = 'workspace-row';
        const active = current && key(path) === key(current);
        const expanded = bound.length > 0 && (Boolean(query) || !collapsed.has(key(path)));
        row.classList.toggle('active', Boolean(active));
        const toggle = bound.length ? button('workspace-expand', '', (expanded ? '折叠项目 ' : '展开项目 ') + name, false, function () {
          if (collapsed.has(key(path))) collapsed.delete(key(path)); else collapsed.add(key(path));
          render();
        }, 'workspace-expand:' + path) : document.createElement('span');
        if (bound.length) { toggle.appendChild(glyph('chevron')); toggle.setAttribute('aria-expanded', String(expanded)); }
        else { toggle.className = 'workspace-expand-placeholder'; toggle.setAttribute('aria-hidden', 'true'); }
        const open = button('workspace-project', '', '切换本地项目：' + path, blocked, function () { void act(function () { return bridge.openWorkspace(index); }, false); });
        if (active) open.setAttribute('aria-current', 'true');
        const icon = document.createElement('span'); window.fileIcons.render(icon, name, true, expanded);
        const label = document.createElement('span'); label.className = 'workspace-name'; label.textContent = name;
        if (roots.filter(function (candidate) { return parts(candidate).pop() === name; }).length > 1) {
          const parent = document.createElement('small'); parent.textContent = names.slice(0, -1).join(' / '); label.appendChild(parent);
        }
        open.append(icon, label);
        const bindLabel = '绑定当前网页会话到项目 ' + name;
        const bind = button('workspace-bind', '', bindLabel, blocked || !sessions.canBind, function () {
          if (!sessions.canBind) return;
          void act(function () { return bridge.bindWorkspaceSession(index); }, true);
        }, 'workspace-bind:' + path);
        bind.appendChild(glyph('link'));
        if (bind.disabled) bind.title = bindLabel + ' · ' + bindingHint();
        const bindControl = document.createElement('span'); bindControl.className = 'workspace-bind-control'; bindControl.title = bind.title;
        bindControl.appendChild(bind);
        const more = moreButton('workspace-project-more', '项目操作：' + name, blocked, 'workspace-remove', '从工作区移除（保留本地文件）', function () { return bridge.removeWorkspace(index); }, false, 'workspace-project-more:' + path);
        row.append(toggle, open, bindControl, more); item.appendChild(row);
        const body = document.createElement('div'); body.className = 'workspace-project-sessions'; body.hidden = !expanded;
        if (bound.length && active && sessions.current && !sessions.selectedId) {
          const text = !currentBinding ? '当前网页会话未绑定' : key(currentBinding.root) !== key(path) ? '当前网页会话属于其他项目' : '';
          if (text) {
            const hint = document.createElement('p'); hint.className = 'workspace-session-hint'; hint.textContent = text; body.appendChild(hint);
          }
        }
        const groups = new Map();
        bound.forEach(function (session) {
          const id = session.platform + ':' + session.accountId;
          if (!groups.has(id)) groups.set(id, []);
          groups.get(id).push(session);
        });
        groups.forEach(function (entries) {
          const group = document.createElement('section'); group.className = 'workspace-session-group';
          const heading = document.createElement('div'); heading.className = 'workspace-session-heading'; heading.textContent = groupName(entries[0]); heading.title = heading.textContent;
          group.setAttribute('aria-label', heading.textContent); group.appendChild(heading);
          const children = document.createElement('ul'); children.className = 'workspace-sessions';
          entries.forEach(function (session) {
            const child = document.createElement('li'); child.className = 'workspace-session-row';
            const selected = sessions.selectedId === session.id;
            child.classList.toggle('selected', selected);
            const select = button('workspace-session', '', '打开会话：' + session.title, blocked, function () {
              void act(function () { return bridge.openWorkspaceSession(session.id); }, true);
            }, 'workspace-session:' + session.id);
            const title = document.createElement('span'); title.className = 'workspace-session-label'; title.textContent = displayTitle(session);
            select.append(glyph('chat'), title);
            if (selected) select.setAttribute('aria-current', 'true');
            const more = moreButton('workspace-session-more', '会话操作：' + session.title, blocked, 'workspace-unbind', '解除绑定（保留官网会话）', function () { return bridge.unbindWorkspaceSession(session.id); }, true, 'workspace-session-more:' + session.id);
            child.append(select, more); children.appendChild(child);
          });
          group.appendChild(children); body.appendChild(group);
        });
        if (bound.length) item.appendChild(body);
        list.appendChild(item);
      });
      message.textContent = errorMessage || sessionError || (!roots.length ? '添加本地目录，开始工作。' : !list.children.length ? '没有匹配的项目或会话。' : '');
      restoreFocus(focused || menuFocus);
    }
    function update(info) {
      if (info.workspaceRoots) roots = info.workspaceRoots;
      current = info.root;
      render();
    }
    function updateSessions(state) {
      if (state.revision < sessions.revision) return;
      if (state.selectedId && state.selectedId !== sessions.selectedId) {
        const selected = state.sessions.find(function (session) { return session.id === state.selectedId; });
        if (selected) collapsed.delete(key(selected.root));
      }
      sessions = state;
      sessionError = state.error || '';
      render();
    }
    async function refreshRoot() {
      const generation = rootGeneration;
      const info = await bridge.getRoot();
      if (generation === rootGeneration) update(info);
    }
    async function act(operation, sessionOperation) {
      if (busy || sessions.busy) return;
      const focused = document.activeElement && list.contains(document.activeElement) ? document.activeElement.getAttribute('data-workspace-focus') : null;
      busy = true; errorMessage = ''; sessionError = ''; render();
      try {
        const result = await operation();
        if (sessionOperation) updateSessions(result);
        else if (result.error) errorMessage = result.error;
        await refreshRoot();
      } catch (error) {
        if (sessionOperation) sessionError = '会话操作失败：' + error.message;
        else errorMessage = '项目操作失败：' + error.message;
      }
      finally {
        busy = false; render();
        if (!document.activeElement || document.activeElement === document.body) restoreFocus(focused);
      }
    }
    search.addEventListener('input', render);
    document.addEventListener('pointerdown', function (event) { if (menu && !menu.contains(event.target) && !menuAnchor.contains(event.target)) hideMenu(false); });
    list.addEventListener('scroll', function () { hideMenu(false); }, { passive: true });
    window.addEventListener('resize', function () { hideMenu(false); });
    window.addEventListener('blur', function () { hideMenu(false); });
    document.getElementById('workspace-add').addEventListener('click', function () { void act(function () { return bridge.chooseRoot(); }, false); });
    bridge.onRootChanged(function (info) { rootGeneration += 1; update(info); });
    bridge.onWorkspaceSessionsState(updateSessions);
    const initialRootGeneration = rootGeneration;
    void refreshRoot().catch(function (error) { if (rootGeneration === initialRootGeneration) { errorMessage = '读取工作区失败：' + error.message; render(); } });
    void bridge.getWorkspaceSessions().then(updateSessions).catch(function (error) { if (sessions.revision < 0) { sessionError = '读取会话失败：' + error.message; render(); } });
    return { update: update };
  };
})();
