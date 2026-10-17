import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

/** Markdown 的浏览器依赖全部打进本地 ESM，动态图型模块同样随包分发。 */
export async function buildMarkdown(root, output) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/renderer/markdownEditor.js'],
    outdir: path.join(output, 'vendor', 'markdown'),
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
    minify: true, legalComments: 'linked', metafile: true,
    chunkNames: 'chunks/[name]-[hash]',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const require = createRequire(path.join(root, 'package.json'));
  const katexRoot = path.dirname(require.resolve('katex/package.json'));
  const fontTarget = path.join(output, 'vendor', 'katex', 'fonts');
  fs.mkdirSync(fontTarget, { recursive: true });
  for (const font of fs.readdirSync(path.join(katexRoot, 'dist', 'fonts'))) fs.writeFileSync(path.join(fontTarget, font), fs.readFileSync(path.join(katexRoot, 'dist', 'fonts', font)));
  fs.copyFileSync(path.join(katexRoot, 'dist', 'katex.min.css'), path.join(output, 'vendor', 'katex', 'katex.min.css'));
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes('node_modules/')) continue;
    let directory = path.dirname(path.resolve(root, input));
    while (directory !== path.dirname(directory) && !fs.existsSync(path.join(directory, 'package.json'))) directory = path.dirname(directory);
    packages.add(directory);
  }
  const licenses = path.join(output, 'vendor', 'licenses', 'markdown');
  fs.mkdirSync(licenses, { recursive: true });
  for (const directory of packages) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    for (const file of fs.readdirSync(directory).filter(name => /^licen[cs]e(?:[.-].*)?$/i.test(name))) {
      if (fs.statSync(path.join(directory, file)).isFile()) fs.copyFileSync(path.join(directory, file), path.join(licenses, manifest.name.replace(/[/@]/g, '_') + '-' + file));
    }
  }
  console.log('[markdown] 本地编辑器、图型模块及公式字体已构建');
}
