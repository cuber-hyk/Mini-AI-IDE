/** 本地文件类型图标；仅静态 SVG，不把文件名插入标记。 */
(function () {
  'use strict';
  const special = { 'package.json': 'package', 'package-lock.json': 'package', 'pnpm-lock.yaml': 'package', 'yarn.lock': 'package', 'dockerfile': 'container', '.gitignore': 'git', '.gitattributes': 'git', '.env': 'config', 'tsconfig.json': 'config' };
  const extensions = { ts: 'typescript', tsx: 'react', js: 'javascript', jsx: 'react', mjs: 'javascript', cjs: 'javascript', vue: 'vue', svelte: 'svelte', html: 'html', htm: 'html', css: 'style', scss: 'style', less: 'style', json: 'config', yaml: 'config', yml: 'config', toml: 'config', ini: 'config', xml: 'config', md: 'markdown', mdx: 'markdown', txt: 'text', log: 'text', py: 'python', rs: 'code', go: 'code', java: 'code', c: 'code', cpp: 'code', h: 'code', cs: 'code', sh: 'terminal', bash: 'terminal', ps1: 'terminal', bat: 'terminal', cmd: 'terminal', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image', ico: 'image', pdf: 'document', docx: 'document', zip: 'archive', gz: 'archive', '7z': 'archive', tar: 'archive' };
  function kind(name, directory, open) {
    if (directory) return open ? 'folder-open' : 'folder';
    const lower = String(name).toLowerCase();
    const extension = lower.includes('.') ? lower.split('.').pop() : '';
    return Object.hasOwn(special, lower) ? special[lower] : lower.startsWith('.env.') ? 'config' : Object.hasOwn(extensions, extension) ? extensions[extension] : 'file';
  }
  const shapes = {
    folder: '<path d="M2 5h5l2 2h9v10H2z"/>',
    'folder-open': '<path d="M2 16V5h5l2 2h9v3M2 16l3-6h14l-3 6z"/>',
    code: '<path d="m7 7-4 3 4 3m6-6 4 3-4 3m-2-8-2 10"/>',
    config: '<path d="M6 4H4v4l-2 2 2 2v4h2m8-12h2v4l2 2-2 2v4h-2M9 7h2m-2 3h2m-2 3h2"/>',
    image: '<rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="7" cy="7" r="1"/><path d="m3 15 5-5 3 3 2-2 4 4"/>',
    terminal: '<rect x="2" y="3" width="16" height="14" rx="2"/><path d="m5 7 3 3-3 3m5 0h5"/>',
    markdown: '<path d="M2 5h16v10H2zM5 12V8l2 2 2-2v4m5-4v4m-2-2 2 2 2-2"/>',
    package: '<path d="m10 2 7 4v8l-7 4-7-4V6zM3 6l7 4 7-4m-7 4v8M6 4l7 4"/>',
    git: '<path d="m10 2 8 8-8 8-8-8zM7 5l6 6M8 6v7"/><circle cx="8" cy="6" r="1"/><circle cx="8" cy="13" r="1"/><circle cx="13" cy="11" r="1"/>',
    archive: '<path d="M4 2h8l4 4v12H4zM12 2v4h4M9 3v2m0 2v2m0 2v2m-1 2h2v2H8z"/>',
    text: '<path d="M4 2h8l4 4v12H4zM12 2v4h4M7 9h6m-6 3h6m-6 3h4"/>',
    file: '<path d="M4 2h8l4 4v12H4zM12 2v4h4"/>',
    vue: '<path d="M2 4h4l4 7 4-7h4l-8 13zM6 4h3l1 2 1-2h3"/>',
    react: '<ellipse cx="10" cy="10" rx="8" ry="3"/><ellipse cx="10" cy="10" rx="8" ry="3" transform="rotate(60 10 10)"/><ellipse cx="10" cy="10" rx="8" ry="3" transform="rotate(120 10 10)"/><circle cx="10" cy="10" r="1"/>',
  };
  const labels = { typescript: 'TS', javascript: 'JS', python: 'Py', html: '<>', style: '#', svelte: 'S', container: 'D', document: 'D' };
  function render(element, name, directory, open) {
    const type = kind(name, directory, open);
    element.className = 'tree-icon tree-icon-' + type;
    element.setAttribute('aria-hidden', 'true');
    const shape = shapes[type] || (labels[type] ? '<text x="10" y="13" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui,sans-serif" font-size="9" font-weight="700">' + labels[type].replace('<', '&lt;').replace('>', '&gt;') + '</text>' : shapes.file);
    element.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" focusable="false">' + shape + '</svg>';
  }
  window.fileIcons = { kind, render };
})();
