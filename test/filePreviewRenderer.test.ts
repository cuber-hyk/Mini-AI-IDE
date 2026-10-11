import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { it } from 'node:test';

class Element {
  children: Element[] = []; style: Record<string, string> = {}; attributes: Record<string, string> = {};
  classes = new Set<string>(); events: Record<string, ((event: any) => any)[]> = {};
  classList = { toggle: (name: string, enabled?: boolean) => { if (enabled ?? !this.classes.has(name)) this.classes.add(name); else this.classes.delete(name); } };
  hidden = false; disabled = false; clientWidth = 600; clientHeight = 500; scrollLeft = 0; scrollTop = 0;
  naturalWidth = 0; naturalHeight = 0; width = 0; height = 0; src = ''; srcdoc = ''; alt = ''; title = '';
  className = ''; tabIndex = -1; type = ''; draggable = false; focused = false; open = false;
  parentNode: Element | null = null; whenFocused?: () => void; private text = '';
  onload: null | (() => void) = null; onerror: null | (() => void) = null; value = '';
  constructor(public tagName: string) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(''); }
  get outerHTML(): string { return `<${this.tagName}>${this.text}${this.children.map(node => node.outerHTML).join('')}</${this.tagName}>`; }
  appendChild(child: Element) { this.children.push(child); child.parentNode = this; return child; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { delete this.attributes[name]; if (name === 'src') this.src = ''; }
  addEventListener(name: string, fn: (event: any) => any) { (this.events[name] ||= []).push(fn); }
  async fire(name: string, event: any = {}) { for (const fn of this.events[name] || []) await fn(event); }
  async click() { if (!this.disabled) { await this.fire('click'); if (this.tagName === 'summary') { this.parentNode!.open = !this.parentNode!.open; await this.parentNode!.fire('toggle'); } } }
  focus() { this.focused = true; this.whenFocused?.(); }
  contains(target: Element | null): boolean { return this === target || this.children.some(child => child.contains(target)); }
  getContext() { return {}; }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(node => [ ...(selector === node.tagName || selector === 'section.docx' && node.tagName === 'section' ? [node] : []), ...node.querySelectorAll(selector)]); }
  cloneNode(): Element { const node = new Element(this.tagName); node.text = this.text; node.style = { ...this.style }; this.children.forEach(child => node.appendChild(child.cloneNode())); return node; }
}
function deferred<T = any>() { let resolve!: (value: T) => void; let reject!: (value: any) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(loadPdf?: () => Promise<any>) {
  const host = new Element('div'); const revoked: string[] = []; const created: Element[] = []; let externalCount = 0;
  const documentEvents: Record<string, (event: any) => void> = {};
  let resize!: () => void; const frames: (() => void)[] = [];
  const context: any = { window: { devicePixelRatio: 2, loadPdf }, document: { activeElement: null, hit: null, elementFromPoint() { return this.hit; }, baseURI: 'file:///app/index.html', addEventListener(name: string, listener: (event: any) => void) { documentEvents[name] = listener; }, createElement(name: string) { const node = new Element(name); node.whenFocused = () => { context.document.activeElement = node; }; created.push(node); return node; } },
    URL: { createObjectURL() { return 'blob:local-preview'; }, revokeObjectURL(value: string) { revoked.push(value); } }, Blob, Uint8Array, atob,
    ResizeObserver: class { constructor(callback: () => void) { resize = callback; } observe() {} },
    requestAnimationFrame(callback: () => void) { frames.push(callback); return frames.length; } };
  // 只替换 ES 模块加载边界，实际 owner 和异步生命周期保持原样执行。
  const source = fs.readFileSync('src/renderer/filePreview.js', 'utf8').replace("import('./vendor/pdfjs/pdf.mjs')", 'window.loadPdf()');
  vm.runInNewContext(source, context);
  const owner = context.window.createFilePreview({ host, openExternal: async () => { externalCount += 1; return { ok: true }; } });
  const button = (text: string) => host.querySelectorAll('button').find(node => node.attributes['aria-label'] === text || node.textContent === text)!;
  const scale = () => created.find(node => node.tagName === 'select')!;
  const chooseScale = async (value: string) => { scale().value = value; await scale().fire('change'); };
  return { host, owner, created, revoked, button, context, documentEvents, scale, chooseScale, externalCount: () => externalCount,
    resize: () => resize(), flushResize: () => { frames.splice(0).forEach(callback => callback()); }, pendingFrames: () => frames.length,
    status: () => created.find(node => node.className === 'file-preview-status')!,
    viewport: () => created.find(node => node.className === 'file-preview-viewport')! };
}
function doc(kind = 'image', preview: any = { ok: true, bytes: new Uint8Array([1, 2]), mimeType: 'image/png' }) { return { path: '附件.' + kind, kind, preview }; }

it('图片只读预览可缩放，切出立即释放 URL，过时加载不覆盖新标签', async () => {
  const f = fixture(); await f.owner.show(doc(), true);
  const image = f.created.find(node => node.tagName === 'img')!; const stale = image.onload!;
  image.naturalWidth = 1000; image.naturalHeight = 500; image.onload!();
  assert.equal(image.style.width, '568px'); assert.equal(f.viewport().focused, true);
  await f.chooseScale('100'); assert.equal(image.style.width, '1000px');
  f.owner.clear(); assert.deepEqual(f.revoked, ['blob:local-preview']); assert.equal(image.src, ''); assert.equal(f.host.hidden, true);
  await f.owner.show(doc('unsupported'), false); const message = f.status().textContent; stale();
  assert.equal(f.status().textContent, message); assert.match(message, /系统应用打开/);
  await f.button('系统应用打开').click(); assert.equal(f.externalCount(), 1);
});

it('损坏图片和超大图片保留明确错误与系统打开入口，不建立可写编辑器', async () => {
  const f = fixture(); await f.owner.show(doc(), false);
  f.created.find(node => node.tagName === 'img')!.onerror!(); assert.match(f.status().textContent, /损坏/);
  await f.owner.show(doc(), false); const image = f.created.filter(node => node.tagName === 'img').at(-1)!;
  image.naturalWidth = 10000; image.naturalHeight = 10000; image.onload!();
  assert.match(f.status().textContent, /尺寸过大/); assert.equal(f.revoked.length, 2); assert.equal(f.button('系统应用打开').disabled, false);
});

it('滚轮缩放仅作用于已加载正文，更新底栏并遵守手动缩放上下限', async () => {
  const f = fixture(); const input = (direction = 'in') => ({ direction, x: 100, y: 120 });
  await f.owner.show(doc(), false); f.context.document.hit = f.viewport();
  assert.equal(f.owner.zoomFromWheel(input()), false);
  const image = f.created.find(node => node.tagName === 'img')!;
  image.naturalWidth = 1000; image.naturalHeight = 500; image.onload!();
  await f.chooseScale('100'); f.scale().focus();
  assert.equal(f.owner.zoomFromWheel(input()), true); assert.equal(image.style.width, '1250px');
  assert.equal(f.scale().children[0].textContent, '125%'); assert.equal(f.scale().value, 'current');
  assert.equal(f.owner.captureViewState().mode, 'custom');
  assert.equal(f.owner.zoomFromWheel(input('out')), true); assert.equal(image.style.width, '1000px');
  f.context.document.hit = f.scale(); assert.equal(f.owner.zoomFromWheel(input()), false);
  f.context.document.hit = null; assert.equal(f.owner.zoomFromWheel(input()), false);
  f.context.document.hit = f.viewport(); assert.equal(f.owner.zoomFromWheel(input('other')), false);
  assert.equal(f.owner.zoomFromWheel({ direction: 'in', x: NaN, y: 1 }), false);
  await f.chooseScale('400'); assert.equal(f.owner.zoomFromWheel(input()), false); assert.equal(image.style.width, '4000px');
  await f.chooseScale('10'); assert.equal(f.owner.zoomFromWheel(input('out')), false); assert.equal(image.style.width, '100px');
  f.owner.clear(); assert.equal(f.owner.zoomFromWheel(input()), false);
  await f.owner.show(doc('unsupported'), false); assert.equal(f.owner.zoomFromWheel(input()), false);
});

it('宽度与窗口适应分别满足横向阅读和完整查看，手动比例保持用户选择', async () => {
  const f = fixture(); const original = doc(); await f.owner.show(original, false);
  const image = f.created.find(node => node.tagName === 'img')!;
  image.naturalWidth = 1000; image.naturalHeight = 2000; image.onload!();
  assert.equal(image.style.height, '468px'); assert.match(f.scale().title, /适应窗口/);
  await f.chooseScale('width'); assert.equal(image.style.width, '568px');
  assert.equal(f.owner.captureViewState().mode, 'width');
  f.viewport().clientWidth = 400; f.resize(); f.resize();
  assert.equal(f.pendingFrames(), 1); assert.equal(image.style.width, '568px');
  f.flushResize(); assert.equal(image.style.width, '368px');
  await f.chooseScale('150'); assert.equal(image.style.width, '1500px');
  f.viewport().clientWidth = 300; f.resize(); f.flushResize(); assert.equal(image.style.width, '1500px');
  original.viewState = f.owner.captureViewState();
  await f.owner.show(original, false);
  const restored = f.created.filter(node => node.tagName === 'img').at(-1)!;
  restored.naturalWidth = 1000; restored.naturalHeight = 2000; restored.onload!();
  assert.equal(restored.style.width, '1500px'); assert.match(f.scale().title, /自定义比例/);
});

it('更多菜单支持键盘退出和外部点击，切标签关闭菜单且系统打开仅由用户触发', async () => {
  const f = fixture(); await f.owner.show(doc('unsupported'), false);
  const more = f.created.find(node => node.tagName === 'details')!;
  const toggle = f.created.find(node => node.tagName === 'summary')!;
  const event = (key: string) => ({ key, preventDefault() {}, stopPropagation() {} });
  await toggle.click(); assert.equal(more.open, true); assert.equal(toggle.attributes['aria-expanded'], 'true');
  await more.fire('keydown', event('ArrowDown')); assert.equal(f.context.document.activeElement.attributes.role, 'menuitem');
  await more.fire('keydown', event('Escape')); assert.equal(more.open, false); assert.equal(f.context.document.activeElement, toggle);
  await toggle.click(); f.documentEvents.pointerdown({ target: f.viewport() }); assert.equal(more.open, false);
  await toggle.click(); await f.owner.show(doc('unsupported'), false); assert.equal(more.open, false); assert.equal(f.externalCount(), 0);
  const inline = f.created.find(node => node.className.includes('file-preview-error-open'))!;
  assert.equal(inline.hidden, false); await inline.click(); assert.equal(f.externalCount(), 1);
});

it('比例选择保留键盘连续导航位置，失焦后显示实际百分比', async () => {
  const f = fixture(); await f.owner.show(doc(), false);
  const image = f.created.find(node => node.tagName === 'img')!;
  image.naturalWidth = 1000; image.naturalHeight = 2000; image.onload!();
  f.scale().focus();
  await f.chooseScale('width'); assert.equal(f.scale().value, 'width');
  await f.chooseScale('window'); assert.equal(f.scale().value, 'window');
  await f.chooseScale('50'); assert.equal(f.scale().value, '50');
  assert.equal(f.owner.captureViewState().zoom, 0.5);
  await f.scale().fire('blur'); assert.equal(f.scale().value, 'current');
  assert.equal(f.scale().children[0].textContent, '50%');
});

it('Word 适应窗口以页面尺寸计算比例，排版说明保持在可聚焦提示图标', async () => {
  const f = fixture();
  f.context.window.docx = { async renderAsync(_bytes: any, body: Element) {
    const section = new Element('section'); section.style.width = '612pt'; section.style.minHeight = '792pt'; body.appendChild(section);
  } };
  f.context.window.DOMPurify = { sanitize(body: Element) { return body.cloneNode(); } };
  await f.owner.show(doc('docx'), false); const widthScale = f.owner.captureViewState().zoom;
  await f.chooseScale('window');
  assert.equal(f.owner.captureViewState().zoom, 468 / 1116);
  assert.ok(f.owner.captureViewState().zoom < widthScale);
  const note = f.created.find(node => node.className === 'file-preview-note')!;
  assert.equal(note.hidden, false); assert.equal(note.tabIndex, 0); assert.equal(f.status().hidden, true);
  f.context.document.hit = f.created.filter(node => node.tagName === 'iframe').at(-1);
  const before = f.owner.captureViewState().zoom;
  assert.equal(f.owner.zoomFromWheel({ direction: 'in', x: 100, y: 120 }), true);
  assert.equal(f.owner.captureViewState().zoom, before * 1.25);
  const frame = f.created.filter(node => node.tagName === 'iframe').at(-1)!;
  assert.equal(frame.attributes.sandbox, ''); assert.equal(frame.srcdoc.includes('<script'), false);
});

it('PDF 页面超大时限制栅格内存，保留翻页、缩放和文档销毁', async () => {
  const paints: any[] = []; let destroyed = 0; const copied: Uint8Array[] = [];
  const pdf = { numPages: 2, async getPage(page: number) { return { getViewport({ scale }: any) { return { width: 100000 * scale, height: 100000 * scale }; }, render(options: any) { paints.push({ ...options, page }); return { cancel() {}, promise: Promise.resolve() }; } }; } };
  const f = fixture(async () => ({ GlobalWorkerOptions: {}, getDocument(options: any) { copied.push(options.data); assert.equal(options.useWorkerFetch, false); assert.equal(options.enableXfa, false); return { promise: Promise.resolve(pdf), destroy() { destroyed += 1; } }; } }));
  // 模拟 URL 构造与 object URL 静态方法并存。
  f.context.URL = URL; const original = doc('pdf'); await f.owner.show(original, false);
  assert.ok(paints.length > 0); const first = paints[0].canvas;
  assert.ok(first.width * first.height <= 16000000); assert.ok(first.width <= 8192 && first.height <= 8192);
  assert.notEqual(copied[0], original.preview.bytes);
  await f.button('下一页').click(); await new Promise(done => setImmediate(done));
  assert.equal(paints.at(-1).page, 2); assert.equal(f.button('下一页').disabled, true);
  f.owner.clear(); assert.equal(destroyed, 1);
});

it('PDF 读取未结束切出时销毁任务，旧失败不得覆盖新预览', async () => {
  const loading = deferred(); let destroyed = 0;
  const f = fixture(async () => ({ GlobalWorkerOptions: {}, getDocument() { return { promise: loading.promise, destroy() { destroyed += 1; } }; } })); f.context.URL = URL;
  const pending = f.owner.show(doc('pdf'), false); await new Promise(done => setImmediate(done));
  await f.owner.show(doc('unsupported'), false); const message = f.status().textContent;
  loading.reject(new Error('旧 PDF 错误')); await pending;
  assert.equal(destroyed, 1); assert.equal(f.status().textContent, message);
});

it('PDF 重绘保持比例菜单可聚焦，连续选择后仅最终绘制生效', async () => {
  const rendering = deferred(); let cancelled = 0; let count = 0;
  const pdf = { numPages: 1, async getPage() { return { getViewport({ scale }: any) { return { width: 600 * scale, height: 800 * scale }; },
    render() { count += 1; return { promise: count === 1 ? Promise.resolve() : rendering.promise, cancel() { cancelled += 1; } }; } }; } };
  const f = fixture(async () => ({ GlobalWorkerOptions: {}, getDocument() { return { promise: Promise.resolve(pdf), destroy() {} }; } })); f.context.URL = URL;
  await f.owner.show(doc('pdf'), false); f.scale().focus();
  await f.chooseScale('150'); await new Promise(done => setImmediate(done));
  assert.equal(f.scale().disabled, false); assert.equal(f.scale().value, '150');
  await f.chooseScale('50'); await new Promise(done => setImmediate(done));
  assert.equal(f.scale().disabled, false); assert.equal(f.scale().value, '50'); assert.equal(cancelled, 1);
  rendering.resolve(); await new Promise(done => setImmediate(done));
  assert.equal(f.owner.captureViewState().zoom, 0.5); assert.equal(f.scale().value, '50');
  f.context.document.hit = f.viewport();
  assert.equal(f.owner.zoomFromWheel({ direction: 'in', x: 100, y: 120 }), true);
  await new Promise(done => setImmediate(done));
  assert.equal(f.owner.captureViewState().zoom, 0.625); assert.equal(f.scale().children[0].textContent, '63%');
});

it('PDF 正在绘制时切标签取消 render，旧绘制结束不能清除新错误信息', async () => {
  const rendering = deferred(); let cancelled = 0;
  const pdf = { numPages: 1, async getPage() { return { getViewport({ scale }: any) { return { width: 600 * scale, height: 800 * scale }; },
    render() { return { promise: rendering.promise, cancel() { cancelled += 1; } }; } }; } };
  const f = fixture(async () => ({ GlobalWorkerOptions: {}, getDocument() { return { promise: Promise.resolve(pdf), destroy() {} }; } })); f.context.URL = URL;
  const pending = f.owner.show(doc('pdf'), false); await new Promise(done => setImmediate(done));
  await f.owner.show(doc('image', { ok: false, error: '新文件损坏' }), false);
  rendering.resolve(undefined); await pending;
  assert.equal(cancelled, 1); assert.match(f.status().textContent, /新文件损坏/);
});

it('读取失败显示真实错误，未允许导航或自动打开外部应用', async () => {
  const f = fixture(); await f.owner.show(doc('docx', { ok: false, error: '文件超过大小限制' }), false);
  assert.match(f.status().textContent, /文件超过大小限制/); assert.equal(f.externalCount(), 0);
  assert.equal(f.scale().disabled, true); assert.equal(f.button('系统应用打开').disabled, false);
});

it('Word 只在净化后进入无脚本 iframe，源 CSS 不能闭合 style 标签注入 HTML', async () => {
  const f = fixture(); let sanitizeConfig: any; let renderOptions: any;
  f.context.window.docx = { async renderAsync(_bytes: any, body: Element, styles: Element, options: any) {
    renderOptions = options; const section = new Element('section'); section.style.width = '612pt'; section.textContent = '正文和表格'; body.appendChild(section);
    const style = new Element('style'); style.textContent = 'p{color:black} </style><script>attack()</script>'; styles.appendChild(style);
  } };
  f.context.window.DOMPurify = { sanitize(body: Element, config: any) { sanitizeConfig = config; return body.cloneNode(); } };
  await f.owner.show(doc('docx'), false); const frame = f.created.find(node => node.tagName === 'iframe')!;
  assert.equal(renderOptions.renderAltChunks, false); assert.equal(renderOptions.useBase64URL, true);
  assert.ok(sanitizeConfig.FORBID_TAGS.includes('a')); assert.ok(sanitizeConfig.FORBID_TAGS.includes('script'));
  assert.equal(frame.attributes.sandbox, ''); assert.match(frame.srcdoc, /正文和表格/);
  assert.equal(frame.srcdoc.includes('<script>attack()'), false); assert.match(frame.srcdoc, /\\3c \/style>/);
  assert.equal(f.status().hidden, true); assert.match(f.created.find(node => node.className === 'file-preview-note')!.title, /近似排版/);
});

it('Word 异步加载过时后不建立 iframe，不改写新标签状态', async () => {
  const f = fixture(); const pending = deferred<void>();
  f.context.window.docx = { renderAsync: () => pending.promise }; f.context.window.DOMPurify = { sanitize() { throw new Error('不应净化过时内容'); } };
  const showing = f.owner.show(doc('docx'), false); await f.owner.show(doc('unsupported'), false);
  pending.resolve(); await showing; assert.equal(f.created.some(node => node.tagName === 'iframe'), false); assert.match(f.status().textContent, /系统应用打开/);
});
