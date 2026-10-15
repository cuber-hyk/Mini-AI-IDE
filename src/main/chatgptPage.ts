/** ChatGPT 普通对话只读 DOM 规则，依据原生页面结构诊断；控件变化时暂停。 */
export const CHATGPT_SEND_SELECTOR = 'button[type="submit"][aria-label="发送"],button[type="submit"][aria-label="Send"]';
/** 官网附件结构的只读解释；图片卡与文档卡分开，文档缩略图不能冒充图片附件。 */
export const CHATGPT_ATTACHMENT_READER = `(composer => {
  const visible = e => !!e && e.isConnected && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const remove = e => e.matches('button') && visible(e) && /^(移除|删除|remove|delete)/i.test(e.getAttribute('aria-label') || '');
  const buttons = Array.from(composer.querySelectorAll('button')).filter(remove);
  const cards = buttons.map(button => {
    const node = button.parentElement;
    if (!button.matches('button[type="button"]') || !node || node === composer || node.closest('form') !== composer || node.querySelector('input,textarea,[contenteditable="true"],[data-dil-message-id]')
      || Array.from(node.querySelectorAll('button')).filter(remove).length !== 1) return null;
    const images = Array.from(node.querySelectorAll('img')).filter(visible);
    const image = node.matches('div[role="button"][aria-haspopup][data-state="closed"]') && images.length === 1
      && !images[0].hasAttribute('data-attachment-thumbnail-state');
    const document = node.tagName === 'SPAN' && String(node.textContent || '').trim() !== '';
    if (!image && !document) return null;
    const thumbnails = Array.from(node.querySelectorAll('[data-attachment-thumbnail-state]'));
    const readyImage = image && images[0].complete && images[0].naturalWidth > 0 && /^(data:image\\/|blob:)/.test(images[0].getAttribute('src') || '');
    const names = [node, ...Array.from(node.querySelectorAll('*'))].map(e => String(e.textContent || ''));
    const displayName = (button.getAttribute('aria-label') || '').replace(/^(?:移除|删除|remove|delete)\\s*/i, '');
    return { node, remove: button, kind: image ? 'image' : 'document', text: String(node.textContent || ''),
      matchesName: name => {
        if (names.includes(name)) return true;
        const dot = name.lastIndexOf('.');
        if (!document || dot <= 0 || !displayName.startsWith(name.slice(0, dot)) || !displayName.endsWith(name.slice(dot)) || !names.includes(displayName)) return false;
        // 官网同名文档会在扩展名前追加数字编号；仅接受完整已知名称，不用前缀包含代替身份。
        return /^ ?\\([1-9][0-9]*\\)$/.test(displayName.slice(dot, -name.slice(dot).length));
      },
      ready: image ? readyImage : thumbnails.every(e => e.getAttribute('data-attachment-thumbnail-state') === 'ready') };
  });
  const previews = Array.from(composer.querySelectorAll('img,video,audio,canvas,[data-attachment-thumbnail-state],[data-testid*="attachment"],[data-testid*="file"],[data-testid*="upload"],[data-testid*="image"]'))
    .filter(e => visible(e) && !e.matches('button,[role="button"]'));
  const unknown = cards.some(card => !card) || cards.some((card, i) => cards.some((other, j) => i !== j && card && other && card.node.contains(other.node)))
    || previews.some(e => !cards.some(card => card?.node.contains(e)));
  const pending = Array.from(composer.querySelectorAll('[role="progressbar"],[aria-busy="true"]')).some(visible);
  const error = Array.from(composer.querySelectorAll('[role="alert"],[aria-invalid="true"],[data-state="error"],[data-state="failed"]')).some(e => visible(e) && !e.closest('[contenteditable="true"]'))
    || cards.some(card => card && /上传失败|上传错误|无法上传|不支持.{0,12}文件|超出.{0,12}限制|upload failed|upload error|failed to upload|file too large|unsupported file/i.test(card.text));
  return { cards: cards.filter(Boolean), unknown, pending, error };
})`;
/** 文档身份须双向唯一；同名或编号名称有多个解释时，发送和清理均暂停。 */
export const CHATGPT_DOCUMENTS_MATCH = `((cards, files) => {
  const documents = cards.filter(card => card.kind === 'document');
  const expected = files.filter(file => !/^image\\//.test(file.type || ''));
  const matches = expected.map(file => documents.map(card => card.matchesName(file.name)));
  const matched = matches.filter(row => row.filter(Boolean).length === 1).length;
  const ambiguous = matches.some(row => row.filter(Boolean).length > 1) || documents.some((_, index) => matches.filter(row => row[index]).length > 1);
  return { ready: !ambiguous && matched === expected.length && documents.length === expected.length, ambiguous, matched };
})`;
export const CHATGPT_TURN_SELECTOR = 'div[data-talvt-turn-state]';
// 正文资格由本轮角色、owner、markdown及唯一性限定，样式类不承担消息身份。
export const CHATGPT_REPLY_SELECTOR = 'div[data-dil-message-id]';
export const CHATGPT_CODE_SELECTOR = 'code[class*="CodeContent-"]';
export const CHATGPT_CODE_SURFACE_SELECTOR = 'div[class*="CodeSurface-"][data-markdown-copy]';
const CHATGPT_BODY_CONTROL_EXCLUSION = `${CHATGPT_CODE_SURFACE_SELECTOR},${CHATGPT_REPLY_SELECTOR},[data-user-message-bubble],[class~="group/user-message"]`;

export const CHATGPT_REPLY_NODES = `
  const messages = Array.from(document.querySelectorAll(${JSON.stringify(CHATGPT_TURN_SELECTOR)}));
  const frame = messages.at(-1);
  const excluded = '[data-user-message-bubble],[class~="group/user-message"],[data-testid*="thought"],[data-testid*="reasoning"],details,[data-d-component*="thought"],[data-d-component*="reasoning"]';
  const markers = frame ? Array.from(frame.querySelectorAll('h4[data-conversation-role="assistant"]')).filter(e => !e.closest(excluded)
    && e.closest(${JSON.stringify(CHATGPT_TURN_SELECTOR)}) === frame) : [];
  const ownerSelector = 'div[data-chatgpt-search-unit-key]';
  const ownerOf = marker => {
    const owner = marker?.closest(ownerSelector);
    if (!owner || owner.closest(${JSON.stringify(CHATGPT_TURN_SELECTOR)}) !== frame) return null;
    const roles = Array.from(owner.querySelectorAll('h4[data-conversation-role="assistant"]')).filter(e => !e.closest(excluded));
    return roles.length === 1 && roles[0] === marker ? owner : null;
  };
  const latestOwner = ownerOf(markers.at(-1));
  // 同轮较早消息须有自己的局部页脚；只接纳已知连续消息结构，不从未知最后角色向前回退。
  const earlierOwners = markers.slice(0, -1).map(ownerOf);
  const earlierComplete = new Set(earlierOwners).size === earlierOwners.length && earlierOwners.every(owner => owner
    && owner !== latestOwner && !owner.contains(latestOwner) && !latestOwner?.contains(owner)
    && Array.from(owner.querySelectorAll('.turn-action-controls')).filter(e => e.closest(ownerSelector) === owner
      && !e.closest(excluded) && !e.closest(${JSON.stringify(CHATGPT_REPLY_SELECTOR)})).length === 1);
  const latestHasFooter = latestOwner && Array.from(latestOwner.querySelectorAll('.turn-action-controls')).some(e => e.closest(ownerSelector) === latestOwner
    && !e.closest(excluded) && !e.closest(${JSON.stringify(CHATGPT_REPLY_SELECTOR)}));
  const assistant = earlierComplete && (!earlierOwners.length || !latestHasFooter) ? latestOwner : null;
  const candidates = assistant && assistant.closest(${JSON.stringify(CHATGPT_TURN_SELECTOR)}) === frame
    ? Array.from(assistant.querySelectorAll(${JSON.stringify(CHATGPT_REPLY_SELECTOR)})).filter(e => !e.closest(excluded)
      && e.closest(${JSON.stringify(CHATGPT_TURN_SELECTOR)}) === frame
      && e.closest(ownerSelector) === assistant
      && !!e.closest('div[data-markdown-text-style]') && assistant.contains(e.closest('div[data-markdown-text-style]'))) : [];
  const nodes = candidates.length === 1 ? candidates : [];
  const reply = nodes[0] || null;
`;

/** 同步只读生成见证：只有当前回复区域及已知停止控件能阻断本轮。 */
export const CHATGPT_GENERATING_SCRIPT = `(() => {
  const visible = e => !!e && e.getClientRects().length > 0;
  const labels = e => [e.getAttribute('aria-label'), e.getAttribute('title')].filter(Boolean).join(' ').trim();
  if (Array.from(document.querySelectorAll('button')).some(e => visible(e)
    && !e.closest(${JSON.stringify(CHATGPT_BODY_CONTROL_EXCLUSION)})
    && (e.getAttribute('data-testid') === 'stop-button' || /^(stop|停止|stop generating|stop streaming|停止生成|停止回答|停止流式传输)$/i.test(labels(e))))) return true;
  ${CHATGPT_REPLY_NODES}
  if (!frame) return false;
  const busy = '[aria-busy="true"],[data-is-streaming="true"]';
  if (visible(frame) && frame.matches(busy)) return true;
  return !!assistant && [assistant, ...Array.from(assistant.querySelectorAll(busy))].some(e => visible(e)
    && e.matches(busy) && e.closest(${JSON.stringify(CHATGPT_TURN_SELECTOR)}) === frame
    && !e.closest('button,[role="button"],div[class*="StickyActionBar-"][data-markdown-copy],[data-user-message-bubble],[class~="group/user-message"]')
    && (e === assistant || (reply && (e.contains(reply) || reply.contains(e)))
      || !!e.closest('[data-testid*="thought"],[data-testid*="reasoning"],details,[data-d-component*="thought"],[data-d-component*="reasoning"]')));
})()`;

/** 来源见证只取正文；复制等控件文案变化不能把已完成回复变成未知来源。 */
export const CHATGPT_SOURCE_TEXT_READER = `(node => {
  const excluded = '[data-user-message-bubble],[class~="group/user-message"],[data-testid*="thought"],[data-testid*="reasoning"],details,[data-d-component*="thought"],[data-d-component*="reasoning"]';
  const read = current => {
    if (current.nodeType === 3) return String(current.textContent || '');
    if (current.nodeType !== 1 || current.matches(excluded)) return '';
    // 正式代码逐字读取；段落短路与 collector 保持相同范围，不能漏掉实际采集文本。
    if (current.matches(${JSON.stringify(CHATGPT_CODE_SELECTOR)})) return String(current.textContent || '');
    const tag = String(current.tagName || '').toUpperCase();
    if (/^(BUTTON|SVG|SCRIPT|STYLE|INPUT|TEXTAREA|SELECT)$/.test(tag)) return '';
    if (/^(H[1-6]|P|LI|BLOCKQUOTE|DT|DD)$/.test(tag) && !current.querySelector(${JSON.stringify(CHATGPT_CODE_SELECTOR)})) return String(current.innerText || current.textContent || '');
    const children = Array.from(current.childNodes || []);
    return children.length ? children.map(read).join('') : String(current.textContent || '');
  };
  return read(node);
})`;

export const CHATGPT_COMPLETION_SCRIPT = `(() => {
  if (globalThis.__miniAIReplyChanges?.lastAction === 'stop') return 'interrupted';
  const visible = e => !!e && e.getClientRects().length > 0;
  const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
  const labels = e => [e.getAttribute('aria-label'), e.getAttribute('title')].filter(Boolean).join(' ').trim();
  if (${CHATGPT_GENERATING_SCRIPT}) return 'generating';
  if (buttons.some(e => !e.closest(${JSON.stringify(CHATGPT_BODY_CONTROL_EXCLUSION)}) && /^(continue generating|继续生成)$/i.test(labels(e)))) return 'interrupted';
  ${CHATGPT_REPLY_NODES}
  if (!reply || !visible(reply) || frame.getAttribute('data-talvt-turn-state') !== 'complete') return 'unknown';
  if (assistant.querySelector('details[open]')) return 'unknown';
  const footers = Array.from(frame.querySelectorAll('.turn-action-controls')).filter(e => e.closest(${JSON.stringify(CHATGPT_TURN_SELECTOR)}) === frame
    && !e.closest(ownerSelector) && !e.closest(excluded) && !e.closest(${JSON.stringify(CHATGPT_REPLY_SELECTOR)}));
  if (footers.length !== 1) return 'unknown';
  const copies = Array.from(footers[0].querySelectorAll('button')).filter(e => visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true'
    && /^(复制|copy)$/i.test(String(e.getAttribute('aria-label') || '').trim()));
  return copies.length === 1 ? 'complete' : 'unknown';
})()`;

export const CHATGPT_OBSERVATION_SCRIPT = `(() => {
  const completion = ${CHATGPT_COMPLETION_SCRIPT};
  if (completion !== 'complete') return { completion, signature: completion };
  ${CHATGPT_REPLY_NODES}
  const content = String(reply.innerHTML || reply.textContent || '');
  globalThis.__miniAIReplyChanges?.updateSources?.();
  const source = globalThis.__miniAIReplyChanges?.sources?.source(reply);
  const sourceKey = globalThis.__miniAIReplyChanges?.sources?.key(reply);
  let first = 2166136261, second = 5381;
  for (let i = 0; i < content.length; i++) { first = Math.imul(first ^ content.charCodeAt(i), 16777619); second = Math.imul(second, 33) ^ content.charCodeAt(i); }
  return { completion, source, sourceKey, signature: [messages.length, reply.querySelectorAll(${JSON.stringify(CHATGPT_CODE_SELECTOR)}).length, content.length, first >>> 0, second >>> 0, completion, source || '', sourceKey || ''].join(':') };
})()`;

export const CHATGPT_COLLECT_SCRIPT = `(() => {
  ${CHATGPT_REPLY_NODES}
  if (!reply) return [];
  const fenceFor = content => { let longest = 0; for (const match of content.matchAll(/\x60+/g)) longest = Math.max(longest, match[0].length); return '\x60'.repeat(Math.max(4, longest + 1)); };
  const parts = [];
  const codePart = surface => {
    const codes = Array.from(surface.querySelectorAll(${JSON.stringify(CHATGPT_CODE_SELECTOR)}));
    if (codes.length !== 1 || codes[0].closest(${JSON.stringify(CHATGPT_CODE_SURFACE_SELECTOR)}) !== surface) throw new Error('ChatGPT 代码框结构不唯一');
    const bars = Array.from(surface.children).filter(e => e.matches('div[class*="StickyActionBar-"][data-markdown-copy]'));
    const labels = [];
    const readLabel = node => {
      if (/^(BUTTON|SVG|CODE|SCRIPT|STYLE)$/.test(String(node.tagName || '').toUpperCase()) || node.getAttribute('role') === 'button') return;
      if (node.children.length) { Array.from(node.children).forEach(readLabel); return; }
      const text = String(node.textContent || '').trim();
      if (/^[\\w+#-]+$/.test(text) && !/^(copy|download|run)$/i.test(text)) labels.push(text);
    };
    if (bars.length !== 1) throw new Error('ChatGPT 代码框语言工具栏不唯一');
    readLabel(bars[0]);
    const unique = Array.from(new Set(labels));
    const language = unique.length === 1 ? unique[0] : '';
    const text = codes[0].textContent;
    if (typeof text !== 'string') throw new Error('无法读取 ChatGPT 代码正文');
    const fence = fenceFor(text);
    parts.push(fence + language + '\\n' + text + '\\n' + fence);
  };
  const walk = node => {
    const tag = String(node.tagName || '').toUpperCase();
    if (node.matches?.(excluded)) return;
    if (node.matches?.(${JSON.stringify(CHATGPT_CODE_SURFACE_SELECTOR)})) { codePart(node); return; }
    if (/^(BUTTON|SCRIPT|STYLE|INPUT|TEXTAREA|SELECT|SVG)$/.test(tag)) return;
    if (node.matches?.(${JSON.stringify(CHATGPT_CODE_SELECTOR)})) throw new Error('ChatGPT 代码正文缺少已识别代码框');
    if (tag === 'HR') { parts.push('---'); return; }
    if (/^(H[1-6]|P|LI|BLOCKQUOTE|DT|DD)$/.test(tag) && !node.querySelector(${JSON.stringify(CHATGPT_CODE_SELECTOR)})) {
      const text = String(node.innerText || node.textContent || '').trim();
      if (text) parts.push(/^H[1-6]$/.test(tag) ? '#'.repeat(Number(tag[1])) + ' ' + text : text);
      return;
    }
    Array.from(node.childNodes || node.children || []).forEach(child => {
      if (child.nodeType === 3) { if (String(child.textContent || '').trim()) parts.push(child.textContent); }
      else walk(child);
    });
  };
  walk(reply);
  return parts.length ? [parts.join('\\n\\n')] : [];
})()`;
