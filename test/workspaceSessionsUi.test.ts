import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { it } from 'node:test';

const rootA = 'C:\\work\\Alpha';
const rootB = 'C:\\work\\Beta';
const first = {
  revision: 1, selectedId: 'ds-a', canBind: false, busy: false,
  current: { platform: 'deepseek', accountId: 'default', conversationId: 'a' },
  sessions: [
    { id: 'ds-a', root: rootA, platform: 'deepseek', accountId: 'default', conversationId: 'a', title: '修复保存问题', accountName: '默认账号' },
    { id: 'ds-b', root: rootA, platform: 'deepseek', accountId: 'default', conversationId: 'b', title: '编辑器讨论', accountName: '默认账号' },
    { id: 'gpt-a', root: rootA, platform: 'chatgpt', accountId: 'default', conversationId: 'c', title: '设计会话导航', accountName: '默认账号' },
    { id: 'work-b', root: rootB, platform: 'deepseek', accountId: 'work', conversationId: 'd', title: '排查部署', accountName: '工作账号' },
  ],
};
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function deferred() { let resolve!: (value: any) => void; let reject!: (error: Error) => void; const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
function fixture(overrides: any = {}) {
  let activeElement: any = null;
  const document: any = { get activeElement() { return activeElement; } };
  function eventsFor(target: any) {
    const events = new Map<string, ((event: any) => unknown)[]>();
    target.addEventListener = (name: string, listener: any) => events.set(name, [...events.get(name) ?? [], listener]);
    target.removeEventListener = (name: string, listener: any) => events.set(name, (events.get(name) ?? []).filter(item => item !== listener));
    target.fire = async (name: string, values: any = {}) => {
      const event = { target, preventDefault() {}, stopPropagation() {}, ...values };
      for (const listener of events.get(name) ?? []) await listener(event);
      await flush();
    };
    return target;
  }
  function element(tag = 'div'): any {
    const classes = new Set<string>();
    let ownText = '';
    return eventsFor({
      tag, className: '', children: [] as any[], attrs: {} as Record<string, string>,
      disabled: false, hidden: false, value: '', title: '', type: '', style: {} as Record<string, string>, parentNode: null as any,
      get textContent(): string { return ownText + this.children.map((child: any) => child.textContent).join(''); },
      set textContent(value: string) { ownText = value; this.children = []; },
      set innerHTML(_value: string) { throw new Error('会话与账号必须按纯文本渲染'); },
      classList: { add(name: string) { classes.add(name); }, remove(name: string) { classes.delete(name); }, toggle(name: string, enabled: boolean) { if (enabled) classes.add(name); else classes.delete(name); }, contains(name: string) { return classes.has(name); } },
      setAttribute(name: string, value: string) { this.attrs[name] = value; },
      getAttribute(name: string) { return this.attrs[name] ?? null; },
      append(...nodes: any[]) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } },
      appendChild(node: any) { this.append(node); return node; },
      prepend(...nodes: any[]) { for (const node of nodes) node.parentNode = this; this.children.unshift(...nodes); },
      remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter((child: any) => child !== this); this.parentNode = null; } if (activeElement && this.contains(activeElement)) activeElement = null; },
      replaceChildren(...nodes: any[]) { if (activeElement && this.contains(activeElement)) activeElement = null; for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); },
      contains(node: any): boolean { return this === node || this.children.some((child: any) => child.contains(node)); },
      querySelectorAll(selector: string): any[] { return this.children.flatMap((child: any) => [...(child.tag === selector ? [child] : []), ...child.querySelectorAll(selector)]); },
      focus() { activeElement = this; },
      getBoundingClientRect() { return { left: 16, right: 180, top: 24, bottom: 54, width: 164, height: 30 }; },
      offsetWidth: 190, offsetHeight: 36,
    });
  }
  const nodes: Record<string, any> = Object.fromEntries(['workspace-navigation', 'workspace-list', 'workspace-search', 'workspace-message', 'workspace-add'].map(id => [id, element()]));
  let publishRoot!: (state: any) => void;
  let publishSessions!: (state: any) => void;
  const calls = { projects: [] as number[], bindings: [] as number[], opens: [] as string[], unbinds: [] as string[], add: 0, removes: [] as number[] };
  let root = { root: rootA, workspaceRoots: [rootA, rootB] };
  let state: any = first;
  const bridge = {
    getRoot: async () => root,
    onRootChanged(fn: any) { publishRoot = fn; },
    getWorkspaceSessions: async () => state,
    onWorkspaceSessionsState(fn: any) { publishSessions = fn; },
    async openWorkspace(index: number) { calls.projects.push(index); root = { ...root, root: root.workspaceRoots[index]! }; publishRoot(root); return {}; },
    async chooseRoot() { calls.add++; return {}; },
    async removeWorkspace(index: number) { calls.removes.push(index); return {}; },
    async bindWorkspaceSession(index: number) { calls.bindings.push(index); return state; },
    async openWorkspaceSession(id: string) { calls.opens.push(id); return state; },
    async unbindWorkspaceSession(id: string) { calls.unbinds.push(id); state = { ...state, revision: state.revision + 1, selectedId: null, canBind: true, sessions: state.sessions.filter((session: any) => session.id !== id) }; return state; },
    ...overrides,
  };
  document.createElement = element;
  document.createElementNS = (_namespace: string, tag: string) => element(tag);
  document.getElementById = (id: string) => nodes[id];
  document.body = element('body'); document.body.append(...Object.values(nodes));
  document.documentElement = { clientWidth: 1000, clientHeight: 800 };
  eventsFor(document);
  const window: any = eventsFor({ fileIcons: { render() {} }, innerWidth: 1000, innerHeight: 800 });
  vm.runInNewContext(fs.readFileSync('src/renderer/workspaceNavigation.js', 'utf8'), { window, document });
  window.setupWorkspaceNavigation(bridge);
  function find(className: string, parent = nodes['workspace-list']): any[] {
    return parent.children.flatMap((child: any) => [...(child.className.split(' ').includes(className) ? [child] : []), ...find(className, child)]);
  }
  return {
    nodes, calls, find, document, window, focused: () => activeElement,
    publishRoot(value: any) { root = value; publishRoot(value); },
    publish(value: any) { state = value; publishSessions(value); },
    async search(value: string) { nodes['workspace-search'].value = value; await nodes['workspace-search'].fire('input'); },
  };
}

it('只展示显式绑定记录，按项目和平台·账号分组，不会因初始化、导航或搜索自动绑定', async () => {
  const ui = fixture(); await flush();
  assert.deepEqual(ui.find('workspace-session-heading').map(node => node.textContent), ['DeepSeek · 默认账号', 'ChatGPT · 默认账号', 'DeepSeek · 工作账号']);
  assert.equal(ui.find('workspace-session-group', ui.nodes['workspace-list'].children[0]).length, 2);
  assert.equal(ui.find('workspace-session').length, 4);
  ui.publish({ ...first, revision: 2, selectedId: null, canBind: true });
  ui.publishRoot({ root: rootB, workspaceRoots: [rootA, rootB] });
  await ui.search('部署'); await ui.search('');
  assert.deepEqual(ui.calls.bindings, []);
  assert.deepEqual(ui.calls.opens, []);
  ui.publish({ ...first, revision: 3, sessions: [], selectedId: null });
  assert.equal(ui.find('workspace-session-group').length, 0, '空平台账号不展示占位分组');
  assert.deepEqual(ui.calls.bindings, []);
});

it('项目折叠、切本地项目、绑定和打开会话各走独立具名入口，选中只认主进程', async () => {
  const ui = fixture(); await flush();
  const toggle = ui.find('workspace-expand')[0]; toggle.focus(); await toggle.fire('click');
  assert.equal(ui.find('workspace-project-sessions')[0].hidden, true);
  assert.equal(ui.focused(), ui.find('workspace-expand')[0], '折叠重绘仍可连续使用键盘按钮');
  assert.deepEqual(ui.calls.projects, []); assert.deepEqual(ui.calls.opens, []);
  await ui.find('workspace-expand')[0].fire('click');
  const projectButton = ui.find('workspace-project')[1]; projectButton.focus(); await projectButton.fire('click');
  assert.deepEqual(ui.calls.projects, [1]); assert.deepEqual(ui.calls.opens, []);
  assert.equal(ui.find('workspace-project')[1].attrs['aria-current'], 'true');
  assert.equal(ui.focused(), ui.find('workspace-project')[1], '异步切换结束后恢复按钮焦点');
  ui.publish({ ...first, revision: 2, selectedId: null, canBind: true });
  await ui.find('workspace-bind')[1].fire('click');
  assert.deepEqual(ui.calls.bindings, [1]); assert.deepEqual(ui.calls.opens, []);
  await ui.find('workspace-session')[2].fire('click');
  assert.deepEqual(ui.calls.opens, ['gpt-a']); assert.deepEqual(ui.calls.projects, [1]);
  assert.equal(ui.find('workspace-session-row').some(node => node.classList.contains('selected')), false, '请求成功前后不猜测选中');
  ui.publish({ ...first, revision: 3, selectedId: 'gpt-a' });
  assert.equal(ui.find('workspace-session')[2].attrs['aria-current'], 'true');
  for (const button of ui.nodes['workspace-list'].querySelectorAll('button')) {
    assert.equal(button.type, 'button'); assert.ok(button.attrs['aria-label']);
  }
});

it('官网选中已绑定会话会展开其项目；切到未绑定会话只清选中，不创建记录', async () => {
  const ui = fixture(); await flush();
  await ui.find('workspace-expand')[1].fire('click');
  assert.equal(ui.find('workspace-project-sessions')[1].hidden, true);
  ui.publish({ ...first, revision: 2, selectedId: 'work-b' });
  assert.equal(ui.find('workspace-project-sessions')[1].hidden, false);
  assert.equal(ui.find('workspace-session')[3].attrs['aria-current'], 'true');
  ui.publish({ ...first, revision: 3, selectedId: null, canBind: true, current: { ...first.current, conversationId: 'unbound' } });
  assert.equal(ui.find('workspace-session-row').some(node => node.classList.contains('selected')), false);
  assert.equal(ui.find('workspace-session-hint')[0].textContent, '当前网页会话未绑定');
  assert.equal(ui.find('workspace-session').length, 4);
  assert.deepEqual(ui.calls.bindings, []);
});

it('搜索匹配项目、会话标题和平台账号，匹配隐藏会话时可直接看到结果', async () => {
  const ui = fixture(); await flush();
  await ui.find('workspace-expand')[0].fire('click');
  await ui.search('设计会话');
  assert.equal(ui.nodes['workspace-list'].children.length, 1);
  assert.deepEqual(ui.find('workspace-session').map(node => node.textContent), ['设计会话导航']);
  assert.equal(ui.find('workspace-project-sessions')[0].hidden, false);
  await ui.search('chatgpt'); assert.equal(ui.find('workspace-session').length, 1);
  await ui.search('工作账号'); assert.equal(ui.find('workspace-session')[0].textContent, '排查部署');
  await ui.search('ALPHA'); assert.equal(ui.find('workspace-session').length, 3);
  await ui.search('不存在'); assert.equal(ui.nodes['workspace-message'].textContent, '没有匹配的项目或会话。');
  await ui.search(''); assert.equal(ui.nodes['workspace-message'].textContent, '');
  assert.equal(ui.find('workspace-project-sessions')[0].hidden, true, '退出搜索恢复用户折叠状态');
});

it('解除绑定只发送绑定 ID，移除本地条目；原添加和移除项目入口保留', async () => {
  const ui = fixture(); await flush();
  assert.equal(ui.find('workspace-unbind', ui.document.body).length, 0, '解除绑定动作不常驻会话行');
  await ui.find('workspace-session-more')[0].fire('click');
  await ui.find('workspace-unbind', ui.document.body)[0].fire('click');
  assert.deepEqual(ui.calls.unbinds, ['ds-a']);
  assert.equal(ui.find('workspace-session').length, 3);
  assert.deepEqual(ui.calls.opens, []); assert.deepEqual(ui.calls.projects, []);
  await ui.nodes['workspace-add'].fire('click');
  await ui.find('workspace-project-more')[1].fire('click');
  await ui.find('workspace-remove', ui.document.body)[0].fire('click');
  assert.equal(ui.calls.add, 1); assert.deepEqual(ui.calls.removes, [1]);
});

it('全程禁用不可绑定和忙时操作，等待中去重，所有选中仍由确认状态决定', async () => {
  const pending = deferred(); let count = 0;
  const ui = fixture({ openWorkspaceSession() { count++; return pending.promise; } }); await flush();
  assert.equal(ui.find('workspace-bind')[0].disabled, true);
  await ui.find('workspace-bind')[0].fire('click'); assert.deepEqual(ui.calls.bindings, []);
  ui.publish({ ...first, revision: 2, busy: true, canBind: true });
  assert.equal(ui.nodes['workspace-add'].disabled, true);
  for (const className of ['workspace-project', 'workspace-bind', 'workspace-session', 'workspace-session-more', 'workspace-project-more']) {
    assert.ok(ui.find(className).every(node => node.disabled), className);
  }
  await ui.find('workspace-session')[1].fire('click'); assert.equal(count, 0);
  ui.publish({ ...first, revision: 3 });
  const oldButton = ui.find('workspace-session')[1];
  const action = oldButton.fire('click'); await flush();
  await oldButton.fire('click'); assert.equal(count, 1);
  assert.ok(ui.find('workspace-session').every(node => node.disabled));
  assert.equal(ui.find('workspace-session')[0].attrs['aria-current'], 'true');
  pending.resolve({ ...first, revision: 4, selectedId: 'ds-b' }); await action; await flush();
  assert.equal(ui.find('workspace-session')[1].attrs['aria-current'], 'true');
});

it('初始查询和旧 mutation 回执均不能覆盖更新广播，旧根查询同样不能倒退项目', async () => {
  const initial = deferred(); const root = deferred(); const mutation = deferred();
  const ui = fixture({ getWorkspaceSessions: () => initial.promise, getRoot: () => root.promise, openWorkspaceSession: () => mutation.promise });
  ui.publishRoot({ root: rootB, workspaceRoots: [rootA, rootB] });
  ui.publish({ ...first, revision: 10, selectedId: 'work-b' });
  initial.resolve(first); root.resolve({ root: rootA, workspaceRoots: [rootA] }); await flush();
  assert.equal(ui.find('workspace-session')[3].attrs['aria-current'], 'true');
  assert.equal(ui.find('workspace-project')[1].attrs['aria-current'], 'true');
  const action = ui.find('workspace-session')[0].fire('click');
  ui.publish({ ...first, revision: 12, selectedId: 'gpt-a' });
  mutation.resolve({ ...first, revision: 11, selectedId: 'ds-a', error: '旧错误' }); await action;
  assert.equal(ui.find('workspace-session')[2].attrs['aria-current'], 'true');
  assert.doesNotMatch(ui.nodes['workspace-message'].textContent, /旧错误/);
});

it('标题与账号名称按纯文本展示，失败可见且未绑定提示或搜索不覆盖操作错误', async () => {
  const dangerous = '<img src=x onerror=alert(1)>';
  const ui = fixture({ bindWorkspaceSession: async () => ({ ...first, revision: 3, selectedId: null, canBind: true, current: { ...first.current, conversationId: 'unbound' }, error: '保存失败，保留当前项目' }) });
  await flush();
  ui.publish({ ...first, revision: 2, selectedId: null, canBind: true, sessions: [{ ...first.sessions[0], title: dangerous, accountName: dangerous }] });
  assert.equal(ui.find('workspace-session')[0].textContent, dangerous);
  assert.equal(ui.find('workspace-session-heading')[0].textContent, 'DeepSeek · ' + dangerous);
  await ui.find('workspace-bind')[0].fire('click');
  assert.equal(ui.nodes['workspace-message'].textContent, '保存失败，保留当前项目');
  assert.equal(ui.find('workspace-session-hint')[0].textContent, '当前网页会话未绑定');
  await ui.search('不存在');
  assert.equal(ui.nodes['workspace-message'].textContent, '保存失败，保留当前项目');
});

it('晚到的初始化查询失败不遮盖已就绪广播', async () => {
  const sessions = deferred(); const root = deferred();
  const ui = fixture({ getWorkspaceSessions: () => sessions.promise, getRoot: () => root.promise });
  ui.publishRoot({ root: rootA, workspaceRoots: [rootA, rootB] });
  ui.publish(first);
  sessions.reject(new Error('旧会话读取失败')); root.reject(new Error('旧目录读取失败')); await flush();
  assert.equal(ui.nodes['workspace-message'].textContent, '');
  assert.equal(ui.find('workspace-session').length, 4);
});

it('跨项目已绑定但尚未选中的网页会话明确提示归属，按完整身份而非筛选结果判断', async () => {
  const ui = fixture(); await flush();
  ui.publish({ ...first, revision: 2, selectedId: null, canBind: false });
  assert.equal(ui.find('workspace-session-hint').length, 0, '当前项目已绑定，仅同步中不显示未绑定');
  ui.publish({ ...first, revision: 3, selectedId: null, canBind: false, current: { platform: 'deepseek', accountId: 'work', conversationId: 'd' } });
  await ui.search('Alpha');
  assert.equal(ui.find('workspace-session-hint')[0].textContent, '当前网页会话属于其他项目');
  assert.equal(ui.find('workspace-session').length, 3, '所属项目被搜索隐藏仍正确识别绑定');
  ui.publish({ ...first, revision: 4, selectedId: null, canBind: true, current: { platform: 'deepseek', accountId: 'default', conversationId: 'd' } });
  assert.equal(ui.find('workspace-session-hint')[0].textContent, '当前网页会话未绑定', '不同账号的相同会话 ID 不混淆');
  ui.publish({ ...first, revision: 5, selectedId: null, canBind: true, current: { platform: 'chatgpt', accountId: 'work', conversationId: 'd' } });
  assert.equal(ui.find('workspace-session-hint')[0].textContent, '当前网页会话未绑定', '不同平台的相同会话 ID 不混淆');
  assert.deepEqual(ui.calls.bindings, []);
});

it('新会话状态清除已恢复的主进程错误，迟到状态不清除当前错误，项目操作错误独立保留', async () => {
  const ui = fixture({ removeWorkspace: async () => ({ error: '项目移除失败' }) }); await flush();
  ui.publish({ ...first, revision: 2, error: '会话同步保存失败' });
  assert.equal(ui.nodes['workspace-message'].textContent, '会话同步保存失败');
  ui.publish(first);
  assert.equal(ui.nodes['workspace-message'].textContent, '会话同步保存失败', '拒绝旧状态也不会误清错误');
  ui.publish({ ...first, revision: 3 });
  assert.equal(ui.nodes['workspace-message'].textContent, '', '恢复后无残留会话错误');
  await ui.find('workspace-project-more')[0].fire('click');
  await ui.find('workspace-remove', ui.document.body)[0].fire('click');
  assert.equal(ui.nodes['workspace-message'].textContent, '项目移除失败');
  ui.publish({ ...first, revision: 4, error: '新的会话状态错误' });
  ui.publish({ ...first, revision: 5 });
  assert.equal(ui.nodes['workspace-message'].textContent, '项目移除失败', '正常会话广播不擦掉项目操作错误');
  await ui.search('Alpha');
  assert.equal(ui.nodes['workspace-message'].textContent, '项目移除失败');
});

it('会话读取或操作异常能由后续就绪状态清除', async () => {
  const ui = fixture({ getWorkspaceSessions: async () => { throw new Error('读取失败'); }, openWorkspaceSession: async () => { throw new Error('打开失败'); } });
  await flush();
  assert.equal(ui.nodes['workspace-message'].textContent, '读取会话失败：读取失败');
  ui.publish(first);
  assert.equal(ui.nodes['workspace-message'].textContent, '');
  await ui.find('workspace-session')[0].fire('click');
  assert.equal(ui.nodes['workspace-message'].textContent, '会话操作失败：打开失败');
  ui.publish({ ...first, revision: 2 });
  assert.equal(ui.nodes['workspace-message'].textContent, '');
});

it('空项目只保留项目行与行内绑定，不渲染空展开和空会话区', async () => {
  const ui = fixture(); await flush();
  ui.publish({ ...first, revision: 2, sessions: [], selectedId: null, canBind: true });
  assert.equal(ui.find('workspace-project').length, 2);
  assert.equal(ui.find('workspace-expand').length, 0);
  assert.equal(ui.find('workspace-project-sessions').length, 0);
  assert.equal(ui.find('workspace-session-hint').length, 0);
  for (const row of ui.find('workspace-row')) assert.equal(ui.find('workspace-bind', row).length, 1);
  await ui.find('workspace-bind')[1].fire('click');
  assert.deepEqual(ui.calls.bindings, [1], '空项目仍可显式绑定');
});

it('展示标题仅去掉相同平台的末尾标记，原始标题和身份保持完整', async () => {
  const ui = fixture(); await flush();
  const titles = ['可靠保存 - DeepSeek', '保留异平台 - ChatGPT', '界面设计 | ChatGPT', '不改正文 DeepSeek'];
  ui.publish({ ...first, revision: 2, sessions: first.sessions.map((entry, index) => ({ ...entry, title: titles[index] })) });
  assert.deepEqual(ui.find('workspace-session').map(node => node.textContent), ['可靠保存', '保留异平台 - ChatGPT', '界面设计', '不改正文 DeepSeek']);
  assert.deepEqual(ui.find('workspace-session').map(node => node.title), titles.map(title => '打开会话：' + title));
  assert.deepEqual(ui.find('workspace-session').map(node => node.attrs['aria-label']), titles.map(title => '打开会话：' + title));
  await ui.find('workspace-session-more')[0].fire('click');
  assert.equal(ui.calls.unbinds.length, 0, '展开操作菜单不自动解除绑定');
  const action = ui.find('workspace-unbind', ui.document.body)[0];
  assert.ok(action.parentNode.attrs['aria-label'].includes(titles[0]), '菜单可访问名称保留原始会话标题');
  assert.equal(action.attrs.role, 'menuitem');
  assert.ok(ui.find('file-menu', ui.document.body).length, '复用文件菜单样式');
  assert.equal(ui.find('workspace-unbind').length, 0, '操作菜单独立于项目列表');
});

it('菜单可用键盘并在离开和重绘时关闭，旧菜单不能误操作', async () => {
  const ui = fixture(); await flush();
  let anchor = ui.find('workspace-session-more')[0];
  assert.equal(anchor.attrs['aria-haspopup'], 'menu');
  await anchor.fire('click');
  let action = ui.find('workspace-unbind', ui.document.body)[0];
  const menu = action.parentNode;
  assert.equal(menu.attrs.role, 'menu');
  assert.equal(ui.focused(), action, '菜单首项自动聚焦');
  assert.equal(anchor.attrs['aria-expanded'], 'true');
  await menu.fire('keydown', { key: 'ArrowDown', target: action });
  assert.equal(ui.focused(), action, '单项菜单方向键循环仍停在可用项');
  await menu.fire('keydown', { key: 'Escape', target: action });
  assert.equal(ui.find('workspace-unbind', ui.document.body).length, 0);
  assert.equal(anchor.attrs['aria-expanded'], 'false');
  assert.equal(ui.focused(), anchor, 'Escape 回到原菜单按钮');
  await anchor.fire('click'); action = ui.find('workspace-unbind', ui.document.body)[0];
  await action.parentNode.fire('keydown', { key: 'Tab', target: action });
  assert.equal(ui.find('workspace-unbind', ui.document.body).length, 0);
  assert.equal(ui.focused(), anchor, 'Tab关闭浮层先回到入口，原生焦点顺序从入口继续');
  for (const [owner, event] of [[ui.document, 'pointerdown'], [ui.nodes['workspace-list'], 'scroll'], [ui.window, 'resize'], [ui.window, 'blur']] as const) {
    anchor = ui.find('workspace-session-more')[0]; await anchor.fire('click');
    assert.equal(ui.find('workspace-unbind', ui.document.body).length, 1);
    await owner.fire(event, { target: ui.nodes['workspace-search'] });
    assert.equal(ui.find('workspace-unbind', ui.document.body).length, 0, event + ' 后不保留浮层');
  }
  await ui.find('workspace-session-more')[0].fire('click');
  action = ui.find('workspace-unbind', ui.document.body)[0];
  ui.publish({ ...first, revision: 2, sessions: first.sessions.slice(1) });
  assert.equal(ui.find('workspace-unbind', ui.document.body).length, 0, '刷新关闭过期菜单');
  await action.fire('click');
  assert.deepEqual(ui.calls.unbinds, [], '移除的旧菜单项不能操作旧会话');
});

it('同名会话跨账号或平台重绘后保持原会话焦点，并打开对应绑定 ID', async () => {
  const ui = fixture(); await flush();
  const named = first.sessions.map((entry, index) => ({ ...entry, title: '讨论保存问题', ...(index === 1 ? { accountId: 'work', accountName: '工作账号' } : {}) }));
  ui.publish({ ...first, revision: 2, sessions: named });
  ui.find('workspace-session')[1].focus();
  ui.publish({ ...first, revision: 3, sessions: named });
  assert.equal(ui.focused(), ui.find('workspace-session')[1], '同名的不同账号不会把焦点恢复到第一条会话');
  await ui.focused().fire('click');
  assert.deepEqual(ui.calls.opens, ['ds-b']);
  ui.find('workspace-session')[2].focus();
  ui.publish({ ...first, revision: 4, sessions: named });
  assert.equal(ui.focused(), ui.find('workspace-session')[2], '同名的不同平台不会把焦点恢复到前面的会话');
  await ui.focused().fire('click');
  assert.deepEqual(ui.calls.opens, ['ds-b', 'gpt-a']);
});

it('同名不同路径项目的绑定按钮重绘后保持目标项目，绑定不会跳到首个同名项目', async () => {
  const ui = fixture(); await flush();
  const paths = ['C:\\work\\One\\Shared', 'D:\\work\\Two\\Shared'];
  ui.publishRoot({ root: paths[0], workspaceRoots: paths });
  ui.publish({ ...first, revision: 2, sessions: [], selectedId: null, canBind: true });
  assert.equal(ui.find('workspace-bind')[0].attrs['aria-label'], ui.find('workspace-bind')[1].attrs['aria-label'], '同名项目的展示名称相同');
  ui.find('workspace-bind')[1].focus();
  ui.publish({ ...first, revision: 3, sessions: [], selectedId: null, canBind: true, current: { ...first.current, conversationId: 'another' } });
  assert.equal(ui.focused(), ui.find('workspace-bind')[1], '状态广播后仍保持第二个完整路径项目的按钮');
  await ui.focused().fire('click');
  assert.deepEqual(ui.calls.bindings, [1]);
  assert.equal(ui.focused(), ui.find('workspace-bind')[1], '绑定请求完成后也保持原目标项目');
});
