import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';
import { ToolAttachments } from '../src/main/tools/attachments';
import { MAX_PROMPT_ATTACHMENTS } from '../src/main/localPromptAttachments';
import type { ToolSelection } from '../src/main/tools/harness';
import type { PromptAttachment } from '../src/shared/localPrompt';
import type { ToolResult } from '../src/shared/toolProtocol';

const selection = (root: string, files: string[], batch_id = 'batch-1'): ToolSelection => ({ root, session: 'session-1', batch: {
  protocol_version: 1, batch_id, requests: files.map((file, index) => ({ id: `attach-${index}`, tool: 'attach_file', args: { path: file } })),
} });
const done = (data: PromptAttachment, index = 0, batch_id = 'batch-1'): ToolResult => ({ batch_id, request_id: `attach-${index}`, tool: 'attach_file', status: 'done', data });

it('当前批图片/PDF/Word返回真实附件描述与字节，不将本地路径或二进制写入结果', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-attachments-'));
  try {
    const files = ['plot.png', 'paper.pdf', 'report.docx'];
    const content = [Buffer.from([137, 80, 78, 71]), Buffer.from('%PDF-1.7'), Buffer.from([80, 75, 3, 4])];
    await Promise.all(files.map((file, index) => fs.writeFile(path.join(root, file), content[index]!)));
    const attachments = new ToolAttachments(); attachments.begin(selection(root, files));
    const metadata: PromptAttachment[] = [];
    for (const file of files) metadata.push(await attachments.stage(root, file, () => true));
    assert.deepEqual(metadata.map(item => item.mediaType), ['image/png', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
    assert.deepEqual(Object.keys(metadata[0]!).sort(), ['id', 'mediaType', 'name', 'size']);
    const resolved = await attachments.resolve(metadata.map((data, index) => done(data, index)));
    for (let index = 0; index < resolved.length; index++) {
      const chunks: Buffer[] = [];
      for await (const chunk of resolved[index]!.stream()) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), content[index]);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('历史结果、伪造描述、错误批次和错误请求不能取得当前暂存附件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-attachments-'));
  try {
    await fs.writeFile(path.join(root, 'a.png'), 'image');
    const attachments = new ToolAttachments(); attachments.begin(selection(root, ['a.png']));
    const data = await attachments.stage(root, 'a.png', () => true);
    for (const result of [done({ ...data, id: 'forged' }), done({ ...data, name: 'other.png' }), done(data, 1), done(data, 0, 'old-batch')])
      await assert.rejects(() => attachments.resolve([result]), /工具附件已失效/);
    attachments.begin(selection(root, ['a.png'], 'batch-2'));
    await assert.rejects(() => attachments.resolve([done(data)]), /工具附件已失效/);
    attachments.reset();
    await assert.rejects(() => attachments.resolve([done(data)]), /工具附件已失效/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('等待中的取消或新选择不会把旧附件带入下一批，未被请求的文件不能暂存', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-attachments-'));
  try {
    await fs.writeFile(path.join(root, 'a.pdf'), 'pdf');
    const attachments = new ToolAttachments(); attachments.begin(selection(root, ['a.pdf']));
    await assert.rejects(() => attachments.stage(root, 'not-requested.pdf', () => true), /请求已失效/);
    let current = true;
    const pending = attachments.stage(root, 'a.pdf', () => current);
    current = false;
    await assert.rejects(() => pending, /请求已失效/);
    const old = attachments.stage(root, 'a.pdf', () => true);
    attachments.begin(selection(root, ['a.pdf'], 'batch-2'));
    await assert.rejects(() => old, /请求已失效|项目已切换/);
    const fresh = await attachments.stage(root, 'a.pdf', () => true);
    assert.equal((await attachments.resolve([done(fresh, 0, 'batch-2')])).length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('拒绝未完成和失败附件的上传，文件变化不能静默遗漏', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-attachments-'));
  try {
    const file = path.join(root, 'a.pdf'); await fs.writeFile(file, 'before');
    const attachments = new ToolAttachments(); attachments.begin(selection(root, ['a.pdf']));
    const data = await attachments.stage(root, 'a.pdf', () => true);
    assert.deepEqual(await attachments.resolve([{ ...done(data), status: 'failed' }, { ...done(data), status: 'running' }]), []);
    await fs.writeFile(file, 'longer-content');
    await assert.rejects(() => attachments.resolve([done(data)]), /附件已变化/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('当前选择累计最多50附件，失败暂存不能突破上限，新选择重新计数', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-attachments-'));
  try {
    await fs.writeFile(path.join(root, 'a.pdf'), 'pdf');
    const attachments = new ToolAttachments(); attachments.begin(selection(root, ['a.pdf']));
    for (let index = 0; index < MAX_PROMPT_ATTACHMENTS; index++) await attachments.stage(root, 'a.pdf', () => true);
    await assert.rejects(() => attachments.stage(root, 'a.pdf', () => true), /最多添加/);
    attachments.begin(selection(root, ['a.pdf'], 'next'));
    assert.equal((await attachments.stage(root, 'a.pdf', () => true)).name, 'a.pdf');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
