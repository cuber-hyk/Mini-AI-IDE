/* 常驻项目导航；目录保护与文件系统操作仍由主进程唯一 owner 处理。 */
(function () {
  'use strict';
  window.setupWorkspaceNavigation = function (bridge) {
    const list = document.getElementById('workspace-list');
    const search = document.getElementById('workspace-search');
    const message = document.getElementById('workspace-message');
    let roots = [];
    let current = null;
    let busy = false;
    function parts(path) { return path.split(/[\\/]/).filter(Boolean); }
    function render() {
      list.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase();
      roots.forEach(function (path, index) {
        if (query && !path.toLocaleLowerCase().includes(query)) return;
        const names = parts(path);
        const name = names[names.length - 1] || path;
        const row = document.createElement('li');
        row.className = 'workspace-row';
        const active = current && path.toLocaleLowerCase() === current.toLocaleLowerCase();
        row.classList.toggle('active', Boolean(active));
        const open = document.createElement('button');
        open.type = 'button'; open.className = 'workspace-project'; open.title = path; open.disabled = busy;
        if (active) open.setAttribute('aria-current', 'true');
        const icon = document.createElement('span'); window.fileIcons.render(icon, name, true, Boolean(active));
        const label = document.createElement('span'); label.className = 'workspace-name'; label.textContent = name;
        if (roots.filter(function (candidate) { return parts(candidate).pop() === name; }).length > 1) {
          const parent = document.createElement('small'); parent.textContent = names.slice(0, -1).join(' / '); label.appendChild(parent);
        }
        open.append(icon, label); open.addEventListener('click', function () { void act(function () { return bridge.openWorkspace(index); }); });
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'workspace-remove'; remove.textContent = '×'; remove.title = '从工作区移除（不删除文件）'; remove.setAttribute('aria-label', '从工作区移除 ' + name); remove.disabled = busy;
        remove.addEventListener('click', function () { void act(function () { return bridge.removeWorkspace(index); }); });
        row.append(open, remove); list.appendChild(row);
      });
      if (!roots.length) message.textContent = '添加本地目录，开始工作。';
      else if (!list.children.length) message.textContent = '没有匹配的项目。';
    }
    function update(info) { if (info.workspaceRoots) roots = info.workspaceRoots; current = info.root; render(); }
    async function act(operation) {
      if (busy) return;
      busy = true; message.textContent = ''; render();
      try { const result = await operation(); if (result.error) message.textContent = result.error; update(await bridge.getRoot()); }
      catch (error) { message.textContent = '项目操作失败：' + error.message; }
      finally { busy = false; render(); }
    }
    search.addEventListener('input', function () { message.textContent = ''; render(); });
    document.getElementById('workspace-add').addEventListener('click', function () { void act(function () { return bridge.chooseRoot(); }); });
    bridge.onRootChanged(update);
    void bridge.getRoot().then(update).catch(function (error) { message.textContent = '读取工作区失败：' + error.message; });
    return { update: update };
  };
})();
