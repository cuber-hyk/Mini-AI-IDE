/**
 * 提示词片段组装单测
 *
 * 重点覆盖用户提出的风险：**代码里含围栏时外层围栏必须变长**，
 * 否则内容会被提前闭合、模型只看到一半。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSnippetText, buildWholeFileText, fenceFor, languageHintFor, numberedBody } from '../src/shared/snippet';

describe('fenceFor', () => {
  it('无围栏内容用三个反引号', () => {
    assert.equal(fenceFor('const a = 1;'), '```');
  });

  it('内容含三反引号时用四个（不会提前闭合）', () => {
    assert.equal(fenceFor('```python\nprint(1)\n```'), '````');
  });

  it('内容含四反引号时用五个', () => {
    assert.equal(fenceFor('````\nx\n````'), '`````');
  });

  it('取内容中最长的一串，而不是第一串', () => {
    assert.equal(fenceFor('```\n`````\n```'), '``````');
  });

  it('内联单个反引号不影响（仍用三个）', () => {
    assert.equal(fenceFor('用 `foo` 调用'), '```');
  });

  it('两个反引号也不影响', () => {
    assert.equal(fenceFor('用 ``foo`` 调用'), '```');
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

describe('numberedBody', () => {
  it('行号右对齐并使用文件真实行号', () => {
    assert.equal(numberedBody('a\nb', 80), ' 80| a\n 81| b');
  });

  it('行号变宽时整体对齐', () => {
    assert.equal(numberedBody('a\nb', 999), ' 999| a\n1000| b');
  });

  it('空文本返回空串', () => {
    assert.equal(numberedBody('', 1), '');
  });
});

describe('buildSnippetText —— 局部修改片段', () => {
  it('包含路径行、行区间、围栏与带行号内容', () => {
    const r = buildSnippetText({ relPath: 'src/a.py', text: 'def f():\n    pass', startLine: 80 });
    assert.equal(r.startLine, 80);
    assert.equal(r.endLine, 81);
    assert.equal(r.fence, '```');
    assert.equal(
      r.text,
      ['### 文件：src/a.py', '### 范围：80-81', '```python', ' 80| def f():', ' 81|     pass', '```'].join('\n')
    );
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

describe('buildWholeFileText —— 整文件片段（上下文用途）', () => {
  it('包含“这个文件是”声明与带语言标注的围栏', () => {
    const r = buildWholeFileText('src/a.ts', 'export const a = 1;');
    assert.equal(
      r.text,
      ['这个文件是 src/a.ts', '', '```typescript', 'export const a = 1;', '```'].join('\n')
    );
    assert.equal(r.lineCount, 1);
  });

  it('完全不含“### ”标题行 —— 避免被回程解析器误认为“待应用的代码块”', () => {
    const r = buildWholeFileText('src/a.ts', 'const x = 1;\nconst y = 2;');
    assert.ok(!/^### /m.test(r.text), r.text);
    assert.ok(!/^### 文件：/m.test(r.text));
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
    assert.ok(r.text.endsWith('hello\n```'), JSON.stringify(r.text));
    assert.equal(r.lineCount, 1);
  });

  it('空文件也能生成合法片段', () => {
    const r = buildWholeFileText('empty.txt', '');
    assert.equal(r.lineCount, 0);
    assert.equal(r.text, ['这个文件是 empty.txt', '', '```', '', '```'].join('\n'));
  });
});
