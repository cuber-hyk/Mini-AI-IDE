/** 用真实临时文件验证解析、应用、读盘与撤销，确保区间外内容不丢失。 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { parseModelReply } from '../src/shared/returnPath';

it('新增预览不落盘，应用创建多级目录，撤销恢复不存在状态并返回片段身份', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-create-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new FileService(); files.setRoot(root); const service = new ReturnPathService(files);
  const block = parseModelReply('### 文件：demo/backend/seed.ts\n````\nconst seed = 1;\n````').blocks[0]!;
  const preview = await service.prepareChange(block);
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.fileExists, false); assert.equal(preview.before, ''); assert.equal(preview.after, block.code);
  assert.deepEqual(await fs.readdir(root), []);
  const source = { collectionId: 'create', index: 2 };
  const result = await service.applyChange({ filePath: block.filePath!, block, expectedFileExists: false, source });
  assert.equal(result.ok, true); assert.equal(result.created, true); assert.equal(result.mode, 'create-file');
  assert.equal(await fs.readFile(path.join(root, block.filePath!), 'utf8'), block.code);
  assert.deepEqual(await service.undoLast(), { ok: true, filePath: block.filePath, deleted: true, ...source });
  assert.deepEqual(await fs.readdir(root), []); assert.equal(service.undoCount, 0);
});

it('新建忽略范围长度而完整写入，缺少路径即使传入目标也拒绝', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-create-range-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new FileService(); files.setRoot(root); const service = new ReturnPathService(files);
  const block = parseModelReply('### 文件：nested/new.txt\n### 范围：1-99\n````\nfirst\nsecond\n````').blocks[0]!;
  const preview = await service.prepareChange(block);
  assert.equal(preview.ok, true); assert.deepEqual(await fs.readdir(root), []);
  if (!preview.ok) return;
  assert.equal(preview.after, 'first\nsecond');
  assert.equal((await service.applyChange({ filePath: block.filePath!, block })).created, true);
  assert.equal(await fs.readFile(path.join(root, block.filePath!), 'utf8'), 'first\nsecond');
  assert.equal((await service.undoLast()).deleted, true);
  const missingPath = { ...block, filePath: null };
  assert.equal((await service.prepareChange(missingPath, 'guess.txt')).ok, false);
  assert.equal((await service.applyChange({ filePath: 'guess.txt', block: missingPath })).reason, 'path-missing');
  assert.deepEqual(await fs.readdir(root), []); assert.equal(service.undoCount, 0);
});

it('已有文件缺少范围阻塞，不以新内容长度猜区间或覆盖全文', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-range-required-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'head\noriginal\ntail');
  const files = new FileService(); files.setRoot(root); const service = new ReturnPathService(files);
  const block = parseModelReply('### 文件：a.txt\n````\nnew\n````').blocks[0]!;
  assert.equal((await service.prepareChange(block)).ok, false);
  assert.equal((await service.applyChange({ filePath: 'a.txt', block })).reason, 'range-missing');
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'head\noriginal\ntail');
  assert.equal(service.undoCount, 0);
});

it('只读命令与元数据冲突不能通过应用接口写入文件', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-readonly-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new FileService(); files.setRoot(root); const service = new ReturnPathService(files);
  const command = parseModelReply('```bash\nnpm install\n```').blocks[0]!;
  assert.equal((await service.applyChange({ filePath: 'commands.sh', block: command })).reason, 'read-only-content');
  const invalid = { ...command, kind: undefined, filePath: 'new.txt', validationError: '文件标题冲突' };
  assert.equal((await service.applyChange({ filePath: 'new.txt', block: invalid })).reason, 'metadata-invalid');
  assert.deepEqual(await fs.readdir(root), []);
});

it('预览后同名目标出现时拒绝覆盖，原有目标消失时也不静默新建', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-create-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new FileService(); files.setRoot(root); const service = new ReturnPathService(files);
  const block = parseModelReply('### 文件：new.txt\n````\nAI\n````').blocks[0]!;
  assert.equal((await service.prepareChange(block)).ok, true);
  await fs.writeFile(path.join(root, 'new.txt'), 'another application');
  assert.equal((await service.applyChange({ filePath: 'new.txt', block, expectedFileExists: false })).reason, 'target-changed');
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'another application');
  await fs.unlink(path.join(root, 'new.txt'));
  assert.equal((await service.applyChange({ filePath: 'new.txt', block, expectedFileExists: true })).reason, 'target-changed');
  assert.deepEqual(await fs.readdir(root), []); assert.equal(service.undoCount, 0);
});

it('新增后修改拒绝撤销，撤销新建只清理本次创建且仍为空的目录', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-create-undo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'existing'));
  const files = new FileService(); files.setRoot(root); const service = new ReturnPathService(files);
  const block = parseModelReply('### 文件：existing/new/file.txt\n````\nAI\n````').blocks[0]!;
  assert.equal((await service.applyChange({ filePath: block.filePath!, block })).ok, true);
  await fs.writeFile(path.join(root, block.filePath!), 'user content');
  assert.equal((await service.undoLast()).ok, false); assert.equal(service.undoCount, 1);
  assert.equal(await fs.readFile(path.join(root, block.filePath!), 'utf8'), 'user content');
  await fs.writeFile(path.join(root, block.filePath!), block.code);
  await fs.writeFile(path.join(root, 'existing/new/keep.txt'), 'keep');
  assert.equal((await service.undoLast()).deleted, true);
  assert.equal(await fs.readFile(path.join(root, 'existing/new/keep.txt'), 'utf8'), 'keep');
  assert.equal((await fs.stat(path.join(root, 'existing'))).isDirectory(), true);
});

it('新增空文件的撤销删除文件，已有空文件的撤销仍保留空文件', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-create-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new FileService(); files.setRoot(root); const service = new ReturnPathService(files);
  const base = parseModelReply('### 文件：empty.txt\n````\nAI\n````').blocks[0]!;
  const block = { ...base, code: '' };
  assert.equal((await service.applyChange({ filePath: 'empty.txt', block })).created, true);
  assert.equal((await service.undoLast()).deleted, true); assert.deepEqual(await fs.readdir(root), []);
  await fs.writeFile(path.join(root, 'empty.txt'), '');
  assert.equal((await service.applyChange({ filePath: 'empty.txt', block: { ...base, range: { start: 1, end: 1 } }, expectedOriginal: '' })).created, undefined);
  assert.equal((await service.undoLast()).deleted, undefined);
  assert.equal(await fs.readFile(path.join(root, 'empty.txt'), 'utf8'), '');
});

it('目录目标和超限新增内容不能降级为创建', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-create-limit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'directory'));
  const files = new FileService(3); files.setRoot(root); const service = new ReturnPathService(files);
  const block = parseModelReply('### 文件：new.txt\n````\nlong content\n````').blocks[0]!;
  assert.equal((await service.prepareChange(block)).ok, false);
  assert.equal((await service.applyChange({ filePath: 'new.txt', block })).ok, false);
  assert.equal((await service.prepareChange({ ...block, filePath: 'directory', code: 'a' })).ok, false);
  assert.deepEqual(await fs.readdir(root), ['directory']); assert.equal(service.undoCount, 0);
});

it('绝对路径应用按根目录内相对路径记录，改名失效不能漏掉撤销', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-undo-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const absolute = path.join(root, 'a.txt'); await fs.writeFile(absolute, 'original');
  const files = new FileService(); files.setRoot(root); const service = new ReturnPathService(files);
  const block = parseModelReply('### 文件：a.txt\n### 范围：1-1\n````\nAI\n````').blocks[0]!;
  assert.equal((await service.applyChange({ filePath: absolute, block, expectedOriginal: 'original' })).filePath, 'a.txt');
  assert.deepEqual(service.describeSnapshots().map(s => s.relPath), ['a.txt']);
  await fs.rename(absolute, path.join(root, 'renamed.txt')); service.invalidate('a.txt', false);
  assert.equal(service.undoCount, 0); assert.equal((await service.undoLast()).ok, false);
  assert.equal(await fs.readFile(path.join(root, 'renamed.txt'), 'utf8'), 'AI');
});

it('应用后又保存的用户内容不会被旧 AI 撤销覆盖', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-undo-edited-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'original'); const files = new FileService(); files.setRoot(root);
  const service = new ReturnPathService(files); const block = parseModelReply('### 文件：a.txt\n### 范围：1-1\n````\nAI\n````').blocks[0]!;
  assert.equal((await service.applyChange({ filePath: 'a.txt', block, expectedOriginal: 'original' })).ok, true);
  await files.writeFile('a.txt', 'user saved'); assert.equal((await service.undoLast()).ok, false);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'user saved');
});

it('同名文件不能跨根目录撤销，失效清理只影响指定目录下的记录', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-undo-workspace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'A')); await fs.mkdir(path.join(root, 'B')); await fs.mkdir(path.join(root, 'A/sub'));
  await fs.writeFile(path.join(root, 'A/a.txt'), 'A'); await fs.writeFile(path.join(root, 'A/sub/b.txt'), 'A-sub');
  await fs.writeFile(path.join(root, 'B/a.txt'), 'B');
  const files = new FileService(); files.setRoot(path.join(root, 'A')); const service = new ReturnPathService(files);
  for (const filePath of ['a.txt', 'sub/b.txt']) {
    const block = parseModelReply(`### 文件：${filePath}\n### 范围：1-1\n\`\`\`\`\nupdated\n\`\`\`\``).blocks[0]!;
    assert.equal((await service.applyChange({ filePath, block, expectedOriginal: filePath === 'a.txt' ? 'A' : 'A-sub' })).ok, true);
  }
  service.invalidate('sub', true); assert.equal(service.undoCount, 1);
  assert.deepEqual(service.describeSnapshots().map((s) => s.relPath), ['a.txt']);
  files.setRoot(path.join(root, 'B')); assert.equal((await service.undoLast()).ok, false);
  assert.equal(await fs.readFile(path.join(root, 'B/a.txt'), 'utf8'), 'B');
  service.clear(); assert.equal(service.undoCount, 0);
});

it('同文件不同片段及不同批次的撤销返回精确身份', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-ide-undo-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'original');
  const files = new FileService();
  files.setRoot(root);
  const service = new ReturnPathService(files);
  const sources = [{ collectionId: 'first', index: 0 }, { collectionId: 'first', index: 1 }, { collectionId: 'second', index: 0 }];
  for (const source of sources) {
    const block = parseModelReply(`### 文件：a.txt\n### 范围：1-1\n\`\`\`\`\n${source.collectionId}-${source.index}\n\`\`\`\``).blocks[0]!;
    assert.equal((await service.applyChange({ filePath: 'a.txt', block, source, expectedOriginal: (await files.readRawText('a.txt') as { text: string }).text })).ok, true);
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

it('撤销新建核对应用时的文件身份，外部同内容替换保留快照且不删除', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ai-undo-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new FileService(); files.setRoot(root); const service = new ReturnPathService(files);
  const block = parseModelReply('### 文件：new.txt\n### 范围：1-1\n```text\nAI\n```').blocks[0]!;
  assert.equal((await service.applyChange({ filePath: 'new.txt', block })).created, true);
  await fs.rename(path.join(root, 'new.txt'), path.join(root, 'original.txt'));
  await fs.writeFile(path.join(root, 'new.txt'), 'AI');
  const undo = await service.undoLast(); assert.equal(undo.ok, false);
  assert.match(undo.error ?? '', /同名文件替换/); assert.equal(service.undoCount, 1);
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'AI');
  await fs.unlink(path.join(root, 'new.txt')); await fs.rename(path.join(root, 'original.txt'), path.join(root, 'new.txt'));
  assert.equal((await service.undoLast()).deleted, true);
  assert.equal(service.undoCount, 0);
});
