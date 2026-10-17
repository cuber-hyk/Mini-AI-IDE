/**
 * 把不需要 TypeScript 编译的静态资源复制到 dist/。
 *
 * 目前包含：
 *  - 编辑器页面 HTML/JS/CSS（原生 JS，不用打包器）；
 *  - Monaco Editor 的 AMD 发行文件（从 node_modules 复制，避免运行时依赖 node_modules）。
 *
 * 实现说明：这里**不用** `fs.cpSync` —— 在本项目的执行环境中它会以 EIO 失败
 * （已实测）。改用显式的 `mkdirSync` + `writeFileSync` 递归复制，行为稳定可预期。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildMarkdown } from './build-markdown.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const dist = path.join(repoRoot, 'dist');

let fileCount = 0;

function copyTree(from, to) {
  if (!fs.existsSync(from)) {
    console.warn(`[copy-static] 源不存在，跳过：${path.relative(repoRoot, from)}`);
    return;
  }
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      copyTree(path.join(from, name), path.join(to, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, fs.readFileSync(from));
  fileCount += 1;
}

copyTree(path.join(repoRoot, 'src', 'renderer'), path.join(dist, 'renderer'));
await buildMarkdown(repoRoot, path.join(dist, 'renderer'));
const { FORMAT_SPEC } = createRequire(import.meta.url)(path.join(dist, 'shared', 'formatSpec.js'));
fs.writeFileSync(path.join(dist, 'renderer', 'formatSpecDefaults.js'),
  `/* Generated from shared/formatSpec.ts */\nwindow.formatSpecDefaults = ${JSON.stringify(FORMAT_SPEC)};\n`);
const tokens = JSON.parse(fs.readFileSync(path.join(repoRoot, 'design-tokens.json'), 'utf8'));
const tokenCss = Object.entries(tokens).map(([name, token]) => `  --${name}: ${token.$value};`).join('\n');
fs.writeFileSync(path.join(dist, 'renderer', 'ui-tokens.css'), `/* Generated from design-tokens.json */\n:root {\n${tokenCss}\n}\n`);
copyTree(path.join(repoRoot, 'node_modules', 'monaco-editor', 'min'), path.join(dist, 'renderer', 'vendor', 'monaco'));

const localRequire = createRequire(import.meta.url);
const vendor = path.join(dist, 'renderer', 'vendor');
const docxEntry = localRequire.resolve('docx-preview');
copyTree(path.join(path.dirname(docxEntry), 'docx-preview.min.js'), path.join(vendor, 'docx-preview.min.js'));
const zipPackage = createRequire(docxEntry).resolve('jszip/package.json');
copyTree(path.join(path.dirname(zipPackage), 'dist', 'jszip.min.js'), path.join(vendor, 'jszip.min.js'));
copyTree(path.join(path.dirname(localRequire.resolve('dompurify')), 'purify.min.js'), path.join(vendor, 'purify.min.js'));
const pdfRoot = path.dirname(localRequire.resolve('pdfjs-dist/package.json'));
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) copyTree(path.join(pdfRoot, 'build', file), path.join(vendor, 'pdfjs', file));
for (const [name, source] of [['pdfjs', pdfRoot], ['docx-preview', path.dirname(path.dirname(docxEntry))], ['jszip', path.dirname(zipPackage)], ['dompurify', path.dirname(path.dirname(localRequire.resolve('dompurify')))]]) {
  for (const file of ['LICENSE', 'LICENSE.txt', 'LICENSE.markdown', 'LICENSE-APACHE', 'LICENSE-MIT']) {
    if (fs.existsSync(path.join(source, file))) copyTree(path.join(source, file), path.join(vendor, 'licenses', name + '-' + file));
  }
}
// PDF 字体、CMap 和解码资源由本地字节表提供，保持 connect-src 'none'。
const pdfResources = {};
for (const [kind, folder] of [['cMapUrl', 'cmaps'], ['standardFontDataUrl', 'standard_fonts'], ['wasmUrl', 'wasm']]) {
  pdfResources[kind] = {};
  for (const file of fs.readdirSync(path.join(pdfRoot, folder))) {
    if (/^(LICENSE|README)/.test(file)) { copyTree(path.join(pdfRoot, folder, file), path.join(vendor, 'licenses', folder + '-' + file)); continue; }
    if (file.endsWith('.js')) continue;
    pdfResources[kind][file] = fs.readFileSync(path.join(pdfRoot, folder, file)).toString('base64');
  }
}
fs.writeFileSync(path.join(dist, 'renderer', 'filePreviewPdfResources.js'), `window.filePreviewPdfResources = ${JSON.stringify(pdfResources)};\n`);
const { filePreviewKind } = localRequire(path.join(dist, 'shared', 'filePreview.js'));
fs.writeFileSync(path.join(dist, 'renderer', 'filePreviewTypes.js'), `window.filePreviewKind = ${filePreviewKind.toString()};\n`);

console.log(`[copy-static] 完成，共复制 ${fileCount} 个文件`);
