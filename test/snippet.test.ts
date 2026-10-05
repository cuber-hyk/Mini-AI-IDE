/** 上下文复制必须无损，不承载写入操作或 AI 定位行号。 */
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

describe('buildSnippetText 原文片段上下文', () => {
  it('明确只读上下文头，行数仅用于本地反馈', () => {
    const r = buildSnippetText({ relPath: 'src/a.py', text: 'def f():\n    pass', startLine: 80 });
    assert.equal(r.startLine, 80); assert.equal(r.endLine, 81);
    assert.equal(r.text, ['### 上下文文件：src/a.py', '### 上下文：原文片段', '````python', 'def f():', '    pass', '````'].join('\n'));
    assert.doesNotMatch(r.text, /### (?:文件|范围|操作)：|^\s*\d+\|/m);
  });
  it('缩进、空格、Tab、CRLF 和尾部空行逐字保留', () => {
    for (const body of ['\n\t  a  \r\n\r\n', 'hello\n\n\n', '   ', '\t', '']) {
      const r = buildSnippetText({ relPath: 'a.txt', text: body, startLine: 5 });
      assert.equal(r.text, ['### 上下文文件：a.txt', '### 上下文：原文片段', '````', body, '````'].join('\n'));
      assert.equal(r.endLine, 5 + Math.max(0, (body ? body.split(/\r\n|\r|\n/).length : 0) - 1));
    }
  });
  it('内嵌围栏不加工，外层自适应长度', () => {
    const body = '冒泡排序：\n````python\ndef bubble_sort(arr):\n    pass\n````\n';
    const r = buildSnippetText({ relPath: 'notes.md', text: body, startLine: 1 });
    assert.equal(r.fence, '`````'); assert.ok(r.text.includes(body));
  });
  it('路径 trim 与本地起始行下限保持既有 API', () => {
    const r = buildSnippetText({ relPath: '  a.ts  ', text: 'x', startLine: 0 });
    assert.equal(r.relPath, 'a.ts'); assert.equal(r.startLine, 1); assert.equal(r.endLine, 1);
  });
});
describe('buildWholeFileText 完整原文上下文', () => {
  it('完整上下文不暗示覆盖全文或写入操作', () => {
    const r = buildWholeFileText('a.ts', 'const a = 1;');
    assert.equal(r.text, ['### 上下文文件：a.ts', '### 上下文：完整原文', '````typescript', 'const a = 1;', '````'].join('\n'));
    assert.doesNotMatch(r.text, /### (?:文件|范围|操作)：/);
    assert.equal(r.lineCount, 1); assert.equal(r.startLine, 1); assert.equal(r.endLine, 1);
  });
  it('全文尾空行与空文件保持原样', () => {
    for (const body of ['hello\n\n\n', '\r\n\t  \r\n', '']) {
      const r = buildWholeFileText('a.txt', body);
      assert.equal(r.text, ['### 上下文文件：a.txt', '### 上下文：完整原文', '````', body, '````'].join('\n'));
      assert.equal(r.lineCount, body ? body.split(/\r\n|\r|\n/).length : 0);
      assert.equal(r.endLine, Math.max(1, r.lineCount));
    }
  });
  it('Markdown 原文里的围栏与协议标记作为正文保留', () => {
    const body = '# 示例\n### 操作：新建\n````text\n内容\n````\n';
    const r = buildWholeFileText('notes.md', body);
    assert.equal(r.fence, '`````'); assert.ok(r.text.includes(body));
  });
});
