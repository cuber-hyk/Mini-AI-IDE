/** 受控网页 composer 运输：限定官方平台、隔离世界、一次发送；调用方负责用户需求或真实工具结果授权。 */
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { sessionKeyOf } from './consumptionStore';
import { DEEPSEEK_SEND_ICON } from './tools/replyObservation';
import { CONTINUATION_BUTTON } from './tools/replyContinuation';
import { isFirstPromptSession, isPendingFirstPromptSession } from './firstPromptSession';
import type { PromptAttachmentData } from '../shared/localPrompt';
import { traceCollection } from './tools/collectionTrace';
import { webPlatformOf } from '../shared/webConversation';
import type { WebPlatform } from '../shared/webPlatform';
import { CHATGPT_SEND_SELECTOR, CHATGPT_GENERATING_SCRIPT, CHATGPT_ATTACHMENT_READER, CHATGPT_DOCUMENTS_MATCH } from './chatgptPage';

export const COMPOSER_SEND_WORLD = 1005;
const KEY = '__miniAIComposerSend';
const ATTACHMENT_KEY = '__miniAIComposerAttachments';
const DOCUMENT_KEY = '__miniAIComposerDocument';
let documentRequestSequence = 0;

function documentScript(nonce: string, token?: string): string {
  const sequence = token ? ++documentRequestSequence : undefined;
  return `/* composer-document */ (() => { const key = ${JSON.stringify(DOCUMENT_KEY)}; let state = globalThis[key]; if (state?.document !== document || typeof state.nonce !== 'string') state = globalThis[key] = { document, nonce: ${JSON.stringify(nonce)} }; ${token ? `if ((state.requestSequence ?? 0) >= ${sequence}) return false; state.requestSequence = ${sequence}; state.activeToken = ${JSON.stringify(token)};` : ''} return state.nonce; })()`;
}

function documentGuard(nonce: string, token?: string): string {
  return `globalThis[${JSON.stringify(DOCUMENT_KEY)}]?.document === document && globalThis[${JSON.stringify(DOCUMENT_KEY)}]?.nonce === ${JSON.stringify(nonce)}${token ? ` && globalThis[${JSON.stringify(DOCUMENT_KEY)}]?.activeToken === ${JSON.stringify(token)}` : ''}`;
}
type SendWeb = Pick<WebContents, 'getURL' | 'isDestroyed' | 'executeJavaScriptInIsolatedWorld' | 'on' | 'removeListener'>;
export type WebSendStage = 'preflight' | 'preparing' | 'draft_backup' | 'waiting_button' | 'clicked' | 'confirmed' | 'unknown';
export type WebSendResult = { ok: boolean; error?: string; uncertain?: boolean; session?: string; draftBackupPath?: string;
  blockedByPreviousCancellation?: true; retryable?: true; transportStarted?: boolean; stage?: WebSendStage; cancellation?: 'not_clicked' | 'clicked' | 'unknown' };
type SendOptions = { allowLocalFixture?: boolean; backupDraft?: (text: string, session: string) => Promise<string>; draftSaved?: (path: string) => void };

function attachmentStartScript(token: string, nonce: string, scope: string, fixture: boolean, platform: WebPlatform): string {
  return `(() => {
    if (!(${documentGuard(nonce, token)})) return { ok: false, error: '网页文档已变化，未上传附件' };
    const token = ${JSON.stringify(token)}, scope = ${JSON.stringify(scope)};
    const u = new URL(location.href);
    if (${platform === 'chatgpt'}) {
      if (u.origin !== 'https://chatgpt.com' || u.origin + u.pathname !== scope || !(u.pathname === '/' || /^\\/c\\/[a-zA-Z0-9_-]+$/.test(u.pathname))) return { ok: false, error: '网页或会话已变化，未上传附件' };
      if (globalThis[${JSON.stringify(ATTACHMENT_KEY)}]) return { ok: false, error: '此前附件清理未确认，请重新加载网页' };
      const visible = e => !!e && e.isConnected && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const inputs = Array.from(document.querySelectorAll('div.ProseMirror[contenteditable="true"][role="textbox"]')).filter(visible);
      if (inputs.length !== 1) return { ok: false, error: '无法唯一识别ChatGPT输入框，未上传附件' };
      const text = inputs[0], composer = text.closest('form[data-chatgpt-composer]');
      if (!composer || composer.querySelector('[data-dil-message-id],[data-message-author-role],[data-talvt-turn-state],[data-markdown-text-style]')
        || Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible).some(e => e !== text)) return { ok: false, error: 'ChatGPT附件区域无法与回复区隔离' };
      if (text.textContent !== '' || !text.isContentEditable || text.getAttribute('aria-disabled') === 'true' || text.getAttribute('aria-readonly') === 'true') return { ok: false, error: '附件发送要求官网输入为空，请先处理网页草稿' };
      if (${CHATGPT_GENERATING_SCRIPT} || Array.from(composer.querySelectorAll('button')).some(e => visible(e) && /^(continue generating|继续生成)$/i.test(e.getAttribute('aria-label') || ''))) return { ok: false, error: '网页仍在生成或等待继续，未上传附件' };
      const files = Array.from(composer.querySelectorAll('input[type="file"]')).filter(e => e.isConnected && !e.disabled && e.multiple && !e.getAttribute('accept') && e.form === composer);
      if (files.length !== 1) return { ok: false, error: '无法唯一识别ChatGPT通用文件控件，请手动上传' };
      const input = files[0], read = ${CHATGPT_ATTACHMENT_READER};
      const view = read(composer);
      if (view.cards.length || view.unknown || view.pending || view.error || Array.from(document.querySelectorAll('input[type="file"]')).some(e => e.files?.length)) return { ok: false, error: '官网附件区已有文件或状态未知，请先处理后重试' };
      const s = { token, scope, input, composer, text, files: [], parts: [], size: 0, name: '', type: '', takenOver: false };
      const events = ['beforeinput', 'input', 'change', 'paste', 'drop', 'compositionstart', 'pointerdown'];
      const takeOver = e => { if (e.isTrusted && composer.contains(e.target)) s.takenOver = true; };
      events.forEach(name => composer.addEventListener(name, takeOver, true));
      s.release = () => events.forEach(name => composer.removeEventListener(name, takeOver, true));
      s.read = () => read(composer);
      s.inspect = () => {
        const now = new URL(location.href);
        if (!(${documentGuard(nonce)}) || now.origin + now.pathname !== scope || !composer.isConnected || !input.isConnected || input.form !== composer || text.closest('form') !== composer || s.takenOver) return { error: '附件上传期间输入、文档或会话已变化，未发送正文' };
        const current = read(composer), expected = s.expectedFiles || [];
        if (current.error || current.unknown || current.cards.length > expected.length) return { error: '官网附件失败、混入其他附件或结构未知，未发送正文' };
        const images = current.cards.filter(card => card.kind === 'image');
        const expectedDocuments = expected.filter(file => !/^image\\//.test(file.type || ''));
        const documents = (${CHATGPT_DOCUMENTS_MATCH})(current.cards, expected);
        if (documents.ambiguous) return { error: '官网文档名称存在歧义，未发送正文' };
        if (!documents.ready) return { pending: true, reason: '等待官网显示本次文档' };
        const sends = Array.from(composer.querySelectorAll(${JSON.stringify(CHATGPT_SEND_SELECTOR)})).filter(visible);
        if (!expected.length || current.cards.length !== expected.length || images.length !== expected.length - expectedDocuments.length || current.pending || current.cards.some(card => !card.ready)
          || sends.length !== 1 || sends[0].disabled || sends[0].getAttribute('aria-disabled') === 'true') return { pending: true, reason: '等待全部附件和官网发送控件就绪' };
        return { ready: true };
      };
      globalThis[${JSON.stringify(ATTACHMENT_KEY)}] = s;
      return { ok: true };
    }
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

function attachmentBeginFileScript(token: string, nonce: string, file: PromptAttachmentData): string {
  return `(() => { if (!(${documentGuard(nonce, token)})) return false; const s = globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; if (!s || s.token !== ${JSON.stringify(token)} || s.parts.length || s.name) return false; s.name = ${JSON.stringify(file.name)}; s.type = ${JSON.stringify(file.mediaType)}; s.expected = ${file.size}; s.size = 0; return true; })()`;
}

function attachmentChunkScript(token: string, nonce: string, bytes: Uint8Array): string {
  const base64 = Buffer.from(bytes).toString('base64');
  return `(() => { if (!(${documentGuard(nonce, token)})) return false; const s = globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; if (!s || s.token !== ${JSON.stringify(token)} || !s.name) return false; const raw = atob(${JSON.stringify(base64)}), part = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) part[i] = raw.charCodeAt(i); s.parts.push(part); s.size += part.length; return s.size <= s.expected; })()`;
}

function attachmentFinishFileScript(token: string, nonce: string): string {
  return `(() => { if (!(${documentGuard(nonce, token)})) return false; const s = globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; if (!s || s.token !== ${JSON.stringify(token)} || !s.name || s.size !== s.expected) return false; try { s.files.push(new File(s.parts, s.name, { type: s.type })); s.parts = []; s.size = 0; s.name = ''; s.type = ''; return true; } catch { return false; } })()`;
}

function attachmentCommitScript(token: string, nonce: string, files: readonly PromptAttachmentData[]): string {
  return `(() => { if (!(${documentGuard(nonce, token)})) return false; const s = globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; if (!s || s.token !== ${JSON.stringify(token)} || s.name || s.takenOver || s.files.length !== ${files.length}) return { ok: false, error: '附件数据不完整或用户已接管' }; if (s.inspect) { const view = s.read(); if (s.inspect().error || s.text.textContent !== '' || view.cards.length || view.unknown || view.pending || view.error || Array.from(document.querySelectorAll('input[type="file"]')).some(e => e.files?.length)) return { ok: false, error: '上传前网页输入或附件状态已变化' }; } try { const transfer = new DataTransfer(); s.files.forEach(f => transfer.items.add(f)); const expected = ${JSON.stringify(files.map(file => ({ name: file.name, size: file.size })))}; s.input.files = transfer.files; const actual = Array.from(s.input.files || []); if (actual.length !== expected.length || actual.some((f, i) => f.name !== expected[i].name || f.size !== expected[i].size)) return { ok: false, error: '附件尚未交给官网控件' }; s.committed = expected; s.expectedFiles = ${JSON.stringify(files.map(file => ({ name: file.name, size: file.size, type: file.mediaType })))}; s.baselineNameCounts = expected.map(f => s.composer.textContent.split(f.name).length - 1); s.input.dispatchEvent(new Event('input', { bubbles: true })); s.input.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; } catch { return { ok: false, error: '官网附件控件拒绝文件' }; } })()`;
}

function attachmentStatusScript(token: string, nonce: string, files: readonly PromptAttachmentData[]): string {
  return `(() => {
    if (!(${documentGuard(nonce, token)})) return { error: '网页文档已变化，附件状态不可确认' };
    const s = globalThis[${JSON.stringify(ATTACHMENT_KEY)}];
    if (!s || s.token !== ${JSON.stringify(token)} || !s.composer?.isConnected) return { error: '官网附件区域已变化，未发送文本' };
    if (s.inspect) { const result = s.inspect(); if (result.ready) { s.accepted = true; s.files = []; } return result; }
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

function attachmentCleanupScript(token: string, nonce: string): string {
  return `(async () => { if (!(${documentGuard(nonce)})) return false; const key = ${JSON.stringify(ATTACHMENT_KEY)}, s = globalThis[key]; if (!s || s.token !== ${JSON.stringify(token)}) return true;
    try {
      if (s.read) {
        const current = () => { const url = new URL(location.href); return (${documentGuard(nonce)}) && !s.takenOver && s.composer.isConnected && s.input.isConnected && s.input.form === s.composer && s.text.closest('form') === s.composer && url.origin + url.pathname === s.scope; };
        if (!current()) return false;
        if (s.committed) {
          const view = s.read();
          if (view.unknown || !s.expectedFiles || view.cards.length !== s.expectedFiles.length) return false;
          if (!(${CHATGPT_DOCUMENTS_MATCH})(view.cards, s.expectedFiles).ready
            || view.cards.filter(card => card.kind === 'image').length !== s.expectedFiles.filter(file => /^image\\//.test(file.type || '')).length) return false;
          const ownFiles = () => { const selected = Array.from(s.input.files || []); return !selected.length || selected.length === s.committed.length && selected.every((f, i) => f.name === s.committed[i].name && f.size === s.committed[i].size); };
          if (!ownFiles()) return false;
          for (const card of view.cards) { if (!current() || !ownFiles() || !card.remove.isConnected) return false; HTMLElement.prototype.click.call(card.remove); }
          const deadline = Date.now() + 250;
          while (Date.now() < deadline) {
            if (!current() || !ownFiles()) return false;
            const after = s.read();
            if (!after.cards.length && !after.unknown && !after.pending) { s.input.files = new DataTransfer().files; s.release(); delete globalThis[key]; return true; }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          return false;
        }
        s.release(); delete globalThis[key]; return true;
      }
      if (s.committed && s.input.isConnected) { const actual = Array.from(s.input.files || []); if (actual.length !== s.committed.length || actual.some((f, i) => f.name !== s.committed[i].name || f.size !== s.committed[i].size)) return false; s.input.files = new DataTransfer().files; s.input.dispatchEvent(new Event('input', { bubbles: true })); s.input.dispatchEvent(new Event('change', { bubbles: true })); }
      delete globalThis[key]; return true;
    } catch { return false; }
  })()`;
}

function sendScript(token: string, nonce: string, text: string, scope: string, fixture: boolean, prompt: boolean, expectedFiles: readonly PromptAttachmentData[], platform: WebPlatform, backupDraft = false): string {
  return `(() => {
    if (!(${documentGuard(nonce, token)})) return { ok: false, error: '网页文档已变化，未发送' };
    const key = ${JSON.stringify(KEY)}, token = ${JSON.stringify(token)}, payload = ${JSON.stringify(text.replace(/\r\n?/g, '\n'))}, scope = ${JSON.stringify(scope)};
    const previous = globalThis[key];
    if (previous) return { ok: false, error: '页面仍有等待发送的结果' };
    let boundScope = scope;
    const firstSession = ${isFirstPromptSession.toString()};
    const pendingFirstSession = ${isPendingFirstPromptSession.toString()};
    let pendingScope = null;
    const chatgpt = ${platform === 'chatgpt'};
    const inScope = () => { if (!(${documentGuard(nonce, token)})) return false; const current = new URL(location.href); return !current.username && !current.password && ((current.protocol === 'https:' && (chatgpt ? current.origin === 'https://chatgpt.com' && (current.pathname === '/' || /^\\/c\\/[a-zA-Z0-9_-]+$/.test(current.pathname)) : current.origin === 'https://chat.deepseek.com')) || (${fixture} && !chatgpt && current.protocol === 'file:')) && (current.protocol === 'file:' ? 'null' : current.origin) + current.pathname === boundScope; };
    if (!inScope()) return { ok: false, error: '网页或会话已变化' };
    const visible = e => !!e && e.isConnected && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const outside = e => !e.closest('pre,code,[class*="code-block"],[class*="markdown"],.ds-message,[data-message-author-role],[data-talvt-turn-state],[data-markdown-text-style],[data-dil-message-id]');
    const selector = 'button,[role="button"],.ds-button,.ds-icon-button';
    const labels = e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('data-tooltip'), e.getAttribute('data-tooltip-content'), e.textContent].filter(Boolean).join(' ').trim();
    const interrupted = ${CONTINUATION_BUTTON};
    const stateOfPage = () => {
      if (chatgpt) {
        if (${CHATGPT_GENERATING_SCRIPT}) return 'generating';
        const buttons = Array.from(document.querySelectorAll('button')).filter(e => visible(e) && !e.closest('pre,code,[class*="CodeSurface-"],[data-user-message-bubble]'));
        return buttons.some(interrupted) ? 'interrupted' : 'idle';
      }
      const buttons = Array.from(document.querySelectorAll(selector)).filter(visible);
      if (buttons.some(e => e.getAttribute('data-testid') === 'stop-button' || /停止生成|停止回答|停止响应|stop generating|stop streaming|stop response|^stop$|^停止$/i.test(labels(e))) || Array.from(document.querySelectorAll('[aria-busy="true"],[data-is-streaming="true"]')).some(visible)) return 'generating';
      if (buttons.some(interrupted)) return 'interrupted';
      return 'idle';
    };
    const enabled = e => !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !e.classList.contains('ds-button--disabled');
    // 输入内的markdown装饰不是回复；真实消息标记无论位置均拒绝，输入正文仍逐字核验。
    const containsReply = (area, input) => !!area.querySelector('.ds-message,[data-message-author-role],[data-talvt-turn-state],[data-markdown-text-style],[data-dil-message-id]')
      || Array.from(area.querySelectorAll('[class*="markdown"]')).some(e => !input.contains(e));
    const controls = (waiting = false) => {
      const inputs = Array.from(document.querySelectorAll(chatgpt ? 'div.ProseMirror[contenteditable="true"][role="textbox"]' : 'textarea')).filter(visible);
      const sends = chatgpt ? Array.from(document.querySelectorAll(${JSON.stringify(CHATGPT_SEND_SELECTOR)})).filter(e => visible(e) && outside(e)) : Array.from(document.querySelectorAll('.ds-button.ds-button--primary.ds-button--filled.ds-button--circle')).filter(e => visible(e) && outside(e) && Array.from(e.querySelectorAll('svg path')).some(p => String(p.getAttribute('d') || '').replace(/\\s+/g, ' ').startsWith(${JSON.stringify(DEEPSEEK_SEND_ICON)})));
      if (inputs.length !== 1 || sends.length > 1 || (!sends.length && !(chatgpt && waiting)) || !outside(inputs[0])) return null;
      const input = inputs[0], send = sends[0];
      if (chatgpt && Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(e => visible(e) && outside(e)).some(e => e !== input)) return null;
      if (chatgpt) {
        const composer = input.closest('form');
        if (!composer || composer === document.body || composer === document.documentElement
          || containsReply(composer, input) || (send && send.closest('form') !== composer)) return null;
        return { input, send: send || null, composer };
      }
      // 只接纳不含回复正文的局部共同容器；全页面共同祖先不能证明 composer 关联。
      for (let box = input.parentElement, depth = 0; box && depth < 6; box = box.parentElement, depth++) {
        if (box === document.body || box === document.documentElement || box.querySelector('.ds-message,[class*="markdown"],[data-message-author-role]')) return null;
        if (box.contains(send)) return { input, send, composer: box };
      }
      return null;
    };
    const found = controls(true);
    if (!found) return { ok: false, error: '无法唯一识别网页输入框与发送控件，请手动发送' };
    const { input, composer } = found;
    let send = found.send;
    // 现场空 composer 显示开始语音，发送按钮需填入后才挂载；从不点击语音控件。
    // submit/发送控件的结构已现场核验；InputEvent 接收仍需官网人工验收。
    if (!send && !Array.from(composer.querySelectorAll('button')).filter(visible).some(e => /^(开始语音|Start voice|Start voice mode)$/i.test(e.getAttribute('aria-label') || ''))) return { ok: false, error: '无法确认空网页输入区域，请手动发送' };
    const editable = () => chatgpt ? input.isContentEditable && input.getAttribute('aria-disabled') !== 'true' && input.getAttribute('aria-readonly') !== 'true' : !input.disabled && !input.readOnly;
    const empty = () => {
      if (!chatgpt) return input.value === '';
      if (input.textContent !== '') return false;
      if (!input.childNodes.length) return true;
      const block = input.firstChild;
      return input.childNodes.length === 1 && block.nodeType === Node.ELEMENT_NODE && block.tagName === 'P' && (!block.childNodes.length || (block.childNodes.length === 1 && block.firstChild.nodeType === Node.ELEMENT_NODE && block.firstChild.tagName === 'BR'));
    };
    const hasAttachments = () => {
      if (Array.from(document.querySelectorAll('input[type="file"]')).some(e => e.files?.length)) return true;
      if (!chatgpt) return false;
      // 复用附件结构解释，包含没有缩略图且 FileList 已被官网清空的文档卡。
      const area = composer.closest('form');
      if (!area || area === document.body || containsReply(area, input)) return true;
      const view = (${CHATGPT_ATTACHMENT_READER})(area);
      return view.cards.length > 0 || view.unknown || view.pending || view.error;
    };
    if (stateOfPage() !== 'idle') return { ok: false, error: '网页仍在生成或等待继续生成' };
    if (!editable() || (!empty() && !${backupDraft})) return { ok: false, error: '网页输入框已有内容或不可编辑，未覆盖草稿' };
    const attachmentState = globalThis[${JSON.stringify(ATTACHMENT_KEY)}];
    if (${expectedFiles.length > 0}) {
      const expected = ${JSON.stringify(expectedFiles.map(file => ({ name: file.name, size: file.size })))};
      if (attachmentState?.token !== token || attachmentState.accepted !== true || JSON.stringify(attachmentState.committed) !== JSON.stringify(expected)
        || chatgpt && (attachmentState.text !== input || !attachmentState.inspect?.().ready || !empty())) return { ok: false, error: '官网附件尚未确认接收或网页输入已变化，已停止发送' };
    } else {
      if (hasAttachments()) return { ok: false, error: '官网附件区已有文件或无法确认纯文本输入，未发送本地内容' };
    }
    if (input.maxLength >= 0 && payload.length > input.maxLength) return { ok: false, error: '发送内容超过网页输入框长度限制' };
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!chatgpt && !setter) return { ok: false, error: '网页输入控件不可识别' };
    const ownedText = () => {
      if (!chatgpt) return input.value;
      const blocks = Array.from(input.childNodes);
      const appearance = ['class', 'data-appearance', 'data-layout', 'data-font-weight', 'data-tone', 'data-underline-on-hover'];
      const onlyAttributes = (node, names) => Array.from(node.attributes).every(attr => names.includes(attr.name));
      const iconTree = node => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent === '';
        if (node.nodeType !== Node.ELEMENT_NODE) return false;
        const names = node.tagName === 'SPAN' ? ['class', 'contenteditable']
          : node.tagName === 'svg' ? ['width', 'height', 'viewBox', 'fill', 'xmlns', 'class']
          : node.tagName === 'path' ? ['d', 'fill'] : null;
        return names !== null && onlyAttributes(node, names)
          && (!node.hasAttribute('contenteditable') || node.getAttribute('contenteditable') === 'false')
          && Array.from(node.childNodes).every(iconTree);
      };
      // ProseMirror 可整理文本 span 和末尾占位 BR；只比较逐字正文，不 trim 草稿。
      const read = (node, parent) => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent;
        if (node.nodeType !== Node.ELEMENT_NODE) return null;
        if (node.tagName === 'BR') {
          if (parent.childNodes.length === 1 || (node === parent.lastChild && node.classList.contains('ProseMirror-trailingBreak'))) return '';
          return null;
        }
        // 官网在颜色和自动链接旁插入无文字装饰；仅跳过明确身份与受限结构，不接纳任意原子节点。
        if (node.tagName === 'SPAN' && node.getAttribute('aria-hidden') === 'true' && node.getAttribute('contenteditable') === 'false') {
          if (node.hasAttribute('data-hex-color-swatch') && node.childNodes.length === 0
            && onlyAttributes(node, ['aria-hidden', 'class', 'contenteditable', 'data-hex-color-swatch', 'style'])) return '';
          if (node.hasAttribute('data-inline-url-icon') && node.closest('span[data-rich-text-generated-autolink]')
            && onlyAttributes(node, [...appearance, 'data-inline-url-icon', 'aria-hidden', 'contenteditable'])
            && Array.from(node.childNodes).every(iconTree)) return '';
        }
        const autolink = node.tagName === 'SPAN' && node.hasAttribute('data-rich-text-generated-autolink')
          && onlyAttributes(node, [...appearance, 'rich-link-source-app-id', 'data-breakable-url', 'text-link-href', 'data-rich-text-generated-autolink']);
        const literalPaste = node.tagName === 'SPAN' && node.hasAttribute('data-prompt-literal-paste')
          && onlyAttributes(node, ['class', 'data-prompt-literal-paste']);
        const boldText = node.tagName === 'STRONG' && node.attributes.length === 0;
        if ((node.tagName !== 'SPAN' && !boldText) || node.hasAttribute('contenteditable') || node.hasAttribute('role') || node.hasAttribute('hidden')
          || (!autolink && !literalPaste && Array.from(node.attributes).some(attr => attr.name.startsWith('data-'))) || getComputedStyle(node).display === 'none' || getComputedStyle(node).visibility === 'hidden') return null;
        const pieces = Array.from(node.childNodes).map(child => read(child, node));
        return pieces.some(piece => piece === null) ? null : pieces.join('');
      };
      const lines = blocks.map(block => {
        if (block.nodeType !== Node.ELEMENT_NODE || block.tagName !== 'P') return null;
        const pieces = Array.from(block.childNodes).map(child => read(child, block));
        return pieces.some(piece => piece === null) ? null : pieces.join('');
      });
      return lines.some(line => line === null) ? null : lines.join('\\n');
    };
    const draftText = empty() ? null : ownedText();
    if (!empty() && (draftText === null || draftText === '')) return { ok: false, error: '网页草稿无法无损读取，未覆盖' };
    const write = value => {
      if (chatgpt) {
        const blocks = value.split('\\n').map(line => { const p = document.createElement('p'); if (line) p.textContent = line; else p.append(document.createElement('br')); return p; });
        input.replaceChildren(...blocks);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: value ? 'insertText' : 'deleteContentBackward', data: value || null }));
      } else { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    return new Promise(resolve => {
      let complete = resolve;
      const state = { token, stage: 'preparing', clicked: false, done: false, takenOver: false, written: false, timer: null, cancel: null, resume: null };
      const owns = () => state.written && !state.takenOver && input.isConnected && ownedText() === payload;
      const clearOwned = () => {
        if (!state.clicked && owns()) write('');
      };
      const finish = result => {
        if (state.done) return;
        state.done = true; clearTimeout(state.timer);
        if (chatgpt) editEvents.forEach(name => document.removeEventListener(name, takeOver, true));
        try { if (!result.ok && !state.clicked) clearOwned(); } catch { result = { ok: false, error: '未发送结果的清理失败，请检查网页输入框', uncertain: true }; }
        if (globalThis[key] === state) delete globalThis[key];
        const outcome = { ...result, transportStarted: true, stage: result.ok ? 'confirmed' : state.stage };
        complete(outcome);
        return outcome;
      };
      const editEvents = ['beforeinput', 'input', 'paste', 'drop', 'compositionstart'];
      const takeOver = event => {
        if (state.clicked || state.done || !event.isTrusted || !(event.target === input || input.contains(event.target))) return;
        state.takenOver = true;
        finish({ ok: false, error: '用户正在编辑网页输入，自动发送暂停' });
      };
      if (chatgpt) editEvents.forEach(name => document.addEventListener(name, takeOver, true));
      state.cancel = () => finish({ ok: false, error: '自动发送已取消', cancellation: state.clicked ? 'clicked' : 'not_clicked', ...(state.clicked ? { uncertain: true } : {}) });
      globalThis[key] = state;
      let started = 0, clickedAt = 0;
      const poll = () => {
        try {
        if (state.done) return;
        if (!inScope()) {
          const target = new URL(location.href); const next = target.origin + target.pathname;
          if (${prompt} && state.clicked && boundScope === scope && pendingFirstSession(scope, target.href)
            && (!pendingScope || pendingScope === next)) {
            pendingScope = next;
            if (Date.now() - clickedAt >= 3000) return finish({ ok: false, error: '首发会话分配未确认，已停止且不会重试', uncertain: true });
            state.timer = setTimeout(poll, 25); return;
          }
          if (${prompt} && state.clicked && boundScope === scope && firstSession(scope, target.href)) boundScope = next;
          else return finish({ ok: false, error: '网页会话已变化', ...(state.clicked ? { uncertain: true } : {}) });
        }
        if (state.clicked) {
          // DeepSeek 允许已验证的首轮 composer 重挂载；ChatGPT 断开本身不证明接收。
          const attachmentCleared = !chatgpt || !${expectedFiles.length > 0} || attachmentState?.composer.isConnected && (() => { const view = attachmentState.read(); return !view.cards.length && !view.unknown && !view.pending; })();
          if ((input.isConnected && empty() && attachmentCleared) || (!chatgpt && !input.isConnected) || stateOfPage() === 'generating') {
            const attachment = globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; if (attachment?.token === token) { attachment.release?.(); delete globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; }
            return finish({ ok: true, session: boundScope });
          }
          if (Date.now() - clickedAt >= 3000) return finish({ ok: false, error: '发送后未确认网页接收，已停止且不会重试', uncertain: true });
        } else {
          const current = controls(true);
          // 已知按钮可被官网重绘；只在原输入与原FORM未变、旧按钮已断开时选取唯一新按钮。
          // 自有正文、编辑接管、生成及附件仍在本次同步点击前完整复核。
          if (chatgpt && send && !send.isConnected && current?.input === input && current.composer === composer && current.send) send = current.send;
          const changed = !current ? '无法唯一确认输入框与发送按钮' : current.input !== input ? '输入框已替换'
            : chatgpt && current.composer.closest('form') !== composer.closest('form') ? '输入区域已替换'
            : send && current.send !== send ? '发送按钮已替换或消失' : '';
          if (changed) return finish({ ok: false, error: '网页发送控件已变化：' + changed, controlState: {
            inputConnected: input.isConnected, controlsKnown: !!current, sameInput: current?.input === input,
            sameSend: current?.send === send, sameForm: current?.composer.closest('form') === composer.closest('form'),
            ownTextKnown: ownedText() !== null, ownsText: owns()
          } });
          if (!send && current.send) send = current.send;
          if (!owns()) return finish({ ok: false, error: '网页输入已被修改，自动发送暂停' });
          if (!editable() || stateOfPage() !== 'idle') return finish({ ok: false, error: '网页输入不可编辑或仍在生成' });
          if (chatgpt && (${expectedFiles.length > 0} ? !attachmentState?.inspect?.().ready : hasAttachments())) return finish({ ok: false, error: '官网附件区已变化，已停止发送' });
          if (input.maxLength >= 0 && payload.length > input.maxLength) return finish({ ok: false, error: '发送内容超过网页输入框长度限制' });
          if (send && enabled(send)) {
            attachmentState?.release?.();
            state.clicked = true; state.stage = 'clicked'; clickedAt = Date.now();
            // 点击前所有检查在同一同步任务完成；点击之后绝不重试或清理可能已提交内容。
            HTMLElement.prototype.click.call(send);
          } else if (Date.now() - started >= 3000) return finish({ ok: false, error: '网页发送按钮未就绪，请手动发送' });
        }
        state.timer = setTimeout(poll, 25);
        } catch { finish({ ok: false, error: '网页发送检查失败，已停止且不会重试', ...(state.clicked ? { uncertain: true } : {}) }); }
      };
      const start = () => {
        state.written = true;
        try { write(payload); }
        catch { return finish({ ok: false, error: '网页输入失败，已停止发送' }); }
        state.stage = 'waiting_button';
        started = Date.now();
        // 留出一轮事件循环，使关闭开关、用户输入和导航可在点击前取消。
        state.timer = setTimeout(poll, 25);
      };
      if (draftText !== null) {
        state.stage = 'draft_backup';
        state.resume = () => new Promise(next => {
          complete = next; state.resume = null;
          const current = controls(true);
          if (!inScope() || !current || current.input !== input || current.composer !== composer
            || !editable() || stateOfPage() !== 'idle' || hasAttachments() || ownedText() !== draftText)
            return finish({ ok: false, error: '备份期间网页草稿、控件或会话已变化，未覆盖' });
          start();
        });
        resolve({ ok: true, draftText });
      } else start();
    });
  })()`;
}

function resumeDraftScript(token: string, nonce: string): string {
  return `(() => { if (!(${documentGuard(nonce, token)})) return false; const state = globalThis[${JSON.stringify(KEY)}]; if (state?.token !== ${JSON.stringify(token)} || state.done || state.takenOver || typeof state.resume !== 'function') return { ok: false, error: '草稿备份后的发送已取消，未覆盖' }; return state.resume(); })()`;
}

function cancelScript(token: string, nonce: string): string {
  return `(async () => { if (!(${documentGuard(nonce)})) return false; const binding = globalThis[${JSON.stringify(DOCUMENT_KEY)}]; if (binding.activeToken === ${JSON.stringify(token)}) binding.activeToken = undefined; const state = globalThis[${JSON.stringify(KEY)}]; const attachment = globalThis[${JSON.stringify(ATTACHMENT_KEY)}]; if (state?.token === ${JSON.stringify(token)}) { const clicked = state.clicked, result = state.cancel(); if (clicked) return result; const cleaned = await ${attachmentCleanupScript(token, nonce)}; return cleaned ? result : { ...result, uncertain: true, cancellation: 'unknown' }; } if (attachment?.token === ${JSON.stringify(token)}) { const cleanupOk = await ${attachmentCleanupScript(token, nonce)}; return { ok: false, error: '自动发送已取消', transportStarted: true, stage: 'preparing', cancellation: cleanupOk ? 'not_clicked' : 'unknown', ...(cleanupOk ? {} : { uncertain: true }) }; } return false; })()`;
}

export class WebComposerSender {
  private reserved = false;
  private token: string | undefined;
  private disposed = false;
  private generation = 0;
  private documentRevision = 0;
  private documentNonce: string | undefined;
  private tokenDocument: { nonce: string; revision: number } | undefined;
  private cancellationBlock: { token: string; nonce: string; revision: number; reason: string } | undefined;
  private cancelOperation: { token: string; promise: Promise<void> } | undefined;
  private loadingDocument: { revision: number; process: number; routing: number } | undefined;
  private abort: ((result: WebSendResult) => void) | undefined;
  private cleanup: Promise<void> = Promise.resolve();
  private cancellation: { token: string; result: WebSendResult } | undefined;
  private kind: 'results' | 'prompt' | undefined;
  private scope = '';
  constructor(private readonly web: SendWeb, private readonly options: SendOptions = {}) {
    web.on('did-start-navigation', this.navigating);
    web.on('did-navigate-in-page', this.inPage);
    web.on('did-frame-navigate', this.documentNavigated);
    web.on('did-frame-finish-load', this.documentFinished);
    web.on('did-fail-load', this.documentFailed);
    web.on('destroyed', this.destroyed);
  }
  private readonly navigating = (event: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (event.isMainFrame && !event.isSameDocument) { this.loadingDocument = undefined; void this.cancel(); }
  };
  private readonly inPage = (_event: unknown, url: string, main: boolean) => {
    if (main && sessionKeyOf(url) !== this.scope && !(this.kind === 'prompt' && (isFirstPromptSession(this.scope, url) || isPendingFirstPromptSession(this.scope, url)))) void this.cancel();
  };
  private readonly documentNavigated = (_event: unknown, url: string, status: number, _text: string, main: boolean, process: number, routing: number) => {
    if (!main) return;
    void this.cancel();
    this.documentRevision++; this.documentNonce = undefined; this.loadingDocument = undefined;
    const fixture = this.options.allowLocalFixture && url.startsWith('file:');
    if ((status >= 200 && status < 400 && webPlatformOf(url)) || fixture)
      this.loadingDocument = { revision: this.documentRevision, process, routing };
  };
  private readonly documentFailed = (_event: unknown, _code: number, _description: string, _url: string, main: boolean) => {
    if (main) this.loadingDocument = undefined;
  };
  private readonly documentFinished = (_event: unknown, main: boolean, process: number, routing: number) => {
    const loading = this.loadingDocument;
    if (!main || !loading || loading.process !== process || loading.routing !== routing) return;
    const block = this.cancellationBlock;
    if (!block || block.revision >= loading.revision) { this.loadingDocument = undefined; return; }
    void this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code: documentScript(randomUUID()) }]).then(nonce => {
      if (!this.disposed && this.loadingDocument === loading && this.documentRevision === loading.revision && typeof nonce === 'string' && nonce && nonce !== block.nonce) {
        this.documentNonce = nonce;
        if (this.cancellationBlock === block) { this.cancellationBlock = undefined; traceCollection('composer.cancellation-recovered', { reason: 'new-document' }); }
      }
      if (this.loadingDocument === loading) this.loadingDocument = undefined;
    }).catch(() => { if (this.loadingDocument === loading) this.loadingDocument = undefined; });
  };
  private blockedResult(): WebSendResult | undefined {
    const block = this.cancellationBlock;
    return block ? { ok: false, error: `本批尚未发送：此前取消未确认（${block.reason}）；请完整重新加载网页后继续新批次`,
      blockedByPreviousCancellation: true, transportStarted: false, stage: 'preflight' } : undefined;
  }
  private readonly destroyed = () => { void this.dispose(); };

  async send(text: string, expectedSession: string, kind: 'results' | 'prompt' = 'results', current: () => boolean = () => true, attachments: readonly PromptAttachmentData[] = []): Promise<WebSendResult> {
    if (this.reserved) return { ok: false, error: '已有内容正在发送' };
    this.reserved = true; this.kind = kind;
    try { return await this.sendReserved(text, expectedSession, current, attachments); }
    finally { this.reserved = false; this.kind = undefined; }
  }
  private async stageAttachments(token: string, nonce: string, scope: string, fixture: boolean, files: readonly PromptAttachmentData[], generation: number, current: () => boolean, platform: WebPlatform): Promise<WebSendResult | null> {
    if (!files.length) return null;
    const call = (code: string) => this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code }]);
    const started: unknown = await call(attachmentStartScript(token, nonce, scope, fixture, platform));
    if (!started || typeof started !== 'object' || !('ok' in started) || !started.ok) {
      const error = started && typeof started === 'object' && 'error' in started ? String(started.error) : '无法准备官网附件控件';
      traceCollection('composer.attachment-start-rejected', { count: files.length, error });
      return { ok: false, error };
    }
    traceCollection('composer.attachment-started', { count: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0) });
    try {
      for (const file of files) {
        if (generation !== this.generation || !current()) throw new Error('需求、项目或会话已变化，附件上传已取消');
        const begin: unknown = await call(attachmentBeginFileScript(token, nonce, file));
        if (begin !== true) throw new Error('官网附件上传状态已变化');
        let size = 0;
        for await (const bytes of file.stream()) {
          if (generation !== this.generation || !current()) throw new Error('需求、项目或会话已变化，附件上传已取消');
          size += bytes.byteLength;
          if (size > file.size) throw new Error(`附件大小已变化：${file.name}`);
          const accepted: unknown = await call(attachmentChunkScript(token, nonce, bytes));
          if (accepted !== true) throw new Error(`官网拒绝附件数据：${file.name}`);
        }
        if (size !== file.size || await call(attachmentFinishFileScript(token, nonce)) !== true) throw new Error(`附件读取不完整：${file.name}`);
      }
      if (generation !== this.generation || !current()) throw new Error('需求、项目或会话已变化，附件上传已取消');
      const committed: unknown = await call(attachmentCommitScript(token, nonce, files));
      if (committed && typeof committed === 'object' && 'ok' in committed && committed.ok) {
        traceCollection('composer.attachment-committed', { count: files.length });
        const totalMb = Math.ceil(files.reduce((sum, file) => sum + file.size, 0) / (1024 * 1024));
        const deadline = Date.now() + Math.min(300_000, 30_000 + totalMb * 1000);
        let lastStatus = '';
        while (Date.now() < deadline) {
          if (generation !== this.generation || !current()) throw new Error('需求、项目或会话已变化，附件上传已取消');
          const state: unknown = await call(attachmentStatusScript(token, nonce, files));
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
      if (generation !== this.generation && this.cancelOperation?.token === token) {
        await this.cancelOperation.promise;
        return this.cancellation?.token === token ? this.cancellation.result : { ok: false, error: '附件运输已取消，清理状态未知', uncertain: true };
      }
      const cleaned = await call(attachmentCleanupScript(token, nonce)).catch(() => false);
      const message = error instanceof Error ? error.message : String(error);
      traceCollection('composer.attachment-stage-failed', { count: files.length, cleaned, error: message });
      return { ok: false, error: `${message}${cleaned ? '' : '；官网附件清理状态未确认，请检查页面'}`, ...(!cleaned ? { uncertain: true } : {}) };
    }
  }
  private async sendReserved(text: string, expectedSession: string, current: () => boolean, attachments: readonly PromptAttachmentData[]): Promise<WebSendResult> {
    if (this.disposed || this.web.isDestroyed()) return { ok: false, error: '网页已关闭' };
    const blocked = this.blockedResult(); if (blocked) return blocked;
    if (this.token) return { ok: false, error: '已有内容正在发送' };
    if (!text.trim()) return { ok: false, error: '发送内容为空' };
    const generation = this.generation;
    await this.cleanup;
    if (generation !== this.generation) return { ok: false, error: '自动发送已取消' };
    if (this.disposed || this.web.isDestroyed()) return { ok: false, error: '网页已关闭' };
    const afterCleanup = this.blockedResult(); if (afterCleanup) return afterCleanup;
    const raw = this.web.getURL(); let url: URL;
    try { url = new URL(raw); } catch { return { ok: false, error: '网页地址不可识别' }; }
    const platform = webPlatformOf(raw) ?? (this.options.allowLocalFixture && url.protocol === 'file:' ? 'deepseek' : undefined);
    if (!platform) return { ok: false, error: '自动发送仅支持官方平台普通对话网页' };
    if (sessionKeyOf(raw) !== expectedSession) return { ok: false, error: '网页会话已变化' };
    // 等待清理期间其他调用可能已开始，必须再核验唯一正在发送的批次。
    if (this.token) return { ok: false, error: '已有内容正在发送' };
    const token = randomUUID(); this.token = token; this.scope = expectedSession;
    if (!current()) { this.token = undefined; return { ok: false, error: '发送资格已失效' }; }
    const cancelled = new Promise<WebSendResult>(resolve => { this.abort = resolve; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let cancellationSettled = false;
    let stage: WebSendStage = 'preflight';
    let transportStarted = false;
    let nonce = '';
    const bounded = new Promise<WebSendResult>(resolve => { timeout = setTimeout(() => {
      timedOut = true;
      void this.cancel().then(() => {
        cancellationSettled = true;
        const cancelled = this.cancellation?.token === token ? this.cancellation.result : undefined;
        const notClicked = cancelled?.cancellation === 'not_clicked' && !cancelled.uncertain;
        const cancellation = cancelled?.cancellation ?? 'unknown';
        traceCollection('composer.send-timeout', { stage: cancelled?.stage ?? stage, cancellation });
        resolve({ ok: false, error: '网页发送等待超时，' + (notClicked ? '已确认取消且未点击发送，本批不会重试' : cancellation === 'clicked' ? '已触发发送但接收未确认，不会重试' : '取消状态未确认，已停止且不会重试'),
          ...(!notClicked ? { uncertain: true } : {}), transportStarted, stage: cancelled?.stage ?? stage, cancellation });
      });
    }, attachments.length ? Math.min(300_000, Math.max(30_000, 30_000 + Math.ceil(attachments.reduce((sum, file) => sum + file.size, 0) / (1024 * 1024)) * 1000)) : 7500); });
    // 超时后的取消会使页面原 Promise 一并结束；仍等待有界清理结论，不能丢失点击证据。
    const settledCancellation = async (): Promise<WebSendResult> => {
      await this.cleanup;
      cancellationSettled = true;
      return this.cancellation?.token === token ? this.cancellation.result
        : { ok: false, error: '网页取消状态未确认，已停止且不会重试', uncertain: true, transportStarted: true, stage: 'unknown', cancellation: 'unknown' };
    };
    const waitFor = async <T>(task: Promise<T>): Promise<T | WebSendResult> => {
      try {
        const result = await Promise.race([task, cancelled, bounded]);
        return timedOut ? bounded : generation !== this.generation ? settledCancellation() : result;
      } catch (error) {
        if (timedOut) return bounded;
        if (generation !== this.generation) return settledCancellation();
        throw error;
      }
    };
    let draftBackupPath: string | undefined;
    try {
      const documentRevision = this.documentRevision;
      const bound = await waitFor(this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code: documentScript(randomUUID(), token) }]));
      if (typeof bound !== 'string' || !bound) {
        if (bound && typeof bound === 'object' && 'ok' in bound && bound.ok === false) return bound as WebSendResult;
        return { ok: false, error: '无法确认当前网页文档，未发送', transportStarted: false, stage: 'preflight' };
      }
      if (generation !== this.generation || documentRevision !== this.documentRevision || !current() || sessionKeyOf(this.web.getURL()) !== expectedSession)
        return { ok: false, error: '需求、项目或网页文档已变化，未发送', transportStarted: false, stage: 'preflight' };
      nonce = bound; this.documentNonce = nonce; this.tokenDocument = { nonce, revision: documentRevision };
      transportStarted = true; stage = 'preparing';
      if (attachments.length) {
        const staged = await waitFor(this.stageAttachments(token, nonce, expectedSession, this.options.allowLocalFixture === true, attachments, generation, current, platform));
        if (staged) return { stage: 'preparing', ...staged, transportStarted: true };
      }
      if (generation !== this.generation || !current()) {
        if (attachments.length) {
          const cleaned = await this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code: attachmentCleanupScript(token, nonce) }]).catch(() => false);
          if (cleaned !== true) return { ok: false, error: '发送资格已失效，官网附件清理状态未确认，请检查页面', uncertain: true };
        }
        return { ok: false, error: '需求、项目或会话已变化，未发送' };
      }
      const canBackup = platform === 'chatgpt' && this.kind === 'results' && !!this.options.backupDraft;
      let result: unknown = await waitFor(this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code: sendScript(token, nonce, text, expectedSession, this.options.allowLocalFixture === true, this.kind === 'prompt', attachments, platform, canBackup) }]));
      if (canBackup && result && typeof result === 'object' && 'draftText' in result && typeof result.draftText === 'string') {
        if (generation !== this.generation || !current() || sessionKeyOf(this.web.getURL()) !== expectedSession) {
          await this.cancel('results'); return { ok: false, error: '草稿备份前发送资格已失效，未覆盖' };
        }
        try {
          stage = 'draft_backup';
          const saved = await waitFor(this.options.backupDraft!(result.draftText, expectedSession));
          if (typeof saved !== 'string') return saved;
          if (!saved) throw new Error('无法确认草稿备份路径');
          draftBackupPath = saved;
        } catch (error) {
          await this.cancel('results');
          return { ok: false, error: `网页草稿备份失败，未覆盖：${error instanceof Error ? error.message : String(error)}` };
        }
        if (generation !== this.generation || !current() || sessionKeyOf(this.web.getURL()) !== expectedSession) {
          await this.cancel('results'); return { ok: false, error: '草稿已备份，但发送资格已失效，未覆盖', draftBackupPath };
        }
        try { this.options.draftSaved?.(draftBackupPath); }
        catch { traceCollection('composer.draft-notice-failed', { kind: this.kind }); }
        if (generation !== this.generation || !current() || sessionKeyOf(this.web.getURL()) !== expectedSession) {
          await this.cancel('results'); return { ok: false, error: '草稿已备份，但发送资格已失效，未覆盖', draftBackupPath };
        }
        result = await waitFor(this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code: resumeDraftScript(token, nonce) }]));
      }
      traceCollection('composer.send-result', { kind: this.kind, attachmentCount: attachments.length,
        ok: Boolean(result && typeof result === 'object' && 'ok' in result && result.ok === true),
        error: result && typeof result === 'object' && 'error' in result ? String(result.error) : null,
        controlState: result && typeof result === 'object' && 'controlState' in result ? result.controlState : undefined,
        stage: result && typeof result === 'object' && 'stage' in result ? result.stage : stage,
        cancellation: result && typeof result === 'object' && 'cancellation' in result ? result.cancellation : undefined });
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false && !('uncertain' in result) && attachments.length
        && !(cancellationSettled && 'cancellation' in result && result.cancellation === 'not_clicked')) {
        const cleaned = await this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code: attachmentCleanupScript(token, nonce) }]).catch(() => false);
        if (cleaned !== true) return { ok: false, error: '发送未完成，官网附件清理状态未确认，请检查页面', uncertain: true };
      }
      if (result && typeof result === 'object' && 'ok' in result && typeof result.ok === 'boolean') return { stage, ...result as WebSendResult, transportStarted: true, ...(draftBackupPath ? { draftBackupPath } : {}) };
      return { ok: false, error: '网页发送状态不可识别，已停止且不会重试', uncertain: true, transportStarted: true, stage: 'unknown' };
    } catch {
      // 渲染进程异常可能发生在点击后，不能推断为未发送。
      return transportStarted ? { ok: false, error: '网页发送检查失败，已停止且不会重试', uncertain: true, transportStarted: true, stage: 'unknown', ...(draftBackupPath ? { draftBackupPath } : {}) }
        : { ok: false, error: '网页文档核验失败，本批尚未发送', transportStarted: false, stage: 'preflight' };
    } finally {
      clearTimeout(timeout);
      if (this.token === token) { this.token = undefined; this.tokenDocument = undefined; this.kind = undefined; this.abort = undefined; }
    }
  }

  async cancel(expectedKind?: 'results' | 'prompt'): Promise<void> {
    if (expectedKind && this.kind && this.kind !== expectedKind) return;
    this.generation++;
    const token = this.token;
    if (!token) { await this.cleanup; return; }
    if (this.cancelOperation?.token === token) { await this.cancelOperation.promise; return; }
    const abort = this.abort, binding = this.tokenDocument;
    if (!binding) {
      const outcome: WebSendResult = { ok: false, error: '文档核验期间已取消，未发送', transportStarted: false, stage: 'preflight', cancellation: 'not_clicked' };
      this.cancellation = { token, result: outcome }; abort?.(outcome); return;
    }
    const { nonce, revision } = binding;
    const activeDocument = () => !this.disposed && this.documentRevision === revision && this.documentNonce === nonce;
    const safe = (result: WebSendResult | undefined) => result?.cancellation === 'not_clicked' && !result.uncertain;
    const normalize = (result: unknown): WebSendResult => result && typeof result === 'object' && 'ok' in result ? result as WebSendResult
      : { ok: false, error: '网页已变化，自动发送已取消', uncertain: true, transportStarted: true, stage: 'unknown', cancellation: 'unknown' };
    let late: WebSendResult | undefined;
    const recover = () => {
      if (activeDocument() && safe(late) && this.cancellationBlock?.token === token && this.cancellationBlock.nonce === nonce) {
        this.cancellationBlock = undefined; traceCollection('composer.cancellation-recovered', { reason: 'confirmed-cleanup' });
      }
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const raw = Promise.resolve().then(() => this.web.isDestroyed() ? false
      : this.web.executeJavaScriptInIsolatedWorld(COMPOSER_SEND_WORLD, [{ code: cancelScript(token, nonce) }])).then(normalize, () => normalize(false));
    // 原取消结论有界返回；迟到证据只解除对应旧阻断，不修改旧批结果，也不启动任何发送。
    void raw.then(result => { late = result; recover(); });
    const unconfirmed = new Promise<WebSendResult>(resolve => { timeout = setTimeout(() => resolve({ ok: false,
      error: '网页取消状态未确认，自动发送已停止', uncertain: true, transportStarted: true, stage: 'unknown', cancellation: 'unknown' }), 1000); });
    this.cleanup = Promise.race([raw, unconfirmed]).then(outcome => {
      if (activeDocument() && !safe(outcome)) {
        this.cancellationBlock ??= { token, nonce, revision, reason: `${outcome.stage ?? 'unknown'}：${(outcome.error ?? '取消或清理状态未知').replace(/[\r\n]/g, ' ').slice(0, 160)}` };
        recover();
      }
      this.cancellation = { token, result: outcome };
      traceCollection('composer.cancel-result', { stage: outcome.stage, cancellation: outcome.cancellation ?? 'unknown', uncertain: outcome.uncertain === true });
      abort?.(outcome);
    }).finally(() => clearTimeout(timeout));
    this.cancelOperation = { token, promise: this.cleanup };
    await this.cleanup;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.web.removeListener('did-start-navigation', this.navigating);
    this.web.removeListener('did-navigate-in-page', this.inPage);
    this.web.removeListener('destroyed', this.destroyed);
    this.web.removeListener('did-frame-navigate', this.documentNavigated);
    this.web.removeListener('did-frame-finish-load', this.documentFinished);
    this.web.removeListener('did-fail-load', this.documentFailed);
    await this.cancel();
  }
}
