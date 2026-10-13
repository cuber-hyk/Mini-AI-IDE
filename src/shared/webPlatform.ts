/** 官网平台仅接受固定 ID，不接收网页提供的 URL 或分区。 */
import type { ToolState } from './toolProtocol';
export const WEB_PLATFORMS = {
  deepseek: { url: 'https://chat.deepseek.com/', partition: 'persist:postcheck' },
  chatgpt: { url: 'https://chatgpt.com/', partition: 'persist:postcheck-02' },
} as const;

export type WebPlatform = keyof typeof WEB_PLATFORMS;
export type WebPlatformSwitchBlock = '工具正在执行，完成后可切换' | '后台命令正在运行，结束后可切换' | '正在发送，请稍候';
export interface WebPlatformState { platform: WebPlatform; switching: boolean; error?: string; reloading?: true; switchBlockedReason?: WebPlatformSwitchBlock }

/** 门禁与禁用说明同源；倒计时、等待 AI 和网页生成都不构成切换锁。 */
export function webPlatformSwitchBlock(state: Pick<ToolState, 'busy' | 'hasRunningProcesses' | 'resultReturn' | 'continuation'>, promptSending = false): WebPlatformSwitchBlock | undefined {
  if (state.busy) return '工具正在执行，完成后可切换';
  if (state.hasRunningProcesses) return '后台命令正在运行，结束后可切换';
  if (promptSending || state.resultReturn?.phase === 'sending' || state.continuation?.phase === 'sending') return '正在发送，请稍候';
  return undefined;
}
