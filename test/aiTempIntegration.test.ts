import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createToolIntegration, describeTool } from '../src/main/tools/integration';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { CHANNELS } from '../src/shared/contract';

const batch = (id: string, taskId: string) => '```mini-ai-tools\n' + JSON.stringify({
  protocol_version: 1, batch_id: id, requests: [{ id: 'temp', tool: 'get_ai_temp_dir', args: { task_id: taskId } }],
}) + '\n```';

async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('临时目录工具集成流程未在限定时间内完成');
}

test('AI 临时目录走主进程原有授权与持久去重；拒绝不创建、允许后才创建，重复批不再次执行', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-temp-integration-'));
  const files = new FileService(); files.setRoot(root);
  const handlers = new Map<string, (...args: any[]) => any>();
  const editor: any = { mainFrame: {}, send() {}, isDestroyed: () => false };
  const web: any = Object.assign(new EventEmitter(), {
    getURL: () => 'https://chat.deepseek.com/a/chat/temp-permission', isDestroyed: () => false,
  });
  let allow = false; let approvals = 0;
  const system = await createToolIntegration({
    ipc: { handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn) } as any,
    editor, web, files, returnPath: new ReturnPathService(files),
    workspace: { editor: { isDirty: () => false, current: { documents: [] } }, run: (fn: any) => fn() } as any,
    storePath: path.join(root, 'tool-state.json'), disabled: true,
    ask: async (_title, _message, choices) => {
      approvals++;
      return { response: allow ? 0 : choices.length - 1, checkboxChecked: false };
    },
    notifyFile() {}, copy() {},
  });
  t.after(async () => { await system.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const good = { sender: editor, senderFrame: editor.mainFrame };
  await handlers.get(CHANNELS.setToolConfig)!(good, { permission: 'ask', automatic: false });
  const request: any = { id: 'temp', tool: 'get_ai_temp_dir', args: { task_id: 'scratch-001' } };
  const description = await describeTool(root, request);
  assert.equal(description.external, false);
  assert.equal(description.canRemember, true);
  await system.accept(batch('temp-denied', 'scratch-001'), 'complete');
  await until(() => system.getState().results[0]?.status === 'permission_denied');
  assert.equal(approvals, 1);
  await assert.rejects(fs.access(path.join(root, '.mini-ai-ide')));

  allow = true;
  await system.accept(batch('temp-allowed', 'scratch-001'), 'complete');
  await until(() => system.getState().results[0]?.status === 'done' && !system.getState().busy);
  const result = system.getState().results[0]!;
  const data = result.data as { task_id: string; path: string; relative_path: string; reused: boolean };
  assert.equal(result.tool, 'get_ai_temp_dir');
  assert.equal(data.task_id, 'scratch-001');
  assert.equal(data.reused, false);
  assert.equal(data.relative_path, '.mini-ai-ide/ai-temp/scratch-001');
  assert.equal(data.path, await fs.realpath(path.join(root, data.relative_path)));
  assert.equal(approvals, 2);
  const retained = path.join(data.path, 'retained.txt');
  await fs.writeFile(retained, 'preserved');

  await system.accept(batch('temp-allowed', 'scratch-001'), 'complete');
  await until(() => system.getState().message.includes('未重复执行') && !system.getState().busy);
  assert.equal(approvals, 2);
  assert.equal(await fs.readFile(retained, 'utf8'), 'preserved');
  const persisted = JSON.parse(await fs.readFile(path.join(root, 'tool-state.json'), 'utf8'));
  assert.equal(persisted.ledger.length, 2, '拒绝与允许各记录一次，重复批没有新执行账本');
});
