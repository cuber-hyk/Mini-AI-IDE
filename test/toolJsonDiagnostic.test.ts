import assert from 'node:assert/strict';
import { it } from 'node:test';
import { formatToolJsonDiagnostic } from '../src/shared/toolJsonDiagnostic';
import { parseToolBatch } from '../src/shared/toolProtocol';

const parseError = (source: string): Error => {
  try { JSON.parse(source); } catch (error) { assert.ok(error instanceof Error); return error; }
  throw new Error('测试输入必须是无效 JSON');
};

it('保留真实解析错误和位置，非法工具批次不能产生请求', () => {
  const source = '{"protocol_version":1,"batch_id":"fix","requests":[]} extra';
  const error = parseError(source);
  const result = parseToolBatch('```mini-ai-tools\n' + source + '\n```');
  assert.equal(result.kind, 'error');
  if (result.kind !== 'error') throw new Error('无效 JSON 不应生成工具批次');
  assert.ok(result.error.includes(error.message));
  assert.match(result.error, /本批工具未执行/);
  assert.match(result.error, /第 1 行，第 55 列；偏移 54/);
  assert.match(result.error, /完整、合法的 mini-ai-tools/);
});

it('多行 Unicode 文本的坐标使用 UTF-16；预览标记不拆开代理对', () => {
  const source = '{\n  "中文😀": [1, 2 x]\n}';
  const position = source.indexOf('x');
  const result = formatToolJsonDiagnostic(source, new SyntaxError(`Unexpected token at position ${position}`));
  assert.match(result, /第 2 行，第 17 列/);
  assert.ok(result.includes('  "中文😀": [1, 2 x]'));
  const lines = result.split('\n');
  const preview = lines.findIndex(line => line.includes('"中文😀"'));
  assert.equal(lines[preview + 1]!.indexOf('^'), Array.from('  "中文😀": [1, 2 ').length);
});

it('长行和控制字符只输出短预览，不复制整份源码', () => {
  const source = 'A'.repeat(2000) + '\t' + 'x' + 'B'.repeat(2000);
  const result = formatToolJsonDiagnostic(source, new SyntaxError('Unexpected token at position 2001'));
  assert.ok(result.length < 500);
  assert.ok(result.includes('\\t'));
  assert.ok(result.includes('…'));
  assert.ok(!result.includes('A'.repeat(100)));
});

it('Windows 换行只计一行；源末尾位置可以指出缺少内容的位置', () => {
  const source = '{\r\n "a": }';
  const result = formatToolJsonDiagnostic(source, new SyntaxError('Unexpected token at position 9'));
  assert.match(result, /第 2 行，第 7 列/);
  const eof = formatToolJsonDiagnostic('{"a":', new SyntaxError('Unexpected token at position 5'));
  assert.match(eof, /第 1 行，第 6 列；偏移 5/);
  assert.ok(eof.includes('{"a":\n     ^'));
});

it('EOF 或未知异常没有偏移时保留原因，不捏造行列', () => {
  const source = '{"a":';
  const result = formatToolJsonDiagnostic(source, new SyntaxError('Unexpected end of JSON input'));
  assert.match(result, /Unexpected end of JSON input/);
  assert.ok(!result.includes('位置：'));
  assert.ok(!formatToolJsonDiagnostic(source, 'unknown').includes('位置：'));
  assert.ok(!formatToolJsonDiagnostic(source, new SyntaxError('position 10000')).includes('位置：'));
  const quotedPosition = formatToolJsonDiagnostic('{"a":"at position 1"', new SyntaxError('Unexpected token, "at position 1" is not valid JSON'));
  assert.ok(!quotedPosition.includes('位置：'), '原文里的 position 不能被当成解析器的坐标');
});

it('合法 JSON 保持原始请求，不经过修复或诊断', () => {
  const value = { protocol_version: 1, batch_id: 'inspect', requests: [{ id: 'info', tool: 'get_project_info', args: {} }] };
  const result = parseToolBatch('```mini-ai-tools\n' + JSON.stringify(value) + '\n```');
  assert.deepEqual(result, { kind: 'batch', batch: value });
});
