import assert from 'node:assert/strict';
import { it } from 'node:test';
import { OBSERVATION_SCRIPT, ReplyMonitor } from '../src/main/tools/replyObservation';
import * as vm from 'node:vm';
import { AutoCollector } from '../src/main/tools/autoCollector';

function fixture() {
  let url = 'https://chat.deepseek.com/a/chat/one';
  let probe = { signature: 'history', completion: 'complete' };
  let snapshot = { replies: ['history reply'], signature: 'history', completion: 'complete' };
  let probes = 0; let captures = 0;
  const web: any = { getURL: () => url, executeJavaScript: async (script: string) => {
    if (script === OBSERVATION_SCRIPT) { probes++; return { ...probe }; }
    captures++; return { ...snapshot };
  } };
  return {
    monitor: new ReplyMonitor(web),
    update(signature: string, completion: string, text: string) { probe = { signature, completion }; snapshot = { replies: [text], signature, completion }; },
    snapshotOnly(completion: string, signature: string, text: string) { snapshot = { replies: [text], signature, completion }; },
    navigate(next: string) { url = next; },
    counts: () => ({ probes, captures }),
  };
}

it('空闲只读摘要，无变化不采集全文；生成过程不读取半成品，结束后采集一次', async () => {
  const f = fixture();
  assert.equal((await f.monitor.read()).text, 'history reply');
  for (let index = 0; index < 5; index++) await f.monitor.read();
  assert.deepEqual(f.counts(), { probes: 6, captures: 1 });
  f.update('partial-1', 'generating', 'unfinished'); await f.monitor.read();
  f.update('partial-2', 'generating', 'still unfinished'); await f.monitor.read();
  assert.equal(f.counts().captures, 1);
  f.update('new', 'complete', 'complete reply');
  assert.equal((await f.monitor.read()).text, 'complete reply');
  await f.monitor.read();
  assert.equal(f.counts().captures, 2);
});

it('轻量探测与全文之间再次开始生成时，以全文的真实状态为准且不执行', async () => {
  const f = fixture(); const executed: string[] = [];
  const auto = new AutoCollector(() => f.monitor.read(), async text => { executed.push(text); }, () => {});
  auto.setEnabled(true);
  try {
    await auto.tick();

    f.update('new', 'complete', 'looks complete');
    f.snapshotOnly('generating', 'actually-streaming', 'incomplete');
    await auto.tick();
    assert.deepEqual(executed, []);
    f.update('finished', 'complete', 'complete reply'); await auto.tick(); await auto.tick();
    assert.deepEqual(executed, ['complete reply']);
  } finally { auto.dispose(); }
});

it('会话变化重新读取全文和建基线；追踪参数变化不重复采集相同内容', async () => {
  const f = fixture(); const executed: string[] = [];
  const auto = new AutoCollector(() => f.monitor.read(), async text => { executed.push(text); }, () => {});
  auto.setEnabled(true);
  try {
    await auto.tick();
    f.navigate('https://chat.deepseek.com/a/chat/one?tracking=changed'); await auto.tick();
    assert.equal(f.counts().captures, 1);
    f.navigate('https://chat.deepseek.com/a/chat/two'); await auto.tick();
    assert.equal(f.counts().captures, 2); assert.deepEqual(executed, []);
     f.update('new', 'complete', 'new conversation reply'); await auto.tick();
    assert.deepEqual(executed, ['new conversation reply']);
  } finally { auto.dispose(); }
});

it('生成或结束未知时不读取正文摘要或解析半成品，完成后再读取', async () => {
  const f = fixture(); await f.monitor.read();
  f.update('unknown-partial', 'unknown', 'unfinished'); await f.monitor.read();
  assert.equal(f.counts().captures, 1);
  f.update('finished', 'complete', 'finished'); await f.monitor.read(); assert.equal(f.counts().captures, 2);
  const stop = { textContent: '停止生成', getClientRects: () => [{}], getAttribute: () => null };
  const document = { querySelectorAll(selector: string) { if (selector.includes('markdown')) assert.fail('生成中不得读取正文或摘要'); return selector.includes('button') ? [stop] : []; } };
  assert.equal(vm.runInNewContext(OBSERVATION_SCRIPT, { document }).completion, 'generating');
});

it('等待继续生成不读取半成品正文，继续完成后重新读取原回复全文', async () => {
  const f = fixture(); await f.monitor.read();
  f.update('partial', 'interrupted', 'unfinished JSON'); assert.equal((await f.monitor.read()).completion, 'interrupted');
  assert.equal(f.counts().captures, 1);
  f.update('continued', 'generating', 'still partial'); await f.monitor.read(); assert.equal(f.counts().captures, 1);
  f.update('complete', 'complete', 'complete original reply'); assert.equal((await f.monitor.read()).text, 'complete original reply');
  assert.equal(f.counts().captures, 2);
  const button = { textContent: '继续生成', getClientRects: () => [{}], getAttribute: () => null, closest: () => null };
  const document = { querySelectorAll(selector: string) { if (selector.includes('markdown')) assert.fail('中断时不得读取正文摘要'); return selector.includes('button') ? [button] : []; } };
  assert.equal(vm.runInNewContext(OBSERVATION_SCRIPT, { document }).completion, 'interrupted');
});
