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
  for (const [name, expected] of Object.entries({ 'index.TS': 'typescript', 'App.tsx': 'react', 'App.vue': 'vue', 'main.js': 'javascript', 'style.css': 'style', 'README.md': 'markdown', 'notes.txt': 'text', 'a.PNG': 'image', 'package.json': 'node', 'tsconfig.json': 'json', '.gitignore': 'git', '.env.local': 'env', 'Dockerfile': 'docker', 'a.ps1': 'powershell', 'a.py': 'python', 'a.zip': 'archive', 'unknown.zzz': 'other', 'constructor': 'other', 'a.__proto__': 'other', 'types.d.ts': 'typescript', 'App.module.css': 'style', 'Button.test.tsx': 'react', 'webpack.config.js': 'javascript', 'index.min.js': 'javascript', 'Cargo.toml': 'toml', 'main.rs': 'rust', 'main.go': 'go', 'a.java': 'java', 'a.cs': 'csharp', 'a.rb': 'ruby', 'a.php': 'php', 'a.swift': 'swift', 'a.kt': 'kotlin', 'a.lua': 'lua', 'a.sql': 'sql', 'a.yaml': 'yaml', 'a.xml': 'xml', 'a.csv': 'csv', 'a.json': 'json', 'a.pdf': 'pdf', 'a.docx': 'word', 'a.xlsx': 'excel', 'a.pptx': 'ppt', 'a.mp3': 'audio', 'a.mp4': 'video', 'a.woff2': 'font', 'LICENSE': 'license', 'README': 'markdown', 'CHANGELOG.md': 'markdown', 'Makefile': 'makefile', 'CMakeLists.txt': 'cmake', 'pom.xml': 'xml', 'gradlew': 'gradle', 'bun.lockb': 'bun', '.editorconfig': 'ini', '.prettierrc': 'json', 'docker-compose.yml': 'docker', 'a.jsonc': 'json', 'a.astro': 'astro', 'a.svelte': 'svelte' })) assert.equal(kind(name, false), expected, name);
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
