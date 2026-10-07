/* 在 Mini-AI-IDE 内嵌 AI 网页的开发者工具 Console 中粘贴全文；不要在外部浏览器执行。仅同步读取 DOM，不修改网页。 */
(function () {
  function describe(element) {
    return {
      tag: element.tagName,
      className: String(element.className || ''),
      aria: element.getAttribute('aria-label'),
      title: element.getAttribute('title'),
      tooltip: element.getAttribute('data-tooltip'),
      text: String(element.textContent || '').slice(0, 120),
      html: element.outerHTML.slice(0, 1800)
    };
  }
  var markdown = Array.prototype.slice.call(document.querySelectorAll('[class*="markdown"]'));
  // 记录实际候选及控件归属；不以最后12个控件的截断列表推断页脚缺失。
  var roots = markdown.filter(function (element) {
    if (element.closest('pre,code')) return false;
    for (var parent = element.parentElement; parent; parent = parent.parentElement) {
      if (/markdown/.test(String(parent.className || ''))) return false;
    }
    return true;
  });
  var reply = roots[roots.length - 1];
  var message = reply && reply.closest('.ds-message');
  var frame = message && message.parentElement;
  function controlState(element) {
    return {
      tag: element.tagName, className: String(element.className || ''),
      visible: element.getClientRects().length > 0,
      disabled: Boolean(element.disabled), ariaDisabled: element.getAttribute('aria-disabled'),
      aria: element.getAttribute('aria-label'), title: element.getAttribute('title'),
      text: String(element.textContent || '').slice(0, 80),
      inReply: Boolean(reply && reply.contains(element)),
      inCode: Boolean(element.closest('pre,code,[class*="code-block"]')),
      paths: Array.prototype.slice.call(element.querySelectorAll('svg path')).map(function (p) { return String(p.getAttribute('d') || '').slice(0, 100); })
    };
  }
  var pres = document.querySelectorAll('pre');
  var ancestors = [];
  var node = pres.length ? pres[pres.length - 1] : null;
  for (var depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
    ancestors.push({
      tag: node.tagName,
      className: String(node.className || ''),
      controls: Array.prototype.slice.call(node.querySelectorAll('button,[role="button"],.ds-icon-button')).filter(function (element) {
        return element.getClientRects().length > 0;
      }).slice(-12).map(describe)
    });
  }
  return JSON.stringify({
    replyState: {
      candidateCount: roots.length,
      latest: reply ? { tag: reply.tagName, className: String(reply.className || '') } : null,
      frame: frame ? { tag: frame.tagName, className: String(frame.className || '') } : null,
      frameCandidateIndexes: frame ? roots.map(function (root, index) { return frame.contains(root) ? index : -1; }).filter(function (index) { return index >= 0; }) : [],
      frameControls: frame ? Array.prototype.slice.call(frame.querySelectorAll('button,[role="button"],.ds-button,.ds-icon-button')).map(controlState) : [],
      composerControls: Array.prototype.slice.call(document.querySelectorAll('.ds-button.ds-button--primary.ds-button--filled.ds-button--circle')).map(controlState),
      generatingNodes: Array.prototype.slice.call(document.querySelectorAll('[aria-busy="true"],[data-is-streaming="true"]')).map(function (element) { return { tag: element.tagName, className: String(element.className || ''), visible: element.getClientRects().length > 0 }; })
    },
    markdown: markdown.map(function (element) { return { tag: element.tagName, className: String(element.className || '') }; }),
    preAncestors: ancestors,
    controls: Array.prototype.slice.call(document.querySelectorAll('button,[role="button"],.ds-icon-button')).filter(function (element) {
      return element.getClientRects().length > 0;
    }).slice(-35).map(describe)
  }, null, 2);
}());
