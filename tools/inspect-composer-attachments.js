/* 在 IDE 内嵌 DeepSeek 的 Console 中粘贴全文。只读结构与数量，不读取需求正文、文件字节或图片地址。 */
(function () {
  function visible(element) {
    return Boolean(element && element.isConnected && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  }
  function describe(element) {
    return { tag: element.tagName, className: String(element.className || ''), visible: visible(element) };
  }
  var inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  var textareas = Array.from(document.querySelectorAll('textarea')).filter(visible);
  var ancestors = [];
  var node = textareas.length === 1 ? textareas[0].parentElement : null;
  for (var depth = 0; node && depth < 12 && node !== document.body && node !== document.documentElement; depth++, node = node.parentElement) {
    var descendants = [node].concat(Array.from(node.querySelectorAll('*'))).filter(visible);
    ancestors.push(Object.assign(describe(node), {
      depth: depth,
      fileInputIndexes: inputs.map(function (input, index) { return node.contains(input) ? index : -1; }).filter(function (index) { return index >= 0; }),
      images: descendants.filter(function (element) { return element.tagName === 'IMG'; }).map(function (image) {
        return Object.assign(describe(image), { complete: image.complete, naturalWidth: image.naturalWidth, parent: image.parentElement ? describe(image.parentElement) : null });
      }),
      progress: descendants.filter(function (element) {
        return element.getAttribute('role') === 'progressbar' || element.getAttribute('aria-busy') === 'true' ||
          /上传中|正在上传|uploading/i.test([element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')].filter(Boolean).join(' '));
      }).map(function (element) {
        return Object.assign(describe(element), { role: element.getAttribute('role'), busy: element.getAttribute('aria-busy'),
          directText: Array.from(element.childNodes).filter(function (child) { return child.nodeType === Node.TEXT_NODE; }).map(function (child) { return child.textContent; }).join('').match(/上传中|正在上传|uploading/ig) || [] });
      }),
      sendControls: descendants.filter(function (element) { return element.matches('.ds-button.ds-button--primary.ds-button--filled.ds-button--circle'); }).map(function (element) {
        return Object.assign(describe(element), { disabled: Boolean(element.disabled), ariaDisabled: element.getAttribute('aria-disabled'),
          paths: Array.from(element.querySelectorAll('svg path')).map(function (path) { return String(path.getAttribute('d') || '').slice(0, 80); }) });
      })
    }));
  }
  return JSON.stringify({
    origin: location.origin,
    textareas: textareas.map(function (input) { return Object.assign(describe(input), { hasText: input.value !== '', disabled: input.disabled, readOnly: input.readOnly }); }),
    fileInputs: inputs.map(function (input) { return Object.assign(describe(input), { disabled: input.disabled, fileCount: input.files ? input.files.length : 0 }); }),
    ancestors: ancestors
  }, null, 2);
}());
