import assert from 'node:assert/strict';
import { it } from 'node:test';
import { parseToolBatch } from '../src/shared/toolProtocol';
import { joinToolTextEnvelope, wrapToolTextEnvelope } from '../src/shared/toolTextBodies';

const request = (args: unknown, tool = 'run_command') => ({ id: 'one', tool, args });
const manifest = (requests: unknown[]) => JSON.stringify({ protocol_version: 1, batch_id: 'raw-body', requests });
const envelope = (requests: unknown[], bodies: Array<{ id: string; text: string }>) => wrapToolTextEnvelope(joinToolTextEnvelope({ manifest: manifest(requests), bodies }));
const ref = (id: string) => ({ text_ref: id });
const command = (value: unknown = ref('script')) => request({ command: value, shell: 'powershell' });

it('原文块逐字保留引号、反斜杠、中文、缩进、空格与末尾换行；运输换行统一LF', () => {
  for (const text of [String.raw`print("中文", '引号', r'C:\Users\资料')`, '  line  \n\tindent\n\n', '```python\nprint("x")\n```\n']) {
    const source = envelope([command()], [{ id: 'script', text }]);
    for (const transported of [source, source.replace(/\n/g, '\r\n')]) {
      const parsed = parseToolBatch(transported);
      assert.equal(parsed.kind, 'batch');
      if (parsed.kind === 'batch') assert.equal(parsed.batch.requests[0]!.args.command, text);
    }
  }
});

it('创建、覆盖和替换正文可用原文引用，空文件与删除保留明确语义', () => {
  const source = envelope([request({ changes: [
    { path: 'empty.txt', operation: 'create', content: ref('empty') },
    { path: 'file.md', operation: 'replace', edits: [{ old_string: ref('old'), new_string: ref('deleted') }] },
  ] }, 'apply_changes')], [{ id: 'empty', text: '' }, { id: 'old', text: 'original\n' }, { id: 'deleted', text: '' }]);
  const parsed = parseToolBatch(source); assert.equal(parsed.kind, 'batch');
  if (parsed.kind === 'batch') assert.deepEqual(parsed.batch.requests[0]!.args.changes, [
    { path: 'empty.txt', operation: 'create', content: '' },
    { path: 'file.md', operation: 'replace', edits: [{ old_string: 'original\n', new_string: '' }] },
  ]);
});

it('正文只能引用一次且仅限指定槽；路径、未知字段、缺失和闲置块整批拒绝', () => {
  for (const source of [
    envelope([command()], []),
    envelope([command('short')], [{ id: 'script', text: 'orphan' }]),
    envelope([command(), { ...command(), id: 'two' }], [{ id: 'script', text: 'dup' }]),
    envelope([request({ path: ref('script') }, 'read_file')], [{ id: 'script', text: 'README.md' }]),
    envelope([request({ command: 'echo x', shell: 'powershell', cwd: ref('script') })], [{ id: 'script', text: '.' }]),
    envelope([command({ text_ref: 'script', extra: true })], [{ id: 'script', text: 'echo x' }]),
    envelope([request({ command: ref('script'), shell: 'invalid' })], [{ id: 'script', text: 'echo x' }]),
  ]) assert.equal(parseToolBatch(source).kind, 'error', source);
});

it('边界缺失、错误闭合、歧义行、重复块和额外正文不会截取合法前半批执行', () => {
  const header = manifest([command()]);
  for (const suffix of [
    '@@body script\necho x', '@@body script\necho x\n@@end other',
    '@@body script\necho x\n@@body nested\ny\n@@end nested\n@@end script',
    '@@body script\necho x\n @@end script',
    '@@body script\necho x\n@@end script\nextra',
    '@@body script\nx\n@@end script\n@@body script\ny\n@@end script',
    '@@body manifest\nx\n@@end manifest', '@@body script\nx\n@@end script\n',
    '@@body script\n\0\n@@end script',
  ]) {
    const parsed = parseToolBatch(wrapToolTextEnvelope(header + '\n' + suffix));
    assert.equal(parsed.kind, 'error', suffix);
    if (parsed.kind === 'error') assert.equal(parsed.jsonBody, undefined, '边界不明确时要求完整重发，不建可猜测的草稿');
  }
  assert.equal(parseToolBatch(envelope([command()], [{ id: 'script', text: 'x' }]).slice(0, -4)).kind, 'error');
});

it('普通代码块、资料内嵌正式围栏和多正式容器不执行；长正文不产生伪调用', () => {
  const nested = envelope([command('echo nested')], []);
  assert.equal(parseToolBatch('```python\nprint("hello")\n```').kind, 'none');
  assert.equal(parseToolBatch('``````text\n' + nested + '\n``````').kind, 'none');
  assert.equal(parseToolBatch(nested + '\n' + nested).kind, 'error');
  const source = envelope([command()], [{ id: 'script', text: nested }]);
  const parsed = parseToolBatch(source); assert.equal(parsed.kind, 'batch');
  if (parsed.kind === 'batch') assert.equal(parsed.batch.requests.length, 1);
});

it('带正文容器及块数量有界，不依赖模型提供长度或hash', () => {
  assert.equal(parseToolBatch(envelope([command()], [{ id: 'script', text: 'x'.repeat(200_000) }])).kind, 'error');
  const blocks = Array.from({ length: 101 }, (_, n) => ({ id: 'b' + n, text: 'x' }));
  assert.equal(parseToolBatch(envelope([command()], blocks)).kind, 'error');
});

it('同一长Python文本从JSON字符串与原文块还原相同；原文运输避免反复转义', () => {
  const text = Array.from({ length: 400 }, (_, n) => `values[${n}] = {"title": '中文 "引号"', "path": r'C:\\data\\${n}'}`).join('\n') + '\n';
  const raw = envelope([command()], [{ id: 'script', text }]);
  const encoded = envelope([command(text)], []);
  const a = parseToolBatch(raw); const b = parseToolBatch(encoded);
  assert.equal(a.kind, 'batch'); assert.equal(b.kind, 'batch');
  if (a.kind === 'batch' && b.kind === 'batch') assert.deepEqual(a.batch, b.batch);
  assert.ok(raw.length < encoded.length, '比较相同内容，避免把降错率当作尚未测得的结论');
});
