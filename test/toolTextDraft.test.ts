import assert from 'node:assert/strict';
import { it } from 'node:test';
import { JsonDraft } from '../src/main/tools/jsonDraft';
import { parseToolBatch } from '../src/shared/toolProtocol';
import { joinToolTextEnvelope, wrapToolTextEnvelope } from '../src/shared/toolTextBodies';

const scope = 'platform:document:1';
const header = JSON.stringify({ protocol_version: 1, batch_id: 'raw-draft', requests: [{ id: 'create', tool: 'apply_changes', args: { changes: [{ path: 'script.py', operation: 'create', content: { text_ref: 'script' } }] } }] });
const script = 'print("中文", r"C:\\data")\n```nested\nraw\n```\n';
const broken = joinToolTextEnvelope({ manifest: header.slice(0, -1) + ',}', bodies: [{ id: 'script', text: script }] });
function fixture() {
  const owner = new JsonDraft(); const source = wrapToolTextEnvelope(broken); const parsed = parseToolBatch(source);
  assert.equal(parsed.kind, 'error');
  if (parsed.kind !== 'error' || !parsed.jsonBody) throw new Error('expected draft');
  const metadata = owner.capture('root', 'chat', scope, source, parsed.jsonBody)!;
  return { owner, metadata };
}
function patchText(metadata: { draft_id: string; version: number }, body_id: string, content: string) {
  return wrapToolTextEnvelope(joinToolTextEnvelope({ manifest: JSON.stringify({ repair_draft: { ...metadata, body_id, content: { text_ref: 'replacement' } } }), bodies: [{ id: 'replacement', text: content }] }));
}

it('重发短清单即可恢复长正文，原文和嵌套围栏不重复输出，来源仍绑定真实补丁', () => {
  const { owner, metadata } = fixture(); const source = patchText(metadata, 'manifest', header);
  const parsed = parseToolBatch(source); assert.equal(parsed.kind, 'repair');
  if (parsed.kind !== 'repair') return;
  const result = owner.apply('root', 'chat', scope, source, parsed.patch);
  assert.equal(result.kind, 'batch');
  if (result.kind !== 'batch') return;
  const changes = result.batch.requests[0]!.args.changes as Array<{ content: string }>;
  assert.equal(changes[0]!.content, script);
  assert.equal(result.origin.patchSourceText, source);
  assert.equal(owner.matchesRecovery('root', 'chat', scope, result.origin), true);
  assert.equal(owner.matchesRecovery('root', 'other-chat', scope, result.origin), false);
  assert.equal(owner.apply('root', 'chat', scope, source, parsed.patch).kind, 'rejected', '已恢复草稿不可再次执行');
});

it('按块替换不要求重复旧长正文，版本递增后只用当前身份修复清单', () => {
  const { owner, metadata } = fixture(); const replacement = '  print("修改")\n\n';
  const source = patchText(metadata, 'script', replacement); const parsed = parseToolBatch(source);
  assert.equal(parsed.kind, 'repair'); if (parsed.kind !== 'repair') return;
  const result = owner.apply('root', 'chat', scope, source, parsed.patch);
  assert.equal(result.kind, 'diagnostic'); assert.equal(owner.current('root', 'chat', scope)?.version, 2);
  assert.equal(owner.apply('root', 'chat', scope, source, parsed.patch).kind, 'rejected');
  const next = patchText({ ...metadata, version: 2 }, 'manifest', header);
  const nextParsed = parseToolBatch(next); if (nextParsed.kind !== 'repair') throw new Error('patch');
  const recovered = owner.apply('root', 'chat', scope, next, nextParsed.patch);
  assert.equal(recovered.kind, 'batch');
  if (recovered.kind === 'batch') assert.equal((recovered.batch.requests[0]!.args.changes as Array<{ content: string }>)[0]!.content, replacement);
});

it('未知块、歧义边界、旧版本、不同作用域和无变化补丁不改变修订版本', () => {
  const { owner, metadata } = fixture();
  for (const [root, chat, generation, patch] of [
    ['root', 'chat', scope, { ...metadata, body_id: 'missing', content: 'x' }],
    ['root', 'chat', scope, { ...metadata, body_id: 'script', content: '@@end script' }],
    ['root', 'chat', scope, { ...metadata, body_id: 'script', content: script }],
    ['other', 'chat', scope, { ...metadata, body_id: 'manifest', content: header }],
    ['root', 'chat', 'other', { ...metadata, body_id: 'manifest', content: header }],
    ['root', 'chat', scope, { ...metadata, version: 99, body_id: 'manifest', content: header }],
  ] as const) assert.equal(owner.apply(root, chat, generation, 'patch', patch).kind, 'rejected');
  assert.deepEqual(owner.current('root', 'chat', scope), metadata);
});

it('畸形块补丁不递归建草稿，语义校验失败不绕过工具合同', () => {
  const bad = patchText({ draft_id: 'known', version: 1 }, 'manifest', header).replace('@@end replacement', '@@end other');
  const result = parseToolBatch(bad); assert.equal(result.kind, 'error');
  if (result.kind === 'error') { assert.equal(result.repairAttempt, true); assert.equal(result.jsonBody, undefined); }
  const { owner, metadata } = fixture(); const source = patchText(metadata, 'manifest', header.replace('"apply_changes"', '"no_such_tool"'));
  const parsed = parseToolBatch(source); if (parsed.kind !== 'repair') throw new Error('patch');
  assert.equal(owner.apply('root', 'chat', scope, source, parsed.patch).kind, 'rejected');
  assert.equal(owner.current('root', 'chat', scope), null);
});
