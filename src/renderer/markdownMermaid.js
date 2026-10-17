import createDOMPurify from 'dompurify';

let library;
let sequence = Promise.resolve();
let nextId = 0;
const attempts = new WeakMap();

function checkSource(code) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('图表正文为空');
  if (code.length > 30000 || code.split(/\r\n?|\n/).length > 500) throw new Error('图表过大（最多 30000 字符、500 行）');
  if (/^\s*---(?:\s|$)/.test(code) || /%%\s*\{/.test(code)) {
    throw new Error('不支持图内 frontmatter 或初始化配置，请删除配置后编辑图表正文');
  }
  // Mermaid lays out in a live document before returning SVG. Reject resource syntax
  // before that stage; sanitizing only the final SVG would be too late for images.
  if (/(?:https?|ftp|file|data|javascript|vbscript|blob)\s*:|\/\/|\bimg\s*:|\burl\s*\(|@import|<\s*(?:img|image|foreignObject|iframe|script|style|link|object|embed|svg)\b/i.test(code)) {
    throw new Error('离线图表不支持资源地址（含 //）、图片、嵌入 HTML 或 CSS 资源引用');
  }
  for (const statement of code.matchAll(/(?:^|[;\r\n])\s*(?:classDef|style|linkStyle)\b[^\r\n]*/gi)) {
    if (/[\\@{}<>]/.test(statement[0])) throw new Error('图表样式不支持 CSS 转义、规则嵌套或外部资源');
  }
  if ((code.match(/--|==|\.\.|->|:>/g) || []).length > 300) throw new Error('图表连线过多（最多 300 组连线标记）');
}

function safeSvg(svg, ownerDocument) {
  const purify = createDOMPurify(ownerDocument.defaultView);
  const fragment = purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['foreignObject', 'image', 'script', 'iframe', 'a', 'animate', 'animateMotion', 'animateTransform', 'set'],
    FORBID_ATTR: ['href', 'xlink:href', 'target'], ALLOW_DATA_ATTR: false
  });
  const result = fragment.querySelector('svg');
  if (!result || !/^markdown-diagram-\d+$/.test(result.id)) throw new Error('图表没有生成可显示的 SVG');
  const unsafeResource = value => /(?:https?|ftp|file|data|javascript|vbscript|blob)\s*:|\/\//i.test(value)
    || [...value.matchAll(/url\s*\(([^)]*)\)/gi)].some(match => !/^\s*['"]?#[\w:.-]+['"]?\s*$/.test(match[1]));
  for (const element of fragment.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name === 'xmlns' && value === 'http://www.w3.org/2000/svg') continue;
      if (name === 'xmlns:xlink' && value === 'http://www.w3.org/1999/xlink') continue;
      if (name.startsWith('on') || unsafeResource(value)) {
        element.removeAttribute(attribute.name);
      }
    }
    // Mermaid supplies layout CSS. Keep local id references for markers/gradients,
    // but remove all at-rules and non-fragment resource references.
    if (element.localName === 'style') {
      const css = element.textContent || '';
      if (/@import\b/i.test(css)) {
        element.remove();
        continue;
      }
      // Generated CSS lives in the editor document. Reject any selector escaping
      // this SVG, including selectors injected through a diagram's classDef.
      const sheet = new ownerDocument.defaultView.CSSStyleSheet();
      sheet.replaceSync(css);
      const prefix = `#${result.id}`;
      element.textContent = [...sheet.cssRules].filter(rule => rule.type === 1 && !unsafeResource(rule.cssText)
        && rule.selectorText.split(',').every(selector => {
          const value = selector.trim();
          if (!value.startsWith(prefix)) return false;
          const tail = value.slice(prefix.length);
          return !tail || (/^\s/.test(tail) && !/^[+~]/.test(tail.trimStart()));
        })).map(rule => rule.cssText).join('\n');
    }
  }
  result.setAttribute('role', 'img');
  result.setAttribute('aria-label', 'Mermaid 图表，点击编辑源码');
  return result;
}

function showError(host, code, error) {
  host.dataset.renderState = 'error';
  const reason = host.ownerDocument.createElement('div');
  reason.className = 'markdown-render-error-reason';
  reason.textContent = `图表无法渲染：${String(error.message || error).slice(0, 240)}`;
  const source = host.ownerDocument.createElement('pre'); source.textContent = code;
  host.classList.add('markdown-render-error');
  host.replaceChildren(reason, source);
}

function themeVariables(host) {
  const style = host.ownerDocument.defaultView.getComputedStyle(host);
  const color = token => {
    const value = style.getPropertyValue(`--ui-${token}`).trim();
    if (!/^#[\da-f]{6}$/i.test(value)) throw new Error(`图表主题颜色无效：${token}`);
    return value;
  };
  const background = color('bg'), surface = color('surface'), control = color('control');
  const text = color('text'), muted = color('muted'), accent = color('accent');
  const palette = [accent, color('success'), color('warning'), muted];
  const variables = {
    darkMode: true, background, primaryColor: control, primaryTextColor: text,
    primaryBorderColor: muted, secondaryColor: surface, secondaryTextColor: text,
    secondaryBorderColor: muted, tertiaryColor: control, tertiaryTextColor: text,
    tertiaryBorderColor: muted, lineColor: muted, textColor: text,
    edgeLabelBackground: surface, noteBkgColor: surface, noteTextColor: text,
    noteBorderColor: muted, git0: control, gitBranchLabel0: text,
    pieTitleTextColor: text, pieLegendTextColor: text, pieSectionTextColor: background,
    pieStrokeColor: background, pieOuterStrokeColor: muted, pieOpacity: '1'
  };
  // Mermaid derives near-black section colors in dark mode. Explicit existing
  // accent/status tokens keep mindmap edges, timeline sections and pie slices visible.
  for (let index = 0; index < 12; index++) {
    variables[`cScale${index}`] = palette[index % palette.length];
    variables[`cScaleLabel${index}`] = background;
    variables[`cScaleInv${index}`] = muted;
    variables[`pie${index + 1}`] = palette[index % palette.length];
  }
  return variables;
}

/** One queue for Mermaid's shared configuration; stale widgets never receive output. */
export function renderMermaid(code, host, isCurrent) {
  const attempt = {};
  attempts.set(host, attempt);
  const current = () => attempts.get(host) === attempt && isCurrent();
  if (!current()) return Promise.resolve();
  host.classList.add('markdown-mermaid'); host.classList.remove('markdown-render-error');
  host.dataset.renderState = 'pending'; host.textContent = '正在绘制图表…';
  const task = async () => {
    if (!current()) return;
    let staging;
    try {
      checkSource(code);
      if (!library) library = import('mermaid').then(module => module.default).catch(error => { library = null; throw error; });
      const mermaid = await library;
      if (!current()) return;
      const colors = themeVariables(host);
      mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
        suppressErrorRendering: true, maxTextSize: 30000, maxEdges: 300,
        theme: 'base', themeVariables: colors,
        fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
        secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'suppressErrorRendering'],
        flowchart: { htmlLabels: false },
        deterministicIds: false
      });
      // Layout needs measured SVG nodes, so keep this off screen rather than display:none.
      staging = host.ownerDocument.createElement('div');
      staging.className = 'markdown-mermaid-staging';
      staging.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:900px';
      staging.setAttribute('aria-hidden', 'true');
      host.ownerDocument.body.appendChild(staging);
      const { svg } = await mermaid.render(`markdown-diagram-${++nextId}`, code, staging);
      if (!current()) return;
      const result = safeSvg(svg, host.ownerDocument);
      // Timeline reuses its section-label color for bare-background connectors
      // and leaves arrowheads black. Keep its deep text on bright sections while
      // applying the existing line token only to those local connectors/markers.
      for (const line of result.querySelectorAll('.lineWrapper line')) {
        line.style.stroke = colors.lineColor;
        const reference = /^url\(\s*#([\w:.-]+)\s*\)$/.exec(line.getAttribute('marker-end') || '');
        if (reference) {
          for (const path of result.querySelectorAll(`marker[id="${reference[1]}"] path`)) {
            path.style.fill = colors.lineColor; path.style.stroke = colors.lineColor;
          }
        }
      }
      if (!current()) return;
      host.replaceChildren(result); host.dataset.renderState = 'ready';
    } catch (error) {
      if (current()) showError(host, code, error);
    } finally {
      staging?.remove();
    }
  };
  const result = sequence.then(task);
  sequence = result.catch(() => {});
  return result;
}
