import assert from 'node:assert/strict';
import { it } from 'node:test';
import { CHANNELS } from '../src/shared/contract';
import type { ToolState } from '../src/shared/toolProtocol';
import { projectToolWorkspaceStatus, registerToolWorkspaceStatus } from '../src/main/toolWorkspaceStatus';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createToolIntegration } from '../src/main/tools/integration';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';

function state(patch: Partial<ToolState> = {}): ToolState {
  return { config: { permission: 'full', automatic: false, dirtyPolicy: 'ask', completionSound: true, autoCopyResults: true, sendIntervalSeconds: 3 }, results: [], message: 'C:\\private\\notes.txt', busy: false, ...patch };
}

it('顶栏摘要仅保留展示字段，结果正文、路径、权限和错误详情不会进入载荷', () => {
  const summary = projectToolWorkspaceStatus(state({
    results: [{ batch_id: 'secret-batch', request_id: 'secret-request', tool: 'read_file', status: 'failed', error: 'C:\\private\\secret.txt', data: { text: 'SECRET' } }],
    continuation: { phase: 'paused', message: '自动发送暂停：C:\\private\\secret.txt' },
  }));
  assert.deepEqual(Object.keys(summary).sort(), ['automatic', 'count', 'message', 'phase']);
  assert.equal(summary.phase, 'paused'); assert.equal(summary.count, 1);
  assert.doesNotMatch(JSON.stringify(summary), /private|secret|SECRET|permission|read_file/);
});

it('工具授权和回传暂停明显可见，正常 waiting_user 不被标记为失败', () => {
  const approval = projectToolWorkspaceStatus(state({ busy: true, results: [{ batch_id: 'b', request_id: 'r', tool: 'read_file', status: 'pending_permission' }] }));
  assert.equal(approval.phase, 'approval');
  const waiting = projectToolWorkspaceStatus(state({ continuation: { phase: 'waiting_user', message: '等待你发送需求' } }));
  assert.equal(waiting.phase, 'waiting_user');
  const paused = projectToolWorkspaceStatus(state({ continuation: { phase: 'paused', message: '连续 5 次批次校验失败，已停止自动发送' } }));
  assert.match(paused.message, /连续批次校验失败/);
  const resultPaused = projectToolWorkspaceStatus(state({ resultReturn: { canSend: false, attachmentCount: 0, phase: 'paused', message: '发送结果无法确认' } }));
  assert.equal(resultPaused.phase, 'paused'); assert.match(resultPaused.message, /无法确认/);
});

it('真实倒计时和运输状态同步到顶栏，工具失败仍保留可见标识', () => {
  const dueAt = Date.now() + 3000;
  assert.deepEqual(projectToolWorkspaceStatus(state({ config: { ...state().config, automatic: true }, continuation: { phase: 'countdown', message: '工具结果就绪', dueAt } })),
    { phase: 'countdown', message: '工具结果等待回传', count: 0, automatic: true, dueAt });
  assert.equal(projectToolWorkspaceStatus(state({ resultReturn: { canSend: false, attachmentCount: 1, phase: 'sending', message: '正在发送' } })).phase, 'sending');
  assert.equal(projectToolWorkspaceStatus(state({ busy: true })).phase, 'running');
  assert.equal(projectToolWorkspaceStatus(state({ batchError: { status: 'failed', error: 'secret' } })).phase, 'failed');
});

it('查询与恢复仅供顶栏主 frame 零参数使用，初始加载和销毁不泄漏执行能力', () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: any[] = []; let destroyed = false; let opened = 0;
  const webbar = { mainFrame: {}, isDestroyed: () => destroyed, send: (...args: any[]) => sent.push(args) };
  const owner = registerToolWorkspaceStatus({ ipc: { handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any, webbar: webbar as any, open: () => { opened++; return { toolsVisible: true }; } });
  const trusted = { sender: webbar, senderFrame: webbar.mainFrame };
  for (const channel of owner.channels) {
    const invoke = handlers.get(channel)!;
    assert.throws(() => invoke({ sender: {}, senderFrame: {} }), /主 frame/);
    assert.throws(() => invoke({ sender: webbar, senderFrame: {} }), /主 frame/);
    assert.throws(() => invoke(trusted, undefined), /不接受参数/);
    assert.throws(() => invoke(trusted, { permission: 'full' }), /不接受参数/);
  }
  assert.equal(handlers.get(CHANNELS.getToolWorkspaceStatus)!(trusted).phase, 'loading');
  assert.equal(opened, 0);
  handlers.get(CHANNELS.openToolWorkspace)!(trusted); assert.equal(opened, 1);
  owner.publish(state({ busy: true }));
  assert.equal(sent.length, 1); assert.equal(sent[0][0], CHANNELS.toolWorkspaceStatus);
  assert.equal(handlers.get(CHANNELS.getToolWorkspaceStatus)!(trusted).phase, 'running');
  const queried = handlers.get(CHANNELS.getToolWorkspaceStatus)!(trusted); queried.message = 'tampered';
  assert.equal(handlers.get(CHANNELS.getToolWorkspaceStatus)!(trusted).message, '工具执行中');
  destroyed = true; owner.publish(state()); assert.equal(sent.length, 1);
});

it('后台命令真实失败或超时明确显示，其他命令仍运行也不能掩盖失败', () => {
  for (const data of [{ status: 'failed' }, { status: 'stopped', timed_out: true }]) {
    const results: ToolState['results'] = [{ batch_id: 'b', request_id: 'cmd', tool: 'run_command', status: 'done', data }];
    assert.equal(projectToolWorkspaceStatus(state({ results })).phase, 'failed');
    assert.equal(projectToolWorkspaceStatus(state({ results, busy: true, hasRunningProcesses: true })).phase, 'failed');
  }
  assert.equal(projectToolWorkspaceStatus(state({ results: [{ batch_id: 'b', request_id: 'query', tool: 'get_process_output', status: 'done', data: { status: 'failed' } }] })).phase, 'done');
  assert.equal(projectToolWorkspaceStatus(state({ results: [{ batch_id: 'b', request_id: 'cmd', tool: 'run_command', status: 'done', data: { status: 'stopped', timed_out: false } }] })).phase, 'done');
});

it('真实工具批次与自动回传的状态变化同步广播顶栏，即使详情标签没有打开', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-status-broadcast-'));
  let integration: Awaited<ReturnType<typeof createToolIntegration>> | undefined;
  let finishWatcher: ((value: unknown) => void) | undefined;
  try {
    const notifications: ToolState[] = []; const editorNotifications: ToolState[] = [];
    const handlers = new Map<string, (...args: any[]) => any>();
    const editor: any = { mainFrame: {}, isDestroyed: () => false, send(channel: string, value: ToolState) { if (channel === CHANNELS.toolState) editorNotifications.push(value); } };
    const files = new FileService(); files.setRoot(root);
    const reply = '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: 'status', requests: [{ id: 'read', tool: 'get_project_info', args: {} }] }) + '\n```';
    const web: any = Object.assign(new EventEmitter(), {
      getURL: () => 'https://chat.deepseek.com/a/chat/status', isDestroyed: () => false,
      executeJavaScript: async () => ({ replies: [reply], completion: 'complete' }),
      executeJavaScriptInIsolatedWorld: async (_world: number, entries: { code: string }[]) => {
        if (entries[0]!.code.includes('previous.waiter = resolve')) return new Promise(resolve => { finishWatcher = resolve; });
        if (entries[0]!.code.includes('previous.dispose();')) { finishWatcher?.(false); finishWatcher = undefined; }
        return true;
      },
    });
    integration = await createToolIntegration({
      ipc: { handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any, editor, web, files,
      returnPath: new ReturnPathService(files), workspace: { editor: { isDirty: () => false }, run: (action: any) => action() } as any,
      storePath: path.join(root, 'state.json'), disabled: false,
      ask: async () => ({ response: 0, checkboxChecked: false }), notifyFile() {}, copy() {}, notifyState(value) { notifications.push(value); },
      sender: { async send() { return { ok: false, error: '官网已有输入' }; }, async cancel() {}, async dispose() {} },
    });
    await integration.configure({ automatic: true, sendIntervalSeconds: 0 });
    await integration.accept(reply, 'complete');
    for (let attempt = 0; integration.getState().continuation?.phase !== 'paused' && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(notifications.some(value => value.results[0]?.status === 'done'), '正常执行完成会更新摘要');
    for (const phase of ['countdown', 'sending', 'paused']) assert.ok(notifications.some(value => value.continuation?.phase === phase), phase);
    assert.ok(notifications.some(value => value.resultReturn?.phase === 'sending'));
    assert.ok(notifications.some(value => value.resultReturn?.phase === 'paused'));
    assert.equal(notifications.length, editorNotifications.length, '顶部摘要同步全部实际广播，不只工具执行状态');
    assert.deepEqual(notifications, editorNotifications);
  } finally { await integration?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
