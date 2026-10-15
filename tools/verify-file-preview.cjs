/** 原生 Electron 离线附件预览验收；仅加载临时 fixture，不连接官网或用户项目。 */
const { app, BrowserWindow, nativeImage, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const JSZip = createRequire(require.resolve('docx-preview'))('jszip');

const directory = fsSync.mkdtempSync(path.join(os.tmpdir(), 'mini-file-preview-probe-'));
app.setPath('userData', path.join(directory, 'user-data'));
app.disableHardwareAcceleration();
const checks = []; const screenshots = []; const networkRequests = []; const rendererErrors = [];
const previewResourceRequests = []; const expectedLoadErrors = []; let failedPurifyRequests = 0;
let window;
const deadline = setTimeout(() => finish(new Error('附件预览离线验收超过 30 秒')), 30_000);

function finish(error) {
  clearTimeout(deadline);
  console.log(JSON.stringify({ ok: !error, checks, screenshots, networkRequests, rendererErrors, previewResourceRequests, expectedLoadErrors, directory, error: error && String(error.stack || error) }, null, 2));
  app.exit(error ? 1 : 0);
}

function check(name, observed, detail) {
  const result = { name, pass: Boolean(observed) };
  if (detail !== undefined) result.observed = detail;
  checks.push(result);
  if (!observed) throw new Error(name);
}

function makePdf(paddingBytes = 0) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 280] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 280] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const text of ['Local PDF page one', 'Local PDF page two']) {
    const content = `BT /F1 24 Tf 35 225 Td (${text}) Tj ET\n0.2 0.5 0.8 rg 40 65 220 100 re f\n` + (objects.length === 5 ? ' '.repeat(paddingBytes) : '');
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const crossReference = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${crossReference}\n%%EOF`;
  return Buffer.from(pdf);
}

function makePng() {
  const width = 640; const height = 320; const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    pixels[offset] = x < width / 2 ? 210 : 80; pixels[offset + 1] = y < height / 2 ? 130 : 210;
    pixels[offset + 2] = x < width / 2 ? 70 : 210; pixels[offset + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, { width, height }).toPNG();
}

async function makeDocx(png, paddingBytes = 0) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/><Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/never-request" TargetMode="External"/></Relationships>');
  zip.file('word/media/image.png', png);
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>本地 Word 预览验收</w:t></w:r></w:p>
    <w:p><w:r><w:t>Preview text stays local.</w:t></w:r><w:hyperlink r:id="rLink"><w:r><w:t>External link becomes plain text</w:t></w:r></w:hyperlink></w:p>
    <w:tbl><w:tblPr><w:tblW w:w="7800" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="8"/><w:bottom w:val="single" w:sz="8"/><w:left w:val="single" w:sz="8"/><w:right w:val="single" w:sz="8"/><w:insideH w:val="single" w:sz="8"/><w:insideV w:val="single" w:sz="8"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3900"/><w:gridCol w:w="3900"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>预览内容</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Word</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>文字、表格、图片</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:drawing><wp:inline><wp:extent cx="3657600" cy="1828800"/><wp:docPr id="1" name="Embedded local image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="image.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3657600" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>
  </w:body></w:document>`);
  if (paddingBytes) zip.file('word/media/unused.bin', Buffer.alloc(paddingBytes), { compression: 'STORE' });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

app.whenReady().then(async () => {
  const rendererDirectory = path.resolve(__dirname, '../dist/renderer');
  const source = await fs.readFile(path.resolve(__dirname, '../src/renderer/index.html'), 'utf8');
  const policy = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/>/m.exec(source)?.[1];
  if (!policy) throw new Error('无法读取编辑器 CSP');
  const page = path.join(directory, 'preview.html');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><base href="${pathToFileURL(rendererDirectory + path.sep).href}"><link rel="stylesheet" href="ui-tokens.css"><link rel="stylesheet" href="ui.css"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="filePreview.css"><style>html,body{margin:0;width:100%;height:100%;font:14px system-ui;background:var(--ui-bg,#fafafa)}#file-preview{position:relative;width:100%;height:600px}</style></head><body><div id="file-preview" class="file-preview"></div><script src="filePreview.js"></script><script src="vendor/monaco/vs/loader.js"></script><script>window.externalOpenCount=0;window.previewZoomNotifications=0;window.preview=window.createFilePreview({host:document.getElementById('file-preview'),openExternal:async function(){window.externalOpenCount++;return {ok:true}}});window.editorBridge.onFilePreviewZoom(function(input){window.previewZoomNotifications++;window.preview.zoomFromWheel(input)});</script></body></html>`;
  await fs.writeFile(page, html);
  window = new BrowserWindow({ show: false, width: 920, height: 640, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, preload: path.resolve(__dirname, '../dist/main/preload.js') } });
  const { FileService } = require('../dist/main/fileService');
  const { registerFilePreviewIpc } = require('../dist/main/filePreviewIpc');
  const files = new FileService(); files.setRoot(directory);
  registerFilePreviewIpc(ipcMain, window.webContents, files);
  let cursorPoint = { x: -1, y: -1 };
  const { registerFilePreviewZoom } = require('../dist/main/filePreviewZoom');
  registerFilePreviewZoom(window.webContents, () => window.getContentBounds(), () => cursorPoint);
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, reply) => {
    if (/^https?:/.test(details.url)) { networkRequests.push(details.url); reply({ cancel: true }); return; }
    if (/\/(?:jszip|docx-preview|purify)\.min\.js$/.test(details.url)) {
      previewResourceRequests.push(details.url);
      if (details.url.endsWith('/purify.min.js') && failedPurifyRequests === 0) { failedPurifyRequests += 1; reply({ cancel: true }); return; }
    }
    reply({ cancel: false });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', event => {
    if (event.level !== 'error') return;
    if (event.sourceId.endsWith('/purify.min.js') && event.message.includes('ERR_BLOCKED_BY_CLIENT')) expectedLoadErrors.push(event.message);
    else rendererErrors.push(event.message);
  });
  window.webContents.on('render-process-gone', (_event, details) => finish(new Error(`渲染进程退出：${details.reason}`)));
  await window.loadFile(page);
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  const waitFor = async code => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (await evaluate(code)) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('等待预览状态超时：' + code + '\n' + await evaluate("document.querySelector('.file-preview-status')?.textContent"));
  };
  const show = async (kind, mimeType, bytes) => evaluate(`window.preview.show({path:${JSON.stringify(`fixture.${kind === 'image' ? 'png' : kind}`)},kind:${JSON.stringify(kind)},preview:{ok:true,kind:${JSON.stringify(kind)},mimeType:${JSON.stringify(mimeType)},bytes:Uint8Array.from(${JSON.stringify(Array.from(bytes))})}})`);
  const showFile = async (name, kind, size) => {
    const loaded = await evaluate(`(async () => {const result=await window.editorBridge.readFilePreview(${JSON.stringify(name)},${JSON.stringify(directory)});await window.preview.show({path:${JSON.stringify(name)},kind:${JSON.stringify(kind)},preview:result});return {ok:result.ok,bytes:result.ok?result.bytes.byteLength:0,error:result.ok?null:result.error};})()`);
    check(name + ' 通过真实主进程与 IPC 完整读取超过 32 MiB 的本地附件', loaded.ok && loaded.bytes === size, loaded);
  };
  const chooseScale = async value => {
    await evaluate(`(() => {const select=document.querySelector('select.file-preview-scale');select.focus();select.value=${JSON.stringify(String(value))};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor("!document.querySelector('select.file-preview-scale').disabled");
  };
  // 隐藏离屏页面没有操作系统焦点；显式派发失焦事件验证控件的失焦处理。
  const blurScale = async () => evaluate("(() => {const select=document.querySelector('select.file-preview-scale');select.blur();select.dispatchEvent(new FocusEvent('blur'));})()");
  const editorZoomFactor = window.webContents.getZoomFactor();
  // 通知 handler 验收：直接发出本地 WebContents 事件，不模拟物理滚轮或移动用户鼠标。
  const nativeZoom = async (direction, selector, outsideWindow = false) => {
    const notifications = await evaluate('window.previewZoomNotifications');
    const bounds = window.getContentBounds(); const factor = window.webContents.getZoomFactor();
    if (outsideWindow) cursorPoint = { x: bounds.x - 10, y: bounds.y - 10 };
    else {
      const point = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+Math.min(r.height/2,100)};})()`);
      cursorPoint = { x: bounds.x + point.x * factor, y: bounds.y + point.y * factor };
    }
    window.webContents.emit('zoom-changed', {}, direction);
    if (outsideWindow) await new Promise(resolve => setTimeout(resolve, 50));
    else await waitFor(`window.previewZoomNotifications > ${notifications}`);
    return evaluate('window.preview.captureViewState().zoom');
  };
  const wheelZoom = async (kind, selector = '.file-preview-viewport') => {
    const initial = await evaluate('window.preview.captureViewState().zoom');
    const larger = await nativeZoom('in', selector);
    await waitFor("!document.querySelector('select.file-preview-scale').disabled");
    check(kind + ' 原生缩放通知放大附件并更新底栏比例', larger > initial && await evaluate(`document.querySelector('select.file-preview-scale').selectedOptions[0].textContent === ${JSON.stringify(Math.round(larger * 100) + '%')}`));
    const smaller = await nativeZoom('out', selector);
    await waitFor("!document.querySelector('select.file-preview-scale').disabled");
    check(kind + ' 原生缩放通知缩小附件且编辑器全局比例不变', smaller < larger && Math.abs(smaller - initial) < 0.0001 && window.webContents.getZoomFactor() === editorZoomFactor);
  };
  const ignoredWheel = async (name, selector, outsideWindow = false) => {
    const initial = await evaluate('window.preview.captureViewState().zoom');
    const zoom = await nativeZoom('in', selector, outsideWindow);
    check(name + ' 不改变附件或编辑器全局比例', zoom === initial && window.webContents.getZoomFactor() === editorZoomFactor);
  };
  const bottomBar = async kind => check(kind + ' 控件固定底部且缩放位于右侧', await evaluate(`(() => {
    const host=document.getElementById('file-preview'),bar=document.querySelector('.file-preview-toolbar'),viewport=document.querySelector('.file-preview-viewport'),right=document.querySelector('.file-preview-right');
    const h=host.getBoundingClientRect(),b=bar.getBoundingClientRect(),v=viewport.getBoundingClientRect(),r=right.getBoundingClientRect();
    const before=b.top,scroll=viewport.scrollTop;viewport.scrollTop=viewport.scrollHeight;
    const fixed=Math.abs(bar.getBoundingClientRect().top-before)<1;viewport.scrollTop=scroll;
    return host.lastElementChild===bar && b.top>=v.bottom-1 && Math.abs(b.bottom-h.bottom)<2 && r.right>=b.right-12 && r.left>b.left && fixed;
  })()`));
  const narrow = async (kind, width) => {
    window.setContentSize(width, 600);
    await waitFor(`document.getElementById('file-preview').clientWidth <= ${width}`);
    await new Promise(resolve => setTimeout(resolve, 150));
    await waitFor("!document.querySelector('select.file-preview-scale').disabled");
    check(kind + ' 在 ' + width + ' px 窄列中底栏单行且无横向溢出', await evaluate(`(() => {
      const host=document.getElementById('file-preview'),bar=document.querySelector('.file-preview-toolbar'),left=document.querySelector('.file-preview-left'),right=document.querySelector('.file-preview-right');
      const b=bar.getBoundingClientRect(),l=left.getBoundingClientRect(),r=right.getBoundingClientRect();
      return host.scrollWidth<=host.clientWidth+1 && bar.scrollWidth<=bar.clientWidth+1 && Math.abs((l.top+l.bottom)/2-(r.top+r.bottom)/2)<2 && l.right<=r.left+1 && b.height<=40 && window.preview.captureViewState().zoom<1;
    })()`));
    await bottomBar(kind + ' ' + width + ' px');
    await capture(kind.toLowerCase() + '-preview-' + width + 'px');
  };
  const capture = async name => {
    const target = path.join(directory, name + '.png');
    let image;
    if (name.startsWith('word-')) {
      // iframe srcdoc 重建后的离屏合成晚于 DOM 就绪，必须核验真实像素。
      await evaluate("window.__wordCaptureFrame=document.querySelector('iframe')");
      await new Promise(resolve => setTimeout(resolve, 850));
      let visible = false; let pixelCounts;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const bounds = await evaluate("(() => {const f=document.querySelector('iframe');if(f!==window.__wordCaptureFrame){window.__wordCaptureFrame=f;return null;}if(!f)return null;const r=f.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,innerWidth,innerHeight};})()");
        image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        if (bounds) {
          const size = image.getSize(); const pixels = image.toBitmap();
          const scaleX = size.width / bounds.innerWidth; const scaleY = size.height / bounds.innerHeight;
          const x1 = Math.max(0, Math.floor(bounds.x * scaleX)); const x2 = Math.min(size.width, Math.ceil((bounds.x + bounds.width) * scaleX));
          const y1 = Math.max(0, Math.floor(bounds.y * scaleY)); const y2 = Math.min(size.height, Math.ceil((bounds.y + bounds.height) * scaleY));
          let white = 0; let dark = 0; let colored = 0;
          for (let y = y1; y < y2; y += 1) for (let x = x1; x < x2; x += 1) {
            const offset = (y * size.width + x) * 4; const blue = pixels[offset], green = pixels[offset + 1], red = pixels[offset + 2];
            if (red > 245 && green > 245 && blue > 245) white += 1;
            if (red < 100 && green < 100 && blue < 100) dark += 1;
            if (Math.max(red, green, blue) - Math.min(red, green, blue) > 60) colored += 1;
          }
          pixelCounts = { white, dark, colored, width: bounds.width, height: bounds.height };
          // 240px 列内文字缩至约 24%，抗锯齿后的深色像素仍须存在。
          visible = white > 5000 && dark > 10 && colored > 1000;
        }
        if (visible) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!visible) {
        const failed = path.join(directory, name + '-failed.png');
        await fs.writeFile(failed, image.toPNG()); screenshots.push(failed);
      }
      check(name + ' 真实截图包含白纸、文字和内嵌图片', visible, pixelCounts);
    } else image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await fs.writeFile(target, image.toPNG()); screenshots.push(target);
  };
  const png = makePng(); const pdf = makePdf(); const docx = await makeDocx(png);
  await Promise.all([fs.writeFile(path.join(directory, 'fixture.png'), png), fs.writeFile(path.join(directory, 'fixture.pdf'), pdf), fs.writeFile(path.join(directory, 'fixture.docx'), docx)]);
  check('真实预览 owner、preload 和 Monaco AMD 就绪，普通首屏不加载专用库', await evaluate("Boolean(window.preview && window.editorBridge.onFilePreviewZoom && window.define.amd && window.require.config && !window.docx && !window.DOMPurify && !window.JSZip && !window.filePreviewPdfResources)"));
  await show('image', 'image/png', png);
  await waitFor("document.querySelector('.file-preview-content img')?.naturalWidth === 640");
  check('图片成功解码且适应窗口', await evaluate("document.querySelector('.file-preview-content img').naturalHeight === 320 && !document.querySelector('[aria-label=\"放大\"]').disabled"));
  check('图片默认使用适应窗口模式', await evaluate("window.preview.captureViewState().mode === 'window'"));
  check('图片预览不加载 PDF 或 Word 专用库', await evaluate("!window.docx && !window.DOMPurify && !window.JSZip && !window.filePreviewPdfResources"));
  await bottomBar('图片');
  await wheelZoom('图片');
  await ignoredWheel('鼠标位于底栏', '.file-preview-toolbar');
  await ignoredWheel('鼠标位于编辑器窗口外', null, true);
  await evaluate("document.querySelector('[aria-label=\"放大\"]').click()");
  check('图片放大操作改变预览比例', await evaluate('window.preview.captureViewState().zoom > 1'));
  await chooseScale('100');
  check('比例控件聚焦选择 100% 时保留当前选项', await evaluate("window.preview.captureViewState().mode === 'custom' && window.preview.captureViewState().zoom === 1 && document.querySelector('select.file-preview-scale').value === '100'"));
  await blurScale();
  const actualScale = await evaluate("({mode:window.preview.captureViewState().mode,zoom:window.preview.captureViewState().zoom,value:document.querySelector('select.file-preview-scale').value,text:document.querySelector('select.file-preview-scale').selectedOptions[0]?.textContent})");
  check('原生比例控件选择 100% 并返回实际比例显示', actualScale.mode === 'custom' && actualScale.zoom === 1 && actualScale.value === 'current' && actualScale.text === '100%', actualScale);
  await chooseScale('width');
  check('比例控件聚焦选择适应宽度时保留选项', await evaluate("window.preview.captureViewState().mode === 'width' && document.querySelector('select.file-preview-scale').value === 'width' && document.activeElement === document.querySelector('select.file-preview-scale')"));
  await chooseScale('window');
  check('比例控件连续选择适应窗口时保留选项', await evaluate("window.preview.captureViewState().mode === 'window' && document.querySelector('select.file-preview-scale').value === 'window' && document.activeElement === document.querySelector('select.file-preview-scale')"));
  await chooseScale('100');
  check('比例控件连续选择 100% 不被重绘重置', await evaluate("window.preview.captureViewState().zoom === 1 && document.querySelector('select.file-preview-scale').value === '100' && document.activeElement === document.querySelector('select.file-preview-scale')"));
  await chooseScale('window');
  await blurScale();
  await evaluate("document.querySelector('.file-preview-more summary').click()");
  await waitFor("document.querySelector('.file-preview-more').open");
  check('更多菜单原生展开且系统打开入口默认藏于菜单', await evaluate("document.querySelector('.file-preview-more [aria-label=\"系统应用打开\"]') && !document.querySelector('.file-preview-toolbar > [aria-label=\"系统应用打开\"]')"));
  await ignoredWheel('鼠标位于更多菜单', '.file-preview-menu');
  await evaluate("document.querySelector('.file-preview-more button').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  check('Escape 关闭更多菜单并恢复触发器焦点', await evaluate("!document.querySelector('.file-preview-more').open && document.activeElement===document.querySelector('.file-preview-more summary')"));
  await evaluate("document.querySelector('.file-preview-more summary').click()");
  await waitFor("document.querySelector('.file-preview-more').open");
  await evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));document.body.click()");
  check('点击菜单外区域关闭更多菜单', await evaluate("!document.querySelector('.file-preview-more').open"));
  await evaluate("document.querySelector('.file-preview-more summary').click()");
  await waitFor("document.querySelector('.file-preview-more').open");
  await capture('image-preview');
  await show('pdf', 'application/pdf', pdf);
  check('首次 PDF 只加载 PDF 本地资源，不提前加载 Word 依赖', await evaluate("Boolean(window.filePreviewPdfResources && !window.docx && !window.DOMPurify && !window.JSZip)"));
  await waitFor("document.querySelector('.file-preview-pages').textContent === '1 / 2' && !document.querySelector('[aria-label=\"下一页\"]').disabled");
  check('切换附件关闭更多菜单且 PDF 默认适应宽度', await evaluate("!document.querySelector('.file-preview-more').open && window.preview.captureViewState().mode === 'width'"));
  await wheelZoom('PDF');
  await chooseScale('150');
  check('PDF 重绘期间比例控件保持聚焦和启用', await evaluate("document.activeElement === document.querySelector('select.file-preview-scale') && !document.querySelector('select.file-preview-scale').disabled && document.querySelector('select.file-preview-scale').value === '150' && window.preview.captureViewState().zoom === 1.5"));
  await chooseScale('100');
  check('PDF 重绘期间可连续选择新比例并保留焦点', await evaluate("document.activeElement === document.querySelector('select.file-preview-scale') && document.querySelector('select.file-preview-scale').value === '100' && window.preview.captureViewState().zoom === 1"));
  await blurScale();
  await chooseScale('width');
  await blurScale();
  await bottomBar('PDF');
  check('PDF 第一页画布包含可见内容', await waitFor("(() => {const c=document.querySelector('canvas');if(!c||document.querySelector('select.file-preview-scale').disabled)return false;const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let count=0;for(let i=0;i<p.length;i+=4)if(p[i]<240||p[i+1]<240||p[i+2]<240)count++;return count>500;})()"));
  check('PDF 标准字体文字实际绘制到画布', await waitFor("(() => {const c=document.querySelector('canvas');if(!c||document.querySelector('select.file-preview-scale').disabled)return false;const p=c.getContext('2d').getImageData(0,0,c.width,Math.floor(c.height/3)).data;let count=0;for(let i=0;i<p.length;i+=4)if(p[i]<100&&p[i+1]<100&&p[i+2]<100)count++;return count>50;})()"));
  await capture('pdf-page-one');
  await evaluate("document.querySelector('[aria-label=\"下一页\"]').click()");
  await waitFor("document.querySelector('.file-preview-pages').textContent === '2 / 2' && !document.querySelector('[aria-label=\"上一页\"]').disabled");
  check('PDF 翻页达到第二页', await evaluate("document.querySelector('canvas').getAttribute('aria-label') === 'PDF 第 2 页'"));
  await capture('pdf-page-two');
  await narrow('PDF', 380);
  await narrow('PDF', 240);
  window.setContentSize(920, 640);
  await waitFor("document.getElementById('file-preview').clientWidth >= 900");
  await show('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx);
  check('真实 AMD 首次净化库加载故障显示错误，不渲染未净化 Word', failedPurifyRequests === 1 && await evaluate("!document.querySelector('iframe') && !document.querySelector('.file-preview-status').hidden && document.querySelector('.file-preview-status').textContent.includes('预览失败')"));
  const monacoAfterFailure = await evaluate("new Promise((resolve,reject)=>{window.require.config({paths:{vs:'./vendor/monaco/vs'}});window.require(['vs/editor/editor.main'],()=>resolve(Boolean(window.monaco.editor)),reject)})");
  check('Word 依赖加载失败不影响真实 Monaco AMD 模块', monacoAfterFailure);
  await show('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx);
  check('再次打开通过 AMD 重试 Word 净化库，模块导出不依赖全局变量', await evaluate("!window.JSZip && !window.docx && !window.DOMPurify && typeof window.require('jszip') === 'function'"));
  const successfulWordRequests = previewResourceRequests.slice();
  await waitFor("Boolean(document.querySelector('iframe')?.srcdoc.includes('本地 Word 预览验收'))");
  check('Word 文字、表格、内嵌图片保留且脚本和外链不能执行', await evaluate("(() => {const f=document.querySelector('iframe'),d=new DOMParser().parseFromString(f.srcdoc,'text/html');return f.getAttribute('sandbox') === '' && d.querySelectorAll('table').length===1 && d.querySelectorAll('tr').length===2 && d.querySelector('img')?.src.startsWith('data:image/png') && !d.querySelector('script,[href],[onclick],[onload]') && d.body.textContent.includes('External link becomes plain text');})()"));
  check('Word 近似排版提示保留在底栏图标中且默认适应宽度', await evaluate("document.querySelector('.file-preview-note')?.title.includes('Word') && document.querySelector('.file-preview-status').hidden && window.preview.captureViewState().mode === 'width'"));
  await wheelZoom('Word', 'iframe');
  check('Word 缩放后仍使用无脚本、无桥的空 sandbox', await evaluate("document.querySelector('iframe').getAttribute('sandbox') === '' && !new DOMParser().parseFromString(document.querySelector('iframe').srcdoc,'text/html').querySelector('script')"));
  await chooseScale('width');
  await blurScale();
  await bottomBar('Word');
  await capture('word-preview');
  await narrow('Word', 380);
  await narrow('Word', 240);
  await show('pdf', 'application/pdf', pdf);
  await show('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx);
  const previewScriptCounts = await evaluate("(() => {const paths=['filePreviewPdfResources.js','vendor/jszip.min.js','vendor/docx-preview.min.js','vendor/purify.min.js'];return Object.fromEntries(paths.map(path=>[path,Array.from(document.scripts).filter(script=>script.src.endsWith('/'+path)).length]));})()");
  check('成功后再次打开 PDF 和 Word 不增加专用脚本请求', JSON.stringify(previewResourceRequests) === JSON.stringify(successfulWordRequests) && previewScriptCounts['filePreviewPdfResources.js'] === 1, previewScriptCounts);
  window.setContentSize(920, 640);
  await waitFor("document.getElementById('file-preview').clientWidth >= 900");
  const largePdf = makePdf(33 * 1024 * 1024); await fs.writeFile(path.join(directory, 'large.pdf'), largePdf);
  await showFile('large.pdf', 'pdf', largePdf.length);
  await waitFor("document.querySelector('.file-preview-pages').textContent === '1 / 2' && !document.querySelector('select.file-preview-scale').disabled");
  check('超过 32 MiB PDF 的页面与文字仍正常绘制', await waitFor("(() => {const c=document.querySelector('canvas');if(!c)return false;const p=c.getContext('2d').getImageData(0,0,c.width,Math.floor(c.height/3)).data;let count=0;for(let i=0;i<p.length;i+=4)if(p[i]<100&&p[i+1]<100&&p[i+2]<100)count++;return count>50;})()"));
  const largeDocx = await makeDocx(png, 33 * 1024 * 1024); await fs.writeFile(path.join(directory, 'large.docx'), largeDocx);
  await showFile('large.docx', 'docx', largeDocx.length);
  await waitFor("Boolean(document.querySelector('iframe')?.srcdoc.includes('本地 Word 预览验收'))");
  check('超过 32 MiB Word 正文、表格和图片正常，切换已清理 PDF 画布', await evaluate("(() => {const f=document.querySelector('iframe'),d=new DOMParser().parseFromString(f.srcdoc,'text/html');return !document.querySelector('canvas') && d.body.textContent.includes('Preview text stays local.') && d.querySelector('table') && d.querySelector('img')?.src.startsWith('data:image/png') && f.getAttribute('sandbox')==='';})()"));
  await capture('word-large-preview');
  await show('image', 'image/png', png);
  await waitFor("document.querySelector('.file-preview-content img')?.naturalWidth === 640");
  check('大文档切换回图片清理 iframe 和画布，未增加 Word 专用资源请求', await evaluate("!document.querySelector('iframe,canvas')") && JSON.stringify(previewResourceRequests) === JSON.stringify(successfulWordRequests));
  await evaluate("window.preview.show({path:'unreadable.pdf',kind:'pdf',preview:{ok:false,error:'fixture read failure'}})");
  check('预览失败仍显示错误原因与系统打开入口', await evaluate("document.querySelector('.file-preview-status').textContent.includes('fixture read failure') && !document.querySelector('.file-preview-status').hidden && Boolean(document.querySelector('.file-preview-status [aria-label=\"系统应用打开\"]'))"));
  await ignoredWheel('附件读取失败状态', '.file-preview-viewport');
  await evaluate("document.querySelector('.file-preview-status [aria-label=\"系统应用打开\"]').click()");
  await waitFor('window.externalOpenCount === 1');
  await evaluate("document.querySelector('.file-preview-more summary').click()");
  await waitFor("document.querySelector('.file-preview-more').open");
  await evaluate("document.querySelector('.file-preview-more [aria-label=\"系统应用打开\"]').click()");
  await waitFor('window.externalOpenCount === 2');
  check('失败时直接入口和更多菜单都能调用系统打开 owner', await evaluate('window.externalOpenCount === 2'));
  await capture('preview-read-error-240px');
  await evaluate('window.preview.clear()');
  check('清理预览释放 DOM 并隐藏面板', await evaluate("document.getElementById('file-preview').hidden && document.querySelector('.file-preview-content').children.length === 0"));
  await ignoredWheel('附件预览隐藏状态', 'body');
  check('整轮附件缩放不改变编辑器全局比例', window.webContents.getZoomFactor() === editorZoomFactor);
  check('全部附件预览不发出 HTTP 请求', networkRequests.length === 0);
  check('预览期间没有渲染错误', rendererErrors.length === 0);
  finish();
}).catch(finish);
