/** 本地官网顶栏只显示主进程投影的摘要；恢复工具不授予通用布局或执行权限。 */
import type { IpcMain, WebContents } from 'electron';
import { CHANNELS, type ToolWorkspaceStatus } from '../shared/contract';
import type { ToolState } from '../shared/toolProtocol';

function pauseReason(message: string): string {
  if (message.includes('连续 5 次')) return '回传暂停：连续批次校验失败';
  if (message.includes('无法确认')) return '回传暂停：发送结果无法确认';
  if (/清理失败/.test(message)) return '回传暂停：发送清理失败';
  if (/项目、会话|网页最新回复|网页回复状态/.test(message)) return '回传暂停：项目、会话或网页回复已变化';
  if (/已有输入|草稿|非空/.test(message)) return '回传暂停：官网输入框已有内容';
  if (/拒绝|中断|状态未知/.test(message)) return '回传暂停：工具中断或状态未知';
  if (/旧批|旧结果|已发起新一轮/.test(message)) return '回传暂停：已发起新一轮';
  return '回传暂停：发送未完成，请查看工具详情';
}

export function projectToolWorkspaceStatus(state: ToolState): ToolWorkspaceStatus {
  const base = { count: state.results.length, automatic: state.config.automatic };
  if (state.results.some(result => result.status === 'pending_permission')) return { ...base, phase: 'approval', message: '工具需要批准' };
  if (state.resultReturn?.phase === 'paused' || state.continuation?.phase === 'paused')
    return { ...base, phase: 'paused', message: pauseReason(state.resultReturn?.phase === 'paused' ? state.resultReturn.message : state.continuation!.message) };
  if (state.storageError) return { ...base, phase: 'failed', message: '工具记录加载失败，工具已停用' };
  if (state.batchError || state.results.some(result => {
    const process = result.tool === 'run_command' && result.data as { status?: string; timed_out?: boolean } | undefined;
    return result.status === 'failed' || process && (process.status === 'failed' || process.status === 'stopped' && process.timed_out);
  })) return { ...base, phase: 'failed', message: state.batchError || state.completion?.validation_failed ? '工具批次校验失败' : '工具执行失败' };
  if (state.busy || state.hasRunningProcesses) return { ...base, phase: 'running', message: '工具执行中' };
  const continuation = state.continuation;
  if (continuation?.phase === 'countdown') return { ...base, phase: 'countdown', message: '工具结果等待回传', ...(continuation.dueAt === undefined ? {} : { dueAt: continuation.dueAt }) };
  if (continuation?.phase === 'sending' || state.resultReturn?.phase === 'sending') return { ...base, phase: 'sending', message: '正在回传工具结果' };
  if (continuation?.phase === 'waiting_reply') return { ...base, phase: 'waiting_reply', message: '结果已回传，等待 AI 回复' };
  if (continuation?.phase === 'waiting_user') return { ...base, phase: 'waiting_user', message: '等待需求或新的工具结果' };
  if (state.results.length) return { ...base, phase: 'done', message: '工具批次已结束' };
  return { ...base, phase: 'idle', message: '工具空闲' };
}

interface Options {
  ipc: Pick<IpcMain, 'handle'>;
  webbar: WebContents;
  open: () => unknown;
}

/** 在加载顶栏前注册，工具初始化完成后再 publish，避免首次查询找不到 handler。 */
export function registerToolWorkspaceStatus(options: Options) {
  let status: ToolWorkspaceStatus = { phase: 'loading', message: '正在读取工具状态', count: 0, automatic: false };
  const channels = [CHANNELS.getToolWorkspaceStatus, CHANNELS.openToolWorkspace];
  const actions = [() => ({ ...status }), options.open];
  for (let index = 0; index < channels.length; index++) {
    options.ipc.handle(channels[index]!, (event, ...args: unknown[]) => {
      if (event.sender !== options.webbar || event.senderFrame !== options.webbar.mainFrame) throw new Error('工具摘要仅供本地官网顶栏主 frame 使用');
      if (args.length) throw new Error('工具摘要操作不接受参数');
      return actions[index]!();
    });
  }
  return {
    channels,
    publish(state: ToolState): void {
      status = projectToolWorkspaceStatus(state);
      if (!options.webbar.isDestroyed()) options.webbar.send(CHANNELS.toolWorkspaceStatus, { ...status });
    },
  };
}
