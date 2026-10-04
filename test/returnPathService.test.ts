/** 用真实临时文件验证解析、应用、读盘与撤销，确保区间外内容不丢失。 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { parseModelReply } from '../src/shared/returnPath';

it('同文件不同片段及不同批次的撤销返回精确身份', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-ide-undo-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'original');
  const files = new FileService();
  files.setRoot(root);
  const service = new ReturnPathService(files);
  const sources = [{ collectionId: 'first', index: 0 }, { collectionId: 'first', index: 1 }, { collectionId: 'second', index: 0 }];
  for (const source of sources) {
    const block = parseModelReply(`### 文件：a.txt\n\`\`\`\`\n${source.collectionId}-${source.index}\n\`\`\`\``).blocks[0]!;
    assert.equal((await service.applyChange({ filePath: 'a.txt', block, source })).ok, true);
  }
  for (const source of [...sources].reverse()) {
    assert.deepEqual(await service.undoLast(), { ok: true, filePath: 'a.txt', ...source });
  }
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'original');
});

it('10-10 替换十行后读盘与计算一致，撤销恢复原文件', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-ide-range-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'a.txt');
  const lines = Array.from({ length: 25 }, (_, i) => `原第 ${i + 1} 行`);
  lines[10] = '}';
  lines[11] = '';
  const original = lines.join('\n');
  await fs.writeFile(filePath, original);
  const files = new FileService();
  files.setRoot(root);
  const service = new ReturnPathService(files);
  const replacement = [...Array.from({ length: 7 }, (_, i) => `新增 ${i + 1}`), '}', '', '最后一行'];
  const block = parseModelReply([
    '### 文件：a.txt', '### 范围：10-10', '````', ...replacement, '````',
  ].join('\n')).blocks[0]!;
  const result = await service.applyChange({
    filePath: 'a.txt', block, expectedOriginal: lines[9],
    contextPrev: lines[8], contextNext: lines[10],
  });
  assert.equal(result.ok, true);
  const expected = [...lines.slice(0, 9), ...replacement, ...lines.slice(10)].join('\n');
  assert.equal(result.after, expected);
  assert.equal(await fs.readFile(filePath, 'utf8'), expected);
  assert.equal(service.undoCount, 1);
  assert.equal((await service.undoLast()).ok, true);
  assert.equal(await fs.readFile(filePath, 'utf8'), original);
  assert.equal(service.undoCount, 0);
});

it('原片段变化后拒绝写盘且不产生撤销快照', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-ide-range-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'a.txt');
  const current = 'head\nchanged\ntail';
  await fs.writeFile(filePath, current);
  const files = new FileService();
  files.setRoot(root);
  const service = new ReturnPathService(files);
  const block = parseModelReply('### 文件：a.txt\n### 范围：2-2\n````\nnew\n````').blocks[0]!;
  const result = await service.applyChange({
    filePath: 'a.txt', block, expectedOriginal: 'old', contextPrev: 'head', contextNext: 'tail',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'content-mismatch');
  assert.equal(await fs.readFile(filePath, 'utf8'), current);
  assert.equal(service.undoCount, 0);
});
