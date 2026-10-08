import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as vm from 'node:vm';
import { AutoCollector, COMPLETION_SCRIPT, type AutoReply } from '../src/main/tools/autoCollector';

it('回复内部复制代码按钮与历史回复复制按钮不能证明最新回复结束', () => {
  const button: any = { textContent: '复制', getAttribute: () => null, getClientRects: () => [{}], closest: () => null };
  const ancestor: any = { parentElement: null, className: '', querySelectorAll: () => [button], contains: () => true };
  const old: any = { closest: () => null, parentElement: ancestor };
  const reply: any = { closest: () => null, className: 'markdown', parentElement: ancestor, querySelectorAll: () => [button], contains: (e: unknown) => e === reply || e === button };
  const document: any = { querySelectorAll: (selector: string) => selector.includes('markdown') ? [old, reply] : selector.includes('button') ? [button] : [] };
  assert.equal(vm.runInNewContext(COMPLETION_SCRIPT, { document }), 'idle');
  ancestor.contains = (e: unknown) => e === reply; reply.contains = (e: unknown) => e === reply;
  assert.equal(vm.runInNewContext(COMPLETION_SCRIPT, { document }), 'complete');
});
it('启用及导航只建立历史基线；生成中不执行，实际结束后执行一次', async () => {
  let reply: AutoReply = { url: 'one', text: 'history', completion: 'complete' }; const collected: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => { collected.push(text); }, () => {});
  auto.setEnabled(true); await auto.tick();

  reply = { ...reply, text: 'partial', completion: 'generating' }; await auto.tick(); await auto.tick();
  assert.deepEqual(collected, []);
  reply = { ...reply, text: 'new batch', completion: 'idle' }; await auto.tick(); await auto.tick();
  assert.deepEqual(collected, ['new batch']);
  reply = { url: 'two', text: 'other history', completion: 'complete' }; await auto.tick(); assert.equal(collected.length, 1);
  auto.setEnabled(false); reply.text = 'while disabled'; await auto.tick(); auto.setEnabled(true); await auto.tick(); assert.equal(collected.length, 1);
  auto.dispose();
});
it('未知 DOM 与仅文字稳定不能判结束；完成控件可确认错过生成阶段的回复', async () => {
  let reply: AutoReply = { url: 'one', text: 'history', completion: 'complete' }; const output: string[] = []; const messages: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => { output.push(text); }, text => { messages.push(text); });
  auto.setEnabled(true); await auto.tick(); reply = { ...reply, text: 'new', completion: 'idle' };
  await auto.tick(); await auto.tick(); assert.equal(output.length, 0); assert.match(messages.at(-1)!, /手动|采集回复/);
  reply.completion = 'complete'; await auto.tick(); assert.deepEqual(output, ['new']); auto.dispose();
});

it('手动已采集的回复被调度确认，不重复执行或用未知结束提示覆盖工具完成结果', async () => {
  let reply: AutoReply = { url: 'one', text: 'history', completion: 'complete' };
  const output: string[] = []; const messages: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => { output.push(text); }, text => { messages.push(text); });
  auto.setEnabled(true);
  try {
    await auto.tick();
    reply = { ...reply, text: 'manually collected', completion: 'unknown' };
    auto.acknowledge(reply.url, reply.text);
    messages.length = 0;
    await auto.tick(); await auto.tick();
    assert.deepEqual(output, []); assert.deepEqual(messages, []);
     reply = { ...reply, text: 'next', completion: 'complete' }; await auto.tick();
    assert.deepEqual(output, ['next']);
  } finally { auto.dispose(); }
});

it('异步旧快照不能跨重置执行，新会话通知在旧读取结束后仍建立基线', async () => {
  let resolve: ((reply: AutoReply) => void) | undefined;
  let reply: AutoReply = { url: 'one', text: 'history', completion: 'complete' };
  const collected: string[] = []; let delayed = false;
  const auto = new AutoCollector(() => delayed ? new Promise(yes => { resolve = yes; }) : Promise.resolve(reply), async text => { collected.push(text); }, () => {});
  auto.setEnabled(true); await auto.tick();
  delayed = true; const old = auto.tick();
  auto.reset(); delayed = false; reply = { url: 'two', text: 'other history', completion: 'complete' };
  await auto.tick(); resolve!({ url: 'one', text: 'stale dangerous request', completion: 'complete' }); await old;
  assert.deepEqual(collected, []);
  reply.text = 'new request'; await auto.tick(); assert.deepEqual(collected, ['new request']); auto.dispose();
});

it('完成标记的异步清理期间切换上下文、关闭或销毁，旧正文失去执行资格', async () => {
  for (const invalidate of ['reset', 'disable', 'dispose'] as const) {
    let reply: AutoReply = { url: 'one', text: 'history', completion: 'complete' };
    let release: (() => void) | undefined; const output: string[] = [];
    const auto = new AutoCollector(async () => reply, async (text, current) => {
      await new Promise<void>(resolve => { release = resolve; });
      if (current()) output.push(text);
    }, () => {});
    auto.setEnabled(true); await auto.tick(); reply = { ...reply, text: 'OLD_SESSION_TOOLS' };
    const collecting = auto.tick(); await Promise.resolve();
    if (invalidate === 'reset') auto.reset(); else if (invalidate === 'disable') auto.setEnabled(false); else auto.dispose();
    release!(); await collecting; assert.deepEqual(output, [], invalidate); auto.dispose();
  }
});

it('同条回复多次中断只提示等待，续写完全结束后一次采集，关闭后补全不执行', async () => {
  let reply: AutoReply = { url: 'one', text: 'history', completion: 'complete' };
  const output: string[] = []; const messages: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => { output.push(text); }, text => { messages.push(text); });
  auto.setEnabled(true); await auto.tick(); messages.length = 0;
  reply = { ...reply, text: 'partial', completion: 'interrupted' }; await auto.tick(); await auto.tick();
  assert.deepEqual(output, []); assert.equal(messages.length, 1); assert.match(messages[0]!, /等待继续生成/);
  reply.completion = 'generating'; await auto.tick();
  reply = { ...reply, text: 'still partial', completion: 'interrupted' }; await auto.tick(); assert.deepEqual(output, []);
  reply = { ...reply, text: 'complete', completion: 'complete' }; await auto.tick(); await auto.tick();
  assert.deepEqual(output, ['complete']);
  reply.completion = 'interrupted'; await auto.tick(); auto.setEnabled(false);
  reply = { ...reply, text: 'finished after disable', completion: 'complete' }; await auto.tick(); assert.deepEqual(output, ['complete']); auto.dispose();
});

it('切会话空帧与迟到历史只建立基线，之后完整新输出无需发送动作', async () => {
 let reply:AutoReply={url:'one',text:'old',completion:'complete'};const output:string[]=[];
 const auto=new AutoCollector(async()=>reply,async text=>{output.push(text);},()=>{});
 auto.setEnabled(true);await auto.tick();auto.reset(true);
 reply={url:'two',text:'',completion:'unknown'};await auto.tick();
 reply={url:'two',text:'history loaded late',completion:'complete'};await auto.tick();assert.deepEqual(output,[]);
 reply.text='new tool output';await auto.tick();await auto.tick();assert.deepEqual(output,['new tool output']);auto.dispose();
});
it('地址分配只延续内容观察，首页新输出无需发送回执', async () => {
 let reply:AutoReply={url:'home',text:'',completion:'unknown'};const output:string[]=[];
 const auto=new AutoCollector(async()=>reply,async text=>{output.push(text);},()=>{});
 auto.setEnabled(true);await auto.tick();reply.completion='generating';await auto.tick();auto.continueAt('allocated');
 reply={url:'allocated',text:'new batch',completion:'complete'};await auto.tick();assert.deepEqual(output,['new batch']);auto.dispose();
});

it('已确认首页交接结束遗留历史等待，但不伪造生成态或丢失已消费正文', async () => {
  let reply: AutoReply = { url: 'old', text: 'old history', completion: 'complete' };
  const output: string[] = [];
  const auto = new AutoCollector(async () => reply, async text => { output.push(text); }, () => {});
  auto.setEnabled(true); await auto.tick(); auto.reset(true);
  reply = { url: 'home', text: '', completion: 'unknown' }; await auto.tick();
  auto.continueAt('allocated');
  reply = { url: 'allocated', text: 'first tools', completion: 'idle' }; await auto.tick();
  assert.deepEqual(output, [], '首页交接不能把未知结束当作已生成完成');
  reply.completion = 'complete'; await auto.tick(); await auto.tick();
  assert.deepEqual(output, ['first tools']);
  auto.continueAt('another-address'); reply.url = 'another-address'; await auto.tick();
  assert.deepEqual(output, ['first tools'], '交接保留已消费正文，不重复执行'); auto.dispose();
});
