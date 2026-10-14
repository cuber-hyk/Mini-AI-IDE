import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonDraft } from '../src/main/tools/jsonDraft';
import { parseToolBatch } from '../src/shared/toolProtocol';
import { TOOL_JSON_RESEND_INSTRUCTION } from '../src/shared/toolJsonDiagnostic';

const initial = '{"protocol_version":1,"batch_id":"example","requests":[{"id":"one","tool":"get_project_info","args":{}}],}';
const wrapped = (body: string) => '```mini-ai-tools\n' + body + '\n```';
const scope = 'current-browser-revision';

test('畸形顶层修复指令不产生新草稿，遗漏冒号及转义属性名仍是修复尝试', () => {
  for (const body of [
    '{"repair_draft" {"draft_id":"a","version":1}}',
    '{"note":1,"repair_draft" {"draft_id":"a"}}',
    String.raw`{"repair_\u0064raft" {"draft_id":"a"}}`,
    String.raw`{"repair_\u0064raft":{"draft_id":"a",}`,
    '{repair_draft:{"draft_id":"a"}}',
    "{'repair_draft':{'draft_id':'a'}}",
    String.raw`{'repair_\u0064raft':{}}`,
  ]) {
    const parsed = parseToolBatch(wrapped(body));
    assert.equal(parsed.kind, 'error');
    if (parsed.kind === 'error') {
      assert.equal(parsed.repairAttempt, true, body);
      assert.equal(parsed.jsonBody, undefined, '补丁自身不能递归建立草稿');
    }
  }
});

test('普通批次正文和嵌套属性的 repair_draft 字样不剥夺 JSON 语法恢复资格', () => {
  for (const body of [
    '{"protocol_version":1,"batch_id":"review-code","requests":[{"id":"create","tool":"apply_changes","args":{"changes":[{"path":"x.txt","operation":"create","content":"sample: "repair_draft": value"}]}}]}',
    '{"protocol_version":1,"batch_id":"repair_draft","requests":[],}',
    '{"protocol_version":1,"requests":[{"args":{"repair_draft":1}}],}',
    String.raw`{"protocol_version":1,"requests":[{"args":{"command":"echo \"repair_draft\": sample"}}],}`,
    '{"batch_id":repair_draft,"requests":[],}',
    '{"protocol_version":1,"batch_id":"sample "repair_draft": name","requests":[],}',
    "{'batch_id':'repair_draft','requests':[]}",
    '{"requests":[{repair_draft:1}],}',
  ]) {
    const parsed = parseToolBatch(wrapped(body));
    assert.equal(parsed.kind, 'error');
    if (parsed.kind === 'error') {
      assert.equal(parsed.repairAttempt, undefined, body);
      assert.equal(parsed.jsonBody, body, '正文转义错误应保留普通批次草稿');
    }
  }
});

test('仅完整单正式围栏的 JSON.parse 错误允许建立草稿；非法补丁不能递归建立草稿', () => {
  const parsed = parseToolBatch(wrapped(initial));
  assert.equal(parsed.kind, 'error');
  if (parsed.kind !== 'error') return;
  assert.equal(parsed.jsonBody, initial);
  for (const text of [wrapped('{"repair_draft":{"draft_id":"a","version":1,'),
    wrapped('{"protocol_version":1,"repair_draft":{"draft_id":"a","version":1,'),
    wrapped('{"protocol_version":2,"requests":[]}'),
    wrapped('{}') + '\n' + wrapped('{}'), '```mini-ai-tools\n{']) {
    const result = parseToolBatch(text);
    assert.equal(result.kind, 'error');
    if (result.kind === 'error') assert.equal(result.jsonBody, undefined);
  }
  const owner = new JsonDraft();
  assert.equal(owner.capture('root', 'chat', scope, wrapped(initial), parsed.jsonBody)?.version, 1);
  assert.equal(owner.current('root', 'chat', scope)?.version, 1);
});

test('严格补丁格式，当前修订稿唯一替换、版本递增、原始回复与来源摘要稳定', () => {
  const owner = new JsonDraft(); const source = wrapped(initial);
  const first = owner.capture('root', 'chat', scope, source, initial)!;
  assert.deepEqual(owner.capture('root', 'chat', scope, source, initial), first);
  const patch = { draft_id: first.draft_id, version: 1, old_string: ',}', new_string: '}' };
  const text = wrapped(JSON.stringify({ repair_draft: patch }));
  const parsed = parseToolBatch(text); assert.equal(parsed.kind, 'repair');
  if (parsed.kind !== 'repair') return;
  const result = owner.apply('root', 'chat', scope, text, parsed.patch);
  assert.equal(result.kind, 'batch');
  if (result.kind !== 'batch') return;
  assert.equal(result.batch.batch_id, 'example'); assert.equal(result.origin.version, 2);
  assert.equal(result.origin.patchSourceText, text);
  assert.match(result.origin.originalHash, /^[0-9a-f]{64}$/);
  assert.match(result.origin.revisedHash, /^[0-9a-f]{64}$/);
  assert.notEqual(result.origin.originalHash, result.origin.revisedHash);
  assert.equal(owner.current('root', 'chat', scope), null);
  assert.equal(owner.apply('root', 'chat', scope, text, parsed.patch).kind, 'rejected');
});

test('修正后仍非法可继续修复；旧版本与歧义、错项目、无效替换不修改版本', () => {
  const owner = new JsonDraft(); const first = owner.capture('root', 'chat', scope, wrapped(initial), initial)!;
  const invalid = owner.apply('root', 'chat', scope, 'patch-1', { ...first, old_string: ',}', new_string: ', ]}' });
  assert.equal(invalid.kind, 'diagnostic');
  if (invalid.kind === 'diagnostic') {
    assert.ok(invalid.error.includes(first.draft_id));
    assert.match(invalid.error, /版本 2/);
    assert.match(invalid.error, /只返回这一条草稿补丁/);
    assert.ok(!invalid.error.includes(TOOL_JSON_RESEND_INSTRUCTION), '仍可修复的真实草稿只能得到补丁指导');
  }
  assert.equal(owner.current('root', 'chat', scope)?.version, 2);
  assert.equal(owner.apply('root', 'chat', scope, 'patch-old', { ...first, old_string: ', ]}', new_string: '}' }).kind, 'rejected');
  assert.equal(owner.apply('other-root', 'chat', scope, 'patch-wrong-project', { ...first, version: 2, old_string: ', ]}', new_string: '}' }).kind, 'rejected');
  assert.equal(owner.apply('root', 'chat', scope, 'patch-ambiguous', { ...first, version: 2, old_string: '"', new_string: '!' }).kind, 'rejected');
  assert.equal(owner.current('root', 'chat', scope)?.version, 2);
  const valid = owner.apply('root', 'chat', scope, 'patch-2', { ...first, version: 2, old_string: ', ]}', new_string: '}' });
  assert.equal(valid.kind, 'batch');
  owner.invalidate();
  assert.equal(owner.current('root', 'chat', scope), null);
});

test('有效草稿的拒绝沿用当前身份和版本，无草稿时只要求完整重发', () => {
  const owner = new JsonDraft();
  const current = owner.capture('root', 'chat', scope, wrapped(initial), initial)!;
  const outcome = owner.apply('root', 'chat', scope, 'stale-patch', { ...current, version: 99, old_string: ',}', new_string: '}' });
  assert.equal(outcome.kind, 'rejected');
  if (outcome.kind === 'rejected') {
    assert.match(outcome.error, /版本不匹配/);
    assert.ok(outcome.error.includes(JsonDraft.instruction(current)), '重试只使用仍有效的真实 ID 和版本');
    assert.ok(!outcome.error.includes(TOOL_JSON_RESEND_INSTRUCTION));
  }
  assert.deepEqual(owner.current('root', 'chat', scope), current);
  owner.invalidate();
  const missing = owner.apply('root', 'chat', scope, 'missing-patch', { ...current, old_string: ',}', new_string: '}' });
  assert.equal(missing.kind, 'rejected');
  if (missing.kind === 'rejected') {
    assert.ok(missing.error.endsWith(TOOL_JSON_RESEND_INSTRUCTION));
    assert.doesNotMatch(missing.error, /repair_draft|草稿 [0-9a-f-]{36}/, '失效草稿不得继续授予补丁身份');
  }
});

test('结构错误、非法字段、无效版本和普通工具批次不能伪装成修复', () => {
  for (const body of [
    { repair_draft: { draft_id: 'draft', version: 0, old_string: 'x', new_string: 'y' } },
    { repair_draft: { draft_id: 'draft', version: 1, old_string: '', new_string: 'y' } },
    { repair_draft: { draft_id: 'draft', version: 1, old_string: 'x', new_string: 'x' } },
    { repair_draft: { draft_id: 'draft', version: 1, old_string: 'x', new_string: 'y', extra: true } },
    { repair_draft: { draft_id: 'draft', version: 1, old_string: 'x', new_string: 'y' }, requests: [] },
  ]) {
    const parsed = parseToolBatch(wrapped(JSON.stringify(body)));
    assert.equal(parsed.kind, 'error');
    if (parsed.kind === 'error') {
      assert.equal(parsed.repairAttempt, true);
      assert.equal(parsed.jsonBody, undefined);
    }
  }
  assert.equal(parseToolBatch(wrapped(JSON.stringify({ repair_draft: { draft_id: 'draft', version: 1, old_string: 'x', new_string: 'y' } }))).kind, 'repair');
  assert.equal(parseToolBatch(wrapped(JSON.stringify({ protocol_version: 1, batch_id: 'normal', requests: [{ id: 'one', tool: 'get_project_info', args: {} }] }))).kind, 'batch');
});

test('修补消除了 JSON 语法错误却留下非法协议时必须终止该草稿，不得继续局部修补或执行', () => {
  const body = '{"protocol_version":1,"batch_id":"bad-schema","requests":[{"id":"one","tool":"no_such_tool","args":{}}],}';
  const owner = new JsonDraft();
  const current = owner.capture('root', 'chat', scope, wrapped(body), body)!;
  const patch = { ...current, old_string: ',}', new_string: '}' };
  const outcome = owner.apply('root', 'chat', scope, wrapped(JSON.stringify({ repair_draft: patch })), patch);
  assert.equal(outcome.kind, 'rejected');
  if (outcome.kind === 'rejected') {
    assert.match(outcome.error, /草稿已失效.*未执行工具/);
    assert.ok(outcome.error.endsWith(TOOL_JSON_RESEND_INSTRUCTION));
    assert.doesNotMatch(outcome.error, /只返回这一条草稿补丁/);
  }
  assert.equal(owner.current('root', 'chat', scope), null);
  assert.equal(owner.apply('root', 'chat', scope, 'retry', { ...patch, version: 2 }).kind, 'rejected');
  assert.equal(owner.matchesRecovery('root', 'chat', scope, {} as never), false);
});
