import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LocalPromptController } from '../src/main/localPromptController';
import { CHANNELS } from '../src/shared/contract';

function fixture() {
  let root: string | null = null; let session = 'https://chat.deepseek.com/a/chat/one'; let busy = false;
  let saved = { localPrompt: { includeInitialization: true}, formatSpecVariant: 'short', customFormatSpecShort: null, customFormatSpecFull: null };
  const sent: Array<{text: string; session: string; kind: string; attachments?: unknown}> = []; const cancellations: unknown[] = [];
  const handlers = new Map<string, Function>(); const editor = { mainFrame: {} };
  const options: any = { ipc: { handle(name: string, fn: Function) { handlers.set(name, fn); } }, editor,
    settings: { get: () => structuredClone(saved), update(patch: object) { saved = { ...saved, ...patch }; } },
    skills: { async list(value: string | null) { return { root: value, skills: [{ name: 'review', description: '审阅', source: 'global' }], errors: [] }; },
      async load(_root: string | null, name: string) { if (name !== 'review') throw new Error('技能不存在'); return { name, description: '审阅', source: 'global', content: '完整技能：保留真实错误', resourceRoot: 'C:/skills/review', instructionPath: 'C:/skills/review/SKILL.md' }; } },
    sender: { async send(text: string, target: string, kind: string, _current: unknown, attachments: unknown) { sent.push({ text, session: target, kind, attachments }); return { ok: true }; }, async cancel(kind: string) { cancellations.push(kind); } },
    attachments: { async stage() { return []; }, async resolve() { return []; }, remove() { return true; }, clear() {} }, chooseFiles: async () => [],
    resolveWorkspacePath: async (relative: string) => ({ ok: true, absolute: `C:\\project\\${relative}` }),
    root: () => root, session: () => session, busy: () => busy,
  };
  const controller = new LocalPromptController(options); controller.register();
  const input = { requirement: '/review 审阅代码', root: null, skills: ['review'] };
  const event = { sender: editor, senderFrame: editor.mainFrame };
  return { controller, options, input, sent, cancellations, handlers, event,
    setRoot(value: string | null) { root = value; }, setSession(value: string) { session = value; }, setBusy(value: boolean) { busy = value; } };
}

it('初始化由用户勾选，关闭仅需求与显式技能；发送后选择不自动复位', async () => {
  const f = fixture();
  assert.equal((await f.controller.send(f.input)).ok, true);
  assert.match(f.sent[0]!.text, /唯一执行协议/); assert.match(f.sent[0]!.text, /可用技能/); assert.match(f.sent[0]!.text, /完整技能/);
  f.controller.setOptions({ includeInitialization: false});
  await f.controller.send(f.input);
  assert.equal(f.sent[1]!.kind, 'prompt');
  assert.doesNotMatch(f.sent[1]!.text, /唯一执行协议|目录结构|可用技能/); assert.match(f.sent[1]!.text, /完整技能/);
  assert.deepEqual(f.controller.getOptions(), { includeInitialization: false});
});
it('受限模式、工具正忙、未知参数与错误项目均不写网页', async () => {
  const f = fixture(); f.options.disabled = true; assert.equal((await f.controller.send(f.input)).ok, false); assert.equal(f.sent.length, 0);
  f.options.disabled = false; f.setBusy(true);
  assert.equal((await f.controller.send(f.input)).ok, false); f.setBusy(false);
  for (const input of [{...f.input, root:'C:/other'}, {...f.input, requirement:''}, {...f.input, extra:1}, {...f.input, skills:['../secret']}, {...f.input, requirement:'已删除引用'}]) {
    assert.equal((await f.controller.send(input)).ok, false); assert.equal(f.sent.length, 0);
  }
  assert.throws(() => f.controller.setOptions({automatic:true}));
});
it('技能加载期间更改初始化或切换项目，迟到需求不能提交；取消只属于prompt', async () => {
  const f = fixture();
  const load = f.options.skills.load; let resolve!: (value: unknown) => void;
  f.options.skills.load = () => new Promise(done => { resolve = done; });
  const sending = f.controller.send(f.input); f.controller.setOptions({ includeInitialization: false }); resolve(await load(null,'review'));
  assert.equal((await sending).ok, false); assert.equal(f.sent.length,0); assert.ok(f.cancellations.every(value => value==='prompt'));
  const switched = f.controller.send(f.input); f.setRoot('C:/new'); f.controller.cancel(); resolve(await load(null,'review'));
  assert.equal((await switched).ok,false); assert.equal(f.sent.length,0);
});
it('并发发送拒绝第二次，发送不确定只返回结果不自动重试', async () => {
  const f = fixture(); f.controller.setOptions({includeInitialization:false});
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

it('回车提交从本地待发附件 ID 解析数据，并将文件字节流交给网页 sender', async () => {
  const f = fixture(); f.controller.setOptions({includeInitialization: false });
  const staged = { id: 'clipboard-id', name: 'clipboard-image.png', size: 3, mediaType: 'image/png', stream: async function* () { yield new Uint8Array([1, 2, 3]); } };
  f.options.attachments.resolve = async (ids: string[]) => { assert.deepEqual(ids, ['clipboard-id']); return [staged]; };
  const result = await f.controller.send({ ...f.input, requirement: '识别图中代码', skills: [], attachments: ['clipboard-id'] });
  assert.equal(result.ok, true);
  assert.deepEqual(f.sent[0]!.attachments, [staged]);
  assert.equal(typeof (f.sent[0]!.attachments as any[])[0].stream, 'function');
});

it('附件 IPC 只允许编辑器主 frame，选择取消不创建附件', async () => {
  const f = fixture();
  assert.deepEqual(await f.handlers.get(CHANNELS.choosePromptAttachments)!(f.event), []);
  assert.throws(() => f.handlers.get(CHANNELS.stagePromptAttachments)!({ sender: {}, senderFrame: {} }, ['C:/secret.txt']), /主 frame/);
  assert.throws(() => f.handlers.get(CHANNELS.removePromptAttachment)!(f.event, 'id', 'extra'), /数量/);
});

it('工作区树拖入只接纳当前根下的相对路径并在根切换后失效', async () => {
  const f = fixture(); f.setRoot('C:\\project');
  let staged: string[] = [];
  f.options.attachments.stage = async (paths: string[]) => { staged = paths; return []; };
  const stage = f.handlers.get(CHANNELS.stageWorkspacePromptAttachments)!;
  assert.deepEqual(await stage(f.event, ['docs/readme.md'], 'C:\\project'), []);
  assert.deepEqual(staged, ['C:\\project\\docs/readme.md']);
  await assert.rejects(() => stage(f.event, ['docs/readme.md'], 'C:\\other'), /工作区已变化/);
  f.setRoot('C:\\new-project'); f.controller.cancel();
  await assert.rejects(() => stage(f.event, ['docs/readme.md'], 'C:\\project'), /工作区已变化/);
});

it('三个附件入口在暂存等待期间切项目均拒绝迟到结果，仅删除旧批 ID', async () => {
  for (const channel of [CHANNELS.choosePromptAttachments, CHANNELS.stagePromptAttachments, CHANNELS.stageWorkspacePromptAttachments]) {
    const f = fixture(); f.setRoot('C:/project');
    f.options.chooseFiles = async () => ['C:/project/file.md'];
    let finish!: (value: unknown) => void; let started!: () => void;
    const staging = new Promise<void>(resolve => { started = resolve; });
    const removed: string[] = []; let clears = 0;
    f.options.attachments.stage = () => { started(); return new Promise(resolve => { finish = resolve; }); };
    f.options.attachments.remove = (id: string) => { removed.push(id); };
    f.options.attachments.clear = () => { clears++; };
    const args = channel === CHANNELS.choosePromptAttachments ? [] : channel === CHANNELS.stagePromptAttachments ? [['C:/project/file.md']] : [['file.md'], 'C:/project'];
    const pending = f.handlers.get(channel)!(f.event, ...args);
    const rejected = assert.rejects(pending, /项目已切换/);
    await staging;
    f.setRoot('C:/new-project'); f.controller.cancel();
    finish([{ id: 'old-file' }]); await rejected;
    assert.deepEqual(removed, ['old-file']); assert.equal(clears, 1);
  }
});
