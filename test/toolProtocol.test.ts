import assert from 'node:assert/strict';
import { it } from 'node:test';
import { parseToolBatch, TOOL_PROTOCOL_PROMPT } from '../src/shared/toolProtocol';
const batch = (requests: unknown[], id = 'inspect-1') => '````mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: id, requests }) + '\n````';
const read = { id: 'read', tool: 'read_file', args: { path: 'README.md' } };
it('只执行完整正式围栏，正文、普通 JSON 与嵌套示例不能成为调用', () => {
  assert.equal(parseToolBatch(JSON.stringify(read)).kind, 'none');
  assert.equal(parseToolBatch('`````markdown\n' + batch([read]) + '\n`````').kind, 'none');
  assert.equal(parseToolBatch('> ' + batch([read]).replace(/\n/g, '\n> ')).kind, 'none');
  assert.equal(parseToolBatch(batch([read])).kind, 'batch');
  assert.equal(parseToolBatch(batch([read]).slice(0, -4)).kind, 'error');
});
it('方案 A/B、重复 ID、未来依赖和无效参数整批拒绝', () => {
  for (const reply of [batch([read]) + '\n' + batch([read], 'inspect-2'), batch([read, read]),
    batch([{ ...read, depends_on: ['future'] }]), batch([read, { id: 'cmd', tool: 'run_command', args: { command: 'echo x', shell: 'cmd' } }]),
    batch([{ ...read, args: { path: 'x', start_line: 9, end_line: 2 } }])]) assert.equal(parseToolBatch(reply).kind, 'error');
  assert.equal(parseToolBatch(batch([read, { id: 'next', tool: 'list_directory', args: {}, depends_on: ['read'] }])).kind, 'batch');
});
it('正式工具与额外可应用文件块混用不能偷偷只取一半执行', () => {
  const reply = batch([read]) + '\n### 文件：a.txt\n### 操作：新建\n````text\nx\n````';
  assert.equal(parseToolBatch(reply).kind, 'error');
});
it('手动采集同样不能接受旧文件操作，但围栏内示例与原文保持只读', () => {
  const old = '### 文件：a.txt\n### 操作：新建\n````text\nx\n````';
  assert.equal(parseToolBatch(old).kind, 'error');
  assert.equal(parseToolBatch('### 文件：a.txt\n### 操作：新建').kind, 'error');
  assert.equal(parseToolBatch('`````text\n' + old + '\n`````').kind, 'none');
  assert.equal(parseToolBatch('```typescript\n// file: a.ts\nexport const example = 1;\n```').kind, 'none');
  assert.equal(parseToolBatch('### 上下文文件：a.txt\n### 上下文：完整原文\n````text\nx\n````').kind, 'none');
});
it('修改参数确定且保留空白，空新建允许，空 old_string 拒绝', () => {
  assert.equal(parseToolBatch(batch([{ id: 'edit', tool: 'apply_changes', args: { changes: [{ path: 'empty', operation: 'create', content: '' }] } }])).kind, 'batch');
  assert.equal(parseToolBatch(batch([{ id: 'edit', tool: 'apply_changes', args: { changes: [{ path: 'a', operation: 'replace', edits: [{ old_string: '', new_string: 'x' }] }] } }])).kind, 'error');
  assert.match(TOOL_PROTOCOL_PROMPT, /最终确定/); assert.match(TOOL_PROTOCOL_PROMPT, /备选方案/);
});
it('附件必须来自明确 attach_file 请求，拒绝缺失路径与正文或上传地址参数', () => {
  for (const args of [{}, { path: '' }, { path: '   ' }, { path: 1 }, { path: 'paper.pdf', bytes: 'aGVsbG8=' }, { path: 'a.png', url: 'https://example.com' }])
    assert.equal(parseToolBatch(batch([{ id: 'attachment', tool: 'attach_file', args }])).kind, 'error');
  assert.equal(parseToolBatch(batch([{ id: 'attachment', tool: 'attach_file', args: { path: '论文.pdf' } }])).kind, 'batch');
  assert.match(TOOL_PROTOCOL_PROMPT, /done 仅表示当前批已暂存/);
  assert.match(TOOL_PROTOCOL_PROMPT, /受工具权限审批/);
});
