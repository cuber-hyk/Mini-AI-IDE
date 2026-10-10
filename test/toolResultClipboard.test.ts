import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ResultClipboard } from '../src/main/tools/resultClipboard';
import type { ToolResult, ToolState } from '../src/shared/toolProtocol';

const command: ToolResult = { batch_id: 'current', request_id: 'run', tool: 'run_command', status: 'done', started_at: 100, finished_at: 300, data: { status: 'done', stdout: 'actual', exit_code: 0 } };
const state = (patch: Partial<ToolState> = {}): ToolState => ({ config: { permission: 'full', automatic: true, dirtyPolicy: 'ask', completionSound: false, autoCopyResults: true }, busy: false, results: [command], message: '', completion: { id: 1, batch_id: 'current', outcome: 'success' }, ...patch });

it('批次只复制一次，结果包含完整真实输出与失败信息，通知查询不写剪贴板', () => {
  const copies: string[] = []; const clipboard = new ResultClipboard(value => copies.push(value));
  const current = state({ results: [command, { ...command, request_id: 'failed', status: 'failed', data: { status: 'failed', exit_code: 7, stderr: 'error' } }] });
  clipboard.complete(current); clipboard.complete(current);
  assert.equal(copies.length, 1); assert.deepEqual(JSON.parse(copies[0]!).tool_results, current.results);
  assert.equal(clipboard.notification(current)?.ok, true); assert.equal(copies.length, 1);
});

it('全部请求与后台命令真正结束后才复制，启动回执和局部结果不复制', () => {
  const copies: string[] = []; const clipboard = new ResultClipboard(value => copies.push(value));
  clipboard.complete(state({ busy: true }));
  clipboard.complete(state({ results: [{ ...command, data: { status: 'running', process_id: 'proc-owned' } }] }));
  assert.equal(copies.length, 0);
  clipboard.complete(state()); assert.equal(copies.length, 1);
});

it('读取、搜索、修改和进程工具执行完成均复制本批一次，不要求含运行命令', () => {
  for (const tool of ['get_project_info', 'list_directory', 'search_files', 'read_file', 'search_text', 'apply_changes', 'get_process_output', 'stop_process'] as const) {
    const copies: string[] = []; const clipboard = new ResultClipboard(text => copies.push(text));
    const current = state({ results: [{ ...command, tool, data: { text: '真实结果' } }] });
    clipboard.complete(current); clipboard.complete(current);
    assert.equal(copies.length, 1, tool);
    assert.deepEqual(JSON.parse(copies[0]!).tool_results, current.results);
    assert.equal(clipboard.notification(current)?.ok, true);
  }
});

it('无命令的混合批次也保留工具失败与依赖跳过回执，全部结束后一起复制', () => {
  const copies: string[] = []; const clipboard = new ResultClipboard(text => copies.push(text));
  const current = state({ results: [
    { batch_id: 'current', request_id: 'read', tool: 'read_file', status: 'failed', started_at: 100, finished_at: 300, error: '文件不存在' },
    { batch_id: 'current', request_id: 'dependent', tool: 'search_text', status: 'skipped_dependency', error: '前置读取失败' },
  ] });
  clipboard.complete(current);
  assert.equal(copies.length, 1);
  assert.deepEqual(JSON.parse(copies[0]!).tool_results, current.results);
});

it('配置关闭、取消、未知、未执行和空结果不会覆盖剪贴板，开启设置不追补旧结果', () => {
  for (const patch of [
    { config: { ...state().config, autoCopyResults: false } },
    { completion: { ...state().completion!, cancelled: true } },
    { results: [{ ...command, status: 'unknown' as const }] },
    { results: [{ ...command, finished_at: undefined, data: { status: 'stopped' } }] },
    { results: [{ ...command, status: 'permission_denied' as const, started_at: undefined }] },
    { results: [] },
  ]) {
    let copies = 0; const clipboard = new ResultClipboard(() => copies++);
    clipboard.complete(state(patch as Partial<ToolState>)); clipboard.complete(state());
    assert.equal(copies, 0);
  }
});

it('超时和已清理的单条停止命令自动复制真实部分输出，取消整批及清理中仍不复制', () => {
  for (const status of ['failed', 'cancelled', 'done'] as const) {
    const result = { ...command, status, data: { status: 'stopped', timed_out: status === 'failed', cleanup_pending: false, stdout: 'before-stop' } };
    const copies: string[] = []; const clipboard = new ResultClipboard(text => copies.push(text));
    const current = state({ results: [result] }); clipboard.complete(current); clipboard.complete(current);
    assert.deepEqual(copies, [JSON.stringify({ protocol_version: 1, tool_results: [result] }, null, 2)]);
    for (const blocked of [
      state({ completion: { ...current.completion!, cancelled: true }, results: [result] }),
      state({ results: [{ ...result, data: { ...result.data, cleanup_pending: true } }] }),
    ]) {
      const blockedCopies: string[] = []; new ResultClipboard(text => blockedCopies.push(text)).complete(blocked);
      assert.equal(blockedCopies.length, 0);
    }
  }
});

it('新批次清除旧复制通知；返回旧完成事件也不会再次写剪贴板', () => {
  let copies = 0; const clipboard = new ResultClipboard(() => copies++);
  clipboard.complete(state()); clipboard.complete(state({ completion: undefined } as unknown as Partial<ToolState>));
  assert.equal(clipboard.notification(state()), undefined);
  clipboard.complete(state()); assert.equal(copies, 1);
});

it('复制失败明确通知但不改变工具结果，不能在任意状态广播中暗中重试', () => {
  let calls = 0; const clipboard = new ResultClipboard(() => { calls++; throw new Error('clipboard unavailable'); });
  clipboard.complete(state()); clipboard.complete(state());
  assert.deepEqual(clipboard.notification(state()), { id: 1, ok: false, error: 'clipboard unavailable' });
  assert.equal(calls, 1); assert.equal(state().results[0]?.status, 'done');
});
