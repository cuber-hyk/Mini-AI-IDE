import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { registerApplicationUpdateIpc } from '../src/main/applicationUpdateIpc';
import { CHANNELS } from '../src/shared/contract';
import type { ApplicationUpdateState } from '../src/shared/applicationUpdate';

function fixture() {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const ipc = { handle(channel: string, listener: Parameters<IpcMain['handle']>[1]) { handlers.set(channel, listener); } };
  const editor = { mainFrame: {} } as WebContents;
  const state: ApplicationUpdateState = { status: 'idle', release: null, percent: 0, busy: false, error: null,
    checked: false, revision: 0, currentVersion: '0.1.1', disabledReason: null };
  const calls: string[] = [];
  const updater = { getState: () => state,
    check: async () => { calls.push('check'); state.revision++; },
    download: async () => { calls.push('download'); state.revision++; },
    install: async () => { calls.push('install'); state.revision++; } };
  const channels = registerApplicationUpdateIpc(ipc, editor, updater);
  const event = { sender: editor, senderFrame: editor.mainFrame } as IpcMainInvokeEvent;
  return { channels, editor, event, calls, state,
    invoke: (channel: string, input = event, ...args: unknown[]) => handlers.get(channel)!(input, ...args) };
}

it('更新状态与动作仅允许本地编辑器主frame，网页和子frame不能查询或安装', async () => {
  const f = fixture();
  for (const channel of f.channels) {
    for (const event of [
      { sender: {}, senderFrame: f.editor.mainFrame },
      { sender: f.editor, senderFrame: {} },
      { sender: f.editor, senderFrame: null },
    ]) await assert.rejects(f.invoke(channel, event as IpcMainInvokeEvent), /仅供本地编辑器/);
  }
  assert.deepEqual(f.calls, []);
});

it('所有更新IPC拒绝额外参数，不能通过路径或URL指挥主进程', async () => {
  const f = fixture();
  for (const channel of f.channels) {
    await assert.rejects(f.invoke(channel, f.event, { url: 'https://example.test', path: 'C:\\other.exe' }), /不接受参数/);
    await assert.rejects(f.invoke(channel, f.event, undefined), /不接受参数/);
  }
  assert.deepEqual(f.calls, []);
});

it('查询状态没有副作用，用户的单一动作返回完成后的主进程状态', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke(CHANNELS.getUpdateState), f.state); assert.deepEqual(f.calls, []);
  for (const [channel, action] of [[CHANNELS.checkForUpdate, 'check'], [CHANNELS.downloadUpdate, 'download'], [CHANNELS.installUpdate, 'install']]) {
    const state = await f.invoke(channel!);
    assert.equal(f.calls.at(-1), action); assert.equal(state.revision, f.calls.length);
  }
  assert.deepEqual(f.calls, ['check', 'download', 'install']);
});
