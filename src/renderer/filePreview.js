/* 本地附件只读呈现；文件读取和外部打开仍由主进程负责。 */
(function () {
  'use strict';
  const scripts = new Map();
  function previewScript(path, ready) {
    if (ready()) return Promise.resolve();
    if (!scripts.has(path)) {
      const loading = new Promise(function (resolve, reject) {
        const script = document.createElement('script'); script.src = path;
        function failed(message) { script.remove(); reject(new Error(message + path)); }
        script.onload = function () {
          if (ready()) resolve();
          else failed('预览组件不可用：');
        };
        script.onerror = function () { failed('预览组件加载失败：'); };
        document.head.appendChild(script);
      }).catch(function (error) {
        scripts.delete(path);
        throw error;
      });
      scripts.set(path, loading);
    }
    return scripts.get(path);
  }
  let pdfLibrary;
  function pdfjs() {
    if (!pdfLibrary) pdfLibrary = Promise.all([
      previewScript('./filePreviewPdfResources.js', function () { return Boolean(window.filePreviewPdfResources); }),
      import('./vendor/pdfjs/pdf.mjs')
    ]).then(function (loaded) {
      const library = loaded[1];
      library.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', document.baseURI).href;
      return library;
    }).catch(function (error) {
      pdfLibrary = null;
      throw error;
    });
    return pdfLibrary;
  }
  const wordModules = new Map(); let moduleAttempt = 0; let zipRegistered = false;
  function wordModule(path, ready) {
    if (!wordModules.has(path)) {
      const loading = new Promise(function (resolve, reject) {
        if (!window.require || !window.require.config || !window.require.define) throw new Error('Word 预览模块加载器不可用');
        // Monaco 缓存失败模块；重开失败组件时换专用 ID，保留编辑器加载状态。
        const id = 'mini-ai-file-preview/' + (++moduleAttempt);
        const paths = {}; paths[id] = path;
        window.require.config({ paths });
        window.require([id], function (library) {
          if (ready(library)) resolve(library);
          else reject(new Error('Word 预览组件不可用：' + path));
        }, reject);
      }).catch(function (error) { wordModules.delete(path); throw error; });
      wordModules.set(path, loading);
    }
    return wordModules.get(path);
  }
  async function wordLibraries() {
    const zip = await wordModule('./vendor/jszip.min', function (library) { return typeof library === 'function'; });
    // DOCX 的 UMD 模块声明固定的 jszip 依赖，仅注册已经成功加载的导出。
    if (!zipRegistered) { window.require.define('jszip', [], function () { return zip; }); zipRegistered = true; }
    return Promise.all([
      wordModule('./vendor/docx-preview.min', function (library) { return Boolean(library && library.renderAsync); }),
      wordModule('./vendor/purify.min', function (library) { return Boolean(library && library.sanitize); })
    ]);
  }
  window.createFilePreview = function (options) {
    const host = options.host;
    const toolbar = document.createElement('div'); toolbar.className = 'file-preview-toolbar'; toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', '预览控制');
    const left = document.createElement('div'); left.className = 'file-preview-left'; toolbar.appendChild(left);
    const right = document.createElement('div'); right.className = 'file-preview-right'; toolbar.appendChild(right);
    const badge = document.createElement('span'); badge.className = 'file-preview-badge'; badge.title = '只读预览'; badge.setAttribute('role', 'img'); badge.setAttribute('aria-label', '只读预览');
    badge.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5"/><path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7"/></svg>'; left.appendChild(badge);
    const note = document.createElement('span'); note.className = 'file-preview-note'; note.textContent = 'ⓘ'; note.tabIndex = 0;
    note.title = 'Word 预览为近似排版，复杂格式可能与 Word 不同。'; note.setAttribute('aria-label', note.title); left.appendChild(note);
    const viewport = document.createElement('div'); viewport.className = 'file-preview-viewport'; viewport.tabIndex = 0;
    const content = document.createElement('div'); content.className = 'file-preview-content'; viewport.appendChild(content);
    const status = document.createElement('div'); status.className = 'file-preview-status'; status.setAttribute('role', 'status');
    const statusText = document.createElement('span'); status.appendChild(statusText);
    let generation = 0; let paintVersion = 0; let active = null; let mode = 'window'; let zoom = 1; let page = 1;
    let image = null; let imageUrl = null; let pdf = null; let loadingTask = null; let renderTask = null;
    let word = null; let wordWidth = 816; let wordHeight = 1056; let savedScroll = null;
    function button(label, action, icon, parent) {
      const node = document.createElement('button'); node.type = 'button'; node.className = icon ? 'ui-icon' : 'ui-button';
      node.textContent = label; node.title = label; node.setAttribute('aria-label', label);
      node.addEventListener('click', action); parent.appendChild(node); return node;
    }
    const previous = button('‹', function () { if (pdf && page > 1) { page -= 1; viewport.scrollTop = 0; void paintPdf(); } }, true, left);
    previous.title = '上一页'; previous.setAttribute('aria-label', '上一页');
    const pages = document.createElement('span'); pages.className = 'file-preview-pages'; left.appendChild(pages);
    const next = button('›', function () { if (pdf && page < pdf.numPages) { page += 1; viewport.scrollTop = 0; void paintPdf(); } }, true, left);
    next.title = '下一页'; next.setAttribute('aria-label', '下一页');
    const smaller = button('−', function () { setZoom(zoom / 1.25); }, true, right); smaller.title = '缩小'; smaller.setAttribute('aria-label', '缩小');
    const scale = document.createElement('select'); scale.className = 'file-preview-scale'; scale.setAttribute('aria-label', '缩放比例'); right.appendChild(scale);
    const currentScale = document.createElement('option'); currentScale.value = 'current'; currentScale.disabled = true; currentScale.hidden = true; scale.appendChild(currentScale);
    [['width', '适应宽度'], ['window', '适应窗口'], ['25', '25%'], ['50', '50%'], ['75', '75%'], ['100', '100%'], ['150', '150%'], ['200', '200%']].forEach(function (item) {
      const option = document.createElement('option'); option.value = item[0]; option.textContent = item[1]; scale.appendChild(option);
    });
    scale.addEventListener('change', function () {
      const value = scale.value;
      if (value === 'width' || value === 'window') { mode = value; void paint(); }
      else if (value !== 'current') setZoom(Number(value) / 100);
    });
    scale.addEventListener('blur', function () { scale.value = 'current'; });
    const larger = button('+', function () { setZoom(zoom * 1.25); }, true, right); larger.title = '放大'; larger.setAttribute('aria-label', '放大');
    const more = document.createElement('details'); more.className = 'file-preview-more'; right.appendChild(more);
    const moreToggle = document.createElement('summary'); moreToggle.className = 'ui-icon'; moreToggle.textContent = '⋯'; moreToggle.title = '更多预览操作';
    moreToggle.setAttribute('aria-label', moreToggle.title); moreToggle.setAttribute('aria-haspopup', 'menu'); moreToggle.setAttribute('aria-expanded', 'false'); more.appendChild(moreToggle);
    const menu = document.createElement('div'); menu.className = 'file-preview-menu'; menu.setAttribute('role', 'menu'); more.appendChild(menu);
    const external = button('系统应用打开', openExternal, false, menu); external.setAttribute('role', 'menuitem');
    const errorOpen = button('系统应用打开', openExternal, false, status); errorOpen.className += ' file-preview-error-open';
    async function openExternal() {
      if (!active || external.disabled) return;
      const epoch = generation; more.open = false; moreToggle.focus(); external.disabled = errorOpen.disabled = true;
      try {
        const result = await options.openExternal();
        if (epoch === generation && result && result.ok === false) message('打开失败：' + result.error, true);
      } catch (error) { if (epoch === generation) message('打开失败：' + error.message, true); }
      finally { if (epoch === generation) external.disabled = errorOpen.disabled = false; }
    }
    more.addEventListener('toggle', function () { moreToggle.setAttribute('aria-expanded', String(more.open)); });
    more.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && more.open) { event.preventDefault(); event.stopPropagation(); more.open = false; moreToggle.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); more.open = true; external.focus(); }
    });
    more.addEventListener('focusout', function (event) { if (!more.contains(event.relatedTarget)) more.open = false; });
    document.addEventListener('pointerdown', function (event) { if (more.open && !more.contains(event.target)) more.open = false; });
    host.appendChild(viewport); host.appendChild(status); host.appendChild(toolbar); host.hidden = true;
    function message(text, warning) {
      statusText.textContent = text || ''; status.hidden = !text; status.classList.toggle('warn', Boolean(warning));
      errorOpen.hidden = !warning && (!active || active.kind !== 'unsupported');
    }
    function controls(ready, pendingPaint) {
      const isPdf = active && active.kind === 'pdf';
      toolbar.classList.toggle('pdf', Boolean(isPdf)); note.hidden = !active || active.kind !== 'docx';
      previous.hidden = pages.hidden = next.hidden = !isPdf;
      previous.disabled = !ready || !pdf || page <= 1; next.disabled = !ready || !pdf || page >= pdf.numPages;
      pages.textContent = pdf ? page + ' / ' + pdf.numPages : '— / —';
      pages.title = pages.textContent; pages.setAttribute('aria-label', 'PDF 页码 ' + pages.textContent);
      smaller.disabled = larger.disabled = !ready; scale.disabled = !ready && !pendingPaint;
      currentScale.textContent = ready || pendingPaint ? Math.round(zoom * 100) + '%' : '—';
      if (document.activeElement !== scale) scale.value = 'current';
      scale.title = (mode === 'width' ? '适应宽度' : mode === 'window' ? '适应窗口' : '自定义比例') + ' · ' + currentScale.textContent;
    }
    function release() {
      paintVersion += 1;
      if (renderTask) { renderTask.cancel(); renderTask = null; }
      if (loadingTask) { Promise.resolve(loadingTask.destroy()).catch(function () {}); loadingTask = null; }
      pdf = null;
      if (image) { image.onload = image.onerror = null; image.removeAttribute('src'); image = null; }
      if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
      word = null; wordWidth = 816; wordHeight = 1056; savedScroll = null; content.textContent = ''; more.open = false;
    }
    function clear() { generation += 1; release(); active = null; host.hidden = true; message(''); }
    function restoreScroll() {
      if (!savedScroll) return;
      viewport.scrollLeft = savedScroll.left; viewport.scrollTop = savedScroll.top; savedScroll = null;
    }
    function setZoom(value) { mode = 'custom'; zoom = Math.max(0.1, Math.min(4, value)); void paint(); }
    function zoomFromWheel(input) {
      if (!active || host.hidden || scale.disabled || !input || !['in', 'out'].includes(input.direction) ||
        !Number.isFinite(input.x) || !Number.isFinite(input.y)) return false;
      // 顶层命中测试会返回 Word iframe 元素，无需访问其中的隔离文档。
      if (!viewport.contains(document.elementFromPoint(input.x, input.y))) return false;
      if (input.direction === 'in' ? zoom >= 4 : zoom <= 0.1) return false;
      scale.value = 'current';
      setZoom(input.direction === 'in' ? zoom * 1.25 : zoom / 1.25);
      return true;
    }
    function sizeScale(width, height) {
      if (mode !== 'custom') zoom = Math.min(1, Math.max(0.01, (viewport.clientWidth - 32) / width), mode === 'window' ? Math.max(0.01, (viewport.clientHeight - 32) / height) : 1);
      return zoom;
    }
    function paintImage() {
      if (!image || !image.naturalWidth) return;
      const value = sizeScale(image.naturalWidth, image.naturalHeight);
      image.style.width = Math.max(1, Math.round(image.naturalWidth * value)) + 'px';
      image.style.height = Math.max(1, Math.round(image.naturalHeight * value)) + 'px';
      controls(true); restoreScroll();
    }
    async function paintPdf() {
      if (!pdf) return;
      const documentPdf = pdf; const epoch = generation; const version = ++paintVersion;
      if (renderTask) { renderTask.cancel(); renderTask = null; }
      controls(false, true);
      try {
        const documentPage = await documentPdf.getPage(page);
        if (epoch !== generation || version !== paintVersion) return;
        const base = documentPage.getViewport({ scale: 1 });
        if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) throw new Error('PDF 页面尺寸无效');
        const desired = sizeScale(base.width, base.height);
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const bounded = Math.min(desired * pixelRatio, 8192 / base.width, 8192 / base.height, Math.sqrt(16000000 / (base.width * base.height)));
        const target = documentPage.getViewport({ scale: bounded });
        const canvas = document.createElement('canvas'); canvas.className = 'file-preview-page';
        canvas.width = Math.max(1, Math.floor(target.width)); canvas.height = Math.max(1, Math.floor(target.height));
        canvas.style.width = Math.max(1, Math.round(base.width * desired)) + 'px'; canvas.style.height = Math.max(1, Math.round(base.height * desired)) + 'px';
        canvas.setAttribute('aria-label', 'PDF 第 ' + page + ' 页');
        content.textContent = ''; content.appendChild(canvas);
        const task = documentPage.render({ canvasContext: canvas.getContext('2d'), canvas, viewport: target }); renderTask = task;
        await task.promise;
        if (epoch !== generation || version !== paintVersion) return;
        renderTask = null; message(''); controls(true); restoreScroll();
      } catch (error) {
        if (epoch !== generation || version !== paintVersion || error.name === 'RenderingCancelledException') return;
        message('PDF 预览失败：' + error.message, true); controls(false);
      }
    }
    function paintWord() {
      if (!word) return;
      sizeScale(wordWidth + 60, wordHeight + 60);
      const html = document.createElement('html'); const head = document.createElement('head'); const body = document.createElement('body');
      const charset = document.createElement('meta'); charset.setAttribute('charset', 'utf-8'); head.appendChild(charset);
      const policy = document.createElement('meta'); policy.setAttribute('http-equiv', 'Content-Security-Policy');
      policy.setAttribute('content', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"); head.appendChild(policy);
      const style = document.createElement('style');
      style.textContent = word.css + '\nhtml,body{margin:0;min-height:100%;background:#e8e8e8;}body{zoom:' + zoom + ';}a{pointer-events:none;}'; head.appendChild(style);
      body.appendChild(word.body.cloneNode(true)); html.appendChild(head); html.appendChild(body);
      const frame = document.createElement('iframe'); frame.className = 'file-preview-word'; frame.title = active.path + '（只读 Word 预览）';
      frame.setAttribute('sandbox', ''); frame.setAttribute('referrerpolicy', 'no-referrer');
      // CSS 原文可能含闭合标签；显式转义后再序列化到 srcdoc。
      const safeCss = style.textContent.replace(/</g, '\\3c '); style.textContent = safeCss;
      frame.srcdoc = '<!doctype html>' + html.outerHTML;
      content.textContent = ''; content.appendChild(frame); controls(true);
    }
    function paint() {
      if (!active) return;
      if (active.kind === 'image') paintImage();
      if (active.kind === 'pdf') return paintPdf();
      if (active.kind === 'docx') paintWord();
    }
    async function show(doc, focus) {
      generation += 1; release(); const epoch = generation; active = doc; host.hidden = false;
      content.classList.toggle('word', doc.kind === 'docx');
      const view = doc.viewState || {}; mode = ['custom', 'width', 'window'].includes(view.mode) ? view.mode : doc.kind === 'image' ? 'window' : 'width';
      zoom = Number.isFinite(view.zoom) ? Math.max(0.1, Math.min(4, view.zoom)) : 1;
      page = Number.isInteger(view.page) && view.page > 0 ? view.page : 1;
      savedScroll = { left: Number(view.scrollLeft) || 0, top: Number(view.scrollTop) || 0 };
      viewport.scrollLeft = viewport.scrollTop = 0; external.disabled = errorOpen.disabled = false; controls(false);
      if (focus) viewport.focus();
      if (doc.kind === 'unsupported') { message('此格式暂不支持内置预览，请使用系统应用打开。'); return; }
      if (!doc.preview || !doc.preview.ok) { message('预览失败：' + (doc.preview && doc.preview.error || '未读取到文件内容'), true); return; }
      message('正在加载预览…');
      try {
        if (doc.kind === 'image') {
          const node = document.createElement('img'); node.alt = doc.path; node.draggable = false; image = node;
          node.onload = function () {
            if (epoch !== generation) return;
            if (!node.naturalWidth || !node.naturalHeight || node.naturalWidth * node.naturalHeight > 40000000) {
              release(); message('图片尺寸过大或无效，无法内置预览。', true); controls(false); return;
            }
            message(''); paintImage();
          };
          node.onerror = function () { if (epoch === generation) { release(); message('图片损坏或格式不受支持。', true); controls(false); } };
          imageUrl = URL.createObjectURL(new Blob([doc.preview.bytes], { type: doc.preview.mimeType })); node.src = imageUrl; content.appendChild(node);
        } else if (doc.kind === 'pdf') {
          const library = await pdfjs(); if (epoch !== generation) return;
          class LocalBinaryDataFactory {
            async fetch(request) {
              const resources = window.filePreviewPdfResources;
              const encoded = resources && resources[request.kind] && Object.prototype.hasOwnProperty.call(resources[request.kind], request.filename) && resources[request.kind][request.filename];
              if (typeof encoded !== 'string') throw new Error('缺少本地 PDF 资源：' + request.filename);
              const raw = atob(encoded); const bytes = new Uint8Array(raw.length);
              for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
              return bytes;
            }
          }
          const task = library.getDocument({ data: doc.preview.bytes.slice(), useWorkerFetch: false, BinaryDataFactory: LocalBinaryDataFactory,
            isEvalSupported: false, enableXfa: false, maxImageSize: 16000000, canvasMaxAreaInBytes: 64000000, useSystemFonts: true });
          loadingTask = task;
          const loaded = await task.promise; if (epoch !== generation) return;
          pdf = loaded; page = Math.min(page, pdf.numPages); await paintPdf();
        } else if (doc.kind === 'docx') {
          const libraries = await wordLibraries(); if (epoch !== generation) return;
          const body = document.createElement('div'); const styles = document.createElement('div');
          await libraries[0].renderAsync(doc.preview.bytes.slice(), body, styles, { useBase64URL: true, renderAltChunks: false, ignoreWidth: false });
          if (epoch !== generation) return;
          const sanitized = libraries[1].sanitize(body, { RETURN_DOM: true, FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'svg', 'form', 'input', 'button', 'link', 'meta', 'base', 'a'], FORBID_ATTR: ['srcset', 'formaction'] });
          const first = sanitized.querySelector('section.docx');
          if (first && first.style.width) {
            const parsed = /^([\d.]+)(pt|px|in|cm|mm)$/.exec(first.style.width);
            if (parsed) wordWidth = Number(parsed[1]) * ({ pt: 4 / 3, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[parsed[2]]);
          }
          if (first) {
            const parsed = /^([\d.]+)(pt|px|in|cm|mm)$/.exec(first.style.minHeight || first.style.height || '');
            if (parsed) wordHeight = Number(parsed[1]) * ({ pt: 4 / 3, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[parsed[2]]);
          }
          const css = Array.from(styles.querySelectorAll('style')).map(function (node) { return node.textContent; }).join('\n');
          word = { body: sanitized, css }; message(''); paintWord();
        }
      } catch (error) {
        if (epoch !== generation) return;
        release(); message('预览失败：' + error.message, true); controls(false);
      }
    }
    let resizeFrame = 0;
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(function () {
      if (resizeFrame || !active || mode === 'custom') return;
      resizeFrame = requestAnimationFrame(function () {
        resizeFrame = 0;
        if (active && mode !== 'custom') void paint();
      });
    }).observe(viewport);
    return { show, clear, zoomFromWheel,
      captureViewState: function () { return { mode, zoom, page, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop }; },
      rename: function (doc) {
        if (active !== doc) return;
        if (image) image.alt = doc.path;
        const frame = content.querySelector('iframe'); if (frame) frame.title = doc.path + '（只读 Word 预览）';
      }
    };
  };
})();
