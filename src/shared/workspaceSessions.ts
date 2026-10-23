import { deepseekAccountPartition } from './deepseekAccounts';
import type { WebPlatform } from './webPlatform';

export interface WorkspaceConversation { platform: WebPlatform; accountId: string; conversationId: string }
export interface WorkspaceSession extends WorkspaceConversation { id: string; root: string; title: string }
export interface WorkspaceSessionView extends WorkspaceSession { accountName: string }
export interface WorkspaceSessionsState {
  revision: number;
  sessions: WorkspaceSessionView[];
  current: WorkspaceConversation | null;
  selectedId: string | null;
  canBind: boolean;
  busy: boolean;
  error?: string;
}

function validIdentity(value: WorkspaceConversation): boolean {
  if (!value || typeof value !== 'object' || typeof value.conversationId !== 'string'
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.conversationId)) return false;
  if (value.platform === 'chatgpt') return value.accountId === 'default';
  if (value.platform !== 'deepseek') return false;
  try { deepseekAccountPartition(value.accountId); return true; } catch { return false; }
}

/** 只接纳普通官网的正式会话路径；不保留查询参数、片段或任意导航地址。 */
export function workspaceConversation(platform: WebPlatform, accountId: string, rawUrl: string): WorkspaceConversation | null {
  try {
    if (typeof rawUrl !== 'string' || rawUrl !== rawUrl.trim() || /[\u0000-\u0020\u007f]/.test(rawUrl)) return null;
    const url = new URL(rawUrl);
    if (url.username || url.password) return null;
    const match = platform === 'deepseek' && url.origin === 'https://chat.deepseek.com'
      ? /^\/a\/chat\/s\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname)
      : platform === 'chatgpt' && url.origin === 'https://chatgpt.com'
        ? /^\/c\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname) : null;
    if (!match) return null;
    const identity = { platform, accountId, conversationId: match[1]! };
    return validIdentity(identity) ? identity : null;
  } catch { return null; }
}

/** 导航地址仅由经过校验的身份构造，调用方不能传入 URL。 */
export function workspaceConversationUrl(identity: WorkspaceConversation): string {
  if (!validIdentity(identity)) throw new Error('网页会话身份无效');
  return identity.platform === 'deepseek'
    ? `https://chat.deepseek.com/a/chat/s/${identity.conversationId}`
    : `https://chatgpt.com/c/${identity.conversationId}`;
}

export function sameWorkspaceConversation(a: WorkspaceConversation | null, b: WorkspaceConversation | null): boolean {
  return Boolean(a && b && a.platform === b.platform && a.accountId === b.accountId && a.conversationId === b.conversationId);
}
