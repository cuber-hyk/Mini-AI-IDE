import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';
import { LocalPromptAttachments, MAX_PROMPT_ATTACHMENT_BYTES, MAX_PROMPT_ATTACHMENTS } from '../src/main/localPromptAttachments';

it('切项目清空期间尚未完成的旧附件不再回流，且不清除新项目附件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-prompt-attachments-'));
  try {
    const file = path.join(root, 'draft.md'); await fs.writeFile(file, '# 需求');
    const attachments = new LocalPromptAttachments();
    const old = attachments.stage([file]);
    const rejected = assert.rejects(old, /项目已切换/);
    attachments.clear();
    const [fresh] = attachments.stageClipboardImage('clipboard-image.png', 'image/png', new Uint8Array([1]));
    await rejected;
    assert.equal((await attachments.resolve([fresh!.id])).length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('只暂存用户选择的受支持文档和图片，网页侧只得到元数据与一次性 ID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-prompt-attachments-'));
  try {
    const file = path.join(root, '设计稿.md'); await fs.writeFile(file, '# 需求');
    const attachments = new LocalPromptAttachments();
    const [item] = await attachments.stage([file]);
    assert.deepEqual(item && Object.keys(item).sort(), ['id', 'mediaType', 'name', 'size']);
    assert.equal(item?.name, '设计稿.md'); assert.equal(item?.mediaType, 'text/markdown');
    const [data] = await attachments.resolve([item!.id]);
    let received = Buffer.alloc(0);
    for await (const chunk of data!.stream()) received = Buffer.concat([received, Buffer.from(chunk)]);
    assert.equal(received.toString(), '# 需求');
    assert.equal(attachments.remove(item!.id), true);
    await assert.rejects(() => attachments.resolve([item!.id]), /附件已失效/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('拒绝目录、不支持类型、超出官网单文件上限及超过附件数量的提交', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-prompt-attachments-'));
  try {
    const attachments = new LocalPromptAttachments();
    const directory = path.join(root, 'folder'); await fs.mkdir(directory);
    const unsupported = path.join(root, 'script.js'); await fs.writeFile(unsupported, 'x');
    const oversized = path.join(root, 'large.pdf'); await fs.writeFile(oversized, 'x'); await fs.truncate(oversized, MAX_PROMPT_ATTACHMENT_BYTES + 1);
    await assert.rejects(() => attachments.stage([directory]), /只能添加文件/);
    await assert.rejects(() => attachments.stage([unsupported]), /暂不支持/);
    await assert.rejects(() => attachments.stage([oversized]), /100 MB/);
    const files: string[] = [];
    for (let i = 0; i <= MAX_PROMPT_ATTACHMENTS; i++) {
      const file = path.join(root, `file-${i}.txt`); await fs.writeFile(file, 'x'); files.push(file);
    }
    await assert.rejects(() => attachments.stage(files), /最多添加/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('发送前复核附件是否仍存在且未变化', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-prompt-attachments-'));
  try {
    const file = path.join(root, 'notes.txt'); await fs.writeFile(file, 'before');
    const attachments = new LocalPromptAttachments(); const [item] = await attachments.stage([file]);
    await fs.writeFile(file, 'changed-size');
    await assert.rejects(() => attachments.resolve([item!.id]), /附件已变化/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('剪贴板图片只接纳明确的图片 MIME 与有限字节，并可流式用于网页上传', async () => {
  const attachments = new LocalPromptAttachments();
  assert.throws(() => attachments.stageClipboardImage('clipboard-image.svg', 'image/svg+xml', new Uint8Array([1])), /无效|支持/);
  assert.throws(() => attachments.stageClipboardImage('clipboard-image.png', 'image/jpeg', new Uint8Array([1])), /格式/);
  const [item] = attachments.stageClipboardImage('clipboard-image.png', 'image/png', new Uint8Array([1, 2, 3]));
  assert.equal(item!.mediaType, 'image/png'); assert.equal(item!.size, 3);
  const [resolved] = await attachments.resolve([item!.id]); const chunks: number[] = [];
  for await (const chunk of resolved!.stream()) chunks.push(...chunk);
  assert.deepEqual(chunks, [1, 2, 3]);
});
