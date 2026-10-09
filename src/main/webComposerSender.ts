/** 受控网页 composer 运输：仅官方 DeepSeek、隔离世界、一次发送；调用方负责用户需求或真实工具结果授权。 */
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { sessionKeyOf } from './consumptionStore';
import { DEEPSEEK_SEND_ICON } from './tools/replyObservation';
import { CONTINUATION_BUTTON } from './tools/replyContinuation';
import { isFirstPromptSession } from './firstPromptSession';
import type { PromptAttachmentData } from '../shared/localPrompt';
import { traceCollection } from './tools/collectionTrace';

export const COMPOSER_SEND_WORLD = 1005;
const KEY = '__miniAIComposerSend';
const ATTACHMENT_KEY = '__miniAIComposerAttachments';
type SendWeb = Pick<WebContents, 'getURL' | 'isDestroyed' | 'executeJavaScriptInIsolatedWorld' | 'on' | 'removeListener'>;
export type WebSendResult = { ok: boolean; error?: string; uncertain?: boolean; session?: string };
type SendOptions = { allowLocalFixture?: boolean };

function attachmentStartScript(token: string, scope: string, fixture: boolean): string {
  return `(() => {
    const token = ${JSON.stringify(token)}, scope = ${JSON.stringify(scope)};
    const u = new URL(location.href);
    if (!(((u.origin === 'https://chat.deepseek.com' && u.protocol === 'https:') || (${fixture} && u.protocol === 'file:')) || false)) return { ok: false, error: '附件仅支持官方 DeepSeek 网页' };
    if ((u.protocol === 'file:' ? 'null' : u.origin) + u.pathname !== scope) return { ok: false, error: '网页会话已变化' };
    const visible = e => !!e && e.isConnected && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const textareas = Array.from(document.querySelectorAll('textarea')).filter(visible);
    if (textareas.length !== 1 || textareas[0].disabled || textareas[0].readOnly || textareas[0].value !== '') return { ok: false, error: '官网输入框已有草稿或不可编辑，未上传附件' };
    const labels = e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('data-tooltip'), e.textContent].filter(Boolean).join(' ').trim();
    if (Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible).some(e => /停止生成|停止回答|停止响应|stop generating|stop response|^stop$|继续生成|继续回答|continue generating/i.test(labels(e))) || Array.from(document.querySelectorAll('[aria-busy="true"],[data-is-streaming="true"]')).some(visible)) return { ok: false, error: '官网仍在生成或等待继续，未上传附件' };
    const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(e => e.isConnected && !e.disabled);
    if (inputs.length !== 1) return { ok: false, error: '无法唯一识别官网附件控件，请手动上传' };
    const input = inputs[0];
    let composer = null; for (let box = textareas[0].parentElement, depth = 0; box && depth < 12; box = box.parentElement, depth++) { if (box === document.body || box === document.documentElement) break; if (box.contains(input)) { composer = box; break; } }
    const related = Boolean(composer);
    if (!related) return { ok: false, error: '官网附件控件与输入框关系不明确，请手动上传' };
    // 官网附件卡片是控件共同容器的兄弟节点；仅检查有界的外层，不能扩到回复区或整页。
    composer = composer.parentElement;
    if (!composer || composer === document.body || composer === document.documentElement || composer.closest('pre,code,[class*="code-block"],[class*="markdown"],.ds-message') || composer.querySelector('.ds-message,[class*="markdown"]')) return { ok: false, error: '官网附件区域与回复区无法隔离，请手动上传' };
    const existingImages = Array.from(composer.querySelectorAll('img')).filter(visible).length;
    if (input.files?.length || existingImages) return { ok: false, error: '官网附件区已有文件或图片预览，请先移除后重试' };
    globalThis[${JSON.stringify(ATTACHMENT_KEY)}] = { token, scope, input, composer, baselineImages: existingImages, files: [], parts: [], size: 0, name: '', type: '' };
    return { ok: true };
  })()`;
}

function attachmentBeginFileScript(token: string, file: PromptAttachmentData): string {
  return `(() => { const s = globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; if (!s || s.token !== ${JSON.stringify(token)} || s.parts.length || s.name) return false; s.name = ${JSON.stringify(file.name)}; s.type = ${JSON.stringify(file.mediaType)}; s.expected = ${file.size}; s.size = 0; return true; })()`;
}

function attachmentChunkScript(token: string, bytes: Uint8Array): string {
  const base64 = Buffer.from(bytes).toString('base64');
  return `(() => { const s = globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; if (!s || s.token !== ${JSON.stringify(token)} || !s.name) return false; const raw = atob(${JSON.stringify(base64)}), part = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) part[i] = raw.charCodeAt(i); s.parts.push(part); s.size += part.length; return s.size <= s.expected; })()`;
}

function attachmentFinishFileScript(token: string): string {
  return `(() => { const s = globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; if (!s || s.token !== ${JSON.stringify(token)} || !s.name || s.size !== s.expected) return false; try { s.files.push(new File(s.parts, s.name, { type: s.type })); s.parts = []; s.size = 0; s.name = ''; s.type = ''; return true; } catch { return false; } })()`;
}

function attachmentCommitScript(token: string, files: readonly PromptAttachmentData[]): string {
  return `(() => { const s = globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; if (!s || s.token !== ${JSON.stringify(token)} || s.name || s.files.length !== ${files.length}) return { ok: false, error: '附件数据不完整' }; try { const transfer = new DataTransfer(); s.files.forEach(f => transfer.items.add(f)); const expected = ${JSON.stringify(files.map(file => ({ name: file.name, size: file.size })))}; s.input.files = transfer.files; const actual = Array.from(s.input.files || []); if (actual.length !== expected.length || actual.some((f, i) => f.name !== expected[i].name || f.size !== expected[i].size)) return { ok: false, error: '附件尚未交给官网控件' }; s.committed = expected; s.baselineNameCounts = expected.map(f => s.composer.textContent.split(f.name).length - 1); s.input.dispatchEvent(new Event('input', { bubbles: true })); s.input.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; } catch { return { ok: false, error: '官网附件控件拒绝文件' }; } })()`;
}

function attachmentStatusScript(token: string, files: readonly PromptAttachmentData[]): string {
  return `(() => {
    const s = globalThis[${JSON.stringify(ATTACHMENT_KEY)}];
    if (!s || s.token !== ${JSON.stringify(token)} || !s.composer?.isConnected) return { error: '官网附件区域已变化，未发送文本' };
    const expected = ${JSON.stringify(files.map(file => ({ name: file.name, size: file.size, type: file.mediaType })))};
    const visible = e => !!e && e.isConnected && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const descendants = [s.composer, ...Array.from(s.composer.querySelectorAll('*'))].filter(visible);
    const labels = descendants.map(e => [e.textContent, e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('alt')].filter(Boolean).join(' ')).join(' ');
    if (/上传失败|上传错误|upload failed|upload error|file too large/i.test(labels)) return { error: '官网报告附件上传失败，文本未发送' };
    const represented = expected.every((file, i) => labels.split(file.name).length - 1 > (s.baselineNameCounts?.[i] || 0));
    const imageCount = descendants.filter(e => e.tagName === 'IMG').length;
    const imageRepresented = expected.filter(file => /^image\\//.test(file.type || '')).length;
    const hasPreview = imageRepresented > 0 && imageCount >= s.baselineImages + imageRepresented &&
      expected.every((file, i) => /^image\\//.test(file.type || '') || labels.split(file.name).length - 1 > (s.baselineNameCounts?.[i] || 0));
    const pending = descendants.some(e => e.getAttribute('role') === 'progressbar' || e.getAttribute('aria-busy') === 'true' || /上传中|正在上传|uploading/i.test([e.textContent, e.getAttribute('aria-label'), e.getAttribute('title')].filter(Boolean).join(' ')));
    const evidence = { represented, imageCount, expectedImages: imageRepresented, hasPreview, pending };
    if (!represented && !hasPreview) { s.readySince = 0; return { pending: true, reason: '官网尚未显示已接收的附件', evidence }; }
    if (pending) { s.readySince = 0; return { pending: true, reason: '官网仍在上传附件', evidence }; }
    if (!s.readySince) s.readySince = Date.now();
    if (Date.now() - s.readySince < 200) return { pending: true, reason: '等待官网确认附件' };
    s.accepted = true;
    return { ready: true };
  })()`;
}

function attachmentCleanupScript(token: string): string {
  return `(() => { const key = ${JSON.stringify(ATTACHMENT_KEY)}, s = globalThis[key]; if (!s || s.token !== ${JSON.stringify(token)}) return true; try { if (s.committed && s.input.isConnected) { const actual = Array.from(s.input.files || []); if (actual.length !== s.committed.length || actual.some((f, i) => f.name !== s.committed[i].name || f.size !== s.committed[i].size)) return false; s.input.files = new DataTransfer().files; s.input.dispatchEvent(new Event('input', { bubbles: true })); s.input.dispatchEvent(new Event('change', { bubbles: true })); } delete globalThis[key]; return true; } catch { return false; } })()`;
}

function sendScript(token: string, text: string, scope: string, fixture: boolean, prompt: boolean, expectedFiles: readonly PromptAttachmentData[]): string {
  return `(() => {
    const key = ${JSON.stringify(KEY)}, token = ${JSON.stringify(token)}, payload = ${JSON.stringify(text.replace(/\r\n?/g, '\n'))}, scope = ${JSON.stringify(scope)};
    const previous = globalThis[key];
    if (previous) return { ok: false, error: '页面仍有等待发送的结果' };
    let boundScope = scope;
    const firstSession = ${isFirstPromptSession.toString()};
    const inScope = () => { const current = new URL(location.href); return ((current.origin === 'https://chat.deepseek.com' && current.protocol === 'https:') || (${fixture} && current.protocol === 'file:')) && (current.protocol === 'file:' ? 'null' : current.origin) + current.pathname === boundScope; };
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
    const attachmentState = globalThis[${JSON.stringify(ATTACHMENT_KEY)}];
    if (${expectedFiles.length > 0}) {
      const expected = ${JSON.stringify(expectedFiles.map(file => ({ name: file.name, size: file.size })))};
      if (attachmentState?.token !== token || attachmentState.accepted !== true || JSON.stringify(attachmentState.committed) !== JSON.stringify(expected)) return { ok: false, error: '官网附件尚未确认接收，已停止发送' };
    } else {
      const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
      if (fileInputs.some(e => e.files?.length)) return { ok: false, error: '官网附件区已有文件，未发送本地内容' };
    }
    if (input.maxLength >= 0 && payload.length > input.maxLength) return { ok: false, error: '发送内容超过网页输入框长度限制' };
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
        if (!inScope()) {
          const target = new URL(location.href); const next = target.origin + target.pathname;
          if (${prompt} && state.clicked && boundScope === scope && firstSession(scope, next)) boundScope = next;
          else return finish({ ok: false, error: '网页会话已变化', ...(state.clicked ? { uncertain: true } : {}) });
        }
        if (state.clicked) {
          // 首轮点击后官网会同文档切到新会话并重挂载 composer，旧输入框断开本身即证明消息已被受理；生成态标签在真实站不可读，不能作为唯一判据。
          if ((input.isConnected && input.value === '') || !input.isConnected || stateOfPage() === 'generating') {
            const attachment = globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; if (attachment?.token === token) delete globalThis[${JSON.stringify(ATTACHMENT_KEY)}];
            return finish({ ok: true, session: boundScope });
          }
          if (Date.now() - clickedAt >= 3000) return finish({ ok: false, error: '发送后未确认网页接收，已停止且不会重试', uncertain: true });
        } else {
          const current = controls();
          if (!current || current.input !== input || current.send !== send) return finish({ ok: false, error: '网页发送控件已变化' });
          if (!owns()) return finish({ ok: false, error: '网页输入已被修改，自动发送暂停' });
          if (input.disabled || input.readOnly || stateOfPage() !== 'idle') return finish({ ok: false, error: '网页输入不可编辑或仍在生成' });
          if (input.maxLength >= 0 && payload.length > input.maxLength) return finish({ ok: false, error: '发送内容超过网页输入框长度限制' });
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
  return `(() => { const state = globalThis[${JSON.stringify(KEY)}]; const attachment = globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; if (state?.token === ${JSON.stringify(token)} && !state.clicked) { const result = { ok: false, error: '自动发送已取消' }; state.cancel(); ${attachmentCleanupScript(token)}; return result; } if (state?.token === ${JSON.stringify(token)}) { const result = { ok: false, error: '自动发送已取消', uncertain: true }; state.cancel(); return result; } if (attachment?.token === ${JSON.stringify(token)}) { const cleanupOk = ${attachmentCleanupScript(token)}; return { ok: false, error: '自动发送已取消', ...(cleanupOk ? {} : { uncertain: true }) }; } return false; })()`;
}

export class WebComposerSender {
  private reserved = false;
  private token: string | undefined;
  private disposed = false;
  private generation = 0;
  private cancellationFailed = false;
  private abort: ((result: WebSendResult) => void) | undefined;
  private cleanup: Promise<unknown> = Promise.resolve();
  private kind: 'results' | 'prompt' | undefined;
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
    if (main && sessionKeyOf(url) !== this.scope && !(this.kind === 'prompt' && isFirstPromptSession(this.scope, url))) void this.cancel();
  };
  private readonly destroyed = () => { void this.dispose(); };

  async send(text: string, expectedSession: string, kind: 'results' | 'prompt' = 'results', current: () => boolean = () => true, attachments: readonly PromptAttachmentData[] = []): Promise<WebSendResult> {
    if (this.reserved) return { ok: false, error: '已有内容正在发送' };
    if (attachments.length && kind !== 'prompt') return { ok: false, error: '工具结果回传不支持附件' };
    this.reserved = true; this.kind = kind;
    try { return await this.sendReserved(text, expectedSession, current, attachments); }
    finally { this.reserved = false; this.kind = undefined; }
  }
  private async stageAttachments(token: string, scope: string, fixture: boolean, files: readonly PromptAttachmentData[], generation: number, current: () => boolean): Promise<WebSendResult | null> {
    if (!files.length) return null;
    const call = (code: string) => this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code }]);
    const started: unknown = await call(attachmentStartScript(token, scope, fixture));
    if (!started || typeof started !== 'object' || !('ok' in started) || !started.ok) {
      const error = started && typeof started === 'object' && 'error' in started ? String(started.error) : '无法准备官网附件控件';
      traceCollection('composer.attachment-start-rejected', { count: files.length, error });
      return { ok: false, error };
    }
    traceCollection('composer.attachment-started', { count: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0) });
    try {
      for (const file of files) {
        if (generation !== this.generation || !current()) throw new Error('需求、项目或会话已变化，附件上传已取消');
        const begin: unknown = await call(attachmentBeginFileScript(token, file));
        if (begin !== true) throw new Error('官网附件上传状态已变化');
        let size = 0;
        for await (const bytes of file.stream()) {
          if (generation !== this.generation || !current()) throw new Error('需求、项目或会话已变化，附件上传已取消');
          size += bytes.byteLength;
          if (size > file.size) throw new Error(`附件大小已变化：${file.name}`);
          const accepted: unknown = await call(attachmentChunkScript(token, bytes));
          if (accepted !== true) throw new Error(`官网拒绝附件数据：${file.name}`);
        }
        if (size !== file.size || await call(attachmentFinishFileScript(token)) !== true) throw new Error(`附件读取不完整：${file.name}`);
      }
      const committed: unknown = await call(attachmentCommitScript(token, files));
      if (committed && typeof committed === 'object' && 'ok' in committed && committed.ok) {
        traceCollection('composer.attachment-committed', { count: files.length });
        const totalMb = Math.ceil(files.reduce((sum, file) => sum + file.size, 0) / (1024 * 1024));
        const deadline = Date.now() + Math.min(300_000, 30_000 + totalMb * 1000);
        let lastStatus = '';
        while (Date.now() < deadline) {
          if (generation !== this.generation || !current()) throw new Error('需求、项目或会话已变化，附件上传已取消');
          const state: unknown = await call(attachmentStatusScript(token, files));
          const status = JSON.stringify(state);
          if (status !== lastStatus) {
            lastStatus = status;
            traceCollection('composer.attachment-status', { count: files.length, status: state });
          }
          if (state && typeof state === 'object' && 'ready' in state && state.ready) {
            traceCollection('composer.attachment-visible-ready', { count: files.length });
            return null;
          }
          if (state && typeof state === 'object' && 'error' in state) throw new Error(String(state.error));
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        traceCollection('composer.attachment-confirmation-timeout', { count: files.length });
        throw new Error('官网未确认已接收附件，文本未发送；请改用官网上传按钮重试');
      }
      throw new Error(committed && typeof committed === 'object' && 'error' in committed ? String(committed.error) : '官网未接收附件');
    } catch (error) {
      const cleaned = await call(attachmentCleanupScript(token)).catch(() => false);
      const message = error instanceof Error ? error.message : String(error);
      traceCollection('composer.attachment-stage-failed', { count: files.length, cleaned, error: message });
      return { ok: false, error: `${message}${cleaned ? '' : '；官网附件清理状态未确认，请检查页面'}`, ...(!cleaned ? { uncertain: true } : {}) };
    }
  }
  private async sendReserved(text: string, expectedSession: string, current: () => boolean, attachments: readonly PromptAttachmentData[]): Promise<WebSendResult> {
    if (this.disposed || this.web.isDestroyed()) return { ok: false, error: '网页已关闭' };
    if (this.cancellationFailed) return { ok: false, error: '网页取消状态未确认，自动发送已停止，请重新打开网页', uncertain: true };
    if (this.token) return { ok: false, error: '已有内容正在发送' };
    if (!text.trim()) return { ok: false, error: '发送内容为空' };
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
    if (this.token) return { ok: false, error: '已有内容正在发送' };
    const token = randomUUID(); this.token = token; this.scope = expectedSession;
    if (!current()) { this.token = undefined; return { ok: false, error: '发送资格已失效' }; }
    const cancelled = new Promise<WebSendResult>(resolve => { this.abort = resolve; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<WebSendResult>(resolve => { timeout = setTimeout(() => {
      void this.cancel(); resolve({ ok: false, error: '网页发送等待超时，已停止且不会重试', uncertain: true });
    }, attachments.length ? Math.min(300_000, Math.max(30_000, 30_000 + Math.ceil(attachments.reduce((sum, file) => sum + file.size, 0) / (1024 * 1024)) * 1000)) : 7500); });
    try {
      if (attachments.length) {
        const staged = await Promise.race([this.stageAttachments(token, expectedSession, this.options.allowLocalFixture === true, attachments, generation, current), cancelled, bounded]);
        if (staged) return staged;
      }
      if (generation !== this.generation || !current()) {
        if (attachments.length) {
          const cleaned = await this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code: attachmentCleanupScript(token) }]).catch(() => false);
          if (cleaned !== true) return { ok: false, error: '发送资格已失效，官网附件清理状态未确认，请检查页面', uncertain: true };
        }
        return { ok: false, error: '需求、项目或会话已变化，未发送' };
      }
      const result: unknown = await Promise.race([this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code: sendScript(token, text, expectedSession, this.options.allowLocalFixture === true, this.kind === 'prompt', attachments) }]), cancelled, bounded]);
      traceCollection('composer.send-result', { kind: this.kind, attachmentCount: attachments.length,
        ok: Boolean(result && typeof result === 'object' && 'ok' in result && result.ok === true),
        error: result && typeof result === 'object' && 'error' in result ? String(result.error) : null });
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false && !('uncertain' in result) && attachments.length) {
        const cleaned = await this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code: attachmentCleanupScript(token) }]).catch(() => false);
        if (cleaned !== true) return { ok: false, error: '发送未完成，官网附件清理状态未确认，请检查页面', uncertain: true };
      }
      if (result && typeof result === 'object' && 'ok' in result && typeof result.ok === 'boolean') return result as WebSendResult;
      return { ok: false, error: '网页发送状态不可识别，已停止且不会重试', uncertain: true };
    } catch {
      // 渲染进程异常可能发生在点击后，不能推断为未发送。
      return { ok: false, error: '网页发送检查失败，已停止且不会重试', uncertain: true };
    } finally {
      clearTimeout(timeout);
      if (this.token === token) { this.token = undefined; this.kind = undefined; this.abort = undefined; }
    }
  }

  async cancel(expectedKind?: 'results' | 'prompt'): Promise<void> {
    if (expectedKind && this.kind && this.kind !== expectedKind) return;
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
      this.cleanup = Promise.race([Promise.resolve().then(() => this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code: cancelScript(token) }])), unconfirmed]).then(result => {
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
