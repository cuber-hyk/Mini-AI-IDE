/** 提示词示例经过正式解析和真实文件工具，示例包装本身不可执行。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseModelReply } from '../src/shared/returnPath';
import { FORMAT_SPEC, MAX_CUSTOM_FORMAT_SPEC_LENGTH, getFormatSpec, resolveFormatSpec, buildPrompt } from '../src/shared/formatSpec';
import { TOOL_PROTOCOL_PROMPT, TOOL_NAMES, parseToolBatch } from '../src/shared/toolProtocol';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { ToolChanges } from '../src/main/tools/changes';
import { ToolFiles } from '../src/main/tools/files';

function unwrapped(text: string): string {
  const lines = text.trim().split('\n'); const fence = lines.shift();
  assert.match(fence || '', /^`{5,}$/); assert.equal(lines.pop(), fence);
  return lines.join('\n');
}
const expected: Record<string, string> = {
  'src/counter.ts': 'let n = 1;',
  'src/util/format.ts': 'export function formatDate(d: Date): string {\n  return d.toISOString().slice(0, 10);\n}',
  'src/config.ts': 'export const A = 1;\nexport const B = 2;\nexport const C = 3;',
  'src/hello.ts': 'export const greeting = "hello";\nexport const language = "zh";',
  'src/debug.ts': '', 'src/options.ts': 'const size = 2;\nconst enabled = true;',
  'docs/fences.md': '# 说明\n\n````text\n新内容\n````',
  '.env': 'PORT=4000', LICENSE: '新的许可说明', 'empty.txt': '', 'smoke.sh': 'printf "ok\\n"\n',
};
test('完整工具示例可解析，包装及原文上下文只读，实际文件操作符合用户意图', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'format-tool-examples-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const seenTools = new Set<string>();
  for (const spec of [FORMAT_SPEC]) {
    assert.equal(parseToolBatch(spec).kind, 'none', '复制完整提示词不能执行其中的示例');
    assert.equal((spec.match(/示例 \d+｜/g) || []).length, 15);
    for (const [index, example] of spec.split(/示例 \d+｜/).slice(1).entries()) {
      const input = unwrapped(example.split('【我给你的】')[1]!.split('【你该给我的】')[0]!);
      const output = unwrapped(example.split('【你该给我的】')[1]!);
      assert.equal(parseToolBatch(input).kind, 'none');
      const parsed = parseToolBatch(output);
      if (example.startsWith('普通讨论')) { assert.equal(parsed.kind, 'none'); continue; }
      assert.equal(parsed.kind, 'batch', example.split('\n')[0] + ': ' + JSON.stringify(parsed));
      if (parsed.kind !== 'batch') continue;
      const folder = path.join(root, 'example-' + index);
      await fs.mkdir(path.join(folder, 'src'), { recursive: true });
      await fs.writeFile(path.join(folder, 'README.md'), '项目\nTODO first\nlast\n');
      await fs.writeFile(path.join(folder, 'src/main.ts'), 'TODO first\n');
      for (const block of parseModelReply(input).blocks) {
        assert.equal(block.operation, undefined, '原文不能成为修改请求');
        const file = [...input.slice(0, block.start).matchAll(/^### 上下文文件：(.+)$/gm)].at(-1)?.[1];
        if (file) { await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true }); await fs.writeFile(path.join(folder, file), block.code); }
      }
      const files = new FileService(); files.setRoot(folder);
      const changes = new ToolChanges(files, new ReturnPathService(files), () => false, async () => true, () => {});
      const queries = new ToolFiles();
      for (const req of parsed.batch.requests) {
        seenTools.add(req.tool);
        if (req.tool === 'apply_changes') {
          const result = await changes.execute(folder, req) as { status: string };
          assert.equal(result.status, 'done');
          for (const change of req.args.changes as { path: string }[]) assert.equal(await fs.readFile(path.join(folder, change.path), 'utf8'), expected[change.path], change.path);
        } else if (['get_project_info', 'list_directory', 'search_files', 'read_file', 'search_text'].includes(req.tool)) {
          const result = await queries.execute(folder, req.tool, req.args) as any;
          if (req.tool === 'read_file') assert.equal(result.content, '1: 项目\n2: TODO first\n3: last\n');
          if (req.tool === 'search_files') assert.ok(result.files.includes('src/main.ts'));
          if (req.tool === 'search_text') assert.ok(result.matches.some((m: any) => m.path === 'README.md'));
        }
      }
    }
  }
  assert.deepEqual([...seenTools].sort(), [...TOOL_NAMES].sort(), '完整版覆盖所有正式工具');
});
test('任何格式复制和 prompt 组装都提供唯一协议，冲突自定义原文仍逐字保留', () => {
  const custom = '\n自定义：请只输出普通文件代码块。\n';
  const resolved = resolveFormatSpec(custom);
  assert.ok(resolved.startsWith(TOOL_PROTOCOL_PROMPT)); assert.ok(resolved.endsWith(custom));
  const context = { root: null, tree: null, environment: null };
  for (const formatSpec of [resolved, FORMAT_SPEC, custom, '']) {
    const prompt = buildPrompt({ requirement: '修改', context, formatSpec });
    assert.equal(prompt.split(TOOL_PROTOCOL_PROMPT).length - 1, 1);
    assert.ok(prompt.endsWith(formatSpec));
  }
});
test('自定义格式原文（含前后空行）组装后逐字保留', () => {
  const custom = '\n\n  我的格式原文  \n\n';
  const prompt = buildPrompt({ requirement: '修改', context: { root: null, tree: null, environment: null }, formatSpec: custom });
  assert.ok(prompt.endsWith(custom));
});
test('唯一内置模板包含全部示例，自定义为空时不缺失协议', () => {
  assert.equal(getFormatSpec(), FORMAT_SPEC);
  for (const custom of [null, undefined, '', '   ', '\n\t  \r\n']) assert.equal(resolveFormatSpec(custom), FORMAT_SPEC);
});
test('唯一自定义内容逐字保留为强制协议后的补充', () => {
  const custom = '\n\n【表达风格】\n说明保持简洁\n\n';
  assert.equal(resolveFormatSpec(custom), TOOL_PROTOCOL_PROMPT + '\n\n' + custom);
});

test('MAX_CUSTOM_FORMAT_SPEC_LENGTH：是一个足够写完整套约定的合理上限', () => {
  // 低于默认模板长度就说明"连默认都存不进去"，那是配置错误
  assert.ok(MAX_CUSTOM_FORMAT_SPEC_LENGTH >= FORMAT_SPEC.length, '上限不应小于内置完整版的长度');
  assert.ok(MAX_CUSTOM_FORMAT_SPEC_LENGTH <= 20000, '上限不应大到失去约束意义');
});
