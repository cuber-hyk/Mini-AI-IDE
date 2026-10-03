/**
 * 提示词片段组装单测
 *
 * 核心契约（用户确定）：**输入与输出结构完全对称** ——
 * 程序发出去的片段与提示词要求模型输出的形态逐字一致：
 *
 *   ### 文件：<相对路径>
 *   ### 范围：<起始行>-<结束行>
 *   ````<语言标注>
 *   <内容，不含行号>
 *   ````
 *
 * 两条不变量（改了就是 bug）：
 *  1. 围栏内容里**不得出现行号前缀**（行号只由 `### 范围` 表达）；
 *  2. 围栏**至少四个反引号**，内容含四个及以上时再加长。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSnippetText, buildWholeFileText, fenceFor, languageHintFor } from '../src/shared/snippet';

describe('fenceFor', () => {
  it('无围栏内容也用四个反引号（与提示词要求一致，不再用三个）', () => {
    assert.equal(fenceFor('const a = 1;'), '````');
  });

  it('内容含三反引号时仍用四个（不会提前闭合）', () => {
    assert.equal(fenceFor('```python\nprint(1)\n```'), '````');
  });

  it('内容含四反引号时加长到五个', () => {
    assert.equal(fenceFor('````\nx\n````'), '`````');
  });

  it('取内容中最长的一串，而不是第一串', () => {
    assert.equal(fenceFor('```\n`````\n```'), '``````');
  });

  it('内联单个反引号不影响（仍用四个）', () => {
    assert.equal(fenceFor('用 `foo` 调用'), '````');
  });

  it('两个反引号也不影响', () => {
    assert.equal(fenceFor('用 ``foo`` 调用'), '````');
  });
});

describe('languageHintFor', () => {
  it('常见扩展名映射正确', () => {
    assert.equal(languageHintFor('src/a.ts'), 'typescript');
    assert.equal(languageHintFor('train_caption.py'), 'python');
    assert.equal(languageHintFor('index.html'), 'html');
    assert.equal(languageHintFor('notes.md'), 'markdown');
    assert.equal(languageHintFor('schema.sql'), 'sql');
  });

  it('下划线文件名与多级路径都能识别', () => {
    assert.equal(languageHintFor('a/b/c/my_file.py'), 'python');
  });

  it('未知扩展名返回空串（不加标注）', () => {
    assert.equal(languageHintFor('data.zzz'), '');
    assert.equal(languageHintFor('noext'), '');
  });

  it('txt 不标注语言', () => {
    assert.equal(languageHintFor('a.txt'), '');
  });
});

describe('buildSnippetText —— 局部修改片段', () => {
  it('四部件骨架：### 文件 + ### 范围 + 四反引号围栏 + 无行号内容', () => {
    const r = buildSnippetText({ relPath: 'src/a.py', text: 'def f():\n    pass', startLine: 80 });
    assert.equal(r.startLine, 80);
    assert.equal(r.endLine, 81);
    assert.equal(r.fence, '````');
    assert.equal(
      r.text,
      ['### 文件：src/a.py', '### 范围：80-81', '````python', 'def f():', '    pass', '````'].join('\n')
    );
  });

  it('围栏内不得出现行号前缀（行号只由 ### 范围 表达）', () => {
    const r = buildSnippetText({ relPath: 'src/a.py', text: 'def f():\n    pass', startLine: 80 });
    assert.ok(!/^\s*\d+\|/m.test(r.text), '不应出现 ` 80| ` 形式的前缀：\n' + r.text);
  });

  it('内容与输入原文逐字一致（不加工、不补行号）', () => {
    const body = 'def f():\n    pass';
    const r = buildSnippetText({ relPath: 'src/a.py', text: body, startLine: 80 });
    const inner = r.text.split('\n').slice(3, -1).join('\n');
    assert.equal(inner, body);
  });

  it('内容含围栏时外层围栏自动变长（不会提前闭合）', () => {
    const content = '冒泡排序：\n```python\ndef bubble_sort(arr):\n    pass\n```';
    const r = buildSnippetText({ relPath: 'Mini-AI-IDE-test.md', text: content, startLine: 1 });
    assert.equal(r.fence, '````');
    // 外层四反引号，内层三反引号保持原样
    assert.ok(r.text.startsWith('### 文件：Mini-AI-IDE-test.md\n### 范围：1-5\n````markdown\n'));
    assert.ok(r.text.endsWith('\n````'));
    assert.ok(r.text.includes('```python'));
  });

  it('路径被 trim，行号小于 1 时收敛为 1', () => {
    const r = buildSnippetText({ relPath: '  src/a.ts  ', text: 'x', startLine: 0 });
    assert.equal(r.relPath, 'src/a.ts');
    assert.equal(r.startLine, 1);
    assert.equal(r.endLine, 1);
  });

  it('空文本时行区间为单行（不产生负区间）', () => {
    const r = buildSnippetText({ relPath: 'a.py', text: '', startLine: 5 });
    assert.equal(r.endLine, 5);
  });
});

describe('buildWholeFileText —— 整文件片段', () => {
  it('与局部片段同骨架：### 文件 + ### 范围：1-N + 围栏', () => {
    const r = buildWholeFileText('src/a.ts', 'export const a = 1;');
    assert.equal(
      r.text,
      ['### 文件：src/a.ts', '### 范围：1-1', '````typescript', 'export const a = 1;', '````'].join('\n')
    );
    assert.equal(r.lineCount, 1);
    assert.equal(r.startLine, 1);
    assert.equal(r.endLine, 1);
  });

  it('不再使用「这个文件是」头部（与提示词的 ### 文件 锚点统一）', () => {
    const r = buildWholeFileText('src/a.ts', 'const x = 1;');
    assert.ok(!r.text.includes('这个文件是'), r.text);
    assert.ok(r.text.startsWith('### 文件：src/a.ts\n### 范围：1-1\n'));
  });

  it('整体输出的范围是该文件完整行范围（1 到末行）', () => {
    const r = buildWholeFileText('src/a.ts', 'a\nb\nc');
    assert.equal(r.lineCount, 3);
    assert.ok(r.text.includes('### 范围：1-3'));
  });

  it('围栏内不含行号前缀', () => {
    const r = buildWholeFileText('src/a.ts', 'const x = 1;\nconst y = 2;');
    assert.ok(!/^\s*\d+\|/m.test(r.text), r.text);
  });

  it('含围栏的 markdown 文件自动加长外层围栏', () => {
    const content = '# 标题\n\n```python\nprint(1)\n```';
    const r = buildWholeFileText('notes.md', content);
    assert.equal(r.fence, '````');
    assert.ok(r.text.includes('````markdown'));
    assert.ok(r.text.includes('```python'));
  });

  it('去掉内容末尾多余空行，保持片段紧凑', () => {
    const r = buildWholeFileText('a.txt', 'hello\n\n\n');
    assert.ok(r.text.endsWith('hello\n````'), JSON.stringify(r.text));
    assert.equal(r.lineCount, 1);
  });

  it('空文件也能生成合法片段（范围收敛为 1-1）', () => {
    const r = buildWholeFileText('empty.txt', '');
    assert.equal(r.lineCount, 0);
    assert.equal(r.text, ['### 文件：empty.txt', '### 范围：1-1', '````', '', '````'].join('\n'));
  });
});

describe('输入输出对称性（不可回退）', () => {
  it('两种片段的骨架逐字同构，只差路径/范围/内容', () => {
    const local = buildSnippetText({ relPath: 'a.py', text: 'x', startLine: 1 }).text.split('\n');
    const whole = buildWholeFileText('a.py', 'x').text.split('\n');
    // 行数相同、结构位相同（路径行 / 范围行 / 开围栏 / 内容 / 闭围栏）
    assert.equal(local.length, whole.length);
    assert.equal(local.length, 5);
    assert.ok(local[0].startsWith('### 文件：'));
    assert.ok(whole[0].startsWith('### 文件：'));
    assert.ok(local[1].startsWith('### 范围：'));
    assert.ok(whole[1].startsWith('### 范围：'));
    assert.equal(local[2], whole[2]);
    assert.equal(local[4], whole[4]);
  });

  it('骨架正是解析器能识别的形态（### 文件 命中标题线索）', () => {
    const r = buildSnippetText({ relPath: 'src/a.ts', text: 'const a = 1;', startLine: 10 });
    assert.match(r.text, /^### 文件：src\/a\.ts$/m);
    assert.match(r.text, /^### 范围：10-10$/m);
  });
});
