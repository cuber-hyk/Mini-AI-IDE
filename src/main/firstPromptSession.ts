/** 首页首发只可交接一次官方同源会话地址；调用方另核验实际点击与同文档事件。 */
export function isFirstPromptSession(from: string, to: string): boolean {
  try {
    const source = new URL(from); const target = new URL(to);
    if (source.username || source.password || target.username || target.password || source.pathname !== '/' || target.origin !== source.origin) return false;
    if (source.origin === 'https://chat.deepseek.com') return /^\/a\/chat\/s\/[a-zA-Z0-9_-]+$/.test(target.pathname);
    return source.origin === 'https://chatgpt.com' && /^\/c\/[a-zA-Z0-9_-]+$/.test(target.pathname);
  } catch { return false; }
}

/** 首发分配前的编码占位地址只允许维持已存在的监听/点击确认，不提供网页读写资格。 */
export function isPendingFirstPromptSession(from: string, to: string): boolean {
  try {
    const source = new URL(from); const target = new URL(to);
    return !source.username && !source.password && !target.username && !target.password
      && source.origin === 'https://chatgpt.com' && source.pathname === '/' && target.origin === source.origin
      && /^\/c\/local-chatgpt%3[aA][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target.pathname);
  } catch { return false; }
}
