/**
 * 回程解析器单测
 *
 * 重点：**高容忍**。测试用例刻意模仿模型不按约定回复的真实形态
 * （路径写在注释里 / 写在标题里 / 只在正文提一次 / 完全不提）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeApply,
  extractPathMentions,
  matchHeadingLine,
  matchPathCommentLine,
  normalizeRelPath,
  parseModelReply,
  splitFences,
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

  it('未闭合的围栏不被当作代码块', () => {
    assert.deepEqual(splitFences('```ts\nconst a = 1;'), []);
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
});

describe('parseModelReply —— 路径线索优先级', () => {
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

  it('(d) 无任何线索时用"当前打开的文件"兜底并给出提示', () => {
    const reply = ['```ts', 'const y = 1;', '```'].join('\n');
    const r = parseModelReply(reply, { currentFile: 'src/current.ts' });
    assert.equal(r.blocks[0]?.filePath, 'src/current.ts');
    assert.equal(r.blocks[0]?.pathSource, 'current-file');
    assert.ok(r.notes.some((n) => n.includes('当前打开的文件')));
  });

  it('无任何线索且无当前文件时保持 unresolved，不猜测', () => {
    const reply = ['```ts', 'const z = 1;', '```'].join('\n');
    const r = parseModelReply(reply);
    assert.equal(r.blocks[0]?.filePath, null);
    assert.equal(r.hasUnresolved, true);
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
    start: 0,
    end: 0,
    strippedPathLine: null,
  };

  it('插入光标处时按需补换行', () => {
    const r = computeApply('line1\nline2', block, { kind: 'insert-at-cursor', cursorOffset: 6 });
    assert.equal(r.mode, 'insert-at-cursor');
    assert.equal(r.text, 'line1\nNEW\nline2');
  });

  it('光标在行尾（非行首）时先补换行，使代码从新行开始', () => {
    const r = computeApply('abc', block, { kind: 'insert-at-cursor', cursorOffset: 3 });
    assert.equal(r.text, 'abc\nNEW');
  });

  it('光标紧跟在换行之后时不补前导换行', () => {
    const r = computeApply('abc\n', block, { kind: 'insert-at-cursor', cursorOffset: 4 });
    assert.equal(r.text, 'abc\nNEW');
  });

  it('替换围栏区间并返回被替换内容（供撤销）', () => {
    const r = computeApply('AAA BBB CCC', block, { kind: 'replace-fence-region', start: 4, end: 7 });
    assert.equal(r.text, 'AAA NEW CCC');
    assert.equal(r.replaced, 'BBB');
  });

  it('整文件替换时 replaced 为原文', () => {
    const r = computeApply('old content', block, { kind: 'replace-whole-file' });
    assert.equal(r.text, 'NEW');
    assert.equal(r.replaced, 'old content');
  });

  it('越界的光标与区间被安全收敛', () => {
    assert.equal(computeApply('abc', block, { kind: 'insert-at-cursor', cursorOffset: 999 }).text, 'abc\nNEW');
    assert.equal(computeApply('abc', block, { kind: 'replace-fence-region', start: 99, end: 200 }).text, 'abcNEW');
  });
});
