/** 原生继续生成控件的共用只读谓词；只接纳最新回复正文外页脚或独立控件。 */
export const CONTINUATION_BUTTON = `(element => {
  if (!element || ![element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent]
    .some(label => /^(继续生成|continue generating)$/i.test(String(label || '').trim()))) return false;
  if (!element.getClientRects().length || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
  if (element.classList?.contains('ds-button--disabled') || element.closest('pre,code,[class*="code-block"],[class*="markdown"]')) return false;
  const replies = Array.from(document.querySelectorAll('.ds-assistant-message-main-content'));
  const containing = replies.filter(reply => reply.closest('.ds-message')?.parentElement?.contains(element));
  if (!containing.length) return !element.closest('.ds-message');
  const latest = replies.at(-1);
  const frame = latest?.closest('.ds-message')?.parentElement;
  return containing.length === 1 && containing[0] === latest && !latest.contains(element)
    && replies.filter(reply => frame.contains(reply)).length === 1;
})`;
