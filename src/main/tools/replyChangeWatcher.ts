/** 只读 DOM 变化通知：隔离世界存监听状态，不向网页主世界提供本地能力。 */
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { sessionKeyOf } from '../consumptionStore';
import { isFirstPromptSession } from '../firstPromptSession';
import { DEEPSEEK_SEND_ICON, DEEPSEEK_REGENERATE_ICON, REPLY_NODES } from './replyObservation';
import { CONTINUATION_BUTTON } from './replyContinuation';
import { traceCollection, traceScope } from './collectionTrace';

export const REPLY_WATCH_WORLD = 1004;
const KEY = '__miniAIReplyChanges';
export function replyWatchScript(action: 'install' | 'wait' | 'stop' | 'navigation' | 'acknowledge' | 'local-submit', token: string): string {
  const header = `const key = ${JSON.stringify(KEY)}, token = ${JSON.stringify(token)}; const previous = globalThis[key];`;
  if (action === 'stop') return `(() => { ${header} if (previous?.token !== token) return false; previous.dispose(); delete globalThis[key]; return true; })()`;
  if (action === 'local-submit') return `(() => { ${header} if (previous?.token !== token) return false; previous.submitAt = Date.now(); previous.handoffCancelled = false; return true; })()`;
  if (action === 'navigation') return `(() => { ${header}
    if (previous?.token !== token) return false;
    const url = new URL(location.href), next = (url.protocol === 'file:' ? 'null' : url.origin) + url.pathname;
    const from = previous.scope;
    const reply = previous.replyNodes().at(-1);
    const firstSession = ${isFirstPromptSession.toString()};
    // 官网真实发送与本地主动发送共用一次首页交接记录；它只证明地址连续性，回复仍须独立核验结束。
    const marked = previous.submitAt > 0 && Date.now() - previous.submitAt < 8000;
    const generating = previous.generating();
    const action = previous.lastAction;
    const handoffCancelled = previous.handoffCancelled;
    previous.submitAt = 0;
    const preserve = firstSession(from, next)
      && !handoffCancelled
      && (marked || (!!reply && !previous.initialReplies.includes(reply)) || generating);
    previous.scope = next;
    previous.handoffCancelled = false;
    clearTimeout(previous.history?.timer);
    previous.history = preserve ? null : { reply, generating: previous.generating(), ready: false, timer: null };
    previous.dirty = false; previous.historyReady = false; previous.generated = false; clearTimeout(previous.timer); previous.timer = null;
    previous.lastAction = 'none';
    return { preserve, turn: previous.turn, marked, generating, handoffCancelled, action, replyCount: previous.replyNodes().length, from, to: next };
  })()`;
  if (action === 'acknowledge') return `(() => { ${header} if (previous?.token !== token) return false; return { turn: previous.turn }; })()`;
  if (action === 'wait') return `(() => { ${header} if (previous?.token !== token) return false; if (previous.dirty) { previous.dirty = false; const historyReady = previous.historyReady, generated = previous.generated; previous.historyReady = false; previous.generated = false; return { turn: previous.turn, historyReady, generated, scope: previous.scope }; } return new Promise(resolve => { previous.waiter = resolve; }); })()`;
  return `(() => {
    ${header}
    if (previous) previous.dispose();
    const relevant = '[class*="markdown"],.ds-message,.ds-button,.ds-icon-button,[aria-busy],[data-is-streaming]';
    const inside = node => {
      const element = node.nodeType === 1 ? node : node.parentElement;
      return !!element && !!element.closest(relevant);
    };
    const includes = node => inside(node) || (node.nodeType === 1 && !!node.querySelector(relevant));
    const replyNodes = () => { ${REPLY_NODES} return nodes; };
    const page = new URL(location.href);
    const state = { token, scope: (page.protocol === 'file:' ? 'null' : page.origin) + page.pathname, replyNodes, initialReplies: replyNodes(), generating: null, history: null, historyReady: false, generated: false, turn: 0, dirty: false, waiter: null, timer: null, observer: null, dispose: null, submitAt: 0, handoffCancelled: false, lastAction: 'none' };
    state.generating = () => {
      const visible = element => !!element && element.getClientRects().length > 0;
      if (Array.from(document.querySelectorAll('[aria-busy="true"],[data-is-streaming="true"]')).some(visible)) return true;
      return Array.from(document.querySelectorAll('button,[role="button"],.ds-button,.ds-icon-button')).some(element => visible(element)
        && /停止生成|停止回答|停止响应|stop generating|stop response|^stop$/i.test([element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-tooltip'), element.getAttribute('data-tooltip-content'), element.getAttribute('data-icon'), element.textContent].filter(Boolean).join(' ').trim()));
    };
    const enabled = element => element && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && !element.classList.contains('ds-button--disabled');
    const icon = (element, prefix) => element && Array.from(element.querySelectorAll('svg path')).some(p => String(p.getAttribute('d') || '').replace(/\\s+/g, ' ').startsWith(prefix));
    const composerSelector = '.ds-button--primary.ds-button--circle';
    const continuationButton = ${CONTINUATION_BUTTON};
    const userAction = event => {
      if (!event.isTrusted) return;
      // 每次真实动作先作废旧记录；只有当前已识别的发送/回车才建立一次新交接记录。
      state.submitAt = 0;
      const button = event.target?.closest?.('[role="button"],button,.ds-button');
      const send = event.type === 'click' && button?.matches(composerSelector) && enabled(button) && icon(button, ${JSON.stringify(DEEPSEEK_SEND_ICON)});
      const regenerate = event.type === 'click' && button?.classList.contains('ds-button--iconLabelTertiary') && enabled(button) && button.getAttribute('aria-disabled') === 'false' && icon(button, ${JSON.stringify(DEEPSEEK_REGENERATE_ICON)});
      const resume = event.type === 'click' && continuationButton(button);
      const composer = document.querySelector(composerSelector);
      const enter = event.type === 'keydown' && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && !event.defaultPrevented && event.target?.matches?.('textarea,[contenteditable="true"]') && enabled(composer) && icon(composer, ${JSON.stringify(DEEPSEEK_SEND_ICON)});
      if (send || regenerate || resume || enter) state.turn++;
      // 用户可能打开历史，且历史节点先于导航检查挂载；不得用该新节点复活已取消的交接。
      state.handoffCancelled = !(send || enter);
      state.lastAction = send ? 'send' : enter ? 'enter' : regenerate ? 'regenerate' : resume ? 'resume' : 'other';
      if (send || enter) state.submitAt = Date.now();
      // 只记动作，不读输入内容、不触发采集；后续 DOM 变化才通知主进程。
    };
    document.addEventListener('click', userAction, true);
    document.addEventListener('keydown', userAction, true);
    state.dispose = () => { state.observer.disconnect(); clearTimeout(state.timer); clearTimeout(state.history?.timer); state.waiter?.(false); document.removeEventListener('click', userAction, true); document.removeEventListener('keydown', userAction, true); };
    state.observer = new MutationObserver(records => {
      if (!records.some(record => inside(record.target) || (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(includes)) || (record.type === 'attributes' && includes(record.target)))) return;
      if (state.history) {
        const reply = state.replyNodes().at(-1);
        const startedGenerating = !state.history.generating && state.generating();
        if (!startedGenerating && !state.history.ready && (!reply || reply === state.history.reply)) return;
        state.historyReady = !startedGenerating;
        clearTimeout(state.history.timer);
        if (startedGenerating) { state.history = null; state.generated = true; }
        else {
          state.history.ready = true;
          // 历史分批挂载期间只更新基线；500ms安静窗口不是AI回复结束判据。
          state.history.timer = setTimeout(() => { state.history = null; }, 500);
        }
      }
      // 只在变化后安排一次合并通知；空闲没有定时器，流式变化不会不断推迟通知。
      if (state.timer !== null || state.dirty) return;
      state.timer = setTimeout(() => {
        state.timer = null;
        state.dirty = true;
        if (state.waiter) { const resolve = state.waiter; state.waiter = null; state.dirty = false; const historyReady = state.historyReady, generated = state.generated; state.historyReady = false; state.generated = false; resolve({ turn: state.turn, historyReady, generated, scope: state.scope }); }
      }, 150);
    });
    globalThis[key] = state;
    state.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'aria-label', 'title', 'aria-disabled', 'aria-busy', 'data-is-streaming', 'data-tooltip', 'data-tooltip-content', 'data-icon', 'd', 'style', 'hidden'] });
    return { hasReplies: state.initialReplies.length > 0 };
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
  private navigationHistory = false;
  private navigation: Promise<unknown> = Promise.resolve();
  private cleanup: Promise<unknown> = Promise.resolve();
  constructor(private readonly web: ChangeWeb, private readonly change: (userTurn: boolean) => Promise<void>,
    private readonly resetBaseline: (preserve?: boolean, awaitHistory?: boolean, generated?: boolean) => void, private readonly report: (message: string) => void,
    private readonly scopeChanged: (session: string) => void = () => {}) {
    web.on('dom-ready', this.ready);
    web.on('did-start-navigation', this.navigating);
    web.on('did-navigate-in-page', this.inPage);
    web.on('destroyed', this.destroyed);
  }
  private readonly ready = () => { if (this.enabled) { this.restart(this.navigationHistory); this.navigationHistory = false; } };
  private readonly navigating = (event: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (event.isMainFrame && !event.isSameDocument) { traceCollection('watcher.full-navigation', { history: true }); this.navigationHistory = true; this.stop(); this.resetBaseline(false, true); }
  };
  private readonly inPage = (_event: unknown, url: string, main: boolean) => {
    if (!main || sessionKeyOf(url) === this.scope) return;
    const previousScope = this.scope;
    this.scope = sessionKeyOf(url);
    // 计数与待发送必须观察每次真实切换，不能被后面的异步导航元数据合并吞掉。
    this.scopeChanged(this.scope);
    if (!this.enabled) return;
    const token = this.token; const version = this.version;
    traceCollection('watcher.navigation-start', { from: traceScope(previousScope), to: traceScope(this.scope), version, hasToken: !!token });
    if (token) this.navigation = this.execute('navigation', token).then(metadata => {
      if (!this.enabled || this.disposed || this.version !== version || this.scope !== sessionKeyOf(url)) return;
      const value = metadata && typeof metadata === 'object' ? metadata as { turn?: number; preserve?: boolean; marked?: boolean; generating?: boolean; handoffCancelled?: boolean; action?: string; replyCount?: number; from?: string; to?: string } : {};
      traceCollection('watcher.navigation-result', { from: value.from ? traceScope(value.from) : traceScope(previousScope), to: value.to ? traceScope(value.to) : traceScope(this.scope), preserve: value.preserve === true, turn: value.turn ?? null, marked: value.marked ?? null, generating: value.generating ?? null, handoffCancelled: value.handoffCancelled ?? null, action: value.action ?? null, replyCount: value.replyCount ?? null });
      this.resetBaseline(value.preserve === true, value.preserve !== true);
      this.consumedTurn = value.turn ?? this.consumedTurn;
      // 导航只建立内容基线，不等待工具执行，避免与页面变化处理互相阻塞。
      if (value.preserve === true) void this.change(false).catch(error => this.report('会话切换后的采集失败：' + (error instanceof Error ? error.message : String(error))));
    }).catch(error => { if (this.enabled && this.version === version) { this.resetBaseline(false, true); this.stop(); this.report('会话切换检查失败，请手动采集：' + (error instanceof Error ? error.message : String(error))); } });
    else this.resetBaseline(false, true);
  };
  private readonly destroyed = () => { void this.dispose(); };
  setEnabled(value: boolean): void {
    if (this.enabled === value || this.disposed) return;
    this.enabled = value;
    traceCollection('watcher.enabled', { value });
    this.navigationHistory = false;
    if (value) this.restart(); else this.stop();
  }
  reset(): void { if (this.enabled) this.restart(); else this.resetBaseline(); }
  async settleNavigation(): Promise<void> { let pending; do { pending = this.navigation; await pending; } while (pending !== this.navigation); }
  /** 手动采集消费已通知的动作；动作只取消待回传结果，不授予采集资格。 */
  async acknowledge(manual = false): Promise<void> {
    const token = this.token; const version = this.version;
    if (!token || this.web.isDestroyed()) return;
    const metadata = await this.execute('acknowledge', token);
    if (manual && this.version === version && metadata && typeof metadata === 'object' && 'turn' in metadata)
      this.consumedTurn = Math.max(this.consumedTurn, Number(metadata.turn));
  }
  /** 本地主动提交即将发送：保存短期标记，首页交接在回复与生成态都不可观测时仍保留新轮基线。 */
  async markLocalSubmit(): Promise<void> {
    const token = this.token;
    if (!token || this.disposed || this.web.isDestroyed()) return;
    traceCollection('watcher.local-submit', { scope: traceScope(this.scope), version: this.version });
    await this.execute('local-submit', token);
  }
  private restart(awaitHistory = false): void {
    this.stop(); this.resetBaseline(false, awaitHistory);
    if (!this.enabled || this.disposed || this.web.isDestroyed()) return;
    this.scope = sessionKeyOf(this.web.getURL()); this.consumedTurn = 0; this.navigation = Promise.resolve();
    traceCollection('watcher.restart', { awaitHistory, scope: traceScope(this.scope), version: this.version });
    const version = this.version; const token = `${this.instance}:${version}`; this.token = token;
    const cancelled = new Promise<boolean>(resolve => { this.abort = () => resolve(false); });
    void this.run(version, token, cancelled);
  }
  private execute(action: 'install' | 'wait' | 'stop' | 'navigation' | 'acknowledge' | 'local-submit', token: string): Promise<unknown> {
    return this.web.executeJavaScriptInIsolatedWorld(REPLY_WATCH_WORLD, [{ code: replyWatchScript(action, token) }]);
  }
  private async run(version: number, token: string, cancelled: Promise<boolean>): Promise<void> {
    const current = () => !this.disposed && this.enabled && this.version === version && !this.web.isDestroyed();
    try {
      const installed = await this.execute('install', token);
      if (!installed || !current()) return;
      traceCollection('watcher.installed', { scope: traceScope(this.scope), hasReplies: !!(installed && typeof installed === 'object' && 'hasReplies' in installed && installed.hasReplies === true) });
      if (typeof installed === 'object' && 'hasReplies' in installed && installed.hasReplies === true) this.resetBaseline(false, true);
      // 监听先安装，再建立历史基线；期间的变化保留为一次待通知。
      await this.change(false);
      while (current()) {
        const changed = await Promise.race([this.execute('wait', token), cancelled]);
        if (!changed || !current()) return;
        let navigation;
        do { navigation = this.navigation; await navigation; } while (navigation !== this.navigation);
        if (!current()) return;
        if (typeof changed === 'object' && changed !== null && 'scope' in changed && changed.scope !== this.scope) continue;
        traceCollection('watcher.change', { scope: traceScope(this.scope), changed: typeof changed === 'object' && changed !== null ? changed : null, consumedTurn: this.consumedTurn });
        // 实际生成可能在150ms通知合并期间结束；已见证据不能把完整首回复重置为历史。
        if (typeof changed === 'object' && changed !== null && 'generated' in changed && changed.generated === true) this.resetBaseline(false, false, true);
        else if (typeof changed === 'object' && changed !== null && 'historyReady' in changed && changed.historyReady === true) this.resetBaseline(false, true);
        const next = typeof changed === 'object' && changed !== null && 'turn' in changed ? Number(changed.turn) : this.consumedTurn;
        const userTurn = next > this.consumedTurn; this.consumedTurn = Math.max(next, this.consumedTurn);
        traceCollection('watcher.dispatch', { userTurn, turn: next, historyReady: typeof changed === 'object' && changed !== null && 'historyReady' in changed ? changed.historyReady : null, generated: typeof changed === 'object' && changed !== null && 'generated' in changed ? changed.generated : null });
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
