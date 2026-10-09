/** 本地文件类型图标；静态 SVG，不把文件名插入标记。风格参考 deepseek-harness：折角纸张底 + 白色符号，高频语言用彩色品牌标。 */
(function () {
  'use strict';
  const special = {
    'package.json': 'node', 'package-lock.json': 'node',
    'yarn.lock': 'package', 'bun.lockb': 'bun', 'deno.json': 'deno', 'deno.jsonc': 'deno',
    'dockerfile': 'docker', 'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker',
    '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git', '.gitkeep': 'git',
    '.env': 'env', 'tsconfig.json': 'json', 'tsconfig.base.json': 'json', 'jsconfig.json': 'json',
    'makefile': 'makefile', 'gnumakefile': 'makefile', 'cmakelists.txt': 'cmake',
    'gradlew': 'gradle', 'gradlew.bat': 'gradle', 'pom.xml': 'xml',
    'license': 'license', 'license.md': 'license', 'license.txt': 'license',
    'readme': 'markdown', 'readme.md': 'markdown', 'readme.txt': 'text',
    'changelog': 'markdown', 'changelog.md': 'markdown', 'contributing.md': 'markdown',
    '.editorconfig': 'ini', '.prettierrc': 'json', '.prettierrc.json': 'json',
    '.eslintrc': 'json', '.eslintrc.json': 'json', '.babelrc': 'json', '.npmrc': 'config',
  };
  const extensions = {
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'react',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'react',
    vue: 'vue', svelte: 'svelte', astro: 'astro',
    html: 'html', htm: 'html', css: 'style', scss: 'style', sass: 'style', less: 'style',
    json: 'json', jsonc: 'json', json5: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', xml: 'xml', csv: 'csv', tsv: 'csv',
    md: 'markdown', mdx: 'markdown', txt: 'text', log: 'log',
    py: 'python', pyw: 'python', rb: 'ruby', php: 'php', java: 'java', kt: 'kotlin', kts: 'kotlin',
    rs: 'rust', go: 'go', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
    cs: 'csharp', swift: 'swift', lua: 'lua', r: 'r', sql: 'sql', graphql: 'graphql', gql: 'graphql',
    sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', psm1: 'powershell', bat: 'batch', cmd: 'batch',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', svg: 'image',
    tif: 'image', tiff: 'image', avif: 'image',
    mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio',
    mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video',
    woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', eot: 'font',
    pdf: 'pdf', doc: 'word', docx: 'word', xls: 'excel', xlsx: 'excel', csv2: 'excel',
    ppt: 'ppt', pptx: 'ppt', key: 'ppt', epub: 'epub',
    zip: 'archive', gz: 'archive', tgz: 'archive', '7z': 'archive', tar: 'archive', rar: 'archive', bz2: 'archive',
  };
  function kind(name, directory, open) {
    if (directory) return open ? 'folder-open' : 'folder';
    const lower = String(name).toLowerCase();
    if (Object.hasOwn(special, lower)) return special[lower];
    if (lower.startsWith('.env.')) return 'env';
    const parts = lower.split('.');
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
    const prev = parts.length > 2 ? parts[parts.length - 2] : '';
    if (last === 'ts' && prev === 'd') return 'typescript';
    if ((last === 'css' || last === 'scss' || last === 'less') && prev === 'module') return 'style';
    if (['test', 'spec', 'd', 'config', 'min'].includes(prev) && Object.hasOwn(extensions, last)) return extensions[last];
    return Object.hasOwn(extensions, last) ? extensions[last] : 'other';
  }
  // 折角纸张底形（20x20），fill 由 CSS 类型色控制。
  const PAPER = 'M4.6 1.5h7.3l3.5 3.5v13.5H4.6z';
  const FOLD = 'M11.9 1.5v3.5h3.5z';
  const PAPER_OPEN = 'M2.2 17.4V4.2h5.1l1.9 2h8.6v2.6H2.2z';
  const PAPER_OPEN_BOTTOM = 'M2.2 17.4l2.9-6.2h11.7l-2.9 6.2z';
  function paper(symbol) {
    return '<path d="' + PAPER + '" fill="currentColor"/><path d="' + FOLD + '" fill="#fff" fill-opacity=".35"/><g fill="#fff">' + symbol + '</g>';
  }
  function folderShape(open) {
    if (open) return '<path d="M2.4 16.4V4.9c0-.4.2-.7.7-.7h4.1l1.8 1.9h7.6c.4 0 .7.3.7.7v3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M2.4 16.4l2.7-6h12.7l-2.7 6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>';
    return '<path d="M2.6 16.4V4.9c0-.4.2-.7.7-.7h4l1.8 1.9h7.6c.4 0 .7.3.7.7v9.6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6.3 11.6h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-opacity=".85"/>';
  }
  const BRAND = {
    typescript: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#3178C6"/><text x="10" y="13.8" text-anchor="middle" font-family="Arial" font-size="8" font-weight="700" fill="#fff">TS</text>',
    javascript: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#F7DF1E"/><text x="10" y="13.8" text-anchor="middle" font-family="Arial" font-size="8" font-weight="700" fill="#000">JS</text>',
    react: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#20232A"/><circle cx="10" cy="10" r="1.5" fill="#61DAFB"/><ellipse cx="10" cy="10" rx="6.2" ry="2.4" fill="none" stroke="#61DAFB" stroke-width="1"/><ellipse cx="10" cy="10" rx="6.2" ry="2.4" fill="none" stroke="#61DAFB" stroke-width="1" transform="rotate(60 10 10)"/><ellipse cx="10" cy="10" rx="6.2" ry="2.4" fill="none" stroke="#61DAFB" stroke-width="1" transform="rotate(120 10 10)"/>',
    vue: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#41B883"/><path d="M5 6h2.6L10 11.2 12.4 6H15l-5 9z" fill="#fff"/>',
    svelte: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#FF3E00"/><text x="10" y="14" text-anchor="middle" font-family="Arial" font-size="8" font-weight="700" fill="#fff">S</text>',
    astro: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#0F0F14"/><path d="M10 4l4 12h-2.4l-1.6-4-1.6 4H6z" fill="#FF5D01"/>',
    python: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#3776AB"/><text x="10" y="13.8" text-anchor="middle" font-family="Arial" font-size="8" font-weight="700" fill="#fff">PY</text>',
    java: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#E76F00"/><text x="10" y="13.8" text-anchor="middle" font-family="Arial" font-size="8" font-weight="700" fill="#fff">J</text>',
    go: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#00ADD8"/><text x="10" y="13.6" text-anchor="middle" font-family="Arial" font-size="7" font-weight="700" fill="#fff">GO</text>',
    rust: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#CE422B"/><text x="10" y="13.6" text-anchor="middle" font-family="Arial" font-size="7" font-weight="700" fill="#fff">RS</text>',
    csharp: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#68217A"/><text x="10" y="13.6" text-anchor="middle" font-family="Arial" font-size="7" font-weight="700" fill="#fff">C#</text>',
    php: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#777BB4"/><text x="10" y="13.6" text-anchor="middle" font-family="Arial" font-size="7" font-weight="700" fill="#fff">PHP</text>',
    ruby: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#CC342D"/><text x="10" y="13.6" text-anchor="middle" font-family="Arial" font-size="7" font-weight="700" fill="#fff">RB</text>',
    swift: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#FA7343"/><text x="10" y="13.6" text-anchor="middle" font-family="Arial" font-size="7" font-weight="700" fill="#fff">SW</text>',
    kotlin: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#7F52FF"/><text x="10" y="13.6" text-anchor="middle" font-family="Arial" font-size="7" font-weight="700" fill="#fff">KT</text>',
    r: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#276DC3"/><text x="10" y="13.8" text-anchor="middle" font-family="Arial" font-size="8" font-weight="700" fill="#fff">R</text>',
    lua: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#2C2D72"/><text x="10" y="13.6" text-anchor="middle" font-family="Arial" font-size="7" font-weight="700" fill="#fff">LUA</text>',
    sql: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#336791"/><text x="10" y="13.6" text-anchor="middle" font-family="Arial" font-size="7" font-weight="700" fill="#fff">SQL</text>',
    c: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#5C6BC0"/><text x="10" y="13.8" text-anchor="middle" font-family="Arial" font-size="8" font-weight="700" fill="#fff">C</text>',
    cpp: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#00599C"/><text x="10" y="13.4" text-anchor="middle" font-family="Arial" font-size="6" font-weight="700" fill="#fff">C++</text>',
    json: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#292929"/><text x="10" y="13.4" text-anchor="middle" font-family="Arial" font-size="6.5" font-weight="700" fill="#F7DF1E">JSON</text>',
    yaml: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#fff"/><text x="10" y="9.6" text-anchor="middle" font-family="Arial" font-size="6" font-weight="800" fill="#CB171E">YA</text><text x="10" y="15.6" text-anchor="middle" font-family="Arial" font-size="6" font-weight="800" fill="#1A1A1A">ML</text>',
    toml: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#9C6B4A"/><text x="10" y="13.4" text-anchor="middle" font-family="Arial" font-size="6" font-weight="700" fill="#fff">TOML</text>',
    ini: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#6E7781"/><text x="10" y="13.6" text-anchor="middle" font-family="Arial" font-size="7" font-weight="700" fill="#fff">INI</text>',
    xml: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#F1662A"/><text x="10" y="13.4" text-anchor="middle" font-family="Arial" font-size="6.5" font-weight="700" fill="#fff">XML</text>',
    env: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#ECD53F"/><text x="10" y="13" text-anchor="middle" font-family="Arial" font-size="5.6" font-weight="700" fill="#24292F">.ENV</text>',
    package: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#EDF7EA" stroke="#DDE2E8" stroke-width=".5"/><g transform="translate(3 3) scale(.5833333333)"><path fill="#539E43" d="M11.998,24c-0.321,0-0.641-0.084-0.922-0.247l-2.936-1.737c-0.438-0.245-0.224-0.332-0.08-0.383 c0.585-0.203,0.703-0.25,1.328-0.604c0.065-0.037,0.151-0.023,0.218,0.017l2.256,1.339c0.082,0.045,0.197,0.045,0.272,0l8.795-5.076 c0.082-0.047,0.134-0.141,0.134-0.238V6.921c0-0.099-0.053-0.192-0.137-0.242l-8.791-5.072c-0.081-0.047-0.189-0.047-0.271,0 L3.075,6.68C2.99,6.729,2.936,6.825,2.936,6.921v10.15c0,0.097,0.054,0.189,0.139,0.235l2.409,1.392 c1.307,0.654,2.108-0.116,2.108-0.89V7.787c0-0.142,0.114-0.253,0.256-0.253h1.115c0.139,0,0.255,0.112,0.255,0.253v10.021 c0,1.745-0.95,2.745-2.604,2.745c-0.508,0-0.909,0-2.026-0.551L2.28,18.675c-0.57-0.329-0.922-0.945-0.922-1.604V6.921 c0-0.659,0.353-1.275,0.922-1.603l8.795-5.082c0.557-0.315,1.296-0.315,1.848,0l8.794,5.082c0.57,0.329,0.924,0.944,0.924,1.603 v10.15c0,0.659-0.354,1.273-0.924,1.604l-8.794,5.078C12.643,23.916,12.324,24,11.998,24z M19.099,13.993 c0-1.9-1.284-2.406-3.987-2.763c-2.731-0.361-3.009-0.548-3.009-1.187c0-0.528,0.235-1.233,2.258-1.233 c1.807,0,2.473,0.389,2.747,1.607c0.024,0.115,0.129,0.199,0.247,0.199h1.141c0.071,0,0.138-0.031,0.186-0.081 c0.048-0.054,0.074-0.123,0.067-0.196c-0.177-2.098-1.571-3.076-4.388-3.076c-2.508,0-4.004,1.058-4.004,2.833 c0,1.925,1.488,2.457,3.895,2.695c2.88,0.282,3.103,0.703,3.103,1.269c0,0.983-0.789,1.402-2.642,1.402 c-2.327,0-2.839-0.584-3.011-1.742c-0.02-0.124-0.126-0.215-0.253-0.215h-1.137c-0.141,0-0.254,0.112-0.254,0.253 c0,1.482,0.806,3.248,4.655,3.248C17.501,17.007,19.099,15.91,19.099,13.993z"/></g>',
    node: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#EDF7EA" stroke="#DDE2E8" stroke-width=".5"/><g transform="translate(3 3) scale(.5833333333)"><path fill="#539E43" d="M11.998,24c-0.321,0-0.641-0.084-0.922-0.247l-2.936-1.737c-0.438-0.245-0.224-0.332-0.08-0.383 c0.585-0.203,0.703-0.25,1.328-0.604c0.065-0.037,0.151-0.023,0.218,0.017l2.256,1.339c0.082,0.045,0.197,0.045,0.272,0l8.795-5.076 c0.082-0.047,0.134-0.141,0.134-0.238V6.921c0-0.099-0.053-0.192-0.137-0.242l-8.791-5.072c-0.081-0.047-0.189-0.047-0.271,0 L3.075,6.68C2.99,6.729,2.936,6.825,2.936,6.921v10.15c0,0.097,0.054,0.189,0.139,0.235l2.409,1.392 c1.307,0.654,2.108-0.116,2.108-0.89V7.787c0-0.142,0.114-0.253,0.256-0.253h1.115c0.139,0,0.255,0.112,0.255,0.253v10.021 c0,1.745-0.95,2.745-2.604,2.745c-0.508,0-0.909,0-2.026-0.551L2.28,18.675c-0.57-0.329-0.922-0.945-0.922-1.604V6.921 c0-0.659,0.353-1.275,0.922-1.603l8.795-5.082c0.557-0.315,1.296-0.315,1.848,0l8.794,5.082c0.57,0.329,0.924,0.944,0.924,1.603 v10.15c0,0.659-0.354,1.273-0.924,1.604l-8.794,5.078C12.643,23.916,12.324,24,11.998,24z M19.099,13.993 c0-1.9-1.284-2.406-3.987-2.763c-2.731-0.361-3.009-0.548-3.009-1.187c0-0.528,0.235-1.233,2.258-1.233 c1.807,0,2.473,0.389,2.747,1.607c0.024,0.115,0.129,0.199,0.247,0.199h1.141c0.071,0,0.138-0.031,0.186-0.081 c0.048-0.054,0.074-0.123,0.067-0.196c-0.177-2.098-1.571-3.076-4.388-3.076c-2.508,0-4.004,1.058-4.004,2.833 c0,1.925,1.488,2.457,3.895,2.695c2.88,0.282,3.103,0.703,3.103,1.269c0,0.983-0.789,1.402-2.642,1.402 c-2.327,0-2.839-0.584-3.011-1.742c-0.02-0.124-0.126-0.215-0.253-0.215h-1.137c-0.141,0-0.254,0.112-0.254,0.253 c0,1.482,0.806,3.248,4.655,3.248C17.501,17.007,19.099,15.91,19.099,13.993z"/></g>',
    bun: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#FBF0DF"/><text x="10" y="13.6" text-anchor="middle" font-family="Arial" font-size="7" font-weight="700" fill="#14151A">BUN</text>',
    deno: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#101014"/><circle cx="10" cy="10" r="5" fill="none" stroke="#fff" stroke-width="1.4"/><path d="M10 7v6" stroke="#fff" stroke-width="1.4"/>',
    docker: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#2496ED"/><rect x="4" y="8.5" width="2.2" height="2.2" fill="#fff"/><rect x="6.6" y="8.5" width="2.2" height="2.2" fill="#fff"/><rect x="9.2" y="8.5" width="2.2" height="2.2" fill="#fff"/><rect x="6.6" y="6" width="2.2" height="2.2" fill="#fff"/><rect x="9.2" y="6" width="2.2" height="2.2" fill="#fff"/><path d="M3 12c1.5 3 6 3.5 9 2 1.6-.8 2.6-2 3-3.2.8.2 1.6.1 2-.6-.9-.5-1.6-.6-2-.4 0-.4 0-.8-.2-1.2-.8.4-1.4 1-1.7 1.7H3z" fill="#fff"/>',
    git: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#F05032"/><circle cx="10" cy="5.5" r="1.5" fill="#fff"/><circle cx="6" cy="14" r="1.5" fill="#fff"/><circle cx="14" cy="14" r="1.5" fill="#fff"/><path d="M10 7v3.5M10 10.5l-3.2 2.7M10 10.5l3.2 2.7" stroke="#fff" stroke-width="1.1"/>',
    makefile: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#427819"/><text x="10" y="13.4" text-anchor="middle" font-family="Arial" font-size="5.6" font-weight="700" fill="#fff">MAKE</text>',
    cmake: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#064F8C"/><path d="M4 16l6-13 6 13z" fill="#249847"/><path d="M7 13h6" stroke="#BE2128" stroke-width="1"/>',
    gradle: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#02303A"/><circle cx="10" cy="10" r="5" fill="none" stroke="#40C4B4" stroke-width="1.3"/><path d="M7 10h6M10 7v6" stroke="#40C4B4" stroke-width="1.1"/>',
    shell: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#303642"/><path d="m5 7 3 3-3 3m4 0h5" stroke="#7EE787" stroke-width="1.4" fill="none"/>',
    powershell: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#2671BE"/><path d="m6 7 3 3-3 3m4 0h4" stroke="#fff" stroke-width="1.4" fill="none"/>',
    batch: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#303642"/><path d="m5 7 3 3-3 3m4 0h5" stroke="#7EE787" stroke-width="1.4" fill="none"/>',
    graphql: '<rect x="1" y="1" width="18" height="18" rx="4" fill="#E10098"/><path d="m10 3 6 3.5v7L10 17l-6-3.5v-7z" fill="none" stroke="#fff" stroke-width="1.1"/>',
  };
  function render(element, name, directory, open) {
    const type = kind(name, directory, open);
    element.className = 'tree-icon tree-icon-' + type;
    element.setAttribute('aria-hidden', 'true');
    let inner;
    if (BRAND[type]) {
      inner = BRAND[type];
    } else if (type === 'folder' || type === 'folder-open') {
      inner = folderShape(type === 'folder-open');
    } else if (type === 'markdown') {
      inner = paper('<path d="M6.5 13.5V9.8h1l1.7 2.6h-.5L10.4 9.8h1v3.7h-1v-2.3h.2l-1.2 2h-.5l-1.3-2h.2v2.3z" fill="#fff"/><path d="M12.6 13.5V9.8h1.9c.5 0 .9.1 1.2.3.3.2.6.5.7.8.2.3.3.7.3 1.1s-.1.8-.3 1.1c-.2.3-.4.6-.7.8-.3.2-.7.3-1.2.3zm1.1-.9h.8c.2 0 .4 0 .6-.1.2-.1.3-.2.4-.4.1-.2.1-.4.1-.6s0-.4-.1-.6c-.1-.2-.2-.3-.4-.4-.2-.1-.4-.1-.6-.1h-.8z" fill="#fff"/>');
    } else if (type === 'pdf') {
      inner = paper('<path d="M6.3 13.5V9.8h1.7c.4 0 .7.1 1 .2.3.1.4.3.6.5.1.2.2.5.2.8s-.1.6-.2.8c-.2.2-.3.4-.6.5-.3.1-.6.2-1 .2H7v-.9h1c.2 0 .4 0 .5-.1.2-.1.2-.3.2-.5s0-.4-.2-.5c-.1-.1-.3-.1-.5-.1H7.4v2.7z" fill="#fff"/><path d="M9.8 13.5V9.8h1.9c.5 0 .9.1 1.2.3.3.2.6.5.7.8.2.3.3.7.3 1.1s-.1.8-.3 1.1c-.2.3-.4.6-.7.8-.3.2-.7.3-1.2.3zm1.1-.9h.8c.2 0 .4 0 .6-.1.2-.1.3-.2.4-.4.1-.2.1-.4.1-.6s0-.4-.1-.6c-.1-.2-.2-.3-.4-.4-.2-.1-.4-.1-.6-.1h-.8z" fill="#fff"/><path d="M14 13.5V9.8h2.9v.9H15v2.8z" fill="#fff"/>');
    } else if (type === 'image') {
      inner = paper('<circle cx="7.6" cy="8.6" r="1.3" fill="#fff"/><path d="M5.5 14l3-3 2.2 2.2 1.6-1.6 2.7 2.4z" fill="#fff"/>');
    } else if (type === 'video') {
      inner = paper('<path d="M8 8l5 3.5-5 3.5z" fill="#fff"/>');
    } else if (type === 'audio') {
      inner = paper('<path d="M7.5 13.5V8.6l4-1v4.4" fill="none" stroke="#fff" stroke-width="1.1"/><circle cx="6.6" cy="13.5" r="1.4" fill="#fff"/><circle cx="10.6" cy="12" r="1.4" fill="#fff"/>');
    } else if (type === 'word') {
      inner = paper('<path d="M6 13.5l1-4h1l.8 2.4.8-2.4h1l1 4h-1l-.6-2.6-.9 2.6h-.6l-.9-2.6-.6 2.6z" fill="#fff"/>');
    } else if (type === 'excel') {
      inner = paper('<path d="M6.2 13.5v-4h3.6v4zm.9-.9h1.8v-.7H7.1zm0-1.4h1.8v-.7H7.1z" fill="#fff"/>');
    } else if (type === 'ppt') {
      inner = paper('<path d="M6.2 13.5V9.8h1.7c.4 0 .7.1 1 .2.3.1.4.3.6.5.1.2.2.5.2.8s-.1.6-.2.8c-.2.2-.3.4-.6.5-.3.1-.6.2-1 .2H7.3v.7zm1.1-1.6h1c.2 0 .4 0 .5-.1.2-.1.2-.3.2-.5s0-.4-.2-.5c-.1-.1-.3-.1-.5-.1h-1z" fill="#fff"/>');
    } else if (type === 'epub') {
      inner = paper('<path d="M6.2 14V9.8h2.4v.9H7.3v.7h1.2v.8H7.3v.9h1.4v.9zm3.2 0V9.8h1.7c.4 0 .7.1 1 .2.3.1.4.3.6.5.1.2.2.5.2.8s-.1.6-.2.8c-.2.2-.3.4-.6.5-.3.1-.6.2-1 .2h-.6v1.2zm1.1-2h1c.2 0 .4 0 .5-.1.2-.1.2-.3.2-.5s0-.4-.2-.5c-.1-.1-.3-.1-.5-.1h-1z" fill="#fff"/>');
    } else if (type === 'archive' || type === 'compressed') {
      inner = paper('<rect x="9.2" y="4.8" width="1.6" height="3" fill="#fff"/><rect x="9.2" y="8.4" width="1.6" height="2" fill="#fff"/><rect x="8.7" y="10.6" width="2.6" height="2.6" rx=".5" fill="#fff"/>');
    } else if (type === 'code') {
      inner = paper('<path d="m7.2 10-2 2 2 2" stroke="#fff" stroke-width="1.3" fill="none"/><path d="m12.8 10 2 2-2 2" stroke="#fff" stroke-width="1.3" fill="none"/>');
    } else if (type === 'config') {
      inner = paper('<circle cx="10" cy="11.7" r="1.7" fill="none" stroke="#fff" stroke-width="1.1"/><path d="M10 8.4v1.4M10 13.6v1.4M6.7 11.7h1.4M11.9 11.7h1.4" stroke="#fff" stroke-width="1"/>');
    } else if (type === 'license') {
      inner = paper('<path d="M7 10h6M7 12h6M7 14h4" stroke="#fff" stroke-width="1.1" fill="none"/>');
    } else if (type === 'log' || type === 'text') {
      inner = paper('<path d="M7 9h6M7 11.5h6M7 14h4" stroke="#fff" stroke-width="1.1" fill="none"/>');
    } else if (type === 'font') {
      inner = paper('<path d="M7.4 14 9.6 9.8h.9L12.7 14h-1.3l-1.6-3.4h.2L8.6 14zm1.4-1.2h2.9v.9H8.8z" fill="#fff"/>');
    } else {
      inner = paper('<path d="M7 9h6M7 11.5h6M7 14h4" stroke="#fff" stroke-width="1.1" fill="none"/>');
    }
    element.innerHTML = '<svg viewBox="0 0 20 20" fill="none" focusable="false">' + inner + '</svg>';
  }
  window.fileIcons = { kind, render };
})();
