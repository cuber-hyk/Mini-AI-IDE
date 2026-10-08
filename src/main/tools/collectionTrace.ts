import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import * as path from 'node:path';

const traceFile = path.join(process.cwd(), 'collection-trace.log');
let pendingWrite: Promise<void> = Promise.resolve();

/**
 * 首轮自动采集诊断开关。默认关闭；开启时只输出流程状态和正文长度/哈希，避免记录用户或模型正文。
 * PowerShell: $env:MINI_IDE_COLLECTION_TRACE='1'
 */
export function traceCollection(event: string, data: Record<string, unknown> = {}): void {
  if (process.env.MINI_IDE_COLLECTION_TRACE !== '1') return;
  try {
    const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`;
    pendingWrite = pendingWrite.then(() => appendFile(traceFile, line, 'utf8')).catch(() => { /* 诊断输出不能影响采集链路 */ });
  } catch { /* 诊断输出不能影响采集链路 */ }
}

export function traceText(value: string): { length: number; hash: string } {
  if (process.env.MINI_IDE_COLLECTION_TRACE !== '1') return { length: value.length, hash: '' };
  return { length: value.length, hash: createHash('sha256').update(value).digest('hex').slice(0, 16) };
}

export function traceScope(value: string): { path: string; hash: string } {
  if (process.env.MINI_IDE_COLLECTION_TRACE !== '1') return { path: '', hash: '' };
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/s\/[^/]+(?=\/|$)/, '/s/<id>');
    return { path, hash: createHash('sha256').update(`${url.origin}${url.pathname}`).digest('hex').slice(0, 16) };
  } catch {
    return { path: '<invalid>', hash: createHash('sha256').update(value).digest('hex').slice(0, 16) };
  }
}
