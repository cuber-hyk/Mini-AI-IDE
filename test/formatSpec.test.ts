/** 提示词示例须由真实解析与应用执行，不能只匹配关键字。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeApply, parseModelReply } from '../src/shared/returnPath';
import { FORMAT_SPEC_FULL, FORMAT_SPEC_SHORT, MAX_CUSTOM_FORMAT_SPEC_LENGTH, getFormatSpec, normalizeVariant, resolveFormatSpec, buildPrompt } from '../src/shared/formatSpec';

function unwrapped(text: string): string {
  const lines = text.trim().split('\n'); const fence = lines.shift();
  assert.match(fence || '', /^`{5,}$/); assert.equal(lines.pop(), fence);
  return lines.join('\n');
}
test('两版共用明确三操作协议，废止 AI 定位行号，围栏成对且自适应', () => {
  for (const spec of [FORMAT_SPEC_SHORT, FORMAT_SPEC_FULL]) {
    assert.match(spec, /### 文件：/); assert.match(spec, /### 操作：/);
    assert.match(spec, /替换／新建／覆盖全文/); assert.match(spec, /SEARCH/); assert.match(spec, /REPLACE/);
    assert.match(spec, /逐字/); assert.match(spec, /唯一匹配/); assert.match(spec, /至少四个反引号/);
    assert.match(spec, /成对闭合/); assert.match(spec, /同长度/); assert.match(spec, /多一个/);
    assert.doesNotMatch(spec, /### 范围：|照抄范围|原末行|行首写行号/);
    assert.match(spec, /分多轮/);
    const counts = new Map<number, number>();
    for (const fence of spec.match(/`{3,}/g) || []) counts.set(fence.length, (counts.get(fence.length) || 0) + 1);
    assert.ok([...counts.values()].every(value => value % 2 === 0));
  }
  assert.equal((FORMAT_SPEC_SHORT.match(/示例 \d+｜/g) || []).length, 6);
  assert.equal((FORMAT_SPEC_FULL.match(/示例 \d+｜/g) || []).length, 13);
});
test('两版所有输出示例通过真实 parser 和 computeApply，上下文保持只读', () => {
  for (const spec of [FORMAT_SPEC_SHORT, FORMAT_SPEC_FULL]) {
    const operations = new Set<string>();
    for (const example of spec.split(/示例 \d+｜/).slice(1)) {
      const input = unwrapped(example.split('【我给你的】')[1]!.split('【你该给我的】')[0]!);
      const output = unwrapped(example.split('【你该给我的】')[1]!);
      const inputs = parseModelReply(input).blocks;
      assert.ok(inputs.every(block => !block.operation), '复制原文不能成为写入操作');
      const blocks = parseModelReply(output).blocks;
      if (example.startsWith('错误示例')) {
        assert.equal(blocks.length, 1); assert.ok(blocks[0]!.validationError);
        assert.equal(computeApply(inputs[0]!.code, blocks[0]!).ok, false);
        continue;
      }
      for (const block of blocks) {
        if (!block.operation) { assert.equal(block.kind, 'other'); continue; }
        operations.add(block.operation);
        assert.equal(block.validationError, undefined);
        const context = inputs.find(context => {
          const paths = [...input.slice(0, context.start).matchAll(/^### 上下文文件：(.+)$/gm)];
          return paths.at(-1)?.[1] === block.filePath;
        });
        const result = computeApply(block.operation === 'create' ? '' : context!.code, block);
        assert.equal(result.ok, true, example.split('\n')[0] + ': ' + JSON.stringify(result));
        if (result.ok) {
          assert.equal(result.mode, block.operation);
          assert.doesNotMatch(result.text, /<<<<<<< SEARCH|>>>>>>> REPLACE/);
          if (block.operation !== 'replace') assert.equal(result.text, block.code);
        }
      }
    }
    assert.deepEqual([...operations].sort(), ['create', 'overwrite', 'replace']);
  }
});
test('自定义格式原文（含前后空行）组装后逐字保留', () => {
  const custom = '\n\n  我的格式原文  \n\n';
  const prompt = buildPrompt({ requirement: '修改', context: { root: null, tree: null, environment: null }, formatSpec: custom });
  assert.ok(prompt.endsWith(custom));
});
test('getFormatSpec：默认返回短版，full 返回完整版', () => {
  assert.equal(getFormatSpec(), FORMAT_SPEC_SHORT);
  assert.equal(getFormatSpec('short'), FORMAT_SPEC_SHORT);
  assert.equal(getFormatSpec('full'), FORMAT_SPEC_FULL);
});

/* ------------------------------------------------------------------ *
 * 用户自定义格式要求（系统 prompt 可由用户修改）
 * ------------------------------------------------------------------ */

test('resolveFormatSpec：未设置或只有空白 → 一律回落该版本内置默认', () => {
  // 关键：空串必须**视同未设置**。若允许空格式要求，提示词里就少了唯一让
  // "一键同步"成立的约定，模型输出无法被解析，而且不会有任何报错。
  assert.equal(resolveFormatSpec(null), FORMAT_SPEC_SHORT);
  assert.equal(resolveFormatSpec(undefined), FORMAT_SPEC_SHORT);
  assert.equal(resolveFormatSpec({ short: '' }), FORMAT_SPEC_SHORT);
  assert.equal(resolveFormatSpec({ short: '   ' }), FORMAT_SPEC_SHORT);
  assert.equal(resolveFormatSpec({ short: '\n\t  \r\n' }), FORMAT_SPEC_SHORT);
  assert.equal(resolveFormatSpec(null, 'full'), FORMAT_SPEC_FULL);
  assert.equal(resolveFormatSpec({ full: '' }, 'full'), FORMAT_SPEC_FULL);
});

test('resolveFormatSpec：有自定义内容时原样返回（逐字，不做任何加工）', () => {
  const custom = '【输出格式要求｜我的版本】\n1. 只输出代码，不要解释\n2. 用 ### 文件： 标注';
  assert.equal(resolveFormatSpec({ short: custom }), custom);
  // 前后有空白时保留原文（只在**判断是否为空**时 trim，不 trim 返回值 ——
  // 用户可能有意用前后空行控制提示词里的段落间距）
  const padded = '\n\n' + custom + '\n\n';
  assert.equal(resolveFormatSpec({ short: padded }), padded);
});

test('resolveFormatSpec：简洁版与完整版的自定义互不影响（分版本隔离）', () => {
  // 这是本轮新增的核心不变量：给一版写自定义，另一版必须完全不受影响。
  const s = '简洁版自定义';
  const f = '完整版自定义';
  assert.equal(resolveFormatSpec({ short: s, full: null }, 'full'), FORMAT_SPEC_FULL);
  assert.equal(resolveFormatSpec({ short: null, full: f }, 'short'), FORMAT_SPEC_SHORT);
  assert.equal(resolveFormatSpec({ short: s, full: f }, 'short'), s);
  assert.equal(resolveFormatSpec({ short: s, full: f }, 'full'), f);
});

test('resolveFormatSpec：variant 只在回落默认时起作用', () => {
  assert.equal(resolveFormatSpec(null, 'full'), FORMAT_SPEC_FULL);
  assert.equal(resolveFormatSpec({ full: '自定义' }, 'full'), '自定义');
  // 完整版有自定义、但当前是简洁版 → 简洁版走自己的默认（不被完整版影响）
  assert.equal(resolveFormatSpec({ full: '自定义' }, 'short'), FORMAT_SPEC_SHORT);
});

test('normalizeVariant：任何非 full 的值都归一为 short（IPC 入参不可信）', () => {
  assert.equal(normalizeVariant('full'), 'full');
  assert.equal(normalizeVariant('short'), 'short');
  assert.equal(normalizeVariant('FULL'), 'short');
  assert.equal(normalizeVariant(undefined), 'short');
  assert.equal(normalizeVariant(null), 'short');
  assert.equal(normalizeVariant(123), 'short');
});

test('MAX_CUSTOM_FORMAT_SPEC_LENGTH：是一个足够写完整套约定的合理上限', () => {
  // 低于默认模板长度就说明"连默认都存不进去"，那是配置错误
  assert.ok(MAX_CUSTOM_FORMAT_SPEC_LENGTH >= FORMAT_SPEC_FULL.length, '上限不应小于内置完整版的长度');
  assert.ok(MAX_CUSTOM_FORMAT_SPEC_LENGTH <= 20000, '上限不应大到失去约束意义');
});
