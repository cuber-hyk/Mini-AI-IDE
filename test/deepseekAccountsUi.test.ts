import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { it } from 'node:test';

const first = { platform: 'deepseek', switching: false, deepseekAccounts: { activeId: 'default', accounts: [{ id: 'default', name: '默认账号' }, { id: 'work', name: '工作账号' }] } };
const second = { ...first, deepseekAccounts: { ...first.deepseekAccounts, activeId: 'work' } };
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(yes => { resolve = yes; }); return { resolve, promise }; }
function setup(overrides: any = {}) {
  let active: any;
  function element() {
    const listeners: Record<string, ((event: any) => any)[]> = {}; const classes = new Set<string>();
    return { disabled: false, hidden: false, value: '', textContent: '', title: '', tabIndex: -1, children: [] as any[], attrs: {} as Record<string, string>,
      classList: { toggle(name: string, on: boolean) { if (on) classes.add(name); else classes.delete(name); }, add(name: string) { classes.add(name); } },
      setAttribute(name: string, value: string) { this.attrs[name] = value; }, focus() { active = this; },
      appendChild(child: any) { this.children.push(child); }, replaceChildren() { this.children = []; },
      addEventListener(name: string, fn: (event: any) => any) { (listeners[name] ||= []).push(fn); },
      fire(name: string, event: any = {}) { return Promise.all((listeners[name] || []).map(fn => fn({ preventDefault() {}, ...event }))); } };
  }
  const html = fs.readFileSync('src/renderer/webbar.html', 'utf8');
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], element()]));
  let publish!: (state: any) => void;
  const selects: string[] = []; const adds: string[] = []; const platforms: string[] = [];
  const bridge = { getWebPlatform: async () => first, onWebPlatformState(fn: any) { publish = fn; },
    setDeepSeekAccount: async (id: string) => { selects.push(id); return { ...first, deepseekAccounts: { ...first.deepseekAccounts, activeId: id } }; },
    addDeepSeekAccount: async (name: string) => { adds.push(name); return { ...first, deepseekAccounts: { activeId: 'new', accounts: [...first.deepseekAccounts.accounts, { id: 'new', name }] } }; },
    setWebPlatform: async (id: string) => { platforms.push(id); return { ...first, platform: id }; },
    onToolWorkspaceStatus() {}, getToolWorkspaceStatus: async () => ({ phase: 'idle', message: '工具空闲', count: 0, automatic: false }),
    onChromeState() {}, toggleWorkspace() {}, restoreFileWorkspace() {}, openToolWorkspace() {}, collectReply: async () => ({ ok: true }), ...overrides };
  const window: any = { webbarBridge: bridge, setTimeout() { return 1; }, clearTimeout() {} };
  const context = vm.createContext({ console: { error() {} }, window, document: { getElementById: (id: string) => nodes[id], createElement: element } });
  vm.runInContext(fs.readFileSync('src/renderer/deepseekAccounts.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/renderer/webbar.js', 'utf8'), context);
  return { nodes, selects, adds, platforms, publish: (state: any) => publish(state), focused: () => active };
}

it('仅 DeepSeek 展示账号，安全显示备注并通过受限入口选择已登录会话', async () => {
  const ui = setup(); await flush();
  assert.equal(ui.nodes['deepseek-accounts'].hidden, false);
  assert.equal(ui.nodes['deepseek-account'].value, 'default');
  ui.nodes['deepseek-account'].value = 'work'; await ui.nodes['deepseek-account'].fire('change');
  assert.deepEqual(ui.selects, ['work']); assert.equal(ui.nodes['deepseek-account'].value, 'work');
  const name = '<img src=x onerror=alert(1)>';
  ui.publish({ ...first, deepseekAccounts: { activeId: 'default', accounts: [{ id: 'default', name }] } });
  assert.equal(ui.nodes['deepseek-account'].children[0].textContent, name);
  ui.publish({ ...first, platform: 'chatgpt' }); assert.equal(ui.nodes['deepseek-accounts'].hidden, true);
  ui.publish({ platform: 'deepseek', switching: false }); assert.equal(ui.nodes['deepseek-accounts'].hidden, true);
});

it('添加备注支持确认取消、限制空白与长度，中文组字确认不会误建账号', async () => {
  const ui = setup(); await flush();
  await ui.nodes['btn-add-deepseek-account'].fire('click');
  const name = ui.nodes['deepseek-account-name'];
  assert.equal(ui.focused(), name); assert.equal(ui.nodes['btn-confirm-deepseek-account'].disabled, true);
  name.value = ' '.repeat(3); await name.fire('input'); assert.equal(ui.nodes['btn-confirm-deepseek-account'].disabled, true);
  name.value = 'x'.repeat(33); await name.fire('input'); assert.equal(ui.nodes['btn-confirm-deepseek-account'].disabled, true);
  name.value = ' 工作号 '; await name.fire('compositionstart'); await name.fire('input');
  await name.fire('keydown', { key: 'Enter', isComposing: true }); assert.deepEqual(ui.adds, []);
  await name.fire('compositionend'); await name.fire('keydown', { key: 'Enter', keyCode: 229 }); assert.deepEqual(ui.adds, []);
  await name.fire('keydown', { key: 'Enter' }); await flush();
  assert.deepEqual(ui.adds, ['工作号']); assert.equal(ui.nodes['deepseek-account-form'].hidden, true);
  assert.equal(ui.nodes['deepseek-account'].value, 'new');
  await ui.nodes['btn-add-deepseek-account'].fire('click'); name.value = '不保存';
  await name.fire('keydown', { key: 'Escape' }); assert.equal(ui.nodes['deepseek-account-form'].hidden, true);
  assert.equal(ui.focused(), ui.nodes['btn-add-deepseek-account']); assert.deepEqual(ui.adds, ['工作号']);
  await ui.nodes['btn-add-deepseek-account'].fire('click'); await ui.nodes['btn-cancel-deepseek-account'].fire('click');
  assert.equal(ui.nodes['deepseek-account-form'].hidden, true);
});

it('工具与发送忙统一禁用账号和平台操作并提供可聚焦原因，切换中拒绝重复请求', async () => {
  const changed = deferred(); let count = 0;
  const ui = setup({ setDeepSeekAccount: () => { count += 1; return changed.promise; } }); await flush();
  const reason = '正在发送，请稍候'; ui.publish({ ...first, switchBlockedReason: reason });
  for (const id of ['deepseek-account', 'btn-add-deepseek-account', 'web-platform']) assert.equal(ui.nodes[id].disabled, true);
  assert.equal(ui.nodes['deepseek-account-control'].title, reason); assert.equal(ui.nodes['deepseek-account-control'].tabIndex, 0);
  ui.nodes['deepseek-account'].value = 'work'; await ui.nodes['deepseek-account'].fire('change'); assert.equal(count, 0);
  ui.publish(first); ui.nodes['deepseek-account'].value = 'work'; const pending = ui.nodes['deepseek-account'].fire('change');
  assert.equal(ui.nodes['web-platform'].disabled, true); assert.equal(ui.nodes['btn-add-deepseek-account'].disabled, true);
  ui.nodes['deepseek-account'].value = 'work'; await ui.nodes['deepseek-account'].fire('change'); assert.equal(count, 1);
  changed.resolve(second); await pending; assert.equal(ui.nodes['deepseek-account'].disabled, false);
});

it('切账号作废旧采集回执，初始查询和迟到 mutation 不覆盖新广播', async () => {
  const initial = deferred(); const changed = deferred(); const collected = deferred();
  const ui = setup({ getWebPlatform: () => initial.promise, setDeepSeekAccount: () => changed.promise, collectReply: () => collected.promise });
  ui.publish(first); initial.resolve({ ...first, platform: 'chatgpt' }); await flush();
  assert.equal(ui.nodes['deepseek-accounts'].hidden, false);
  const collecting = ui.nodes['btn-collect'].fire('click');
  ui.nodes['deepseek-account'].value = 'work'; const switching = ui.nodes['deepseek-account'].fire('change');
  ui.publish(second); changed.resolve(first); await switching;
  collected.resolve({ ok: true, blocks: ['old-account'] }); await collecting;
  assert.equal(ui.nodes['deepseek-account'].value, 'work'); assert.doesNotMatch(ui.nodes['collect-status'].textContent, /已采集 1/);
});

it('账号拒绝保留备注且只显示主进程权威短原因，不暴露 IPC 异常', async () => {
  let state: any = first;
  const ui = setup({ getWebPlatform: async () => state, addDeepSeekAccount: async () => { state = { ...first, switchBlockedReason: '工具正在执行，完成后可切换' }; throw new Error("ui:add-deepseek-account full internal error"); } });
  await flush(); await ui.nodes['btn-add-deepseek-account'].fire('click');
  ui.nodes['deepseek-account-name'].value = '新账号'; await ui.nodes['deepseek-account-name'].fire('input');
  await ui.nodes['btn-confirm-deepseek-account'].fire('click');
  assert.equal(ui.nodes['collect-status'].textContent, state.switchBlockedReason);
  assert.equal(ui.nodes['deepseek-account-name'].value, '新账号'); assert.equal(ui.nodes['deepseek-account-form'].hidden, false);
  assert.equal(ui.nodes['btn-confirm-deepseek-account'].disabled, true);
  assert.doesNotMatch(ui.nodes['collect-status'].textContent, /internal|ui:add/);
});

it('重名与控制字符在输入时给出明确短原因并保留备注，不发送无效 IPC', async () => {
  const ui = setup(); await flush(); await ui.nodes['btn-add-deepseek-account'].fire('click');
  const name = ui.nodes['deepseek-account-name'];
  name.value = ' 默认账号 '; await name.fire('input');
  assert.equal(ui.nodes['collect-status'].textContent, '账号备注已存在，请使用其他名称');
  assert.equal(name.value, ' 默认账号 '); assert.equal(name.attrs['aria-invalid'], 'true');
  await ui.nodes['btn-confirm-deepseek-account'].fire('click'); assert.deepEqual(ui.adds, []);
  name.value = '不合法\u0000备注'; await name.fire('input');
  assert.equal(ui.nodes['collect-status'].textContent, '账号备注不能包含控制字符');
  await name.fire('keydown', { key: 'Enter' }); assert.deepEqual(ui.adds, []);
  name.value = '新账号'; await name.fire('input');
  assert.equal(name.attrs['aria-invalid'], 'false'); assert.equal(ui.nodes['btn-confirm-deepseek-account'].disabled, false);
  assert.equal(ui.nodes['collect-status'].textContent, '');
  await ui.nodes['btn-confirm-deepseek-account'].fire('click');
  assert.deepEqual(ui.adds, ['新账号']); assert.equal(ui.nodes['collect-status'].textContent, '');
});

it('权威账号清单变化立即重新校验正在输入的备注', async () => {
  const ui = setup(); await flush(); await ui.nodes['btn-add-deepseek-account'].fire('click');
  const name = ui.nodes['deepseek-account-name']; name.value = '新备注'; await name.fire('input');
  assert.equal(ui.nodes['btn-confirm-deepseek-account'].disabled, false);
  ui.publish({ ...first, deepseekAccounts: { ...first.deepseekAccounts, accounts: [...first.deepseekAccounts.accounts, { id: 'account-8', name: '新备注' }] } });
  assert.equal(ui.nodes['btn-confirm-deepseek-account'].disabled, true);
  assert.equal(ui.nodes['collect-status'].textContent, '账号备注已存在，请使用其他名称');
  assert.equal(name.value, '新备注');
  ui.publish(first);
  assert.equal(ui.nodes['btn-confirm-deepseek-account'].disabled, false);
  assert.equal(ui.nodes['collect-status'].textContent, '');
});
