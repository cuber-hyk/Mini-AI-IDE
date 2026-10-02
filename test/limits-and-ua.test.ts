/**
 * 大小上限 / 分片 / 文本判定 / UA 规则的单测
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkSize, computeTextMeta, isProbablyTextFile, sliceLines } from '../src/shared/limits';
import { checkUaConsistency, stripSelfDeclarations } from '../src/shared/userAgent';

describe('computeTextMeta', () => {
  it('统计字符数与行数（含末尾换行）', () => {
    const meta = computeTextMeta('a\nb\n', 4);
    assert.equal(meta.charCount, 4);
    // "a\nb\n" 按换行切分为 ['a','b',''] -> 3 行
    assert.equal(meta.lineCount, 3);
  });

  it('空文本为 0 行', () => {
    assert.equal(computeTextMeta('', 0).lineCount, 0);
  });

  it('CRLF 与 CR 都算换行', () => {
    assert.equal(computeTextMeta('a\r\nb\rc', 6).lineCount, 3);
  });
});

describe('checkSize', () => {
  it('上限内返回 ok', () => {
    const v = checkSize('abc', 3, 10);
    assert.equal(v.status, 'ok');
  });

  it('超限返回 too-large 且带上限值', () => {
    const v = checkSize('abcdef', 6, 3);
    assert.equal(v.status, 'too-large');
    if (v.status !== 'too-large') return;
    assert.equal(v.limit, 3);
    assert.equal(v.meta.charCount, 6);
  });
});

describe('sliceLines', () => {
  const text = 'l1\nl2\nl3\nl4';

  it('取闭区间行', () => {
    const s = sliceLines(text, 2, 3);
    assert.equal(s.text, 'l2\nl3');
    assert.equal(s.startLine, 2);
    assert.equal(s.endLine, 3);
    assert.equal(s.totalLines, 4);
  });

  it('越界自动收敛', () => {
    const s = sliceLines(text, 3, 99);
    assert.equal(s.endLine, 4);
    assert.equal(s.text, 'l3\nl4');
  });

  it('反向区间收敛为单行', () => {
    const s = sliceLines(text, 3, 1);
    assert.equal(s.startLine, 3);
    assert.equal(s.endLine, 3);
  });

  it('空文本返回 0 行', () => {
    const s = sliceLines('', 1, 5);
    assert.equal(s.totalLines, 0);
    assert.equal(s.text, '');
  });
});

describe('isProbablyTextFile', () => {
  it('识别常见源代码与文本扩展名', () => {
    for (const f of ['a.ts', 'B.PY', 'notes.md', 'data.json', 'x.yaml', 'run.ps1']) {
      assert.equal(isProbablyTextFile(f), true, f);
    }
  });

  it('对二进制扩展名返回 false', () => {
    for (const f of ['a.exe', 'b.dll', 'c.png', 'd.zip', 'e.pdf']) {
      assert.equal(isProbablyTextFile(f), false, f);
    }
  });
});

describe('stripSelfDeclarations（ADR-0001 UA 规则）', () => {
  const raw =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) mini-ai-ide/0.1.0 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36';

  it('移除 Electron 与应用名标记', () => {
    const plan = stripSelfDeclarations(raw, 'mini-ai-ide');
    assert.equal(/Electron\//i.test(plan.effective), false);
    assert.equal(/mini-ai-ide\//i.test(plan.effective), false);
    assert.deepEqual(plan.removed.sort(), ['Electron/44.5.1', 'mini-ai-ide/0.1.0'].sort());
  });

  it('保留真实内核版本与平台段', () => {
    const plan = stripSelfDeclarations(raw, 'mini-ai-ide');
    assert.match(plan.effective, /Chrome\/152\.0\.7977\.130/);
    assert.match(plan.effective, /Windows NT 10\.0; Win64; x64/);
    assert.match(plan.effective, /Safari\/537\.36/);
  });

  it('不产生连续空格', () => {
    const plan = stripSelfDeclarations(raw, 'mini-ai-ide');
    assert.equal(/\s{2,}/.test(plan.effective), false);
  });

  it('对不含标记的 UA 保持不变', () => {
    const plain = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
    const plan = stripSelfDeclarations(plain, 'mini-ai-ide');
    assert.equal(plan.effective, plain);
    assert.equal(plan.removed.length, 0);
  });
});

describe('checkUaConsistency', () => {
  it('主版本一致时通过', () => {
    const r = checkUaConsistency('... Chrome/152.0.7977.130 Safari/537.36', '152.0.7977.130');
    assert.equal(r.ok, true);
    assert.equal(r.uaMajor, '152');
    assert.equal(r.kernelMajor, '152');
  });

  it('主版本不一致时不通过', () => {
    const r = checkUaConsistency('... Chrome/141.0.0.0 Safari/537.36', '152.0.7977.130');
    assert.equal(r.ok, false);
  });

  it('UA 无 Chrome 段时不通过', () => {
    const r = checkUaConsistency('Mozilla/5.0 (compatible)', '152.0.7977.130');
    assert.equal(r.ok, false);
    assert.equal(r.uaMajor, null);
  });
});
