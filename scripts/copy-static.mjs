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
const { FORMAT_SPEC } = createRequire(import.meta.url)(path.join(dist, 'shared', 'formatSpec.js'));
fs.writeFileSync(path.join(dist, 'renderer', 'formatSpecDefaults.js'),
  `/* Generated from shared/formatSpec.ts */\nwindow.formatSpecDefaults = ${JSON.stringify(FORMAT_SPEC)};\n`);
const tokens = JSON.parse(fs.readFileSync(path.join(repoRoot, 'design-tokens.json'), 'utf8'));
const tokenCss = Object.entries(tokens).map(([name, token]) => `  --${name}: ${token.$value};`).join('\n');
fs.writeFileSync(path.join(dist, 'renderer', 'ui-tokens.css'), `/* Generated from design-tokens.json */\n:root {\n${tokenCss}\n}\n`);
copyTree(path.join(repoRoot, 'node_modules', 'monaco-editor', 'min'), path.join(dist, 'renderer', 'vendor', 'monaco'));

console.log(`[copy-static] 完成，共复制 ${fileCount} 个文件`);
