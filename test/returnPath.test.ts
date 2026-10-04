/**
 * 回程解析器单测
 *
 * 重点：**高容忍**。测试用例刻意模仿模型不按约定回复的真实形态
 * （路径写在注释里 / 写在标题里 / 只在正文提一次 / 完全不提）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applySnippetRangeFallback,
  computeApply,
  extractPathMentions,
  formatNumberedSnippet,
  matchHeadingLine,
  matchPathCommentLine,
  matchRangeDirective,
  normalizeRelPath,
  parseModelReply,
  splitFences,
  stripNumberedPrefix,
} from '../src/shared/returnPath';

describe('splitFences', () => {
  it('识别 ``` 围栏并保留语言标注', () => {
    const text = '说明\n```ts\nconst a = 1;\n```\n结束';
    const fences = splitFences(text);
    assert.equal(fences.length, 1);
    assert.equal(fences[0]?.info, 'ts');
    assert.equal(fences[0]?.body, 'const a = 1;\n');
  });

  it('识别 ~~~ 围栏', () => {
    const fences = splitFences('~~~python\nprint(1)\n~~~');
    assert.equal(fences.length, 1);
    assert.equal(fences[0]?.language ?? fences[0]?.info, 'python');
    assert.equal(fences[0]?.body, 'print(1)\n');
  });

  it('识别多个围栏', () => {
    const text = '```ts\na\n```\n中间\n```py\nb\n```';
    assert.equal(splitFences(text).length, 2);
  });

  it('没有围栏时返回空数组', () => {
    assert.deepEqual(splitFences('只有文字，没有代码块'), []);
  });

  it('未闭合围栏被视为「延续到文本结尾」（目标站点只渲染开头围栏）', () => {
    // 实测形态：DeepSeek 把开头 ``` 渲染成文本，结尾围栏是装饰元素、不在 innerText 里。
    // 若坚持"围栏必须成对"，整段回复会被判定为"没有围栏" → 解析出 0 个代码块。
    const collected = ['冒泡排序:', '```python', 'def bubble_sort(arr):', '    return arr'].join('\n');
    const fences = splitFences(collected);
    assert.equal(fences.length, 1);
    assert.equal(fences[0]?.info, 'python');
    assert.equal(fences[0]?.body, 'def bubble_sort(arr):\n    return arr');
  });

  it('未闭合围栏经完整解析可得到路径与代码', () => {
    const collected = [
      '文件： Mini-AI-IDE-test.md',
      '冒泡排序:',
      '```python',
      'def bubble_sort(arr):',
      '    return arr',
    ].join('\n');
    const r = parseModelReply(collected);
    assert.equal(r.blocks.length, 1);
    assert.equal(r.blocks[0]?.filePath, 'Mini-AI-IDE-test.md');
    assert.equal(r.blocks[0]?.language, 'python');
    assert.equal(r.blocks[0]?.code, 'def bubble_sort(arr):\n    return arr');
  });

  it('成对围栏与未闭合围栏混在一段文本里都能识别', () => {
    const text = ['```ts', 'const a = 1;', '```', '', '```py', 'print(1)'].join('\n');
    const fences = splitFences(text);
    assert.equal(fences.length, 2);
    assert.equal(fences[0]?.body, 'const a = 1;\n');
    assert.equal(fences[1]?.info, 'py');
    assert.equal(fences[1]?.body, 'print(1)');
  });

  it('未闭合围栏不重复计入已闭合块内部', () => {
    assert.equal(splitFences(['```ts', 'const a = 1;', '```'].join('\n')).length, 1);
  });
});

describe('normalizeRelPath / extractPathMentions', () => {
  it('去掉 ./ 前缀并统一斜杠', () => {
    assert.equal(normalizeRelPath('.\\src\\a.ts'), 'src/a.ts');
    assert.equal(normalizeRelPath('./src/a.ts'), 'src/a.ts');
  });

  it('含 .. 的路径不作为建议路径（交由白名单拒绝）', () => {
    assert.equal(normalizeRelPath('../../etc/passwd.md'), null);
  });

  it('从正文抽取路径并按出现顺序去重', () => {
    const mentions = extractPathMentions('改 `src/a.ts`，再看 src/b.py，最后回到 src/a.ts');
    assert.deepEqual(mentions, ['src/a.ts', 'src/b.py']);
  });

  it('不把普通单词当路径', () => {
    assert.deepEqual(extractPathMentions('这是一个普通句子，没有文件。'), []);
  });
});

describe('matchPathCommentLine', () => {
  it('识别 // 注释路径', () => {
    assert.equal(matchPathCommentLine('// src/main/index.ts'), 'src/main/index.ts');
  });
  it('识别带 file: 前缀的注释', () => {
    assert.equal(matchPathCommentLine('// file: src/a.ts'), 'src/a.ts');
  });
  it('识别 # 注释路径（Python）', () => {
    assert.equal(matchPathCommentLine('# train_caption.py'), 'train_caption.py');
  });
  it('识别 <!-- --> 路径（HTML）', () => {
    assert.equal(matchPathCommentLine('<!-- index.html -->'), 'index.html');
  });
  it('识别 -- 路径（SQL）', () => {
    assert.equal(matchPathCommentLine('-- schema.sql'), 'schema.sql');
  });
  it('普通代码行不被误判为路径注释', () => {
    assert.equal(matchPathCommentLine('const a = 1;'), null);
    assert.equal(matchPathCommentLine('import os'), null);
  });
  it('文件名含空格与中文也能整段取出（用户实测：「BLIP 阅读笔记.md」）', () => {
    assert.equal(matchPathCommentLine('# BLIP 阅读笔记.md'), 'BLIP 阅读笔记.md');
    assert.equal(matchPathCommentLine('// Mini-Omni 阅读笔记.md'), 'Mini-Omni 阅读笔记.md');
    assert.equal(matchPathCommentLine('<!-- CLIP 阅读笔记.md -->'), 'CLIP 阅读笔记.md');
  });
  it('注释行尾还有别的文字时不误取（行尾锚定）', () => {
    assert.equal(matchPathCommentLine('# a.ts 这是标题说明'), null);
  });
});

describe('matchHeadingLine', () => {
  it('识别 ### 标题里的路径', () => {
    assert.equal(matchHeadingLine('### src/utils/io.ts'), 'src/utils/io.ts');
  });
  it('识别加粗路径', () => {
    assert.equal(matchHeadingLine('**src/a.ts**'), 'src/a.ts');
  });
  it('识别"文件名："式指引', () => {
    assert.equal(matchHeadingLine('文件名：train_caption.py'), 'train_caption.py');
  });
  it('识别有序列表项里的路径', () => {
    assert.equal(matchHeadingLine('1. `src/a.ts`'), 'src/a.ts');
  });
  it('整句中文里的路径不当作标题式路径', () => {
    assert.equal(matchHeadingLine('下面是修改后的 src/a.ts 的完整内容，请替换'), null);
  });
  it('带标签 + 空格中文文件名（extractPathMentions 认不出时整体回退，用户实测 2026-10-04）', () => {
    assert.equal(matchHeadingLine('### 文件：BLIP 阅读笔记.md'), 'BLIP 阅读笔记.md');
    assert.equal(matchHeadingLine('文件： Mini-Omni 阅读笔记.md'), 'Mini-Omni 阅读笔记.md');
  });
  it('无标签的中文整句（即使以扩展名结尾）不回退', () => {
    assert.equal(matchHeadingLine('这是说明文档.md'), null);
  });
});

describe('parseModelReply —— 路径线索优先级', () => {
  it('中文空格文件名 + 范围行：采集注入的「文件：」标题能解析出路径（用户实测 2026-10-04）', () => {
    const reply = [
      '### 文件：BLIP 阅读笔记.md',
      '### 范围：113-113',
      '',
      '```markdown',
      '- **ITC（对比损失）**：把配图文本拉到表示空间相近。',
      '```',
    ].join('\n');
    const r = parseModelReply(reply);
    assert.equal(r.blocks.length, 1);
    assert.equal(r.blocks[0]?.filePath, 'BLIP 阅读笔记.md');
    assert.equal(r.blocks[0]?.pathSource, 'preceding-heading');
    assert.deepEqual(r.blocks[0]?.range, { start: 113, end: 113 });
  });

  it('(a) 围栏内首行路径注释优先，且该行被剥离出代码', () => {    const reply = ['```ts', '// src/a.ts', 'const a = 1;', '```'].join('\n');
    const r = parseModelReply(reply);
    assert.equal(r.blocks.length, 1);
    const b = r.blocks[0];
    assert.equal(b?.filePath, 'src/a.ts');
    assert.equal(b?.pathSource, 'fence-comment');
    assert.equal(b?.code, 'const a = 1;');
    assert.equal(b?.strippedPathLine, '// src/a.ts');
  });

  it('(b) 围栏上方标题提供路径（模型不写注释的常见形态）', () => {
    const reply = ['### src/b.ts', '', '```ts', 'export const b = 2;', '```'].join('\n');
    const r = parseModelReply(reply);
    assert.equal(r.blocks[0]?.filePath, 'src/b.ts');
    assert.equal(r.blocks[0]?.pathSource, 'preceding-heading');
    assert.equal(r.blocks[0]?.code, 'export const b = 2;');
  });

  it('(c) 全文唯一候选路径被采用', () => {
    const reply = ['请把 `src/c.ts` 改成：', '```ts', 'export const c = 3;', '```'].join('\n');
    const r = parseModelReply(reply);
    assert.equal(r.blocks[0]?.filePath, 'src/c.ts');
    assert.equal(r.blocks[0]?.pathSource, 'unique-mention');
  });

  it('(c) 全文有多个候选时**不猜**，交给预览', () => {
    const reply = ['涉及 `src/a.ts` 与 `src/b.ts`：', '```ts', 'export const x = 1;', '```'].join('\n');
    const r = parseModelReply(reply);
    assert.equal(r.blocks[0]?.filePath, null);
    assert.equal(r.blocks[0]?.pathSource, 'none');
    assert.equal(r.hasUnresolved, true);
  });

  it('(d) 无任何线索时**不猜测**：即使编辑器里打开了文件也不兜底（用户明确要求）', () => {
    const reply = ['```ts', 'const y = 1;', '```'].join('\n');
    const r = parseModelReply(reply);
    assert.equal(r.blocks[0]?.filePath, null);
    assert.equal(r.blocks[0]?.pathSource, 'none');
    assert.equal(r.hasUnresolved, true);
  });

  it('(c) 弱线索会给出"务必核对"的提示', () => {
    const reply = ['请把 `src/c.ts` 改成：', '```ts', 'export const c = 3;', '```'].join('\n');
    const r = parseModelReply(reply);
    assert.equal(r.blocks[0]?.pathSource, 'unique-mention');
    assert.ok(r.notes.some((n) => n.includes('务必核对')));
  });

  it('正文里提到多个路径时不自动匹配（防止误写到示例路径）', () => {
    const reply = [
      '这次改动涉及 `src/main/index.ts` 与 `src/shared/contract.ts`：',
      '```ts',
      'export const x = 1;',
      '```',
    ].join('\n');
    const r = parseModelReply(reply);
    assert.equal(r.mentionedPaths.length, 2);
    assert.equal(r.blocks[0]?.filePath, null, JSON.stringify(r.mentionedPaths));
  });

  it('正文只有一个示例路径时会采用，但必须给出"务必核对"提示', () => {
    const reply = [
      '例如写成 `### 文件：src/main/index.ts` 这样。下面是代码：',
      '```ts',
      'export const x = 1;',
      '```',
    ].join('\n');
    const r = parseModelReply(reply);
    assert.equal(r.blocks[0]?.filePath, 'src/main/index.ts');
    assert.equal(r.blocks[0]?.pathSource, 'unique-mention');
    assert.ok(r.notes.some((n) => n.includes('务必核对')));
  });

  it('多围栏各自就近匹配自己的标题', () => {
    const reply = [
      '### src/a.ts',
      '```ts',
      'export const a = 1;',
      '```',
      '',
      '### src/b.ts',
      '```ts',
      'export const b = 2;',
      '```',
    ].join('\n');
    const r = parseModelReply(reply);
    assert.equal(r.blocks.length, 2);
    assert.equal(r.blocks[0]?.filePath, 'src/a.ts');
    assert.equal(r.blocks[1]?.filePath, 'src/b.ts');
  });

  it('带行号的代码块（模型常见输出）也能解析', () => {
    const reply = ['```python', '# train_caption.py', '1  import os', '2  import json', '```'].join('\n');
    const r = parseModelReply(reply);
    assert.equal(r.blocks[0]?.filePath, 'train_caption.py');
    assert.ok(r.blocks[0]?.code.includes('import os'));
  });

  it('语言标注被归一化且不参与路径判断', () => {
    const reply = '```TypeScript {highlight}\nconst a = 1;\n```';
    const r = parseModelReply(reply);
    assert.equal(r.blocks[0]?.language, 'typescript');
  });

  it('无围栏时给出明确备注且不报错', () => {
    const r = parseModelReply('这段回复没有任何代码块。');
    assert.equal(r.blocks.length, 0);
    assert.ok(r.notes.some((n) => n.includes('未找到代码围栏')));
  });

  it('空输入不抛异常', () => {
    const r = parseModelReply('');
    assert.equal(r.blocks.length, 0);
  });
});

describe('computeApply', () => {
  const block = {
    code: 'NEW',
    language: 'ts',
    filePath: 'src/a.ts',
    pathSource: 'fence-comment' as const,
    range: null,
    start: 0,
    end: 0,
    strippedPathLine: null,
  };

  it('插入光标处时按需补换行', () => {
    const r = computeApply('line1\nline2', block, { kind: 'insert-at-cursor', cursorOffset: 6 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.mode, 'insert-at-cursor');
    assert.equal(r.text, 'line1\nNEW\nline2');
  });

  it('光标在行尾（非行首）时先补换行，使代码从新行开始', () => {
    const r = computeApply('abc', block, { kind: 'insert-at-cursor', cursorOffset: 3 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.text, 'abc\nNEW');
  });

  it('光标紧跟在换行之后时不补前导换行', () => {
    const r = computeApply('abc\n', block, { kind: 'insert-at-cursor', cursorOffset: 4 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.text, 'abc\nNEW');
  });

  it('替换字节区间并返回被替换内容（供撤销）', () => {
    const r = computeApply('AAA BBB CCC', block, { kind: 'replace-fence-region', start: 4, end: 7 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.text, 'AAA NEW CCC');
    assert.equal(r.replaced, 'BBB');
  });

  it('整文件替换时 replaced 为原文', () => {
    const r = computeApply('old content', block, { kind: 'replace-whole-file' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.text, 'NEW');
    assert.equal(r.replaced, 'old content');
  });

  it('越界的光标与区间被安全收敛', () => {
    const a = computeApply('abc', block, { kind: 'insert-at-cursor', cursorOffset: 999 });
    assert.equal(a.ok && a.text, 'abc\nNEW');
    const b = computeApply('abc', block, { kind: 'replace-fence-region', start: 99, end: 200 });
    assert.equal(b.ok && b.text, 'abcNEW');
  });
});

describe('行区间指令与片段替换（三向校验）', () => {
  const fileText = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
  const mkBlock = (code: string) => ({
    code,
    language: 'ts',
    filePath: 'src/a.ts',
    pathSource: 'preceding-heading' as const,
    range: { start: 2, end: 3 },
    start: 0,
    end: 0,
    strippedPathLine: null,
  });

  it('matchRangeDirective 识别多种写法', () => {
    assert.deepEqual(matchRangeDirective('### 范围：80-92'), { start: 80, end: 92 });
    assert.deepEqual(matchRangeDirective('### 行：7-9'), { start: 7, end: 9 });
    assert.deepEqual(matchRangeDirective('### lines: 7-9'), { start: 7, end: 9 });
    assert.deepEqual(matchRangeDirective('### 位置：替换第 12-14 行'), { start: 12, end: 14 });
    assert.deepEqual(matchRangeDirective('### 范围：80'), { start: 80, end: 80 });
    assert.deepEqual(matchRangeDirective('### 范围：92-80'), { start: 80, end: 92 });
    assert.equal(matchRangeDirective('### 文件：src/a.ts'), null);
    assert.equal(matchRangeDirective('这是一句普通说明'), null);
  });

  it('解析器从围栏上方的「范围」指令得到行区间', () => {
    const r = parseModelReply(['### 文件：src/a.ts', '### 范围：2-3', '```ts', 'NEW', '```'].join('\n'));
    assert.deepEqual(r.blocks[0]?.range, { start: 2, end: 3 });
    assert.ok(r.notes.some((n) => n.includes('三向校验')));
  });

  it('片段里若带行号前缀会被剥离', () => {
    const r = parseModelReply(['### 文件：src/a.ts', '### 范围：1-2', '```py', '  1| import os', '  2| import sys', '```'].join('\n'));
    assert.equal(r.blocks[0]?.code, 'import os\nimport sys');
  });

  it('三向校验全部通过时按行替换', () => {
    const r = computeApply(fileText, mkBlock('X2\nX3'), {
      kind: 'replace-lines',
      start: 2,
      end: 3,
      expectedOriginal: 'l2\nl3',
      contextPrev: 'l1',
      contextNext: 'l4',
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.text, ['l1', 'X2', 'X3', 'l4', 'l5'].join('\n'));
    assert.equal(r.replaced, 'l2\nl3');
  });

  it('原内容不匹配 → 拒绝（防行号漂移）', () => {
    const r = computeApply(fileText, mkBlock('X'), {
      kind: 'replace-lines',
      start: 2,
      end: 3,
      expectedOriginal: 'DIFFERENT',
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'content-mismatch');
    assert.match(r.detail, /不一致/);
  });

  it('区间越界 → 拒绝', () => {
    const r = computeApply(fileText, mkBlock('X'), { kind: 'replace-lines', start: 4, end: 99, expectedOriginal: 'l4\nl5' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'range-invalid');
  });

  it('上下文（区间上一行）不匹配 → 拒绝', () => {
    const r = computeApply(fileText, mkBlock('X'), {
      kind: 'replace-lines',
      start: 2,
      end: 3,
      expectedOriginal: 'l2\nl3',
      contextPrev: 'WRONG',
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'context-mismatch');
  });

  it('替换整文件末尾若干行时不产生多余换行', () => {
    const r = computeApply(fileText, mkBlock('Z4\nZ5'), {
      kind: 'replace-lines',
      start: 4,
      end: 5,
      expectedOriginal: 'l4\nl5',
      contextPrev: 'l3',
      contextNext: null,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.text, ['l1', 'l2', 'l3', 'Z4', 'Z5'].join('\n'));
  });

  it('新内容比原区间多 1 行：替换区间、后续行整体下移，起始行之前保持原样', () => {
    // 模拟实测场景：原文件 10 行，选中 2-10（9 行），模型返回 10 行新内容
    const orig = ['H1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10'].join('\n');
    const block = mkBlock('n1\nn2\nn3\nn4\nn5\nn6\nn7\nn8\nn9\nn10');
    const r = computeApply(orig, block, {
      kind: 'replace-lines',
      start: 2,
      end: 10,
      expectedOriginal: orig.split('\n').slice(1).join('\n'),
      contextPrev: 'H1',
      contextNext: null,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(
      r.text,
      ['H1', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10'].join('\n'),
      '第 1 行必须原样保留，其余为 10 行新内容（共 11 行）'
    );
  });

  it('新内容比原区间少：删除原区间剩余行，后续行整体上移', () => {
    // 原区间 2-4 共 3 行，新内容只有 1 行 → 原 l4 被删，l5 上移
    const r = computeApply(fileText, mkBlock('X2'), {
      kind: 'replace-lines',
      start: 2,
      end: 4,
      expectedOriginal: 'l2\nl3\nl4',
      contextPrev: 'l1',
      contextNext: 'l5',
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.text, ['l1', 'X2', 'l5'].join('\n'));
  });

  it('10-10 替换为十行：相同括号和空行也不能吞掉区间外原文', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `原第 ${i + 1} 行`);
    lines[10] = '}';
    lines[11] = '';
    const added = [...Array.from({ length: 7 }, (_, i) => `新增 ${i + 1}`), '}', '', '最后一行'];
    const block = parseModelReply([
      '### 文件：a.txt', '### 范围：10-10', '````', ...added, '````',
    ].join('\n')).blocks[0]!;
    const result = computeApply(lines.join('\n'), block, {
      kind: 'replace-lines', start: 10, end: 10,
      expectedOriginal: lines[9]!, contextPrev: lines[8], contextNext: lines[10],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const after = result.text.split('\n');
    assert.equal(after.length, 34);
    assert.deepEqual(after.slice(0, 9), lines.slice(0, 9));
    assert.deepEqual(after.slice(9, 19), added, '新内容应占第 10-19 行');
    assert.deepEqual(after.slice(19), lines.slice(10), '原第 11 行起须完整保留并后移 9 行');
    assert.equal(result.replaced, lines[9]);
  });

  it('缩短区间时新内容恰好等于下一行，也必须保留原下一行', () => {
    const result = computeApply(fileText, mkBlock('l5'), {
      kind: 'replace-lines', start: 2, end: 4,
      expectedOriginal: 'l2\nl3\nl4', contextPrev: 'l1', contextNext: 'l5',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, 'l1\nl5\nl5');
    assert.equal(result.replaced, 'l2\nl3\nl4');
  });
});

describe('带行号片段的格式化与还原', () => {
  it('formatNumberedSnippet 使用文件真实行号并右对齐', () => {
    assert.equal(formatNumberedSnippet('a\nb', 8), '  8| a\n  9| b');
    assert.equal(formatNumberedSnippet('a', 1234), '1234| a');
  });

  it('stripNumberedPrefix 还原纯文本与起始行号', () => {
    const s = stripNumberedPrefix('  8| a\n  9| b');
    assert.equal(s.text, 'a\nb');
    assert.equal(s.startLine, 8);
  });

  it('无行号前缀时原样返回，startLine 为 null', () => {
    const s = stripNumberedPrefix('a\nb');
    assert.equal(s.text, 'a\nb');
    assert.equal(s.startLine, null);
  });

  it('往返一致（格式化后还原）', () => {
    const original = 'def train():\n    pass';
    const round = stripNumberedPrefix(formatNumberedSnippet(original, 80));
    assert.equal(round.text, original);
    assert.equal(round.startLine, 80);
  });
});

describe('applySnippetRangeFallback（选区记忆兜底）', () => {
  const mkBlock = (filePath: string | null, range: { start: number; end: number } | null) => ({
    code: 'NEW',
    language: 'py',
    filePath,
    pathSource: 'none' as const,
    range,
    start: 0,
    end: 0,
    strippedPathLine: null,
  });

  it('模型未回显区间 + 路径与片段一致 → 回填区间（防整文件覆盖）', () => {
    const blocks = [mkBlock('Mini-AI-IDE-test.md', null)];
    const note = applySnippetRangeFallback(blocks, { relPath: 'Mini-AI-IDE-test.md', startLine: 2, endLine: 10 });
    assert.ok(note);
    assert.match(note, /2-10/);
    assert.deepEqual(blocks[0]?.range, { start: 2, end: 10 });
  });

  it('路径比较大小写不敏感（Windows 文件名语义）', () => {
    const blocks = [mkBlock('mini-ai-ide-test.md', null)];
    applySnippetRangeFallback(blocks, { relPath: 'Mini-AI-IDE-TEST.md', startLine: 2, endLine: 10 });
    assert.deepEqual(blocks[0]?.range, { start: 2, end: 10 });
  });

  it('模型已回显区间 → 不改动（显式指令优先于选区记忆）', () => {
    const blocks = [mkBlock('a.md', { start: 5, end: 6 })];
    const note = applySnippetRangeFallback(blocks, { relPath: 'a.md', startLine: 2, endLine: 10 });
    assert.equal(note, null);
    assert.deepEqual(blocks[0]?.range, { start: 5, end: 6 });
  });

  it('目标文件与片段不一致 → 不回填', () => {
    const blocks = [mkBlock('other.md', null)];
    const note = applySnippetRangeFallback(blocks, { relPath: 'a.md', startLine: 2, endLine: 10 });
    assert.equal(note, null);
    assert.equal(blocks[0]?.range, null);
  });

  it('路径未解析出（null）→ 不回填，宁可交预览人工确认', () => {
    const blocks = [mkBlock(null, null)];
    const note = applySnippetRangeFallback(blocks, { relPath: 'a.md', startLine: 2, endLine: 10 });
    assert.equal(note, null);
    assert.equal(blocks[0]?.range, null);
  });

  it('多个无区间同路径块 → 不猜，维持 null', () => {
    const blocks = [mkBlock('a.md', null), mkBlock('a.md', null)];
    const note = applySnippetRangeFallback(blocks, { relPath: 'a.md', startLine: 2, endLine: 10 });
    assert.equal(note, null);
    assert.equal(blocks[0]?.range, null);
    assert.equal(blocks[1]?.range, null);
  });

  it('无选区记忆（null）→ 不回填', () => {
    const blocks = [mkBlock('a.md', null)];
    const note = applySnippetRangeFallback(blocks, null);
    assert.equal(note, null);
    assert.equal(blocks[0]?.range, null);
  });
});
