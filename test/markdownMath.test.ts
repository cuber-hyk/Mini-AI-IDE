import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { mathRanges } from '../src/renderer/markdownMath.js';

function ranges(doc: string) {
  return mathRanges(EditorState.create({ doc, extensions: [markdown()] }));
}

it('数学范围保留原文偏移，支持两种行内和两种块级定界', () => {
  const doc = '中文 $x^2$ 和 \\(y+1\\)\n\n$$\n\\frac{a}{b}\n$$\n\n\\[\na+b\n\\]';
  const found = ranges(doc);
  assert.deepEqual(found.map((item: any) => [item.tex, item.display]), [
    ['x^2', false], ['y+1', false], ['\\frac{a}{b}', true], ['a+b', true]
  ]);
  for (const item of found) assert.equal(doc.slice(item.contentFrom, item.contentTo), item.tex);
  assert.equal(doc.slice(found[2].from, found[2].to), '$$\n\\frac{a}{b}\n$$');
});

it('同一行独立块公式可渲染，未闭合块和跨行美元保留源码', () => {
  assert.deepEqual(ranges('  $$x+y$$  \n\\[z\\]').map((item: any) => [item.tex, item.display]), [['x+y', true], ['z', true]]);
  assert.equal(ranges('$$\nx\n\n尾部 $a\nb$').length, 0);
});

it('代码围栏、缩进代码、行内代码和 frontmatter 的美元不识别为公式', () => {
  const doc = '---\ntitle: "$front$"\n---\n\n`$inline$`\n\n```tex\n$code$\n$$\nx\n$$\n```\n\n    $indented$\n\n正文 $real$';
  assert.deepEqual(ranges(doc).map((item: any) => item.tex), ['real']);
  assert.deepEqual(ranges('+++\ntitle="$front$"\n+++\n\n$real$').map((item: any) => item.tex), ['real']);
  assert.equal(ranges('---\ntitle: "$front$"').length, 0, '未闭合 frontmatter 仍保留源码');
});

it('转义、货币和空白边界不会吞掉正常正文，数学中的数字仍可使用', () => {
  const doc = '\\$escaped\\$，价格 $5 和 $10；$5.00$，$  space$ $space $，$2x + 1$，\\(42\\)，$a\\$b$';
  assert.deepEqual(ranges(doc).map((item: any) => item.tex), ['5.00', '2x + 1', '42', 'a\\$b']);
  assert.deepEqual(ranges('$42$ 和 $5.00$').map((item: any) => item.tex), ['42', '5.00']);
  assert.deepEqual(ranges('$+$ 和 $=$').map((item: any) => item.tex), ['+', '=']);
  assert.equal(ranges('价格 $100，折扣后 $80').length, 0);
});

it('链接目标和图片信息不会产生交叠公式，链接可见正文仍可含公式', () => {
  const doc = '[链接 $label$]($target$ "title $title$") ![图片 $alt$]($image$) <https://example.test/$url$>';
  assert.deepEqual(ranges(doc).map((item: any) => item.tex), ['label']);
});

it('渲染传入不可信 TeX 时禁用信任，限制尺寸/展开，宏不跨公式共享', () => {
  const calls: any[] = [];
  const element = () => ({ className: '', textContent: '', classList: { add() {} }, replaceChildren() {} });
  const context: any = { document: { createElement: element }, katex: { render(_tex: string, _host: any, options: any) {
    calls.push(options);
    assert.equal(options.macros.leaked, undefined);
    options.macros.leaked = 'from previous formula';
  } } };
  const source = readFileSync('src/renderer/markdownMath.js', 'utf8').replace(/^import .*;$/gm, '').replace(/export function /g, 'function ');
  runInNewContext(source + '\nglobalThis.render = renderMath;', context);
  context.render('\\gdef\\leaked{bad}x', false); context.render('x', true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].trust, false); assert.equal(calls[0].throwOnError, true);
  assert.ok(calls[0].maxExpand <= 500); assert.ok(calls[0].maxSize <= 20);
  assert.notEqual(calls[0].macros, calls[1].macros);
});

it('无效及过大公式同时保留原文和可见错误，不以 HTML 插入错误消息', () => {
  let children: any[] = [];
  const context: any = { document: { createElement() { return { classList: { add() {} }, replaceChildren(...value: any[]) { children = value; } }; } },
    katex: { render() { throw new Error('<img src=x> unknown command'); } } };
  const source = readFileSync('src/renderer/markdownMath.js', 'utf8').replace(/^import .*;$/gm, '').replace(/export function /g, 'function ');
  runInNewContext(source + '\nglobalThis.render = renderMath;', context);
  context.render('\\badcommand', false);
  assert.equal(children[0].textContent, '\\badcommand');
  assert.match(children[1].textContent, /公式无法渲染/);
  context.render('x'.repeat(16001), false);
  assert.match(children[1].textContent, /16000/);
});
