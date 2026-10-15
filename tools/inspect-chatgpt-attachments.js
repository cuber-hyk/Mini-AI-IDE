/* 在内嵌ChatGPT的Console运行，或由显式结构诊断加载。只读结构，不返回正文、文件名、字节、URL或属性中的标识符。 */
(function () {
  if (location.origin !== 'https://chatgpt.com' || !(location.pathname === '/' || /^\/c\/[a-zA-Z0-9_-]+$/.test(location.pathname)))
    return JSON.stringify({ supported: false, reason: 'not-official-ordinary-chat' });
  var visible = function (e) { return Boolean(e && e.isConnected && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'); };
  var known = function (value, values) { return values.includes(value) ? value : value === null ? null : '<other>'; };
  var truncated = false;
  var descriptions = 0;
  var limited = function (items, count) { if (items.length > count) truncated = true; return items.slice(0, count); };
  var describe = function (e) {
    if (descriptions++ >= 1200) { truncated = true; return { tag: e.tagName, truncated: true }; }
    var attributeNames = e.getAttributeNames().filter(function (name) { return /^(data-|aria-)|^(id|class|role|type|form|accept|multiple|disabled)$/.test(name); });
    if (attributeNames.some(function (name) { return name.length > 80; })) truncated = true;
    return {
      tag: e.tagName,
      visible: visible(e),
      attributes: limited(attributeNames.filter(function (name) { return name.length <= 80; }), 24),
      role: known(e.getAttribute('role'), ['textbox', 'button', 'progressbar', 'alert', 'status', 'list', 'listitem', 'img']),
      state: known(e.getAttribute('data-state'), ['loading', 'uploading', 'pending', 'complete', 'completed', 'ready', 'error', 'failed', 'open', 'closed']),
      thumbnailState: known(e.getAttribute('data-attachment-thumbnail-state'), ['loading', 'pending', 'ready', 'loaded', 'complete', 'error', 'failed']),
      labelPrefix: /^(?:移除(?:附件|文件|图片)?|删除(?:附件|文件|图片)?|上传(?:其他)?(?:文件|图片|照片|视频)|添加(?:文件|图片|照片)|选择文件|Remove(?: (?:file|attachment|image))?|Upload (?:files?|images?|photos?|videos?)|Attach files?)/i.exec(e.getAttribute('aria-label') || '')?.[0] || null,
      busy: e.getAttribute('aria-busy') === 'true',
      disabled: Boolean(e.disabled || e.getAttribute('aria-disabled') === 'true'),
      testid: known(e.getAttribute('data-testid'), ['composer-plus-btn', 'upload-file-button', 'file-thumbnail', 'attachment', 'file-upload', 'upload-progress', 'remove-file', 'composer-attachment', 'send-button', 'stop-button'])
    };
  };
  var buttonKind = function (e) {
    var label = [e.getAttribute('aria-label'), e.getAttribute('title')].filter(Boolean).join(' ');
    if (/remove|delete|移除|删除/i.test(label)) return 'remove';
    if (/upload|attach|上传|附件|添加文件/i.test(label)) return 'attach';
    if (/^(send|发送|发送消息)$/i.test(label)) return 'send';
    if (/voice|语音/i.test(label)) return 'voice';
    return 'other';
  };
  var inputs = limited(Array.from(document.querySelectorAll('input[type="file"]')), 16);
  var composers = limited(Array.from(document.querySelectorAll('div.ProseMirror[contenteditable="true"][role="textbox"]')).filter(visible), 4);
  var forms = Array.from(new Set(composers.map(function (e) { return e.closest('form'); }).filter(Boolean)));
  var replySelector = '[data-message-author-role],[data-talvt-turn-state],[data-markdown-text-style],[data-dil-message-id]';
  var ancestors = function (e) {
    var result = [];
    for (var p = e.parentElement, depth = 0; p && p !== document.body && p !== document.documentElement && depth < 8; p = p.parentElement, depth++) {
      var replies = Boolean(p.querySelector(replySelector));
      result.push(Object.assign(describe(p), { depth: depth, containsReply: replies,
        composerIndexes: composers.map(function (c, i) { return p.contains(c) ? i : -1; }).filter(function (i) { return i >= 0; }),
        fileInputIndexes: inputs.map(function (c, i) { return p.contains(c) ? i : -1; }).filter(function (i) { return i >= 0; }) }));
      if (replies) break;
    }
    return result;
  };
  var tree = function (root, maximum = 180, maximumDepth = 7) {
    var count = 0, truncated = false;
    var walk = function (e, depth) {
      count++;
      var item = describe(e);
      if (e.matches('button,[role="button"]')) item.control = buttonKind(e);
      if (depth >= maximumDepth) { if (e.children.length) truncated = true; return item; }
      item.children = [];
      for (var child of e.children) {
        if (/^(SCRIPT|STYLE|SVG|PATH)$/.test(child.tagName)) continue;
        if (count >= maximum) { truncated = true; break; }
        item.children.push(walk(child, depth + 1));
      }
      return item;
    };
    var result = walk(root, 0);
    return { root: result, nodeCount: count, truncated: truncated };
  };
  var context = function (e, form) {
    var result = [];
    for (var p = e.parentElement, depth = 0; p && form.contains(p) && p !== form && depth < 2; p = p.parentElement, depth++)
      result.push(tree(p, 32, 5));
    return result;
  };
  // 只输出比较结果，定位文档卡省略扩展名等排版；不输出标签或文件名。
  var nameShape = function (button) {
    var suffix = (button.getAttribute('aria-label') || '').replace(/^(?:移除|删除|remove|delete)\s*/i, '');
    var extension = /\.(txt|md|pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|gif)$/i.exec(suffix);
    var card = button.parentElement;
    var nodes = card ? limited([card].concat(Array.from(card.querySelectorAll('*'))), 240) : [];
    var text = nodes.map(function (e) { return String(e.textContent || ''); });
    return { namedLabel: Boolean(extension), extension: extension ? extension[1].toLowerCase() : null,
      fullNameInText: Boolean(extension && text.includes(suffix)),
      stemInText: Boolean(extension && text.includes(suffix.slice(0, -extension[0].length))),
      fullNameInTitle: Boolean(extension && nodes.some(function (e) { return e.getAttribute('title') === suffix; })),
      fullNameInAriaLabel: Boolean(extension && nodes.some(function (e) { return e !== button && e.getAttribute('aria-label') === suffix; })) };
  };
  var result = { supported: true, version: 1,
    fileInputs: inputs.map(function (e) { return Object.assign(describe(e), { multiple: e.multiple, fileCount: e.files ? e.files.length : 0,
      unrestricted: !e.getAttribute('accept'),
      accept: /^(?:\s*(?:\.[a-z0-9]+|(?:image|application|text|audio|video)\/[a-z0-9.+*-]+)\s*,?)+$/i.test(e.getAttribute('accept') || '') ? e.getAttribute('accept').slice(0, 400) : null,
      label: /^(upload files?|upload photos?|upload images?|upload videos?|attach files?|add files?|choose files?|file upload|上传文件|上传照片|上传图片|上传视频|上传其他文件|添加文件|选择文件)$/i.test(e.getAttribute('aria-label') || '') ? e.getAttribute('aria-label') : null,
      ancestorFormIndex: forms.indexOf(e.closest('form')), associatedFormIndex: forms.indexOf(e.form), ancestors: ancestors(e) }); }),
    composers: composers.map(function (e) { return Object.assign(describe(e), { hasText: e.textContent !== '', formIndex: forms.indexOf(e.closest('form')), ancestors: ancestors(e) }); }),
    forms: forms.map(function (form) {
      var containsReply = Boolean(form.querySelector(replySelector));
      if (containsReply) return { containsReply: true, tree: null };
      var nodes = limited([form].concat(Array.from(form.querySelectorAll('*'))), 240).filter(visible);
      return { containsReply: false, images: nodes.filter(function (e) { return e.tagName === 'IMG'; }).length,
        sendControls: limited(nodes.filter(function (e) { return e.matches('button[type="submit"]') && /^(发送|Send)$/i.test(e.getAttribute('aria-label') || ''); }), 4).map(describe),
        imageDetails: limited(nodes.filter(function (e) { return e.tagName === 'IMG'; }), 3).map(function (e) { return {
          node: describe(e), complete: e.complete, width: e.naturalWidth, height: e.naturalHeight,
          sourceKind: /^(blob:|data:image\/|https:)/.exec(e.getAttribute('src') || '')?.[1] || '<other>', context: context(e, form) }; }),
        removeControls: limited(nodes.filter(function (e) { return e.matches('button,[role="button"]') && buttonKind(e) === 'remove'; }), 3).map(function (e) { return {
          node: describe(e), label: known(e.getAttribute('aria-label'), ['Remove', 'Remove file', 'Remove attachment', 'Remove image', '删除', '移除', '删除文件', '移除文件', '移除附件', '移除图片']), nameShape: nameShape(e), context: context(e, form) }; }),
        progress: limited(nodes.filter(function (e) { return e.getAttribute('role') === 'progressbar' || e.getAttribute('aria-busy') === 'true'; }), 16).map(describe),
        alerts: limited(nodes.filter(function (e) { return e.getAttribute('role') === 'alert'; }), 16).map(describe), tree: tree(form) };
    })
  };
  result.truncated = truncated || result.forms.some(function (form) { return Boolean(form.tree && form.tree.truncated); });
  return JSON.stringify(result);
}());
