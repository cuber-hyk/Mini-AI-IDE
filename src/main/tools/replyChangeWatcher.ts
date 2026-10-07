/** 只读 DOM 变化通知：隔离世界存监听状态，不向网页主世界提供本地能力。 */
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { sessionKeyOf } from '../consumptionStore';
import { DEEPSEEK_SEND_ICON, DEEPSEEK_REGENERATE_ICON } from './replyObservation';
import { CONTINUATION_BUTTON } from './replyContinuation';

export const REPLY_WATCH_WORLD = 1004;
const KEY = '__miniAIReplyChanges';
export function replyWatchScript(action: 'install' | 'wait' | 'stop' | 'navigation' | 'acknowledge', token: string, turn?: number): string {
  const header = `const key = ${JSON.stringify(KEY)}, token = ${JSON.stringify(token)}; const previous = globalThis[key];`;
  if (action === 'stop') return `(() => { ${header} if (previous?.token !== token) return false; previous.dispose(); delete globalThis[key]; return true; })()`;
  if (action === 'navigation') return `(() => { ${header} if (previous?.token !== token) return false; const preserve = previous.newChatTurn; previous.newChatTurn = false; return { preserve, turn: previous.turn }; })()`;
  if (action === 'acknowledge') return `(() => { ${header} if (previous?.token !== token) return false; if (previous.turn <= ${turn === undefined ? 'previous.turn' : JSON.stringify(turn)}) previous.newChatTurn = false; return { turn: previous.turn }; })()`;
  if (action === 'wait') return `(() => { ${header} if (previous?.token !== token) return false; if (previous.dirty) { previous.dirty = false; return { turn: previous.turn }; } return new Promise(resolve => { previous.waiter = resolve; }); })()`;
  return `(() => {
    ${header}
    if (previous) previous.dispose();
    const relevant = '[class*="markdown"],.ds-message,.ds-button,.ds-icon-button,[aria-busy],[data-is-streaming]';
    const inside = node => {
      const element = node.nodeType === 1 ? node : node.parentElement;
      return !!element && !!element.closest(relevant);
    };
    const includes = node => inside(node) || (node.nodeType === 1 && !!node.querySelector(relevant));
    const state = { token, turn: 0, newChatTurn: false, dirty: false, waiter: null, timer: null, observer: null, dispose: null };
    const enabled = element => element && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && !element.classList.contains('ds-button--disabled');
    const icon = (element, prefix) => element && Array.from(element.querySelectorAll('svg path')).some(p => String(p.getAttribute('d') || '').replace(/\\s+/g, ' ').startsWith(prefix));
    const composerSelector = '.ds-button--primary.ds-button--circle';
    const continuationButton = ${CONTINUATION_BUTTON};
    const userAction = event => {
      if (!event.isTrusted) return;
      const button = event.target?.closest?.('[role="button"],button,.ds-button');
      const send = event.type === 'click' && button?.matches(composerSelector) && enabled(button) && icon(button, ${JSON.stringify(DEEPSEEK_SEND_ICON)});
      const regenerate = event.type === 'click' && button?.classList.contains('ds-button--iconLabelTertiary') && enabled(button) && button.getAttribute('aria-disabled') === 'false' && icon(button, ${JSON.stringify(DEEPSEEK_REGENERATE_ICON)});
      const resume = event.type === 'click' && continuationButton(button);
      const composer = document.querySelector(composerSelector);
      const enter = event.type === 'keydown' && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && !event.defaultPrevented && event.target?.matches?.('textarea,[contenteditable="true"]') && enabled(composer) && icon(composer, ${JSON.stringify(DEEPSEEK_SEND_ICON)});
      if (send || regenerate || resume || enter) { state.turn++; state.newChatTurn = !resume && !document.querySelector('.ds-assistant-message-main-content'); }
      else if (event.type === 'click' || (event.type === 'keydown' && ((!event.target?.matches?.('textarea,[contenteditable="true"]')) || (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'))))) state.newChatTurn = false;
      // 只记动作，不读输入内容、不触发采集；后续 DOM 变化才通知主进程。
    };
    document.addEventListener('click', userAction, true);
    document.addEventListener('keydown', userAction, true);
    state.dispose = () => { state.observer.disconnect(); clearTimeout(state.timer); state.waiter?.(false); document.removeEventListener('click', userAction, true); document.removeEventListener('keydown', userAction, true); };
    state.observer = new MutationObserver(records => {
      if (!records.some(record => inside(record.target) || (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(includes)) || (record.type === 'attributes' && includes(record.target)))) return;
      // 只在变化后安排一次合并通知；空闲没有定时器，流式变化不会不断推迟通知。
      if (state.timer !== null || state.dirty) return;
      state.timer = setTimeout(() => {
        state.timer = null;
        state.dirty = true;
        if (state.waiter) { const resolve = state.waiter; state.waiter = null; state.dirty = false; resolve({ turn: state.turn }); }
      }, 150);
    });
    globalThis[key] = state;
    state.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'aria-label', 'title', 'aria-disabled', 'aria-busy', 'data-is-streaming', 'data-tooltip', 'data-tooltip-content', 'data-icon', 'd', 'style', 'hidden'] });
    return true;
  })()`;
}

type ChangeWeb = Pick<WebContents, 'executeJavaScriptInIsolatedWorld' | 'on' | 'removeListener' | 'isDestroyed' | 'getURL'>;
export class ReplyChangeWatcher {
  private enabled = false; private disposed = false; private version = 0;
  private readonly instance = randomUUID();
  private token: string | undefined;
  private abort: (() => void) | undefined;
  private scope = '';
  private consumedTurn = 0;
  private navigation: Promise<unknown> = Promise.resolve();
  private cleanup: Promise<unknown> = Promise.resolve();
  constructor(private readonly web: ChangeWeb, private readonly change: (userTurn: boolean) => Promise<void>,
    private readonly resetBaseline: () => void, private readonly report: (message: string) => void) {
    web.on('dom-ready', this.ready);
    web.on('did-start-navigation', this.navigating);
    web.on('did-navigate-in-page', this.inPage);
    web.on('destroyed', this.destroyed);
  }
  private readonly ready = () => { if (this.enabled) this.restart(); };
  private readonly navigating = (event: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (event.isMainFrame && !event.isSameDocument) { this.stop(); this.resetBaseline(); }
  };
  private readonly inPage = (_event: unknown, url: string, main: boolean) => {
    if (!main || !this.enabled || sessionKeyOf(url) === this.scope) return;
    this.scope = sessionKeyOf(url); this.resetBaseline();
    const token = this.token; const version = this.version;
    if (token) this.navigation = this.execute('navigation', token).then(metadata => {
      if (!this.enabled || this.disposed || this.version !== version || this.scope !== sessionKeyOf(url)) return;
      const value = metadata && typeof metadata === 'object' ? metadata as { turn?: number; preserve?: boolean } : {};
      this.consumedTurn = value.turn ?? this.consumedTurn;
      return this.change(value.preserve === true);
    }).catch(error => { if (this.enabled && this.version === version) { this.stop(); this.report('会话切换检查失败，请手动采集：' + (error instanceof Error ? error.message : String(error))); } });
  };
  private readonly destroyed = () => { void this.dispose(); };
  setEnabled(value: boolean): void {
    if (this.enabled === value || this.disposed) return;
    this.enabled = value;
    if (value) this.restart(); else this.stop();
  }
  reset(): void { if (this.enabled) this.restart(); else this.resetBaseline(); }
  /** 完成后释放首次地址分配关联；自动完成不能清除随后真实发送的新轮。 */
  async acknowledge(manual = false): Promise<void> {
    const token = this.token; const version = this.version;
    if (!token || this.web.isDestroyed()) return;
    const metadata = await this.execute('acknowledge', token, manual ? undefined : this.consumedTurn);
    if (manual && this.version === version && metadata && typeof metadata === 'object' && 'turn' in metadata)
      this.consumedTurn = Math.max(this.consumedTurn, Number(metadata.turn));
  }
  private restart(): void {
    this.stop(); this.resetBaseline();
    if (!this.enabled || this.disposed || this.web.isDestroyed()) return;
    this.scope = sessionKeyOf(this.web.getURL()); this.consumedTurn = 0; this.navigation = Promise.resolve();
    const version = this.version; const token = `${this.instance}:${version}`; this.token = token;
    const cancelled = new Promise<boolean>(resolve => { this.abort = () => resolve(false); });
    void this.run(version, token, cancelled);
  }
  private execute(action: 'install' | 'wait' | 'stop' | 'navigation' | 'acknowledge', token: string, turn?: number): Promise<unknown> {
    return this.web.executeJavaScriptInIsolatedWorld(REPLY_WATCH_WORLD, [{ code: replyWatchScript(action, token, turn) }]);
  }
  private async run(version: number, token: string, cancelled: Promise<boolean>): Promise<void> {
    const current = () => !this.disposed && this.enabled && this.version === version && !this.web.isDestroyed();
    try {
      if (!await this.execute('install', token) || !current()) return;
      // 监听先安装，再建立历史基线；期间的变化保留为一次待通知。
      await this.change(false);
      while (current()) {
        const changed = await Promise.race([this.execute('wait', token), cancelled]);
        if (!changed || !current()) return;
        let navigation;
        do { navigation = this.navigation; await navigation; } while (navigation !== this.navigation);
        if (!current()) return;
        const next = typeof changed === 'object' && changed !== null && 'turn' in changed ? Number(changed.turn) : this.consumedTurn;
        const userTurn = next > this.consumedTurn; this.consumedTurn = Math.max(next, this.consumedTurn);
        await this.change(userTurn);
      }
    } catch (error) {
      if (current()) { this.stop(); this.report('页面变化监听失败，请手动采集或重新开启自动采集：' + (error instanceof Error ? error.message : String(error))); }
    }
  }
  private stop(): void {
    this.version++; this.abort?.(); this.abort = undefined;
    const token = this.token; this.token = undefined;
    if (token && !this.web.isDestroyed()) this.cleanup = this.execute('stop', token).catch(error => {
      if (!this.web.isDestroyed()) this.report('页面监听清理失败：' + (error instanceof Error ? error.message : String(error)));
    });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.enabled = false; this.stop();
    this.web.removeListener('dom-ready', this.ready);
    this.web.removeListener('did-start-navigation', this.navigating);
    this.web.removeListener('did-navigate-in-page', this.inPage);
    this.web.removeListener('destroyed', this.destroyed);
    await this.cleanup;
  }
}
