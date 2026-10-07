/** 当前工具结果的唯一网页写入口；仅官方 DeepSeek、隔离世界、一次发送。 */
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { sessionKeyOf } from '../consumptionStore';
import { DEEPSEEK_SEND_ICON } from './replyObservation';
import { CONTINUATION_BUTTON } from './replyContinuation';

export const RESULT_SEND_WORLD = 1005;
const KEY = '__miniAIResultSend';
type SendWeb = Pick<WebContents, 'getURL' | 'isDestroyed' | 'executeJavaScriptInIsolatedWorld' | 'on' | 'removeListener'>;
export type WebSendResult = { ok: boolean; error?: string; uncertain?: boolean };
type SendOptions = { allowLocalFixture?: boolean };

function sendScript(token: string, text: string, scope: string, fixture: boolean): string {
  return `(() => {
    const key = ${JSON.stringify(KEY)}, token = ${JSON.stringify(token)}, payload = ${JSON.stringify(text.replace(/\r\n?/g, '\n'))}, scope = ${JSON.stringify(scope)};
    const previous = globalThis[key];
    if (previous) return { ok: false, error: '页面仍有等待发送的结果' };
    const inScope = () => { const current = new URL(location.href); return ((current.origin === 'https://chat.deepseek.com' && current.protocol === 'https:') || (${fixture} && current.protocol === 'file:')) && (current.protocol === 'file:' ? 'null' : current.origin) + current.pathname === scope; };
    if (!inScope()) return { ok: false, error: '网页或会话已变化' };
    const visible = e => !!e && e.isConnected && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const outside = e => !e.closest('pre,code,[class*="code-block"],[class*="markdown"],.ds-message');
    const selector = 'button,[role="button"],.ds-button,.ds-icon-button';
    const labels = e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('data-tooltip'), e.getAttribute('data-tooltip-content'), e.textContent].filter(Boolean).join(' ').trim();
    const interrupted = ${CONTINUATION_BUTTON};
    const stateOfPage = () => {
      const buttons = Array.from(document.querySelectorAll(selector)).filter(visible);
      if (buttons.some(e => /停止生成|停止回答|停止响应|stop generating|stop response|^stop$/i.test(labels(e))) || Array.from(document.querySelectorAll('[aria-busy="true"],[data-is-streaming="true"]')).some(visible)) return 'generating';
      if (buttons.some(interrupted)) return 'interrupted';
      return 'idle';
    };
    const enabled = e => !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !e.classList.contains('ds-button--disabled');
    const controls = () => {
      const inputs = Array.from(document.querySelectorAll('textarea')).filter(visible);
      const sends = Array.from(document.querySelectorAll('.ds-button.ds-button--primary.ds-button--filled.ds-button--circle')).filter(e => visible(e) && outside(e) && Array.from(e.querySelectorAll('svg path')).some(p => String(p.getAttribute('d') || '').replace(/\\s+/g, ' ').startsWith(${JSON.stringify(DEEPSEEK_SEND_ICON)})));
      if (inputs.length !== 1 || sends.length !== 1 || !outside(inputs[0])) return null;
      const input = inputs[0], send = sends[0];
      // 只接纳不含回复正文的局部共同容器；全页面共同祖先不能证明 composer 关联。
      for (let box = input.parentElement, depth = 0; box && depth < 6; box = box.parentElement, depth++) {
        if (box === document.body || box === document.documentElement || box.querySelector('.ds-message,[class*="markdown"]')) return null;
        if (box.contains(send)) return { input, send };
      }
      return null;
    };
    const found = controls();
    if (!found) return { ok: false, error: '无法唯一识别网页输入框与发送控件，请手动发送' };
    const { input, send } = found;
    if (stateOfPage() !== 'idle') return { ok: false, error: '网页仍在生成或等待继续生成' };
    if (input.disabled || input.readOnly || input.value !== '') return { ok: false, error: '网页输入框已有内容或不可编辑，未覆盖草稿' };
    if (input.maxLength >= 0 && payload.length > input.maxLength) return { ok: false, error: '工具结果超过网页输入框长度限制' };
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return { ok: false, error: '网页输入控件不可识别' };
    return new Promise(resolve => {
      const state = { token, clicked: false, done: false, timer: null, cancel: null };
      const owns = () => input.isConnected && input.value === payload;
      const clearOwned = () => {
        if (!state.clicked && owns()) { setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); }
      };
      const finish = result => {
        if (state.done) return;
        state.done = true; clearTimeout(state.timer);
        try { if (!result.ok && !state.clicked) clearOwned(); } catch { result = { ok: false, error: '未发送结果的清理失败，请检查网页输入框', uncertain: true }; }
        if (globalThis[key] === state) delete globalThis[key];
        resolve(result);
      };
      state.cancel = () => finish({ ok: false, error: '自动发送已取消', ...(state.clicked ? { uncertain: true } : {}) });
      globalThis[key] = state;
      try { setter.call(input, payload); input.dispatchEvent(new Event('input', { bubbles: true })); }
      catch { return finish({ ok: false, error: '网页输入失败，已停止发送' }); }
      const started = Date.now(); let clickedAt = 0;
      const poll = () => {
        try {
        if (state.done) return;
        if (!inScope()) return finish({ ok: false, error: '网页会话已变化', ...(state.clicked ? { uncertain: true } : {}) });
        if (state.clicked) {
          if ((input.isConnected && input.value === '') || stateOfPage() === 'generating') return finish({ ok: true });
          if (Date.now() - clickedAt >= 3000) return finish({ ok: false, error: '发送后未确认网页接收，已停止且不会重试', uncertain: true });
        } else {
          const current = controls();
          if (!current || current.input !== input || current.send !== send) return finish({ ok: false, error: '网页发送控件已变化' });
          if (!owns()) return finish({ ok: false, error: '网页输入已被修改，自动发送暂停' });
          if (input.disabled || input.readOnly || stateOfPage() !== 'idle') return finish({ ok: false, error: '网页输入不可编辑或仍在生成' });
          if (input.maxLength >= 0 && payload.length > input.maxLength) return finish({ ok: false, error: '工具结果超过网页输入框长度限制' });
          if (enabled(send)) {
            state.clicked = true; clickedAt = Date.now();
            // 点击前所有检查在同一同步任务完成；点击之后绝不重试或清理可能已提交内容。
            HTMLElement.prototype.click.call(send);
          } else if (Date.now() - started >= 3000) return finish({ ok: false, error: '网页发送按钮未就绪，请手动发送' });
        }
        state.timer = setTimeout(poll, 25);
        } catch { finish({ ok: false, error: '网页发送检查失败，已停止且不会重试', ...(state.clicked ? { uncertain: true } : {}) }); }
      };
      // 留出一轮事件循环，使关闭开关、用户输入和导航可在点击前取消。
      state.timer = setTimeout(poll, 25);
    });
  })()`;
}

function cancelScript(token: string): string {
  return `(() => { const state = globalThis[${JSON.stringify(KEY)}]; if (state?.token !== ${JSON.stringify(token)}) return false; const result = { ok: false, error: '自动发送已取消', ...(state.clicked ? { uncertain: true } : {}) }; state.cancel(); return result; })()`;
}

export class WebResultSender {
  private token: string | undefined;
  private disposed = false;
  private generation = 0;
  private cancellationFailed = false;
  private abort: ((result: WebSendResult) => void) | undefined;
  private cleanup: Promise<unknown> = Promise.resolve();
  private scope = '';
  constructor(private readonly web: SendWeb, private readonly options: SendOptions = {}) {
    web.on('did-start-navigation', this.navigating);
    web.on('did-navigate-in-page', this.inPage);
    web.on('destroyed', this.destroyed);
  }
  private readonly navigating = (event: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (event.isMainFrame && !event.isSameDocument) void this.cancel();
  };
  private readonly inPage = (_event: unknown, url: string, main: boolean) => {
    if (main && sessionKeyOf(url) !== this.scope) void this.cancel();
  };
  private readonly destroyed = () => { void this.dispose(); };

  async send(text: string, expectedSession: string): Promise<WebSendResult> {
    if (this.disposed || this.web.isDestroyed()) return { ok: false, error: '网页已关闭' };
    if (this.cancellationFailed) return { ok: false, error: '网页取消状态未确认，自动发送已停止，请重新打开网页', uncertain: true };
    if (this.token) return { ok: false, error: '已有结果正在发送' };
    if (!text.trim()) return { ok: false, error: '工具结果为空' };
    const generation = this.generation;
    await this.cleanup;
    if (generation !== this.generation) return { ok: false, error: '自动发送已取消' };
    if (this.disposed || this.web.isDestroyed()) return { ok: false, error: '网页已关闭' };
    if (this.cancellationFailed) return { ok: false, error: '网页取消状态未确认，自动发送已停止，请重新打开网页', uncertain: true };
    const raw = this.web.getURL(); let url: URL;
    try { url = new URL(raw); } catch { return { ok: false, error: '网页地址不可识别' }; }
    if (url.origin !== 'https://chat.deepseek.com' && !(this.options.allowLocalFixture && url.protocol === 'file:'))
      return { ok: false, error: '自动发送仅支持官方 DeepSeek 网页' };
    if (sessionKeyOf(raw) !== expectedSession) return { ok: false, error: '网页会话已变化' };
    // 等待清理期间其他调用可能已开始，必须再核验唯一正在发送的批次。
    if (this.token) return { ok: false, error: '已有结果正在发送' };
    const token = randomUUID(); this.token = token; this.scope = expectedSession;
    const cancelled = new Promise<WebSendResult>(resolve => { this.abort = resolve; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<WebSendResult>(resolve => { timeout = setTimeout(() => {
      void this.cancel(); resolve({ ok: false, error: '网页发送等待超时，已停止且不会重试', uncertain: true });
    }, 7500); });
    try {
      const result: unknown = await Promise.race([this.web.executeJavaScriptInIsolatedWorld(RESULT_SEND_WORLD, [{ code: sendScript(token, text, expectedSession, this.options.allowLocalFixture === true) }]), cancelled, bounded]);
      if (result && typeof result === 'object' && 'ok' in result && typeof result.ok === 'boolean') return result as WebSendResult;
      return { ok: false, error: '网页发送状态不可识别，已停止且不会重试', uncertain: true };
    } catch {
      // 渲染进程异常可能发生在点击后，不能推断为未发送。
      return { ok: false, error: '网页发送检查失败，已停止且不会重试', uncertain: true };
    } finally {
      clearTimeout(timeout);
      if (this.token === token) { this.token = undefined; this.abort = undefined; }
    }
  }

  async cancel(): Promise<void> {
    this.generation++;
    const token = this.token;
    if (!token) { await this.cleanup; return; }
    const abort = this.abort;
    // 保留 token 至脚本返回，清理过程中不接受第二次发送。
    if (!this.web.isDestroyed()) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const unconfirmed = new Promise<WebSendResult>(resolve => { timeout = setTimeout(() => {
        this.cancellationFailed = true;
        resolve({ ok: false, error: '网页取消状态未确认，自动发送已停止', uncertain: true });
      }, 1000); });
      this.cleanup = Promise.race([Promise.resolve().then(() => this.web.executeJavaScriptInIsolatedWorld(RESULT_SEND_WORLD, [{ code: cancelScript(token) }])), unconfirmed]).then(result => {
        abort?.(result && typeof result === 'object' && 'ok' in result ? result as WebSendResult : { ok: false, error: '网页已变化，自动发送已取消', uncertain: true });
      }).catch(() => { this.cancellationFailed = true; abort?.({ ok: false, error: '网页检查失败，自动发送已取消', uncertain: true }); }).finally(() => clearTimeout(timeout));
    }
    else abort?.({ ok: false, error: '网页已关闭，自动发送已取消', uncertain: true });
    await this.cleanup;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.web.removeListener('did-start-navigation', this.navigating);
    this.web.removeListener('did-navigate-in-page', this.inPage);
    this.web.removeListener('destroyed', this.destroyed);
    await this.cancel();
  }
}
