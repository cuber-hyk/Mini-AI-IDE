/**
 * 用 TypeScript 编译器对编辑器与输入区 owner 脚本做**真实作用域分析**，
 * 找出所有"裸标识符找不到绑定"的位置（TS 诊断 2304 / 2552），
 * 结果写到 `tools/renderer-scope-report.json`，供自检 V6 读取。
 *
 * 为什么需要这个脚本：
 *   `renderer.js` 是**普通 JS**，不走 `tsc`；自检 L2 只用 `node:vm` 做**语法**解析，
 *   语法没问题的前提下，一个引用了不存在变量的表达式完全察觉不到。
 *   而这类错误一旦落在 Monaco 的回调里（例如 `getPosition()`），异常会被
 *   Monaco 内部吞掉 —— 外部既没有报错、也没有按钮，是极难定位的静默失败。
 *   实测踩过：`setupSelectionCopyBubble` 里写了裸 `editor.xxx()`，而该函数
 *   并没有 `editor` 这个绑定（同名的只是别的函数的局部变量）。
 *
 * 只读源码 + 写一份 JSON 报告，不改任何源码。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, 'src/renderer/renderer.js');
const out = path.join(root, 'tools/renderer-scope-report.json');

const targets = [target, ...['promptComposer', 'editorToolbar', 'changeTree', 'preview', 'webbar'].map(name => path.join(root, `src/renderer/${name}.js`))];
const host = ts.createCompilerHost({ allowJs: true, checkJs: true, noEmit: true });
host.writeFile = () => {};

const program = ts.createProgram({
  rootNames: targets,
  options: {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    // 关掉这些以免噪声淹掉真正要看的问题
    strict: false,
    skipLibCheck: true,
    noResolve: true,
  },
  host,
});

const diagnostics = [
  ...program.getSemanticDiagnostics(),
  ...program.getSyntacticDiagnostics(),
].filter((d) => d.file && targets.includes(path.resolve(d.file.fileName)));

/** 只关心"找不到名字"类诊断：2304 Cannot find name / 2552 Did you mean */
const undefinedNames = [];
for (const d of diagnostics) {
  if (d.code !== 2304 && d.code !== 2552) continue;
  const pos = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
  const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
  undefinedNames.push(`${path.basename(d.file.fileName)}:L${pos.line + 1}:${pos.character + 1} ${text}`);
}

const report = {
  generatedAt: new Date().toISOString(),
  files: targets.map((file) => path.relative(root, file)),
  undefinedNames,
  otherDiagnostics: diagnostics
    .filter((d) => d.code !== 2304 && d.code !== 2552)
    .map((d) => {
      const pos = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
      return `${path.basename(d.file.fileName)}:L${pos.line + 1} [${d.code}] ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    }),
};

fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`[scope] 裸标识符未绑定：${undefinedNames.length} 处`);
if (undefinedNames.length > 0) {
  for (const u of undefinedNames) console.log(`  ${u}`);
}
if (report.otherDiagnostics.length > 0) {
  console.log(`[scope] 其它语义诊断：${report.otherDiagnostics.length} 条（不判失败，仅供参考）`);
}
console.log(`[scope] 报告已写入 ${path.relative(root, out)}`);
process.exit(undefinedNames.length === 0 ? 0 : 1);
