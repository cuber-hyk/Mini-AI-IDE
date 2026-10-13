import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createToolIntegration } from '../src/main/tools/integration';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { CHANNELS } from '../src/shared/contract';

const batch = (id: string, tool: string, args: unknown) => '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: id, requests: [{ id: 'request', tool, args }] }) + '\n```';
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < deadline, '协作链路应完成'); await delay(5); } }
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-continue-')); const files = new FileService(); files.setRoot(root);
  const handlers = new Map<string, any>(); const editor: any = { mainFrame: {}, isDestroyed: () => false, send() {} };
  let reply = ''; let completion = 'complete'; let session = 'https://chat.deepseek.com/a/chat/continue';
  let wait: ((value: unknown) => void) | undefined;
  let read: () => Promise<unknown> = async () => ({ replies: [reply], completion });
  const web: any = Object.assign(new EventEmitter(), { getURL: () => session, isDestroyed: () => false,
    executeJavaScript: () => read(),
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
      const script = scripts[0]!.code;
      if (script.includes('const completion =')) return read();
      if (script.includes('new Promise(resolve')) return new Promise(resolve => { wait = resolve; });
      if (script.includes('preserve')) return { preserve: false, turn: 0 };
      if (script.includes('return { turn:')) return { turn: 0 };
      return true;
    },
  });
  const sent: string[] = []; let action = async (_text: string) => ({ ok: true }); let cancellations = 0;
  const system = await createToolIntegration({ files, web, editor,
    ipc: { handle(channel: string, fn: any) { handlers.set(channel, fn); } } as any,
    workspace: { editor: { isDirty: () => false, current: { documents: [] } }, run: (fn: any) => fn() } as any,
    returnPath: new ReturnPathService(files), storePath: path.join(root, 'tools.json'), disabled: false,
    ask: async () => ({ response: 0, checkboxChecked: false }), notifyFile() {}, copy() {},
    sender: { async send(text, expected) { assert.equal(expected, session); sent.push(text); return action(text); }, async cancel() { cancellations++; }, async dispose() {} },
  });
  t.after(async () => { await system.dispose(); wait?.(false); await fs.rm(root, { recursive: true, force: true }); });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)({ sender: editor, senderFrame: editor.mainFrame }, ...args);
  return { root, system, sent, call, get cancellations() { return cancellations; },
    setAction(fn: typeof action) { action = fn; },
    setReply(text: string, phase = 'complete') { reply = text; completion = phase; },
    setRead(fn: typeof read) { read = fn; },
    async notify(text: string, turn = 0) { reply = text; await until(() => !!wait); const next = wait; wait = undefined; next!({ turn }); },
    switchSession() { session += '-new'; web.emit('did-navigate-in-page', {}, session, true); },
  };
}
it('自动发回读取和修改工具结果，下一轮由变化监听采集，普通对话等待用户', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.txt'), 'A');
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  f.setAction(async () => {
    await f.notify(f.sent.length === 1 ? batch('edit', 'apply_changes', { changes: [{ path: 'a.txt', operation: 'replace', edits: [{ old_string: 'A', new_string: 'C' }] }] }) : '需要你选择后续需求');
    return { ok: true };
  });
  const first = batch('read', 'read_file', { path: 'a.txt' }); f.setReply(first);
  await f.system.accept(first, 'complete');
  await until(() => f.sent.length === 2 && !f.system.getState().busy && f.system.getState().results.length === 0);
  assert.equal(JSON.parse(f.sent[0]!).tool_results[0].tool, 'read_file');
  assert.equal(JSON.parse(f.sent[1]!).tool_results[0].tool, 'apply_changes');
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'C');
  assert.equal(f.system.getState().continuation!.phase, 'waiting_user');
  await delay(30); assert.equal(f.sent.length, 2);
});
it('发送 unknown 不重试旧结果，后续真实新输出仍独立采集执行', async t => {
  const f=await fixture(t);await f.call(CHANNELS.setToolConfig,{permission:'full',automatic:true,sendIntervalSeconds:0});
  const first=batch('first','get_project_info',{});f.setReply(first);
  f.setAction(async()=>({ok:false,uncertain:true,error:'发送无法确认'}));
  await f.system.accept(first,'complete');await until(()=>f.system.getState().continuation?.phase==='paused');
  await f.call(CHANNELS.setToolConfig,{sendIntervalSeconds:300});
  const late=batch('late','apply_changes',{changes:[{path:'late.txt',operation:'create',content:'real new output'}]});
  await f.notify(late);await until(()=>f.system.getState().results[0]?.batch_id==='late'&&!f.system.getState().busy);
  assert.equal(await fs.readFile(path.join(f.root,'late.txt'),'utf8'),'real new output');assert.equal(f.sent.length,1,'旧未知发送不得重试');
});
it('新回复先到达而发送回执未结束时，采集不等待回执且旧回执不覆盖新批次', async t => {
 const f=await fixture(t);await f.call(CHANNELS.setToolConfig,{permission:'full',automatic:true,sendIntervalSeconds:0});
 let finish!:(value:any)=>void;f.setAction(()=>new Promise(resolve=>{finish=resolve;}));
 const first=batch('waiting','get_project_info',{});f.setReply(first);await f.system.accept(first,'complete');
 await until(()=>f.system.getState().continuation?.phase==='sending');await f.call(CHANNELS.setToolConfig,{sendIntervalSeconds:300});
 await f.notify(batch('fast-unconfirmed','apply_changes',{changes:[{path:'unconfirmed.txt',operation:'create',content:'real output'}]}));
 await until(()=>f.system.getState().results[0]?.batch_id==='fast-unconfirmed'&&!f.system.getState().busy);
 assert.equal(await fs.readFile(path.join(f.root,'unconfirmed.txt'),'utf8'),'real output');
 finish({ok:false,uncertain:true,error:'unknown'});await delay(30);
 assert.equal(f.system.getState().results[0]?.batch_id,'fast-unconfirmed');assert.equal(f.sent.length,1);
});
it('关闭立即取消发送倒计时，工具实际结果与磁盘修改保留，重新开启不发送旧批', async t => {
  const f = await fixture(t);
  await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 1 });
  const body = batch('create', 'apply_changes', { changes: [{ path: 'created.txt', operation: 'create', content: 'stay' }] }); f.setReply(body);
  await f.system.accept(body, 'complete'); await until(() => f.system.getState().continuation?.phase === 'countdown');
  await f.call(CHANNELS.setToolConfig, { automatic: false });
  assert.equal(f.system.getState().continuation!.phase, 'off'); assert.equal(await fs.readFile(path.join(f.root, 'created.txt'), 'utf8'), 'stay');
  await f.call(CHANNELS.setToolConfig, { automatic: true, sendIntervalSeconds: 0 }); await delay(30); assert.equal(f.sent.length, 0);
});
it('发送前网页读取等待期间关闭再开启，不会让旧任务迟到发送', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const body = batch('delayed', 'get_project_info', {}); f.setReply(body);
  let entered = false; let finish!: (reply: unknown) => void;
  f.setRead(() => { entered = true; return new Promise(resolve => { finish = resolve; }); });
  await f.system.accept(body, 'complete'); await until(() => entered && f.system.getState().continuation?.phase === 'sending');
  await f.call(CHANNELS.setToolConfig, { automatic: false }); await f.call(CHANNELS.setToolConfig, { automatic: true });
  finish({ replies: [body], completion: 'complete' }); await delay(30);
  assert.equal(f.sent.length, 0); assert.notEqual(f.system.getState().continuation?.phase, 'waiting_reply');
});
it('网页最新回复被改为同 ID 不同参数时不发送旧结果，项目与会话变化也取消', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const body = batch('same', 'get_project_info', {}); f.setReply(body);
  f.setReply(batch('same', 'read_file', { path: 'other.txt' })); await f.system.accept(body, 'complete');
  await until(() => !f.system.getState().busy && f.system.getState().continuation?.phase === 'paused'); assert.equal(f.sent.length, 0);
  await f.call(CHANNELS.setToolConfig, { sendIntervalSeconds: 1 }); const fresh = batch('fresh', 'get_project_info', {}); f.setReply(fresh);
  await f.system.accept(fresh, 'complete'); await until(() => f.system.getState().continuation?.phase === 'countdown');
  f.switchSession(); await until(() => f.system.getState().results.length === 0); await delay(30); assert.equal(f.sent.length, 0);
});

// The actual official text stays immutable; only the main-process draft body changes.
const invalidBatch = (id: string, tool: string, args: unknown) => {
  const valid = JSON.stringify({ protocol_version: 1, batch_id: id, requests: [{ id: 'request', tool, args }] });
  return '```mini-ai-tools\n' + valid.slice(0, -1) + ',}\n```';
};
const repairFor = (state: ReturnType<Awaited<ReturnType<typeof fixture>>['system']['getState']>, version: number, old_string: string, new_string: string) => {
  const draft_id = state.batchError?.error.match(/草稿 ([0-9a-f-]{36})/)?.[1];
  assert.ok(draft_id, '诊断必须告知当前真实草稿 ID');
  return '```mini-ai-tools\n' + JSON.stringify({ repair_draft: { draft_id, version, old_string, new_string } }) + '\n```';
};

it('补丁漏冒号只报告错误，保留原草稿 ID 和版本，随后正确补丁仍恢复原批次', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const original = invalidBatch('keep-original-draft', 'apply_changes', { changes: [{ path: 'original.txt', operation: 'create', content: 'original preserved' }] });
  f.setReply(original); await f.system.accept(original, 'complete'); await until(() => f.sent.length === 1);
  const goodPatch = repairFor(f.system.getState(), 1, ',}', '}');
  const badPatch = goodPatch.replace('"repair_draft":', '"repair_draft" ');
  await f.notify(badPatch); await until(() => f.sent.length === 2);
  assert.doesNotMatch(f.system.getState().batchError!.error, /草稿 [0-9a-f-]{36}/, '畸形补丁不获得新的草稿标识');
  assert.equal(f.system.getState().results.length, 0);
  await assert.rejects(fs.access(path.join(f.root, 'original.txt')));
  await f.notify(goodPatch); await until(() => f.sent.length === 3 && !f.system.getState().busy);
  assert.equal(f.system.getState().results[0]?.batch_id, 'keep-original-draft');
  assert.equal(await fs.readFile(path.join(f.root, 'original.txt'), 'utf8'), 'original preserved');
});

it('恢复的完整批次走原工具执行、持久去重及官网补丁来源复核，只发送一次真实结果', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const original = invalidBatch('recover-once', 'apply_changes', { changes: [{ path: 'recovered.txt', operation: 'create', content: 'real recovery' }] });
  f.setReply(original); await f.system.accept(original, 'complete');
  await until(() => f.sent.length === 1);
  assert.ok(JSON.parse(f.sent[0]!).batch_error);
  await assert.rejects(fs.access(path.join(f.root, 'recovered.txt')), { code: 'ENOENT' });
  const patch = repairFor(f.system.getState(), 1, ',}', '}');
  await f.notify(patch);
  await until(() => f.sent.length === 2 && !f.system.getState().busy);
  assert.equal(JSON.parse(f.sent[1]!).tool_results[0].batch_id, 'recover-once');
  assert.equal(JSON.parse(f.sent[1]!).tool_results[0].status, 'done');
  assert.equal(await fs.readFile(path.join(f.root, 'recovered.txt'), 'utf8'), 'real recovery');
  await f.notify(patch); await delay(40);
  assert.equal(f.sent.length, 2, '重放相同官网补丁不得再次执行或回传');
});

it('修复后的 JSON 仍非法时版本递增，再次修复才执行，所有中间诊断都未创建文件', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const original = invalidBatch('recover-twice', 'apply_changes', { changes: [{ path: 'twice.txt', operation: 'create', content: 'after two patches' }] });
  f.setReply(original); await f.system.accept(original, 'complete'); await until(() => f.sent.length === 1);
  const first = repairFor(f.system.getState(), 1, ',}', ', ]}');
  await f.notify(first); await until(() => f.sent.length === 2);
  assert.ok(JSON.parse(f.sent[1]!).batch_error);
  assert.match(f.system.getState().batchError!.error, /版本 2/);
  await assert.rejects(fs.access(path.join(f.root, 'twice.txt')), { code: 'ENOENT' });
  const second = repairFor(f.system.getState(), 2, ', ]}', '}');
  await f.notify(second); await until(() => f.sent.length === 3);
  assert.equal(JSON.parse(f.sent[2]!).tool_results[0].status, 'done');
  assert.equal(await fs.readFile(path.join(f.root, 'twice.txt'), 'utf8'), 'after two patches');
});

it('已执行的恢复批次若官网最新回复发生变化，只保留本地真实结果，不发送旧批', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const original = invalidBatch('changed-recovery', 'apply_changes', { changes: [{ path: 'local-only.txt', operation: 'create', content: 'persist locally' }] });
  f.setReply(original); await f.system.accept(original, 'complete'); await until(() => f.sent.length === 1);
  const patch = repairFor(f.system.getState(), 1, ',}', '}');
  await f.call(CHANNELS.setToolConfig, { sendIntervalSeconds: 1 });
  f.setReply(patch); await f.system.accept(patch, 'complete');
  await until(() => f.system.getState().results[0]?.batch_id === 'changed-recovery' && f.system.getState().continuation?.phase === 'countdown');
  f.setReply(batch('different-latest', 'get_project_info', {}));
  await until(() => f.system.getState().continuation?.phase === 'paused');
  assert.equal(f.sent.length, 1, '只允许先前解析诊断发送，不允许过期工具结果发送');
  assert.equal(await fs.readFile(path.join(f.root, 'local-only.txt'), 'utf8'), 'persist locally');
});

it('手动历史补丁与取消之后的补丁均不可用于执行旧草稿', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: false });
  const original = invalidBatch('reject-stale', 'apply_changes', { changes: [{ path: 'blocked.txt', operation: 'create', content: 'never' }] });
  f.setReply(original); await f.system.accept(original, 'complete');
  await until(() => !!f.system.getState().batchError?.error.includes('草稿'));
  const patch = repairFor(f.system.getState(), 1, ',}', '}');
  f.setReply('different latest reply'); await f.system.accept(patch, 'complete');
  await assert.rejects(fs.access(path.join(f.root, 'blocked.txt')), { code: 'ENOENT' });
  await f.call(CHANNELS.cancelTools);
  f.setReply(patch); await f.system.accept(patch, 'complete');
  await until(() => !!f.system.getState().batchError?.error.includes('没有当前项目'));
  await assert.rejects(fs.access(path.join(f.root, 'blocked.txt')), { code: 'ENOENT' });
  assert.equal(f.sent.length, 0);
});

it('40 请求长 JSON 只需短补丁恢复，修复前零执行且恢复后仅一次整批回传', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const requests = Array.from({ length: 40 }, (_, n) => ({ id: 'item-' + n, tool: 'apply_changes',
    args: { changes: [{ path: 'long-' + n + '.txt', operation: 'create', content: 'x'.repeat(2000) }] } }));
  const valid = JSON.stringify({ protocol_version: 1, batch_id: 'long-recovery', requests });
  const original = '```mini-ai-tools\n' + valid.slice(0, -1) + ',}\n```';
  f.setReply(original); await f.system.accept(original, 'complete'); await until(() => f.sent.length === 1);
  assert.ok(original.length > 80_000);
  await assert.rejects(fs.access(path.join(f.root, 'long-0.txt')));
  const patch = repairFor(f.system.getState(), 1, ',}', '}'); assert.ok(patch.length < 200);
  await f.notify(patch); await until(() => f.sent.length === 2 && !f.system.getState().busy);
  assert.equal(f.system.getState().results.length, 40);
  assert.ok(f.system.getState().results.every(result => result.status === 'done'));
  assert.equal((await fs.readFile(path.join(f.root, 'long-39.txt'), 'utf8')).length, 2000);
  await f.notify(patch); await delay(40); assert.equal(f.sent.length, 2);
});

it('草稿版本递增和重开自动继续均不能重置连续五次错误回传额度', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const original = invalidBatch('repair-quota', 'get_project_info', {});
  f.setReply(original); await f.system.accept(original, 'complete'); await until(() => f.sent.length === 1);
  let previous = ',}';
  for (let n = 1; n <= 5; n++) {
    const replacement = ', ' + ']'.repeat(n) + '}';
    const patch = repairFor(f.system.getState(), n, previous, replacement);
    await f.notify(patch); previous = replacement;
    if (n < 5) await until(() => f.sent.length === n + 1);
    else await until(() => f.system.getState().continuation?.phase === 'paused');
  }
  assert.equal(f.sent.length, 5); assert.equal(f.system.getState().results.length, 0);
  assert.match(f.system.getState().continuation!.message, /连续 5 次/);
  await f.call(CHANNELS.setToolConfig, { automatic: false });
  await f.call(CHANNELS.setToolConfig, { automatic: true }); await delay(40);
  const sixth = repairFor(f.system.getState(), 6, previous, ', ]]]]]] }');
  await f.notify(sixth); await until(() => f.system.getState().batchError?.error.includes('版本 7') === true);
  assert.equal(f.sent.length, 5); assert.equal(f.system.getState().continuation?.phase, 'paused');
});

it('自动继续关闭期间出现的旧草稿补丁不会在重开时补执行', async t => {
  const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
  const original = invalidBatch('off-recovery', 'apply_changes', { changes: [{ path: 'off.txt', operation: 'create', content: 'never automatic' }] });
  f.setReply(original); await f.system.accept(original, 'complete'); await until(() => f.sent.length === 1);
  const patch = repairFor(f.system.getState(), 1, ',}', '}');
  await f.call(CHANNELS.setToolConfig, { automatic: false }); f.setReply(patch);
  await f.call(CHANNELS.setToolConfig, { automatic: true }); await delay(100);
  await assert.rejects(fs.access(path.join(f.root, 'off.txt')));
  assert.equal(f.sent.length, 1);
});

for (const invalidation of ['platform', 'session', 'reset'] as const) {
  it(invalidation + ' 变化使未执行草稿失效，切回后最新补丁也不能恢复旧批次', async t => {
    const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: false });
    const original = invalidBatch('scope-' + invalidation, 'apply_changes', { changes: [{ path: 'stale.txt', operation: 'create', content: 'never' }] });
    f.setReply(original); await f.system.accept(original, 'complete');
    const patch = repairFor(f.system.getState(), 1, ',}', '}');
    if (invalidation === 'platform') { await f.system.setWebActive(false); await f.system.setWebActive(true); }
    else if (invalidation === 'session') f.switchSession();
    else f.system.reset();
    f.setReply(patch); await f.system.accept(patch, 'complete');
    await until(() => f.system.getState().batchError?.error.includes('没有当前项目') === true);
    await assert.rejects(fs.access(path.join(f.root, 'stale.txt')));
    assert.equal(f.sent.length, 0);
  });
}

it('发送前复核区分真实生成、中断与未知完成，拒绝原因不混称会话变化', async t => {
  for (const [phase, reason] of [['generating','网页仍在生成'],['interrupted','网页生成已中断'],['unknown','无法确认网页回复结束']]) {
    const f = await fixture(t); await f.call(CHANNELS.setToolConfig, { permission: 'full', automatic: true, sendIntervalSeconds: 0 });
    const body = batch('verify-'+phase, 'get_project_info', {}); f.setReply(body, phase); await f.system.accept(body, 'complete');
    await until(() => f.system.getState().continuation?.phase === 'paused');
    assert.equal(f.sent.length, 0); assert.ok(f.system.getState().continuation?.message.includes(reason!));
  }
});

it('本地需求确认未结束时新工具照常执行，结果等待运输释放且取消不会补发', async t => {
  for (const cancelled of [false, true]) {
    const f=await fixture(t);await f.call(CHANNELS.setToolConfig,{permission:'full',automatic:true,sendIntervalSeconds:0});
    let finish!:(value:{ok:boolean})=>void;
    f.setAction(async()=>f.sent.length===1?new Promise(resolve=>{finish=resolve;}):{ok:true});
    const prompting=f.system.sendLocalPrompt('只读需求','https://chat.deepseek.com/a/chat/continue',()=>true);
    await until(()=>f.sent.length===1);
    const body=batch('prompt-confirm-'+cancelled,'get_project_info',{});f.setReply(body);await f.system.accept(body,'complete');
    await until(()=>!f.system.getState().busy&&f.system.getState().results[0]?.status==='done');
    await delay(30);assert.equal(f.sent.length,1,'工具已执行，但前一个运输未结束时不能尝试回传');
    if(cancelled){await f.call(CHANNELS.setToolConfig,{automatic:false});await f.call(CHANNELS.setToolConfig,{automatic:true});}
    finish({ok:true});await prompting;
    if(cancelled){await delay(40);assert.equal(f.sent.length,1,'关闭再开启不能复活等待运输的旧批');}
    else {await until(()=>f.sent.length===2);assert.equal(JSON.parse(f.sent[1]!).tool_results[0].batch_id,'prompt-confirm-false');}
  }
});
