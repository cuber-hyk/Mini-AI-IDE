export interface DeepSeekAccount { id: string; name: string }
export interface DeepSeekAccountState { activeId: string; accounts: DeepSeekAccount[] }

export const DEFAULT_DEEPSEEK_ACCOUNT_ID = 'default';

/** 分区只由应用生成的稳定账号编号决定，不接收路径或任意分区名。 */
export function deepseekAccountPartition(id: string): string {
  if (id === DEFAULT_DEEPSEEK_ACCOUNT_ID) return 'persist:postcheck';
  if (typeof id !== 'string' || !/^account-[1-9]\d*$/.test(id)) throw new Error('DeepSeek 账号编号无效');
  const number = Number(id.slice('account-'.length));
  if (!Number.isSafeInteger(number) || `account-${number}` !== id) throw new Error('DeepSeek 账号编号无效');
  return `persist:postcheck-ds-${number}`;
}
