/** 首页首发只可交接一次官方同源会话地址；调用方另核验实际点击与同文档事件。 */
export function isFirstPromptSession(from: string, to: string): boolean {
  try {
    const source = new URL(from); const target = new URL(to);
    return source.origin === 'https://chat.deepseek.com' && source.pathname === '/' && target.origin === source.origin && /^\/a\/chat\/s\/[a-zA-Z0-9_-]+$/.test(target.pathname);
  } catch { return false; }
}
