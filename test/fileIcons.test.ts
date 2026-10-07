import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { it } from 'node:test';

function icons() {
  const context: any = { window: {} };
  vm.runInNewContext(fs.readFileSync('src/renderer/fileIcons.js', 'utf8'), context);
  return context.window.fileIcons;
}

it('常见类型、特殊文件和未知文件有稳定区分，优先特殊文件名', () => {
  const { kind } = icons();
  for (const [name, expected] of Object.entries({ 'index.TS': 'typescript', 'App.tsx': 'react', 'App.vue': 'vue', 'main.js': 'javascript', 'style.css': 'style', 'README.md': 'markdown', 'notes.txt': 'text', 'a.PNG': 'image', 'package.json': 'package', 'tsconfig.json': 'config', '.gitignore': 'git', '.env.local': 'config', 'Dockerfile': 'container', 'a.ps1': 'terminal', 'a.py': 'python', 'a.zip': 'archive', 'unknown.zzz': 'file', 'constructor': 'file', 'a.__proto__': 'file' })) assert.equal(kind(name, false), expected, name);
  assert.equal(kind('src', true, false), 'folder'); assert.equal(kind('src', true, true), 'folder-open');
});

it('文件名不进入 SVG 标记，装饰图标不增加屏幕阅读器噪声', () => {
  const { render } = icons(); const attributes: Record<string, string> = {};
  const element = { className: '', innerHTML: '', setAttribute(name: string, value: string) { attributes[name] = value; } };
  render(element, '<img src=x onerror=alert(1)>.txt', false, false);
  assert.equal(element.className, 'tree-icon tree-icon-text'); assert.equal(attributes['aria-hidden'], 'true');
  assert.ok(element.innerHTML.startsWith('<svg ')); assert.equal(element.innerHTML.includes('<img'), false);
  render(element, 'src', true, true); assert.equal(element.className, 'tree-icon tree-icon-folder-open');
});
