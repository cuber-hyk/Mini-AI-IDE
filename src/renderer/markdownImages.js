/* 图片仅消费当前 Markdown 文档的项目相对路径，真实文件身份仍由主进程校验。 */
(function () {
  'use strict';
  function imagePath(source, documentPath) {
    let value;
    try { value = decodeURIComponent(source.split(/[?#]/, 1)[0]).replace(/\\/g, '/'); }
    catch { throw new Error('图片路径编码无效'); }
    if (!value || value.startsWith('/') || /[:\u0000]/.test(value)) throw new Error('仅支持项目内相对路径图片');
    const parts = documentPath.replace(/\\/g, '/').split('/').slice(0, -1);
    for (const part of value.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) throw new Error('图片路径超出当前项目');
        parts.pop();
      } else parts.push(part);
    }
    return parts.join('/');
  }
  window.createMarkdownImageReader = function (options) {
    return async function (source, documentPath) {
      const before = options.context();
      if (!before.root || before.path !== documentPath) return { ok: false, error: '图片文档已失效' };
      try {
        const relative = imagePath(source, documentPath);
        const result = await options.bridge.readFilePreview(relative, before.root);
        const after = options.context();
        if (after.root !== before.root || after.revision !== before.revision || after.path !== documentPath) return { ok: false, error: '图片文档已失效' };
        if (!result.ok) return result;
        if (result.kind !== 'image') return { ok: false, error: '此文件不是支持的图片格式' };
        return result;
      } catch (error) { return { ok: false, error: error.message || String(error) }; }
    };
  };
})();
