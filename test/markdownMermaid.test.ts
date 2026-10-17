import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';

class Element {
  ownerDocument: any;
  attributes: { name: string; value: string }[] = [];
  dataset: any = {};
  children: any[] = [];
  textContent = '';
  className = '';
  id = '';
  removed = false;
  style: any = {};
  classList = { add() {}, remove() {} };
  constructor(public localName: string, document: any) { this.ownerDocument = document; }
  setAttribute(name: string, value: string) { this.attributes.push({ name, value }); if (name === 'id') this.id = value; }
  getAttribute(name: string) { return this.attributes.find(item => item.name === name)?.value || null; }
  querySelectorAll(_selector: string): Element[] { return []; }
  removeAttribute(name: string) { this.attributes = this.attributes.filter(item => item.name !== name); }
  appendChild(child: any) { this.children.push(child); }
  replaceChildren(...children: any[]) { this.children = children; }
  remove() { this.removed = true; }
}

function fixture() {
  const configurations: any[] = []; const calls: any[] = []; const sanitizerOptions: any[] = [];
  let loaded = 0;
  let render: any = async (id: string) => ({ svg: id });
  const tokens: Record<string, string> = { bg: '#151517', surface: '#1b1b1c', control: '#292929', text: '#e5e5e5', muted: '#a2a4a6', accent: '#5b8def', success: '#73c991', warning: '#ed985b' };
  const document: any = { defaultView: { getComputedStyle() { return { getPropertyValue(name: string) { return tokens[name.replace('--ui-', '')] || ''; } }; }, CSSStyleSheet: class {
    cssRules: any[] = [];
    replaceSync(css: string) {
      this.cssRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(item => ({ type: 1, selectorText: item[1].trim(), cssText: item[0] }));
    }
  } } };
  document.createElement = (name: string) => new Element(name, document);
  document.body = document.createElement('body');
  let svgElements: Element[] = [];
  let line: Element; let arrow: Element; let unrelated: Element;
  const context: any = {
    loadMermaid: async () => { loaded++; return { default: {
      initialize(value: any) { configurations.push(value); },
      render: async (...args: any[]) => { calls.push(args); return render(...args); }
    } }; },
    createDOMPurify: () => ({ sanitize(id: string, options: any) {
      sanitizerOptions.push(options);
      const svg = document.createElement('svg'); svg.setAttribute('id', id);
      line = document.createElement('line'); line.setAttribute('marker-end', `url(#${id}-arrowhead)`);
      arrow = document.createElement('path'); unrelated = document.createElement('path');
      svg.querySelectorAll = (selector: string) => selector === '.lineWrapper line' ? [line]
        : selector === `marker[id="${id}-arrowhead"] path` ? [arrow] : [];
      const path = document.createElement('path');
      path.setAttribute('onclick', 'bad()'); path.setAttribute('fill', 'url(https://bad.test/a)'); path.setAttribute('marker-end', 'url(#arrow)');
      const style = document.createElement('style');
      style.textContent = `#${id} .node {fill:red} body {display:none} #${id} + body {display:none} @keyframes edge {from {stroke-dashoffset:0}}`;
      svgElements = [svg, path, style];
      return { querySelector: () => svg, querySelectorAll: () => svgElements };
    } })
  };
  const source = readFileSync('src/renderer/markdownMermaid.js', 'utf8').replace(/^import .*;$/gm, '')
    .replace("import('mermaid')", 'loadMermaid()').replace(/export function /g, 'function ');
  runInNewContext(source + '\nglobalThis.render = renderMermaid;', context);
  return { render: context.render, host: () => document.createElement('div'), configurations, calls, sanitizerOptions,
    loaded: () => loaded, setRender(fn: any) { render = fn; }, elements: () => svgElements,
    connectors: () => ({ line, arrow, unrelated }), document };
}

it('图内配置、外部资源与过大图在调用 Mermaid 前拒绝，错误保留原文', async () => {
  const f = fixture();
  for (const code of [
    '%%{init:{"securityLevel":"loose"}}%%\ngraph LR\nA-->B',
    '---\nconfig:\n securityLevel: loose\n---\ngraph LR\nA-->B',
    '---  \rconfig:\r securityLevel: loose\r---\rgraph LR\rA-->B',
    'graph LR\nA@{img:"/secret.png"}',
    'graph LR\nA[https://bad.test/image]',
    'graph LR\nclassDef bad fill:url(//bad.test/x)',
    'graph LR\nclassDef bad fill:u\\72l(https\\3a bad.test/x)',
    'graph LR\n' + 'A-->B\n'.repeat(301),
    'graph LR\n' + 'x'.repeat(30001)
  ]) {
    const host = f.host(); await f.render(code, host, () => true);
    assert.equal(host.dataset.renderState, 'error'); assert.equal(host.children[1].textContent, code);
  }
  assert.equal(f.loaded(), 0); assert.equal(f.calls.length, 0);
});

it('固定严格配置，不绑定事件，净化 SVG 并保留本地 marker 引用及有界 CSS', async () => {
  const f = fixture(); const host = f.host();
  await f.render('graph LR\nA-->B', host, () => true);
  assert.equal(host.dataset.renderState, 'ready'); assert.equal(f.configurations[0].securityLevel, 'strict');
  assert.equal(f.configurations[0].htmlLabels, false); assert.equal(f.configurations[0].flowchart.htmlLabels, false);
  assert.equal(f.configurations[0].theme, 'base');
  assert.equal(f.configurations[0].themeVariables.darkMode, true);
  assert.equal(f.configurations[0].themeVariables.primaryColor, '#292929');
  assert.equal(f.configurations[0].themeVariables.cScale0, '#5b8def');
  assert.equal(f.configurations[0].themeVariables.cScaleLabel0, '#151517');
  assert.equal(f.configurations[0].themeVariables.lineColor, '#a2a4a6');
  assert.equal(f.configurations[0].themeVariables.pieOpacity, '1');
  assert.equal(f.configurations[0].suppressErrorRendering, true);
  assert.ok(f.sanitizerOptions[0].FORBID_TAGS.includes('foreignObject'));
  assert.ok(f.sanitizerOptions[0].FORBID_TAGS.includes('image'));
  const [, path, style] = f.elements();
  assert.deepEqual(path.attributes, [{ name: 'marker-end', value: 'url(#arrow)' }]);
  assert.equal(style.removed, false, '通用 keyframes 不能连带丢弃所有节点颜色');
  assert.doesNotMatch(style.textContent, /body|@keyframes/); assert.match(style.textContent, /\.node/);
  assert.equal(f.document.body.children[0].removed, true, '布局临时节点始终清理');
  assert.equal(f.connectors().line.style.stroke, '#a2a4a6', '时间线裸背景连接线沿用可读的现有线色');
  assert.equal(f.connectors().arrow.style.fill, '#a2a4a6', '只修正连接线引用的本地图内箭头');
  assert.equal(f.connectors().unrelated.style.fill, undefined, '不重写任意形状或未引用标记的颜色');
});

it('等待中的旧图被合并丢弃，已开始的旧渲染结束也不能覆盖新文档', async () => {
  const f = fixture(); const host = f.host(); let current = true;
  let finish: any; let started: any;
  const ready = new Promise(resolve => { started = resolve; });
  f.setRender((id: string) => { started(); return new Promise(resolve => { finish = () => resolve({ svg: id }); }); });
  const old = f.render('graph LR\nA-->B', host, () => current);
  await ready;
  current = false; finish(); await old;
  assert.equal(host.dataset.renderState, 'pending', '过期任务连状态都不能写回');
  assert.equal(host.children.length, 0);
  f.setRender(async (id: string) => ({ svg: id }));
  const discarded = f.render('graph LR\nC-->D', host, () => true);
  const latest = f.render('graph LR\nE-->F', host, () => true);
  await Promise.all([discarded, latest]);
  assert.equal(f.calls.length, 2, '同一宿主排队中的旧任务不进入布局');
  assert.equal(f.calls[1][1], 'graph LR\nE-->F'); assert.equal(host.dataset.renderState, 'ready');
});

it('不同图表串行布局，失败可见且不阻断后续队列', async () => {
  const f = fixture(); let active = 0; let maximum = 0;
  f.setRender(async (id: string, code: string) => {
    active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--;
    if (code.includes('broken')) throw new Error('parse error');
    return { svg: id, bindFunctions() { assert.fail('不应绑定图中脚本'); } };
  });
  const first = f.host(); const second = f.host();
  await Promise.all([f.render('broken', first, () => true), f.render('sequenceDiagram\nA->>B: ok', second, () => true)]);
  assert.equal(maximum, 1); assert.equal(first.dataset.renderState, 'error'); assert.equal(second.dataset.renderState, 'ready');
  assert.match(first.children[0].textContent, /parse error/);
  assert.ok(f.document.body.children.every((item: any) => item.removed));
});
