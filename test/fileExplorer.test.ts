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
    toggle() {},
  };
  set textContent(value: string) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.text = value; }
  get textContent() { return this.text; }
  get firstChild() { return this.children[0]; }
  appendChild(child: Element) { child.parentNode = this; this.children.push(child); return child; }
  prepend(child: Element) { child.parentNode = this; this.children.unshift(child); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  contains(element: Element): boolean { return element === this || this.children.some(child => child.contains(element)); }
  closest(selector: string): Element | null {
    if (selector.split(',').some(name => this.className.split(' ').includes(name.trim().slice(1)))) return this;
    return this.parentNode && this.parentNode.closest(selector);
  }
  focus() { this.onFocus?.(this); }
  setSelectionRange() {}
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
    listDir: async (parent: string) => { reads++; return { ok: true, entries: parent ? [] : [{ name: 'sub', relPath: 'sub', isDirectory: true }] }; },
    createEntry: async (...args: unknown[]) => { created.push(args); return { ok: true }; },
    revealEntry: async (...args: unknown[]) => { operations.push(['reveal', ...args]); return { ok: true }; },
    copyEntryPath: async (...args: unknown[]) => { operations.push(['copy', ...args]); return { ok: true }; },
    trashEntry: async (...args: unknown[]) => { operations.push(['trash', ...args]); return { ok: true }; },
    deleteEntry: async (...args: unknown[]) => { operations.push(['delete', ...args]); return { ok: true }; },
  };
  const explorer = context.window.createFileExplorer({ bridge, tree, getRoot: () => root,
    newFile: new Element(), newFolder: new Element(), refresh: new Element(), setInfo(...args: unknown[]) { messages.push(args); }, openFile: async () => true });
  const event = (target: Element, extra = {}) => ({ target, clientX: 100, clientY: 200, preventDefault() {}, ...extra });
  const menu = () => body.children.find(child => child.className === 'file-menu');
  return { sidebar, tree, explorer, event, menu, created, operations, messages, setRoot: (value: string | null) => { root = value; }, reads: () => reads, document };
}
const menuItems = (menu: Element) => menu.children.filter(item => item.tagName === 'BUTTON');
const flush = () => new Promise(done => setImmediate(done));

it('树和侧栏空白右键在根目录创建，不继承此前选中的子目录', async () => {
  for (const isDirectory of [false, true]) {
    const fixture = menuFixture(); await fixture.explorer.refresh(true);
    const row = fixture.tree.querySelectorAll('.tree-row')[0]!; await row.listeners.click!();
    fixture.sidebar.listeners.contextmenu!(fixture.event(isDirectory ? fixture.sidebar : fixture.tree));
    const menu = fixture.menu()!;
    assert.deepEqual(menuItems(menu).map(item => item.textContent), ['新建文件', '新建文件夹', '在文件资源管理器中显示', '复制绝对路径', '复制相对路径', '刷新目录']);
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
  assert.deepEqual(menuItems(fixture.menu()!).map(item => item.textContent), ['新建文件', '新建文件夹', '在文件资源管理器中显示', '复制绝对路径', '复制相对路径', '重命名', '移入回收站', '永久删除…']);
});

it('树容器支持键盘根目录菜单、关闭后恢复焦点，未打开目录时不展示菜单', async () => {
  const fixture = menuFixture(); await fixture.explorer.refresh(true);
  assert.equal(fixture.tree.tabIndex, 0);
  for (const key of ['ContextMenu', 'F10']) {
    fixture.tree.listeners.keydown!(fixture.event(fixture.tree, { key, shiftKey: key === 'F10' }));
    assert.equal(menuItems(fixture.menu()!).length, 6);
    fixture.menu()!.listeners.keydown!(fixture.event(fixture.menu()!, { key: 'Escape' }));
    assert.equal(fixture.menu(), undefined); assert.equal(fixture.document.activeElement, fixture.tree);
  }
  fixture.sidebar.listeners.contextmenu!(fixture.event(fixture.tree)); const before = fixture.reads();
  menuItems(fixture.menu()!)[5]!.listeners.click!(); await flush(); assert.ok(fixture.reads() > before);
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
  await invoke('复制绝对路径', row); await invoke('复制相对路径', row); await invoke('在文件资源管理器中显示', f.tree);
  await invoke('移入回收站', row); await invoke('永久删除…', row);
  assert.deepEqual(f.operations, [['copy', 'sub', false, 'A'], ['copy', 'sub', true, 'A'], ['reveal', '', 'A'], ['trash', 'sub', 'A'], ['delete', 'sub', 'A']]);
  f.sidebar.listeners.contextmenu!(f.event(f.tree)); const oldButton = menuItems(f.menu()!).find(item => item.textContent === '复制相对路径')!;
  f.setRoot('B'); oldButton.listeners.click!(); await flush();
  assert.equal(f.operations.length, 5); assert.deepEqual(f.messages.at(-1), ['目录已切换，请重新操作', true]);
});

it('菜单键盘导航跳过分隔线；文件夹开合时图标同步', async () => {
  const f = menuFixture(); await f.explorer.refresh(true); const row = f.tree.querySelectorAll('.tree-row')[0]!;
  assert.equal(row.children[1]!.className, 'tree-icon tree-icon-folder');
  await row.listeners.click!(); assert.equal(row.children[1]!.className, 'tree-icon tree-icon-folder-open');
  row.listeners.contextmenu!(f.event(row)); const menu = f.menu()!;
  menuItems(menu)[1]!.focus(); menu.listeners.keydown!(f.event(menu, { key: 'ArrowDown' }));
  assert.equal(f.document.activeElement!.textContent, '在文件资源管理器中显示');
});
