/** 网页同步只读状态与快照；变化监听生命周期由 replyChangeWatcher 拥有。 */
import type { WebContents } from 'electron';
import { collectReply, type CollectResult } from '../replyCollector';
import { sessionKeyOf } from '../consumptionStore';
import type { AutoReply } from './autoCollector';
import { CONTINUATION_BUTTON } from './replyContinuation';

export const DEEPSEEK_SEND_ICON = 'M8.3125 0.980206C8.66767 1.05312 8.97902 1.2042';
export const DEEPSEEK_REGENERATE_ICON = 'M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052';

export const REPLY_NODES = `
  const nodes = Array.from(document.querySelectorAll('[class*="markdown"]')).filter(e => {
    if (e.closest('pre,code')) return false;
    for (let parent = e.parentElement; parent; parent = parent.parentElement) {
      if (/markdown/.test(String(parent.className || ''))) return false;
    }
    return true;
  });
  const reply = nodes.at(-1);
`;

export const COMPLETION_SCRIPT = `(() => {
  const visible = e => !!e && e.getClientRects().length > 0;
  const labels = e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('data-tooltip'), e.getAttribute('data-tooltip-content'), e.getAttribute('data-icon'), e.textContent].filter(Boolean).join(' ');
  const selector = 'button,[role="button"],.ds-button,.ds-icon-button';
  const buttons = Array.from(document.querySelectorAll(selector)).filter(visible);
  if (buttons.some(e => /停止生成|停止回答|停止响应|stop generating|stop response|^stop$/i.test(labels(e).trim())) || Array.from(document.querySelectorAll('[aria-busy="true"],[data-is-streaming="true"]')).some(visible)) return 'generating';
  if (buttons.some(${CONTINUATION_BUTTON})) return 'interrupted';
  ${REPLY_NODES}
  if (!reply) return 'unknown';
  const hasClasses = (e, names) => names.every(name => String(e.className || '').split(/\\s+/).includes(name));
  if (hasClasses(reply, ['ds-assistant-message-main-content'])) {
    // 现场原生按钮没有可读标签；只认当前回复的原生页脚与已知发送图标组合。
    const frame = reply.closest('.ds-message')?.parentElement;
    if (!frame || nodes.filter(node => frame.contains(node)).length !== 1) return 'unknown';
    const outsideCode = e => !reply.contains(e) && !e.closest('pre,code,[class*="code-block"]');
    const enabled = e => !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !hasClasses(e, ['ds-button--disabled']);
    const icon = (e, prefix) => Array.from(e.querySelectorAll('svg path')).some(p => String(p.getAttribute('d') || '').replace(/\\s+/g, ' ').startsWith(prefix));
    const actions = Array.from(frame.querySelectorAll(selector)).filter(e => visible(e) && outsideCode(e) && enabled(e) && hasClasses(e, ['ds-button', 'ds-button--iconLabelTertiary', 'ds-button--icon', 'ds-button--capsule', 'ds-button--xs']));
    const copy = actions.some(e => icon(e, 'M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016'));
    const regenerate = actions.some(e => e.getAttribute('aria-disabled') === 'false' && icon(e, ${JSON.stringify(DEEPSEEK_REGENERATE_ICON)}));
    const read = actions.some(e => e.getAttribute('aria-label') === '朗读');
    // 空输入时发送按钮会禁用，仍代表非生成状态；未知图标不能推断为结束。
    const composers = buttons.filter(e => outsideCode(e) && hasClasses(e, ['ds-button', 'ds-button--primary', 'ds-button--filled', 'ds-button--circle']));
    const send = composers.length === 1 && icon(composers[0], ${JSON.stringify(DEEPSEEK_SEND_ICON)});
    return copy && regenerate && read && send ? 'complete' : 'unknown';
  }
  for (let box = reply, depth = 0; box && depth < 5; box = box.parentElement, depth++) {
    if (nodes.filter(node => box.contains(node)).length > 1) break;
    const actions = Array.from(box.querySelectorAll(selector)).filter(visible);
    if (actions.some(e => !reply.contains(e) && !e.closest('pre,code,[class*="code-block"]') && /复制|copy|重新生成|regenerate/i.test(labels(e)))) return 'complete';
  }
  return 'idle';
})()`;

/** 摘要只用于决定是否重读全文，不能作为回复已结束的判据。 */
export const OBSERVATION_SCRIPT = `(() => {
  const completion = ${COMPLETION_SCRIPT};
  if (completion === 'generating' || completion === 'interrupted' || completion === 'unknown') return { completion, signature: completion };
  ${REPLY_NODES}
  const pres = reply ? reply.querySelectorAll('pre') : document.querySelectorAll('pre');
  const source = reply || pres[pres.length - 1];
  const content = source ? String(source.innerHTML || source.textContent || '') : '';
  let first = 2166136261, second = 5381;
  for (let i = 0; i < content.length; i++) {
    first = Math.imul(first ^ content.charCodeAt(i), 16777619);
    second = Math.imul(second, 33) ^ content.charCodeAt(i);
  }
  return { completion, signature: [nodes.length, pres.length, content.length, first >>> 0, second >>> 0, completion].join(':') };
})()`;

type WebReader = Pick<WebContents, 'getURL' | 'executeJavaScript'>;
export type ReplySnapshot = AutoReply & { collected: CollectResult; signature?: string };
const completionOf = (value: unknown): AutoReply['completion'] => ['generating', 'interrupted', 'complete', 'idle'].includes(String(value)) ? value as AutoReply['completion'] : 'unknown';

/** 全文和结束状态在同一同步脚本读取；轻量探测不能替代此次完整快照。 */
export async function readAutoReply(web: WebReader): Promise<ReplySnapshot> {
  const url = web.getURL(); let completion: AutoReply['completion'] = 'unknown'; let signature: string | undefined;
  const collected = await collectReply({ currentUrl: () => web.getURL(), evaluate: async script => {
    const snapshot: unknown = await web.executeJavaScript(`(() => { const replies = ${script}; const observation = ${OBSERVATION_SCRIPT}; const completion = observation.completion; return {replies,completion,signature:observation.signature}; })()`);
    if (!snapshot || typeof snapshot !== 'object') return [];
    const value = snapshot as { replies?: unknown; completion?: unknown; signature?: unknown };
    completion = completionOf(value.completion);
    signature = typeof value.signature === 'string' ? value.signature : undefined;
    return value.replies;
  } });
  if (web.getURL() !== url) return { url: sessionKeyOf(web.getURL()), text: '', completion: 'unknown', collected: { ...collected, replyText: '' } };
  return { url: sessionKeyOf(url), text: collected.replyText ?? '', completion, collected, ...(signature !== undefined ? { signature } : {}) };
}

/** 主进程缓存上一快照；空闲无变化和生成阶段不重复运行完整采集器。 */
export class ReplyMonitor {
  private cached: ReplySnapshot | undefined;
  constructor(private readonly web: WebReader) {}
  async read(): Promise<AutoReply> {
    const url = this.web.getURL(); const scope = sessionKeyOf(url);
    if (this.cached?.url !== scope) this.cached = undefined;
    const raw: unknown = await this.web.executeJavaScript(OBSERVATION_SCRIPT);
    if (this.web.getURL() !== url) { this.cached = undefined; return { url: sessionKeyOf(this.web.getURL()), text: '', completion: 'unknown' }; }
    const observation = raw && typeof raw === 'object' ? raw as { completion?: unknown; signature?: unknown } : {};
    const completion = completionOf(observation.completion);
    if (completion === 'generating' || completion === 'interrupted' || completion === 'unknown') return { url: scope, text: this.cached?.text ?? '', completion };
    if (typeof observation.signature === 'string' && this.cached?.signature === observation.signature && this.cached.completion === completion) return this.cached;
    const latest = await readAutoReply(this.web);
    this.cached = latest.signature ? latest : undefined;
    return latest;
  }
}
