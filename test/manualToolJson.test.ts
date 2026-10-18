import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ManualToolJson } from '../src/main/tools/manualToolJson';
import { MAX_MANUAL_TOOL_JSON_LENGTH } from '../src/shared/manualToolJson';
import { joinToolTextEnvelope, wrapToolTextEnvelope } from '../src/shared/toolTextBodies';

const json = JSON.stringify({ protocol_version: 1, batch_id: 'manual', requests: [{ id: 'info', tool: 'get_project_info', args: {} }] });
function fixture() {
  let context: { project: string | null; error?: string } = { project: 'C:/project' };
  const executed: any[] = []; const diagnostics: { source: string; error: string }[] = [];
  const owner = new ManualToolJson(() => context, async batch => { executed.push(batch); }, (source, error) => diagnostics.push({ source, error }));
  return { owner, executed, diagnostics, context: (next: typeof context) => { context = next; } };
}

it('原始 JSON 与正式单围栏单次提交原文给统一执行入口，不读取网页', async () => {
  for (const text of [json, '```mini-ai-tools\n' + json + '\n```', '~~~~mini-ai-tools\n' + json + '\n~~~~']) {
    const f = fixture(); assert.deepEqual(await f.owner.run(text), { ok: true });
    assert.deepEqual(f.executed, [JSON.parse(json)]); assert.deepEqual(f.diagnostics, []);
  }
});

it('错误、普通话、回执、补丁、多批次与混杂说明形成诊断，但绝不执行或修补', async () => {
  const f = fixture();
  for (const text of ['', '请帮我执行', '{"protocol_version":', '{"tool_results":[]}', '{"repair_draft":{"draft_id":"one","version":1,"old_string":"a","new_string":"b"}}',
    json + '\n' + json, '说明\n```mini-ai-tools\n' + json + '\n```', '```mini-ai-tools\n' + json + '\n```\n说明',
    '```mini-ai-tools\n' + json + '\n```\n```mini-ai-tools\n' + json + '\n```', '```json\n' + json + '\n```', '```mini-ai-tools\n' + json,
    JSON.stringify({ protocol_version: 1, batch_id: 'x', requests: [{ id: 'run', tool: 'run_command', args: { command: 'echo x', shell: 'unsupported' } }] })]) {
    const before = f.diagnostics.length;
    assert.deepEqual(await f.owner.run(text), { ok: true }, text.slice(0, 70));
    assert.equal(f.diagnostics.length, before + 1); assert.equal(f.diagnostics.at(-1)!.source, text);
    assert.ok(f.diagnostics.at(-1)!.error);
  }
  assert.equal(f.executed.length, 0);
});

it('参数类型、长度和 NUL 守卫拒绝提交且不覆盖当前工具结果', async () => {
  const f = fixture();
  for (const input of [null, {}, '\0', ' '.repeat(MAX_MANUAL_TOOL_JSON_LENGTH + 1)]) assert.equal((await f.owner.run(input)).ok, false);
  assert.deepEqual(f.executed, []); assert.deepEqual(f.diagnostics, []);
});

it('无项目或忙状态拒绝提交，格式错误也不能绕过上下文门禁', async () => {
  const f = fixture();
  for (const context of [{ project: null }, { project: 'C:/project', error: 'busy' }, { project: 'C:/project', error: 'storage' }]) {
    f.context(context); assert.equal((await f.owner.run(json)).ok, false); assert.equal((await f.owner.run('{broken')).ok, false);
  }
  assert.deepEqual(f.executed, []); assert.deepEqual(f.diagnostics, []);
});

it('正文中的代码围栏只是参数资料，原始 JSON 添加围栏不截断文件内容', async () => {
  const f = fixture(); const content = '\n````mini-ai-tools\n只是资料\n````\n';
  assert.equal((await f.owner.run(JSON.stringify({ protocol_version: 1, batch_id: 'content', requests: [{ id: 'write', tool: 'apply_changes', args: { changes: [{ path: 'notes.md', operation: 'create', content }] } }] }))).ok, true);
  assert.equal(f.executed[0].requests[0].args.changes[0].content, content);
});

it('手动入口与网页共用原文块解析，不把围栏内的原文当另一批次', async () => {
  const content = '\n```mini-ai-tools\n资料仅供阅读\n```\n';
  const body = joinToolTextEnvelope({ manifest: JSON.stringify({ protocol_version: 1, batch_id: 'manual-raw', requests: [
    { id: 'write', tool: 'apply_changes', args: { changes: [{ path: 'raw.md', operation: 'create', content: { text_ref: 'source' } }] } },
  ] }), bodies: [{ id: 'source', text: content }] });
  for (const input of [body, wrapToolTextEnvelope(body)]) {
    const f = fixture(); assert.equal((await f.owner.run(input)).ok, true);
    assert.equal(f.executed.length, 1); assert.equal(f.executed[0].requests[0].args.changes[0].content, content);
    assert.deepEqual(f.diagnostics, []);
  }
});

it('执行入口的预约拒绝明确返回，单次提交不自动重试', async () => {
  let called = 0;
  const owner = new ManualToolJson(() => ({ project: 'project' }), async () => { called++; throw new Error('预约失败'); }, () => assert.fail('预约错误不是解析诊断'));
  assert.deepEqual(await owner.run(json), { ok: false, error: '预约失败' }); assert.equal(called, 1);
});
