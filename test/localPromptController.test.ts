import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LocalPromptController } from '../src/main/localPromptController';
import { CHANNELS } from '../src/shared/contract';

function fixture() {
  let root: string | null = null; let session = 'https://chat.deepseek.com/a/chat/one'; let busy = false;
  let saved = { localPrompt: { includeInitialization: true, sendOnEnter: false }, formatSpecVariant: 'short', customFormatSpecShort: null, customFormatSpecFull: null };
  const sent: Array<{text: string; session: string; kind: string}> = []; const copies: string[] = []; const cancellations: unknown[] = [];
  const handlers = new Map<string, Function>(); const editor = { mainFrame: {} };
  const options: any = { ipc: { handle(name: string, fn: Function) { handlers.set(name, fn); } }, editor,
    settings: { get: () => structuredClone(saved), update(patch: object) { saved = { ...saved, ...patch }; } },
    skills: { async list(value: string | null) { return { root: value, skills: [{ name: 'review', description: '审阅', source: 'global' }], errors: [] }; },
      async load(_root: string | null, name: string) { if (name !== 'review') throw new Error('技能不存在'); return { name, description: '审阅', source: 'global', content: '完整技能：保留真实错误', resourceRoot: 'C:/skills/review', instructionPath: 'C:/skills/review/SKILL.md' }; } },
    sender: { async send(text: string, target: string, kind: string) { sent.push({ text, session: target, kind }); return { ok: true }; }, async cancel(kind: string) { cancellations.push(kind); } },
    root: () => root, session: () => session, busy: () => busy, copy(text: string) { copies.push(text); },
  };
  const controller = new LocalPromptController(options); controller.register();
  const input = { requirement: '/review 审阅代码', root: null, skills: ['review'] };
  const event = { sender: editor, senderFrame: editor.mainFrame };
  return { controller, options, input, sent, copies, cancellations, handlers, event,
    setRoot(value: string | null) { root = value; }, setSession(value: string) { session = value; }, setBusy(value: boolean) { busy = value; } };
}

it('初始化由用户勾选，关闭仅需求与显式技能；复制与发送共用内容且不自动复位', async () => {
  const f = fixture();
  assert.equal((await f.controller.copy(f.input)).ok, true);
  assert.match(f.copies[0]!, /唯一执行协议/); assert.match(f.copies[0]!, /可用技能/); assert.match(f.copies[0]!, /完整技能/);
  f.controller.setOptions({ includeInitialization: false, sendOnEnter: true });
  await f.controller.copy(f.input); await f.controller.send(f.input);
  assert.equal(f.sent[0]!.text, f.copies[1]); assert.equal(f.sent[0]!.kind, 'prompt');
  assert.doesNotMatch(f.copies[1]!, /唯一执行协议|目录结构|可用技能/); assert.match(f.copies[1]!, /完整技能/);
  assert.deepEqual(f.controller.getOptions(), { includeInitialization: false, sendOnEnter: true });
});
it('发送开关关闭、工具正忙、未知参数与错误项目均不写网页', async () => {
  const f = fixture(); assert.equal((await f.controller.send(f.input)).ok, false); assert.equal(f.sent.length, 0);
  f.controller.setOptions({ sendOnEnter: true }); f.setBusy(true);
  assert.equal((await f.controller.send(f.input)).ok, false); f.setBusy(false);
  for (const input of [{...f.input, root:'C:/other'}, {...f.input, requirement:''}, {...f.input, extra:1}, {...f.input, skills:['../secret']}, {...f.input, requirement:'已删除引用'}]) {
    assert.equal((await f.controller.send(input)).ok, false); assert.equal(f.sent.length, 0);
  }
  assert.throws(() => f.controller.setOptions({automatic:true}));
});
it('技能加载期间关闭开关或切换项目，迟到需求不能提交；取消只属于prompt', async () => {
  const f = fixture(); f.controller.setOptions({ sendOnEnter: true });
  const load = f.options.skills.load; let resolve!: (value: unknown) => void;
  f.options.skills.load = () => new Promise(done => { resolve = done; });
  const sending = f.controller.send(f.input); f.controller.setOptions({ sendOnEnter: false }); resolve(await load(null,'review'));
  assert.equal((await sending).ok, false); assert.equal(f.sent.length,0); assert.ok(f.cancellations.every(value => value==='prompt'));
  const copying = f.controller.copy(f.input); f.setRoot('C:/new'); f.controller.cancel(); resolve(await load(null,'review'));
  assert.equal((await copying).ok,false); assert.equal(f.copies.length,0);
});
it('并发发送拒绝第二次，发送不确定只返回结果不自动重试', async () => {
  const f = fixture(); f.controller.setOptions({sendOnEnter:true,includeInitialization:false});
  let resolve!: (value: unknown) => void; let count=0;
  f.options.sender.send=() => { count++; return new Promise(done=>{resolve=done;}); };
  const first=f.controller.send({...f.input,skills:[]});
  await Promise.resolve(); await Promise.resolve();
  assert.equal((await f.controller.send(f.input)).ok,false);
  resolve({ok:false,uncertain:true,error:'状态未知'});
  assert.equal((await first).uncertain,true); assert.equal(count,1);
});
it('需求、设置和技能IPC只允许编辑器主frame；其他视图、子frame及多参数均拒绝', () => {
  const f=fixture();
  for(const [channel,fn] of f.handlers) {
    for(const event of [{sender:{mainFrame:{}},senderFrame:{}},{sender:f.event.sender,senderFrame:{}}]) assert.throws(()=>fn(event),/主 frame/);
  }
  assert.throws(()=>f.handlers.get(CHANNELS.getSkillCatalog)!(f.event,'C:/secret'),/数量/);
});
