/**
 * 逐行差异单测
 *
 * 覆盖：纯新增/纯删除/修改/未改动大段折叠、行号正确性、空文件、
 * 大文件退化路径、以及"主流编辑器式 hunk 上下文"。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffLines, diffTexts, splitLines, toHunks } from '../src/shared/diff';

describe('splitLines', () => {
  it('兼容 CRLF / CR / LF', () => {
    assert.deepEqual(splitLines('a\r\nb\nc\rd'), ['a', 'b', 'c', 'd']);
  });
  it('忽略末尾换行带来的空尾行', () => {
    assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  });
  it('空文本返回空数组', () => {
    assert.deepEqual(splitLines(''), []);
  });
});

describe('diffLines', () => {
  it('完全相同时全部为 context', () => {
    const lines = diffLines('a\nb', 'a\nb');
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.kind === 'context'));
  });

  it('单行修改产出 1 删 1 增，且行号正确', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc');
    const kinds = lines.map((l) => l.kind);
    assert.deepEqual(kinds, ['context', 'del', 'add', 'context']);
    const del = lines[1];
    const add = lines[2];
    assert.equal(del?.oldLine, 2);
    assert.equal(del?.newLine, null);
    assert.equal(add?.oldLine, null);
    assert.equal(add?.newLine, 2);
    assert.equal(del?.text, 'b');
    assert.equal(add?.text, 'B');
  });

  it('纯新增行', () => {
    const lines = diffLines('a\nc', 'a\nb\nc');
    assert.deepEqual(
      lines.map((l) => `${l.kind}:${l.text}`),
      ['context:a', 'add:b', 'context:c']
    );
  });

  it('纯删除行', () => {
    const lines = diffLines('a\nb\nc', 'a\nc');
    assert.deepEqual(
      lines.map((l) => `${l.kind}:${l.text}`),
      ['context:a', 'del:b', 'context:c']
    );
  });

  it('空原文 → 全部新增', () => {
    const lines = diffLines('', 'x\ny');
    assert.deepEqual(lines.map((l) => l.kind), ['add', 'add']);
  });

  it('新文为空 → 全部删除', () => {
    const lines = diffLines('x\ny', '');
    assert.deepEqual(lines.map((l) => l.kind), ['del', 'del']);
  });

  it('两侧都空 → 无差异', () => {
    assert.deepEqual(diffLines('', ''), []);
  });
});

describe('toHunks', () => {
  it('无改动时没有 hunk', () => {
    assert.deepEqual(toHunks(diffLines('a\nb', 'a\nb')), []);
  });

  it('未改动的大段被折叠（只保留上下文）', () => {
    const before = Array.from({ length: 50 }, (_v, i) => `line${i + 1}`).join('\n');
    const after = before.replace('line25', 'CHANGED');
    const result = diffTexts(before, after, 3);
    assert.equal(result.hunks.length, 1);
    const hunk = result.hunks[0];
    assert.ok(hunk, '应有 hunk');
    // 上下文 3 + 改动 2 行（1 删 1 增）
    assert.equal(hunk.lines.length, 3 + 2 + 3);
    assert.equal(hunk.added, 1);
    assert.equal(hunk.removed, 1);
    assert.equal(result.added, 1);
    assert.equal(result.removed, 1);
  });

  it('相距很远的改动拆成多个 hunk', () => {
    const before = Array.from({ length: 60 }, (_v, i) => `line${i + 1}`).join('\n');
    const after = before.replace('line5', 'A').replace('line50', 'B');
    const result = diffTexts(before, after, 2);
    assert.equal(result.hunks.length, 2);
  });

  it('相邻改动合并成一个 hunk', () => {
    const before = Array.from({ length: 30 }, (_v, i) => `line${i + 1}`).join('\n');
    const after = before.replace('line10', 'A').replace('line12', 'B');
    const result = diffTexts(before, after, 3);
    assert.equal(result.hunks.length, 1);
    assert.equal(result.hunks[0]?.added, 2);
    assert.equal(result.hunks[0]?.removed, 2);
  });

  it('hunk 的起始行号与缓冲区位置一致', () => {
    const before = Array.from({ length: 20 }, (_v, i) => `L${i + 1}`).join('\n');
    const after = before.replace('L10', 'X');
    const hunk = diffTexts(before, after, 2).hunks[0];
    assert.ok(hunk);
    assert.equal(hunk.oldStart, 8, '改动在第 10 行、上下文 2 行 → 从第 8 行开始');
    assert.equal(hunk.newStart, 8);
  });
});

describe('diffTexts', () => {
  it('统计新增与删除行数，并给出行数', () => {
    const result = diffTexts('a\nb\nc', 'a\nB\nc\nd');
    assert.equal(result.removed, 1);
    assert.equal(result.added, 2);
    assert.equal(result.oldLineCount, 3);
    assert.equal(result.newLineCount, 4);
    assert.equal(result.identical, false);
  });

  it('相同文本标记 identical', () => {
    const result = diffTexts('x', 'x');
    assert.equal(result.identical, true);
    assert.equal(result.hunks.length, 0);
  });

  it('行数极多时退化为全删全增（不卡死、且不丢内容）', () => {
    const big = Array.from({ length: 4200 }, (_v, i) => `l${i}`).join('\n');
    const result = diffTexts(big, big.replace('l0\n', 'X\n'));
    // 退化路径：全部删除 + 全部新增
    assert.ok(result.removed >= 4200, `应退化为全删，实际 removed=${result.removed}`);
    assert.ok(result.added >= 4200, `应退化为全增，实际 added=${result.added}`);
  });
});
