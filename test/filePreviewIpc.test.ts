import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';
import { registerFilePreviewIpc } from '../src/main/filePreviewIpc';
import { FileService } from '../src/main/fileService';

it('二进制预览仅允许编辑器主 frame；其他页面和子 frame 无法读取', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-preview-ipc-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.pdf'), '%PDF-1.7'); const files = new FileService(); files.setRoot(root);
  let handler: any; const editor = { id: 1, mainFrame: {} };
  const channels = registerFilePreviewIpc({ handle(channel: string, fn: any) { assert.equal(channel, 'fs:read-file-preview'); handler = fn; } } as any, editor as any, files);
  assert.deepEqual(channels, ['fs:read-file-preview']);
  for (const event of [{ sender: { id: 2 }, senderFrame: editor.mainFrame }, { sender: editor, senderFrame: {} }, { sender: editor, senderFrame: null }]) {
    assert.equal((await handler(event, 'a.pdf', root)).ok, false);
  }
  const event = { sender: editor, senderFrame: editor.mainFrame };
  assert.equal((await handler(event, 'a.pdf', root)).ok, true);
  for (const args of [[42, root], ['a.pdf', null], [null, root], ['a.pdf', `${root}-old`], ['../a.pdf', root]]) assert.equal((await handler(event, ...args)).ok, false);
});
