import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { it } from 'node:test';

const deepseek = { platform: 'deepseek', switching: false };
const chatgpt = { platform: 'chatgpt', switching: false };
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(yes => { resolve = yes; }); return { resolve, promise }; }
function node() {
  const listeners: Record<string, ((event: any) => any)[]> = {}; const classes = new Set<string>();
  return { disabled: false, value: '', hidden: false, title: '', textContent: '', attrs: {} as Record<string, string>, style: {}, clientWidth: 500, scrollHeight: 40,
    classList: { toggle(name: string, on: boolean) { if (on) classes.add(name); else classes.delete(name); }, add(name: string) { classes.add(name); } },
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    addEventListener(name: string, fn: (event: any) => any) { (listeners[name] ||= []).push(fn); },
    fire(name: string) { return Promise.all((listeners[name] || []).map(fn => fn({}))); } };
}
function webbar(overrides: any = {}) {
  const ids = ['web-platform', 'web-platform-control', 'web-platform-hint', 'btn-collect', 'collect-status', 'btn-file-restore', 'btn-workspace-toggle', 'tool-workspace-status', 'btn-tool-workspace'];
  const nodes = Object.fromEntries(ids.map(id => [id, node()])); let listener!: (state: any) => void; let collectCount = 0; const switches: string[] = [];
  const bridge = { getWebPlatform: async () => deepseek, onWebPlatformState(fn: any) { listener = fn; },
    setWebPlatform: async (id: string) => { switches.push(id); return { platform: id, switching: false }; },
    collectReply: async () => { collectCount += 1; return { ok: true, noNewContent: true }; },
    onToolWorkspaceStatus() {}, getToolWorkspaceStatus: async () => ({ phase: 'idle', message: '工具空闲', count: 0, automatic: false }),
    onChromeState() {}, toggleWorkspace: async () => {}, restoreFileWorkspace: async () => {}, openToolWorkspace: async () => {}, ...overrides };
  const timers=new Map<number,{fn:()=>void;delay:number}>();let timerId=0;
  vm.runInNewContext(fs.readFileSync('src/renderer/webbar.js', 'utf8'), { console:{error(){}}, window: { webbarBridge: bridge, setTimeout(fn:()=>void,delay:number) {timers.set(++timerId,{fn,delay});return timerId;}, clearTimeout(id:number) {timers.delete(id);} }, document: { getElementById: (id: string) => nodes[id] } });
  return { nodes, switches, publish: (state: any) => listener(state), collected: () => collectCount,
    expire(delay:number){for(const [id,timer]of [...timers])if(timer.delay===delay){timers.delete(id);timer.fn();}} };
}

it('执行与发送禁用切换但不禁用采集，忙结束和 AI 等待时恢复', async () => {
  const ui=webbar();await flush();
  for(const reason of ['工具正在执行，完成后可切换','后台命令正在运行，结束后可切换','正在发送，请稍候']){
    ui.publish({...deepseek,switchBlockedReason:reason});assert.equal(ui.nodes['web-platform'].disabled,true);
    assert.equal(ui.nodes['web-platform-control'].title,reason);assert.equal(ui.nodes['web-platform-hint'].textContent,reason);
    assert.equal(ui.nodes['btn-collect'].disabled,false);ui.nodes['web-platform'].value='chatgpt';await ui.nodes['web-platform'].fire('change');assert.equal(ui.switches.length,0);
  }
  ui.publish(deepseek);assert.equal(ui.nodes['web-platform'].disabled,false);
});

it('竞态拒绝只显示权威简短原因，三秒清理且不显示 IPC 技术错误', async () => {
  let state:any=deepseek;
  const ui=webbar({getWebPlatform:async()=>state,setWebPlatform:async()=>{state={...deepseek,switchBlockedReason:'正在发送，请稍候'};throw new Error("Error invoking remote method 'ui:set-web-platform': full internal error");}});
  await flush();ui.nodes['web-platform'].value='chatgpt';await ui.nodes['web-platform'].fire('change');
  assert.equal(ui.nodes['web-platform'].value,'deepseek');assert.equal(ui.nodes['web-platform'].disabled,true);
  assert.equal(ui.nodes['collect-status'].textContent,'正在发送，请稍候');ui.expire(3000);assert.equal(ui.nodes['collect-status'].textContent,'');
  assert.equal(ui.nodes['web-platform-control'].title,'正在发送，请稍候');
});

it('切换拒绝后的迟到 busy 查询不能覆盖先到的忙结束广播，选择框必须恢复', async () => {
  const refreshed=deferred();let queries=0;
  const ui=webbar({getWebPlatform:()=>++queries===1?Promise.resolve(deepseek):refreshed.promise,setWebPlatform:async()=>{throw new Error('busy race');}});
  await flush();ui.nodes['web-platform'].value='chatgpt';const pending=ui.nodes['web-platform'].fire('change');await flush();
  ui.publish({...deepseek,switchBlockedReason:'正在发送，请稍候'});ui.publish(deepseek);
  refreshed.resolve({...deepseek,switchBlockedReason:'正在发送，请稍候'});await pending;
  assert.equal(ui.nodes['web-platform'].disabled,false,'当前权威状态已不忙，迟到快照不能锁住界面');
  assert.equal(ui.nodes['web-platform-hint'].textContent,'');
});
it('平台未就绪时关闭采集，DeepSeek 和 ChatGPT 均可采集并保留工具入口', async () => {
  const ui = webbar(); assert.equal(ui.nodes['btn-collect'].disabled, true); await flush();
  assert.equal(ui.nodes['web-platform'].value, 'deepseek'); assert.equal(ui.nodes['btn-collect'].disabled, false);
  ui.publish(chatgpt); assert.equal(ui.nodes['web-platform'].value, 'chatgpt'); assert.equal(ui.nodes['btn-collect'].disabled, false);
  assert.equal(ui.nodes['tool-workspace-status'].textContent, '工具空闲');
  await ui.nodes['btn-collect'].fire('click'); assert.equal(ui.collected(), 1); assert.equal(ui.nodes['btn-tool-workspace'].disabled, false);
  ui.publish(deepseek); assert.equal(ui.nodes['btn-collect'].disabled, false); assert.equal(ui.nodes['collect-status'].textContent, '');
});
it('平台广播先到时迟来的初始查询不能覆盖选择，切换期间阻止重复请求', async () => {
  const initial = deferred(); const change = deferred(); let requested = 0;
  const ui = webbar({ getWebPlatform: () => initial.promise, setWebPlatform: () => { requested += 1; return change.promise; } });
  ui.publish(chatgpt); initial.resolve(deepseek); await flush(); assert.equal(ui.nodes['web-platform'].value, 'chatgpt');
  ui.nodes['web-platform'].value = 'deepseek'; const switching = ui.nodes['web-platform'].fire('change');
  assert.equal(ui.nodes['web-platform'].disabled, true); await ui.nodes['web-platform'].fire('change'); assert.equal(requested, 1);
  ui.publish(deepseek); change.resolve(chatgpt); await switching;
  assert.equal(ui.nodes['web-platform'].value, 'deepseek'); assert.equal(ui.nodes['web-platform'].disabled, false);
});
it('未知切换失败显示固定短提示，期间加载错误保留并在三秒后恢复展示', async () => {
  const ui = webbar({ setWebPlatform: async () => { throw new Error('后台命令仍在运行'); } }); await flush();
  ui.nodes['web-platform'].value = 'chatgpt'; await ui.nodes['web-platform'].fire('change');
  assert.equal(ui.nodes['web-platform'].value, 'deepseek'); assert.equal(ui.nodes['web-platform'].disabled, false);
  assert.equal(ui.nodes['collect-status'].textContent, '暂时无法切换，请稍后重试');
  ui.publish({ ...deepseek, error: '官网加载失败' }); assert.equal(ui.nodes['collect-status'].textContent, '暂时无法切换，请稍后重试');
  ui.expire(3000);assert.equal(ui.nodes['collect-status'].textContent,'官网加载失败');
});

it('轻提示到期不得抹除后续采集反馈，忙原因更新也不作废同平台采集回执', async () => {
  const collected=deferred();const ui=webbar({setWebPlatform:async()=>{throw new Error('technical detail');},collectReply:()=>collected.promise});await flush();
  ui.nodes['web-platform'].value='chatgpt';await ui.nodes['web-platform'].fire('change');
  const pending=ui.nodes['btn-collect'].fire('click');ui.publish({...deepseek,switchBlockedReason:'工具正在执行，完成后可切换'});
  collected.resolve({ok:true,noNewContent:true});await pending;
  ui.expire(3000);assert.equal(ui.nodes['collect-status'].textContent,'最新回复已采集，无新内容');
  ui.publish(deepseek);assert.equal(ui.nodes['collect-status'].textContent,'最新回复已采集，无新内容');
});
it('平台读取失败保持采集不可用，后续权威广播能够恢复选择器', async () => {
  const ui = webbar({ getWebPlatform: async () => { throw new Error('服务断开'); } }); await flush();
  assert.equal(ui.nodes['web-platform'].disabled, true); assert.equal(ui.nodes['btn-collect'].disabled, true);
  assert.match(ui.nodes['collect-status'].textContent, /读取平台状态失败/);
  ui.publish(chatgpt); assert.equal(ui.nodes['web-platform'].disabled, false); assert.equal(ui.nodes['btn-collect'].disabled, false);
  assert.equal(ui.nodes['collect-status'].textContent, '');
});
it('切走后旧采集回执不得覆盖新平台反馈', async () => {
  const collecting = deferred(); const ui = webbar({ collectReply: () => collecting.promise }); await flush();
  const result = ui.nodes['btn-collect'].fire('click'); ui.publish(chatgpt); collecting.resolve({ ok: true, blocks: [1] }); await result;
  assert.equal(ui.nodes['btn-collect'].disabled, false); assert.doesNotMatch(ui.nodes['collect-status'].textContent, /已采集 1/);
});

function composer(overrides: any = {}) {
  const nodes: any = { requirement: node(), 'prompt-custom': node(), 'btn-send-prompt': node(), 'requirement-panel': { ...node(), open: false }, 'prompt-actions': { offsetHeight: 30 } };
  const messages: string[] = []; let busy = false; let listener!: (state: any) => void; let promptListener!: (state: any) => void;
  const bridge = { getWebPlatform: async () => deepseek, onWebPlatformState(fn: any) { listener = fn; }, getPromptStatus: async () => ({ isCustom: false }), onPromptStatus(fn: any) { promptListener = fn; }, ...overrides };
  const window: any = { innerHeight: 900, requestAnimationFrame(fn: any) { fn(); }, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync('src/renderer/promptComposer.js', 'utf8'), { window, document: { getElementById: (id: string) => nodes[id], dispatchEvent() {} }, Event: class {} });
  window.setupPromptComposer(bridge, (message: string) => messages.push(message), { setComposerBusy(value: boolean) { busy = value; } });
  return { nodes, messages, busy: () => busy, publish: (state: any) => listener(state), publishPrompt: (state: any) => promptListener(state) };
}
it('ChatGPT 允许纯文本需求并保留草稿，切换中提示词刷新不能解除门禁', async () => {
  const ui = composer(); ui.nodes.requirement.value = '未发出的本地需求'; await flush(); assert.equal(ui.busy(), false);
  ui.publish(chatgpt); assert.equal(ui.busy(), false); assert.match(ui.nodes.requirement.title, /纯文本/);
  ui.publish({ ...chatgpt, switching: true }); ui.publishPrompt({ isCustom: true }); assert.equal(ui.busy(), true); assert.equal(ui.nodes.requirement.value, '未发出的本地需求');
  ui.publish(deepseek); assert.equal(ui.busy(), false); assert.equal(ui.nodes.requirement.value, '未发出的本地需求');
});
it('需求区初始平台查询失败或迟到都不能许可未知平台代发送', async () => {
  const failed = composer({ getWebPlatform: async () => { throw new Error('不可用'); } }); await flush(); assert.equal(failed.busy(), true); assert.match(failed.messages.at(-1)!, /平台状态失败/);
  const pending = deferred(); const ui = composer({ getWebPlatform: () => pending.promise }); ui.publish({ ...chatgpt, switching: true }); pending.resolve(deepseek); await flush(); assert.equal(ui.busy(), true);
});
