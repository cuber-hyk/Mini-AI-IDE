import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { it } from 'node:test';

// 只提供文件树所需的 DOM，验证旧目录节点不能成为新目录的操作入口。
class Element {
  children: Element[] = []; dataset: Record<string, string> = {}; className = ''; hidden = false;
  parentNode: Element | null = null; style: Record<string, string> = {}; value = ''; disabled = false;
  text = ''; tabIndex = -1; onFocus?: (element: Element) => void;
  listeners: Record<string, (...args: any[]) => unknown> = {};
  constructor(readonly tag = 'div') {}
  get tagName() { return this.tag.toUpperCase(); }
  classList = {
    add: (name: string) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), name])].join(' '); },
    remove: (name: string) => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); },
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle() {},
  };
  set textContent(value: string) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.text = value; }
  get textContent() { return this.text; }
  get firstChild() { return this.children[0]; }
  appendChild(child: Element) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child: Element, next: Element | null) {
    if (child === next) return child;
    child.remove(); const index = next ? this.children.indexOf(next) : this.children.length;
    assert.ok(index >= 0); child.parentNode = this; this.children.splice(index, 0, child); return child;
  }
  prepend(child: Element) { child.parentNode = this; this.children.unshift(child); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  contains(element: Element): boolean { return element === this || this.children.some(child => child.contains(element)); }
  closest(selector: string): Element | null {
    if (selector.split(',').some(name => this.className.split(' ').includes(name.trim().slice(1)))) return this;
    return this.parentNode && this.parentNode.closest(selector);
  }
  focus() { this.onFocus?.(this); }
  selectionStart = 0; selectionEnd = 0;
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  getBoundingClientRect() { return { left: 10, top: 20, bottom: 40, width: 180, height: 100 }; }
  setAttribute() {}
  addEventListener(name: string, fn: (...args: any[]) => unknown) { this.listeners[name] = fn; }
  querySelectorAll(selector: string): Element[] {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return all;
    const classes = selector.slice(1).split('.');
    return all.filter(child => classes.every(name => child.className.split(' ').includes(name)));
  }
}

it('切换目录立即移除旧操作入口，延迟子目录结果不能把旧文件重新挂回新树', async () => {
  const document = { createElement: () => new Element(), addEventListener() {}, activeElement: null };
  const context: any = { window: {}, document };
  vm.runInNewContext(fs.readFileSync('src/renderer/fileIcons.js', 'utf8'), context);
  vm.runInNewContext(fs.readFileSync('src/renderer/fileExplorer.js', 'utf8'), context);
  const tree = new Element(); let root = 'A'; let delay = false; let resume: any;
  const entry = (name: string, isDirectory = false) => ({ name, relPath: name, isDirectory });
  const bridge = { listDir: async (parent: string) => {
    if (parent && delay) return new Promise(done => { resume = done; });
    return { ok: true, entries: root === 'B' ? [entry('new.txt')] : parent ? [] : [entry('sub', true), entry('old.txt')] };
  } };
  const explorer = context.window.createFileExplorer({ bridge, tree, getRoot: () => root,
    newFile: new Element(), newFolder: new Element(), refresh: new Element(), setInfo() {} });
  await explorer.refresh(true);
  await tree.querySelectorAll('.tree-row')[0]!.listeners.click!(); // 记住 sub 展开，下一次刷新会等待读取它。
  delay = true; const oldRefresh = explorer.refresh(false);
  await new Promise(done => setImmediate(done));
  root = 'B'; const newRefresh = explorer.refresh(true);
  assert.equal(tree.querySelectorAll('.tree-row').length, 0, '切换后不能点击旧节点去管理新目录同名文件');
  await newRefresh; resume({ ok: true, entries: [entry('late.txt')] }); await oldRefresh;
  assert.deepEqual(tree.querySelectorAll('.tree-row').map(row => row.dataset.relPath), ['new.txt']);
});

function menuFixture() {
  const body = new Element('body');
  const document = { body, activeElement: null as Element | null,
    createElement(tag: string) { const element = new Element(tag); element.onFocus = value => { document.activeElement = value; }; return element; }, addEventListener() {} };
  const context: any = { window: { innerWidth: 1000, innerHeight: 800 }, document };
  vm.runInNewContext(fs.readFileSync('src/renderer/fileIcons.js', 'utf8'), context);
  vm.runInNewContext(fs.readFileSync('src/renderer/fileExplorer.js', 'utf8'), context);
  const sidebar = body.appendChild(document.createElement('aside')); const tree = sidebar.appendChild(document.createElement('ul'));
  let root: string | null = 'A'; const created: unknown[][] = []; const operations: unknown[][] = []; const messages: unknown[][] = []; let reads = 0;
  const bridge = {
    listDir: async (parent: string) => { reads++; return { ok: true, entries: parent === 'sub' ? [{ name: 'file.txt', relPath: 'sub/file.txt', isDirectory: false }] : parent ? [] : [{ name: 'sub', relPath: 'sub', isDirectory: true }] }; },
    createEntry: async (...args: unknown[]) => { created.push(args); return { ok: true }; },
    revealEntry: async (...args: unknown[]) => { operations.push(['reveal', ...args]); return { ok: true }; },
    openEntry: async (...args: unknown[]) => { operations.push(['open', ...args]); return { ok: true }; },
    copyEntryPath: async (...args: unknown[]) => { operations.push(['copy', ...args]); return { ok: true }; },
    startWorkspaceFileDrag: async (...args: unknown[]) => { operations.push(['drag', ...args]); return { ok: true }; },
    trashEntry: async (...args: unknown[]) => { operations.push(['trash', ...args]); return { ok: true }; },
    deleteEntry: async (...args: unknown[]) => { operations.push(['delete', ...args]); return { ok: true }; },
    renameEntry: async (...args: unknown[]) => { operations.push(['rename', ...args]); return { ok: true }; },
  };
  const newFile = new Element(); const newFolder = new Element();
  const explorer = context.window.createFileExplorer({ bridge, tree, getRoot: () => root,
    newFile, newFolder, refresh: new Element(), setInfo(...args: unknown[]) { messages.push(args); }, openFile: async () => true });
  const event = (target: Element, extra = {}) => ({ target, clientX: 100, clientY: 200, preventDefault() {}, stopPropagation() {}, ...extra });
  const menu = () => body.children.find(child => child.className === 'file-menu');
  return { sidebar, tree, explorer, bridge, newFile, newFolder, event, menu, created, operations, messages, setRoot: (value: string | null) => { root = value; }, reads: () => reads, document };
}
const menuItems = (menu: Element) => menu.children.filter(item => item.tagName === 'BUTTON');
const flush = () => new Promise(done => setImmediate(done));

it('F2在目标行名称处编辑，保留图标和顺序；文件夹含点名称全选', async () => {
  const f = changingFixture(); await f.ready();
  const row = f.row('a/one.txt'); const icon = row.children[1]; const label = row.children[2]!;
  const siblings = row.parentNode!.parentNode!.children.slice();
  row.listeners.keydown!(f.event(row, { key: 'F2' }));
  const draft = row.children[3]!; const input = draft.children[0]!;
  assert.equal(draft.className, 'tree-name-entry tree-rename-entry');
  assert.deepEqual(row.parentNode!.parentNode!.children, siblings);
  assert.equal(row.children[1], icon); assert.equal(label.hidden, true); assert.equal(row.draggable, false);
  assert.equal(input.selectionEnd, 3);
  await input.listeners.keydown!(f.event(input, { key: 'Escape' }));
  assert.equal(label.hidden, false); assert.equal(row.draggable, true); assert.equal(f.document.activeElement, row);
  assert.equal(f.operations.length, 0);
  f.directories.set('', [f.entry('folder.v1', true)]); await f.explorer.refresh(true);
  const folder = f.row('folder.v1'); folder.listeners.keydown!(f.event(folder, { key: 'F2' }));
  assert.equal(folder.children[3]!.children[0]!.selectionEnd, 'folder.v1'.length);
});

it('失焦取消和原名称确认不访问磁盘；输入事件不冒泡到文件行', async () => {
  const f = changingFixture(); await f.ready(); const row = f.row('a/one.txt');
  row.listeners.keydown!(f.event(row, { key: 'F2' })); let input = row.children[3]!.children[0]!;
  let stopped = 0;
  await input.listeners.keydown!(f.event(input, { key: 'Enter', stopPropagation() { stopped++; } }));
  assert.equal(stopped, 1); assert.equal(f.operations.length, 0); assert.equal(row.children.length, 3);
  row.listeners.keydown!(f.event(row, { key: 'F2' })); input = row.children[3]!.children[0]!;
  input.value = 'changed.txt'; const outside = f.document.createElement('input'); outside.focus();
  input.listeners.blur!();
  assert.equal(row.children.length, 3); assert.equal(f.document.activeElement, outside); assert.equal(f.operations.length, 0);
});

it('重命名错误留在原位可修改，中文组字不提交，等待期间重复Enter只提交一次', async () => {
  const f = changingFixture(); await f.ready(); const row = f.row('a/one.txt');
  let calls = 0; let finish!: (result: { ok: boolean; error: string }) => void;
  Object.assign(f.bridge, { renameEntry: async () => { calls++; return new Promise(done => { finish = done; }); } });
  row.listeners.keydown!(f.event(row, { key: 'F2' })); const editor = row.children[3]!; const input = editor.children[0]!;
  input.value = 'two.txt';
  await input.listeners.keydown!(f.event(input, { key: 'Enter', isComposing: true })); assert.equal(calls, 0);
  const pending = input.listeners.keydown!(f.event(input, { key: 'Enter' }));
  await input.listeners.keydown!(f.event(input, { key: 'Enter' })); input.listeners.blur!();
  assert.equal(calls, 1); assert.equal(row.children[3], editor);
  finish({ ok: false, error: '目标名称已存在，不能覆盖' }); await pending;
  assert.equal(editor.children[1]!.textContent, '目标名称已存在，不能覆盖');
  assert.equal(f.document.activeElement, input);
  Object.assign(f.bridge, { renameEntry: async (...args: unknown[]) => { f.operations.push(['rename', ...args]); return { ok: true }; } });
  input.value = 'new.md'; await input.listeners.keydown!(f.event(input, { key: 'Enter' }));
  assert.deepEqual(f.operations, [['rename', 'a/one.txt', 'new.md', 'A']]); assert.equal(row.children.length, 3);
});

it('原位重命名在项目重置后恢复旧行标签，迟到输入不写入新项目', async () => {
  const f = changingFixture(); await f.ready(); const row = f.row('a/one.txt');
  row.listeners.keydown!(f.event(row, { key: 'F2' })); const input = row.children[3]!.children[0]!;
  input.value = 'new.txt'; f.setRoot('B'); await f.explorer.refresh(true);
  await input.listeners.keydown!(f.event(input, { key: 'Enter' }));
  assert.equal(f.operations.length, 0); assert.equal(row.children[2]!.hidden, false);
  assert.equal(f.tree.querySelectorAll('.tree-rename-entry').length, 0);
});

it('用户拖拽文本文件交给原生文件入口，文件夹和程序伪造事件不能发起拖拽', async () => {
  const f = menuFixture(); await f.explorer.refresh(true);
  const folder = f.tree.querySelectorAll('.tree-row')[0]!;
  assert.equal(folder.draggable, false);
  await folder.listeners.click!();
  const file = f.tree.querySelectorAll('.tree-row').find(row => row.dataset.relPath === 'sub/file.txt')!;
  assert.equal(file.draggable, true);
  let prevented = false;
  f.tree.listeners.dragstart!(f.event(file, { isTrusted: true, preventDefault() { prevented = true; } }));
  await flush(); assert.equal(prevented, true);
  assert.deepEqual(f.operations, [['drag', 'sub/file.txt', 'A']]);
  f.tree.listeners.dragstart!(f.event(folder, { isTrusted: true }));
  f.tree.listeners.dragstart!(f.event(file, { isTrusted: false }));
  f.setRoot(null); f.tree.listeners.dragstart!(f.event(file, { isTrusted: true }));
  await flush(); assert.equal(f.operations.length, 1);
});

it('树和侧栏空白右键在根目录创建，不继承此前选中的子目录', async () => {
  for (const isDirectory of [false, true]) {
    const fixture = menuFixture(); await fixture.explorer.refresh(true);
    const row = fixture.tree.querySelectorAll('.tree-row')[0]!; await row.listeners.click!();
    fixture.sidebar.listeners.contextmenu!(fixture.event(isDirectory ? fixture.sidebar : fixture.tree));
    const menu = fixture.menu()!;
    assert.deepEqual(menuItems(menu).map(item => item.textContent), ['新建文件', '新建文件夹', '在文件资源管理器中显示', '在默认应用中打开', '复制绝对路径', '复制相对路径', '刷新目录']);
    menu.children[isDirectory ? 1 : 0]!.listeners.click!(); await flush();
    const draft = fixture.tree.children[0]!; assert.equal(draft.className, 'tree-name-entry');
    const input = draft.children[0]!; input.value = isDirectory ? 'folder' : 'file.txt';
    await input.listeners.keydown!(fixture.event(input, { key: 'Enter' }));
    assert.deepEqual(fixture.created, [['', input.value, isDirectory, 'A']]);
  }
});

it('行菜单同时保留回收站和永久删除，冒泡到侧栏不被根目录菜单覆盖', async () => {
  const fixture = menuFixture(); await fixture.explorer.refresh(true);
  const row = fixture.tree.querySelectorAll('.tree-row')[0]!;
  const event = fixture.event(row.children[1]!);
  row.listeners.contextmenu!(event); fixture.sidebar.listeners.contextmenu!(event);
  assert.deepEqual(menuItems(fixture.menu()!).map(item => item.textContent), ['新建文件', '新建文件夹', '在文件资源管理器中显示', '在默认应用中打开', '复制绝对路径', '复制相对路径', '重命名', '移入回收站', '永久删除…']);
});

it('树容器支持键盘根目录菜单、关闭后恢复焦点，未打开目录时不展示菜单', async () => {
  const fixture = menuFixture(); await fixture.explorer.refresh(true);
  assert.equal(fixture.tree.tabIndex, 0);
  for (const key of ['ContextMenu', 'F10']) {
    fixture.tree.listeners.keydown!(fixture.event(fixture.tree, { key, shiftKey: key === 'F10' }));
    assert.equal(menuItems(fixture.menu()!).length, 7);
    fixture.menu()!.listeners.keydown!(fixture.event(fixture.menu()!, { key: 'Escape' }));
    assert.equal(fixture.menu(), undefined); assert.equal(fixture.document.activeElement, fixture.tree);
  }
  fixture.sidebar.listeners.contextmenu!(fixture.event(fixture.tree)); const before = fixture.reads();
  menuItems(fixture.menu()!)[6]!.listeners.click!(); await flush(); assert.ok(fixture.reads() > before);
  fixture.setRoot(null); await fixture.explorer.refresh(true);
  fixture.sidebar.listeners.contextmenu!(fixture.event(fixture.tree));
  fixture.tree.listeners.keydown!(fixture.event(fixture.tree, { key: 'ContextMenu' }));
  assert.equal(fixture.menu(), undefined);
});

it('菜单路径操作绑定右击目标，空白指向根；旧菜单不能操作新目录', async () => {
  const f = menuFixture(); await f.explorer.refresh(true);
  const row = f.tree.querySelectorAll('.tree-row')[0]!;
  const invoke = async (label: string, target: Element) => {
    const event = f.event(target); if (target === row) row.listeners.contextmenu!(event); else f.sidebar.listeners.contextmenu!(event);
    menuItems(f.menu()!).find(item => item.textContent === label)!.listeners.click!(); await flush();
  };
  await invoke('复制绝对路径', row); await invoke('复制相对路径', row); await invoke('在文件资源管理器中显示', f.tree); await invoke('在默认应用中打开', row);
  await invoke('移入回收站', row); await invoke('永久删除…', row);
  assert.deepEqual(f.operations, [['copy', 'sub', false, 'A'], ['copy', 'sub', true, 'A'], ['reveal', '', 'A'], ['open', 'sub', 'A'], ['trash', 'sub', 'A'], ['delete', 'sub', 'A']]);
  f.sidebar.listeners.contextmenu!(f.event(f.tree)); const oldButton = menuItems(f.menu()!).find(item => item.textContent === '复制相对路径')!;
  f.setRoot('B'); oldButton.listeners.click!(); await flush();
  assert.equal(f.operations.length, 6); assert.deepEqual(f.messages.at(-1), ['目录已切换，请重新操作', true]);
});

it('菜单键盘导航跳过分隔线；文件夹开合时图标同步', async () => {
  const f = menuFixture(); await f.explorer.refresh(true); const row = f.tree.querySelectorAll('.tree-row')[0]!;
  assert.equal(row.children[1]!.className, 'tree-icon tree-icon-folder');
  await row.listeners.click!(); assert.equal(row.children[1]!.className, 'tree-icon tree-icon-folder-open');
  row.listeners.contextmenu!(f.event(row)); const menu = f.menu()!;
  menuItems(menu)[1]!.focus(); menu.listeners.keydown!(f.event(menu, { key: 'ArrowDown' }));
  assert.equal(f.document.activeElement!.textContent, '在文件资源管理器中显示');
});

function changingFixture() {
  const f = menuFixture();
  const entry = (relPath: string, isDirectory = false) => ({ relPath, name: relPath.split('/').pop()!, isDirectory });
  const directories = new Map([['', [entry('a', true), entry('b', true)]], ['a', [entry('a/one.txt')]], ['b', [entry('b/two.txt')]]]);
  const calls: string[] = [];
  let reader = async (parent: string) => ({ ok: true, entries: directories.get(parent) || [] });
  f.bridge.listDir = async parent => { calls.push(parent); return reader(parent); };
  const row = (path: string) => f.tree.querySelectorAll('.tree-row').find(value => value.dataset.relPath === path)!;
  const gate = (parent: string) => {
    const read = reader; let release!: () => void;
    reader = async candidate => {
      if (candidate !== parent) return read(candidate);
      reader = read;
      const snapshot = await read(candidate);
      return new Promise(done => { release = () => done(snapshot); });
    };
    return () => release();
  };
  const ready = async () => { await f.explorer.refresh(true); await row('a').listeners.click!(); await row('b').listeners.click!(); calls.length = 0; };
  return { ...f, directories, entry, calls, row, gate, ready };
}

it('单项变化只读父目录并保留未变化节点和焦点；手动刷新仍发现其他分支的变化', async () => {
  const f = changingFixture(); await f.ready();
  const stable = f.row('b/two.txt'); const parent = f.row('a'); stable.focus();
  f.directories.get('a')!.push(f.entry('a/new.txt'));
  await f.explorer.refresh(false, 'a/new.txt');
  assert.deepEqual(f.calls, ['a']); assert.ok(f.row('a/new.txt')); assert.equal(f.row('a'), parent);
  assert.equal(f.row('b/two.txt'), stable); assert.equal(f.document.activeElement, stable);
  f.calls.length = 0; f.directories.get('b')!.push(f.entry('b/external.txt'));
  await f.explorer.refresh(false);
  assert.deepEqual(f.calls, ['', 'a', 'b']); assert.ok(f.row('b/external.txt')); assert.equal(f.row('b/two.txt'), stable);
  await parent.listeners.click!(); // 复用的事件仍能在新一轮完整刷新后操作。
  await parent.listeners.click!(); assert.equal(f.calls.at(-1), 'a');
});

it('不同父目录并发刷新不互相取消，同父目录迟到结果不能覆盖新事实', async () => {
  const f = changingFixture(); await f.ready();
  const release = f.gate('a'); f.directories.set('a', [f.entry('a/old.txt')]);
  const old = f.explorer.refresh(false, 'a/old.txt'); await flush();
  f.directories.set('b', [f.entry('b/parallel.txt')]); await f.explorer.refresh(false, 'b/parallel.txt');
  assert.ok(f.row('b/parallel.txt'));
  f.directories.set('a', [f.entry('a/newest.txt')]); await f.explorer.refresh(false, 'a/newest.txt');
  release(); await old;
  assert.ok(f.row('a/newest.txt')); assert.equal(f.row('a/old.txt'), undefined); assert.ok(f.row('b/parallel.txt'));
});

it('旧完整刷新被子目录新请求取代后不继续派发其他分支读取', async () => {
  const f = changingFixture(); await f.ready(); const release = f.gate('a');
  const full = f.explorer.refresh(false); await flush();
  f.directories.set('a', [f.entry('a/latest.txt')]); await f.explorer.refresh(false, 'a/latest.txt');
  release(); await full;
  assert.deepEqual(f.calls, ['', 'a', 'a']); assert.ok(f.row('a/latest.txt'));
});

it('删除祖先后旧子目录结果不能复活；改名只迁移相关展开路径', async () => {
  const f = changingFixture(); await f.ready();
  const release = f.gate('a'); const old = f.explorer.refresh(false, 'a/one.txt'); await flush();
  f.directories.set('', [f.entry('b', true)]);
  await f.explorer.entryChanged({ kind: 'deleted', oldRelPath: 'a', isDirectory: true });
  release(); await old; assert.equal(f.row('a'), undefined); assert.equal(f.row('a/one.txt'), undefined);
  f.directories.set('', [f.entry('new-b', true)]); f.directories.set('new-b', [f.entry('new-b/two.txt')]);
  f.calls.length = 0;
  await f.explorer.entryChanged({ kind: 'renamed', oldRelPath: 'b', relPath: 'new-b', isDirectory: true });
  assert.deepEqual(f.calls, ['', 'new-b']); assert.ok(f.row('new-b/two.txt')); assert.equal(f.row('b/two.txt'), undefined);
});

it('折叠期间变动只更新可见祖先，重新展开时读取最新内容', async () => {
  const f = changingFixture(); await f.ready(); await f.row('a').listeners.click!();
  f.directories.set('a', [f.entry('a/closed.txt')]); f.calls.length = 0;
  await f.explorer.refresh(false, 'a/closed.txt'); assert.deepEqual(f.calls, ['']);
  await f.row('a').listeners.click!(); assert.ok(f.row('a/closed.txt')); assert.equal(f.row('a/one.txt'), undefined);
});

it('切项目再切回后拒绝旧行和旧菜单动作，不向新项目执行路径操作', async () => {
  const f = changingFixture(); await f.ready(); const old = f.row('a');
  old.listeners.contextmenu!(f.event(old));
  const action = menuItems(f.menu()!).find(item => item.textContent === '复制相对路径')!;
  f.setRoot('B'); await f.explorer.refresh(true); f.setRoot('A'); await f.explorer.refresh(true);
  const count = f.calls.length; await old.listeners.click!(); action.listeners.click!(); await flush();
  assert.equal(f.calls.length, count); assert.deepEqual(f.operations, []);
});

it('后台刷新取消名称输入时不抢回用户已经转到编辑区的焦点', async () => {
  const f = changingFixture(); await f.ready();
  await f.row('a/one.txt').listeners.click!(); f.newFile.listeners.click!(); await flush();
  assert.ok(f.tree.querySelectorAll('.tree-name-entry').length);
  const outside = f.document.createElement('input'); f.document.body.appendChild(outside); outside.focus();
  await f.explorer.refresh(false, 'b/two.txt'); assert.equal(f.document.activeElement, outside);
  assert.equal(f.tree.querySelectorAll('.tree-name-entry').length, 0);
});

it('一个已展开目录读取失败仍刷新其他分支，保留失败目录旧内容并显示原因', async () => {
  const f = changingFixture(); await f.ready(); const stable = f.row('a/one.txt');
  const read = f.bridge.listDir;
  f.bridge.listDir = async parent => parent === 'a' ? { ok: false, entries: [], error: 'permission denied fixture' } : read(parent);
  f.directories.get('b')!.push(f.entry('b/current.txt'));
  await f.explorer.refresh(false);
  assert.equal(f.row('a/one.txt'), stable); assert.ok(f.row('b/current.txt'));
  assert.deepEqual(f.messages.at(-1), ['permission denied fixture', true]);
});
