import type { WebPlatform } from './webPlatform';

/** 仅官方平台；ChatGPT 特殊工作区不参与普通对话自动协作。 */
export function webPlatformOf(raw: string): WebPlatform | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.origin === 'https://chat.deepseek.com') return 'deepseek';
    if (url.origin === 'https://chatgpt.com' && (url.pathname === '/' || /^\/c\/[a-zA-Z0-9_-]+$/.test(url.pathname))) return 'chatgpt';
  } catch { /* 未知地址不提供网页能力。 */ }
  return null;
}
