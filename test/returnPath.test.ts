/** 明确操作协议：匹配与写入纯计算只采用可验证的原文。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeApply, extractPathMentions, getLineRange, matchHeadingLine,
  matchPathCommentLine, matchRangeDirective, normalizeRelPath, parseModelReply, splitFences,
  type ParsedCodeBlock, type TextEdit,
} from '../src/shared/returnPath';

function pair(oldText: string, newText: string): string {
  return `<<<<<<< SEARCH\n${oldText}\n=======\n${newText}\n>>>>>>> REPLACE`;
}
function reply(operation: string, body: string, path = 'src/a.ts', fence = '````'): string {
  return `### 文件：${path}\n\n### 操作：${operation}\n\n${fence}typescript\n${body}\n${fence}`;
}
function block(operation: string, body: string, path = 'src/a.ts'): ParsedCodeBlock {
  return parseModelReply(reply(operation, body, path)).blocks[0]!;
}
function apply(original: string, edits: TextEdit[]) {
  return computeApply(original, block('替换', edits.map((edit) => pair(edit.oldText, edit.newText)).join('\n\n')));
}

describe('路径入口', () => {
  it('相对路径标准化，保留绝对路径供白名单拒绝，上跳不是建议路径', () => {
    assert.equal(normalizeRelPath('./src\\a.ts'), 'src/a.ts');
    assert.equal(normalizeRelPath('../a.ts'), null);
    assert.equal(normalizeRelPath('C:\\test\\a.ts'), 'C:/test/a.ts');
    assert.equal(normalizeRelPath(''), null);
  });
  it('正文路径候选只供诊断并按Windows语义去重', () => {
    assert.deepEqual(extractPathMentions('src/a.ts SRC/A.ts src/b.prisma'), ['src/a.ts', 'src/b.prisma']);
    assert.deepEqual(extractPathMentions('普通正文'), []);
  });
  it('显式文件标签支持点文件、中文空格和无扩展名', () => {
    for (const file of ['backend/.env', 'BLIP 阅读笔记.md', 'Dockerfile', 'src/schema.prisma', 'my.custom-ext']) {
      assert.equal(matchHeadingLine(`### 文件：${file}`), file);
    }
    assert.equal(matchHeadingLine('### src/a.ts'), 'src/a.ts');
    assert.equal(matchHeadingLine('1. `src/a.ts`'), 'src/a.ts');
    assert.equal(matchHeadingLine('请修改 src/a.ts'), null);
    assert.equal(matchHeadingLine('### 请修改 src/a.ts'), null);
    assert.equal(matchHeadingLine('### 文件：a.ts、b.ts'), null);
  });
  it('独立路径注释入口识别单文件但不接受双目标', () => {
    for (const line of ['// src/a.ts', '# src/a.ts', '<!-- src/a.ts -->', '-- src/a.ts', '/* src/a.ts */']) {
      assert.equal(matchPathCommentLine(line), 'src/a.ts');
    }
    assert.equal(matchPathCommentLine('// BLIP 阅读笔记.md'), 'BLIP 阅读笔记.md');
    assert.equal(matchPathCommentLine('// src/my file.ts'), 'src/my file.ts');
    assert.equal(matchPathCommentLine('// src/a.ts src/b.ts'), null);
    assert.equal(matchPathCommentLine('# file:'), null);
  });
  it('旧范围入口只读取显示诊断，不影响原文定位', () => {
    assert.deepEqual(matchRangeDirective('### 范围：10-19'), { start: 10, end: 19 });
    assert.equal(matchRangeDirective('普通正文'), null);
    assert.deepEqual(getLineRange('a\r\nb\rc', 2, 3), ['b', 'c']);
  });
});

describe('完整围栏与无损正文', () => {
  it('四反引号围栏保留首尾空行、空格、Tab和文本偏移', () => {
    const source = reply('新建', '\n\t a  \n\n');
    const fences = splitFences(source);
    assert.equal(fences.length, 1);
    assert.equal(fences[0]?.closed, true);
    assert.equal(fences[0]?.fenceLength, 4);
    assert.equal(fences[0]?.body, '\n\t a  \n\n');
    assert.equal(source.slice(fences[0]!.bodyStart, fences[0]!.bodyStart + fences[0]!.body.length), fences[0]!.body);
  });
  it('空的新建或覆盖有实际完整围栏，正文是真正空字符串', () => {
    for (const operation of ['新建', '覆盖全文']) {
      const parsed = block(operation, '');
      assert.equal(parsed.code, '');
      assert.equal(parsed.validationError, undefined);
    }
  });
  it('Windows CRLF/CR 多块仍有清晰边界且不清理正文空白', () => {
    for (const eol of ['\r\n', '\r']) {
      const source = (reply('新建', 'A', 'a.ts') + '\n\n' + reply('新建', 'B', 'b.ts')).replace(/\n/g, eol);
      const parsed = parseModelReply(source);
      assert.equal(parsed.blocks.length, 2);
      assert.deepEqual(parsed.blocks.map((item) => item.filePath), ['a.ts', 'b.ts']);
      assert.deepEqual(parsed.blocks.map((item) => item.code), ['A', 'B']);
    }
  });
  it('嵌套较短围栏按内容保留，不成为第二个文件块', () => {
    const body = '# 文档\n```ts\nconst example = 1;\n```\n';
    const parsed = block('新建', body, 'docs/example.md',);
    assert.equal(parsed.code, body);
    assert.equal(parsed.validationError, undefined);
  });
  it('更长关闭围栏可以闭合，较短关闭不能闭合', () => {
    assert.equal(splitFences('````text\na\n`````')[0]?.closed, true);
    assert.equal(splitFences('`````text\na\n````')[0]?.closed, false);
  });
  it('残缺围栏保留可见正文并阻塞，不容忍为可写文本', () => {
    const parsed = parseModelReply('### 文件：a.ts\n### 操作：新建\n````ts\nconst a = 1;\n').blocks[0]!;
    assert.equal(parsed.code, 'const a = 1;\n');
    assert.match(parsed.validationError ?? '', /未闭合/);
    assert.equal(computeApply('', parsed).ok, false);
  });
  it('修改必须使用四反引号，普通只读示例可保留Markdown三围栏', () => {
    assert.match(block('新建', 'A', 'a.ts',).validationError ?? '', /^$/);
    const short = parseModelReply(reply('新建', 'A', 'a.ts', '```')).blocks[0]!;
    assert.match(short.validationError ?? '', /四个反引号/);
    const readonly = parseModelReply('```ts\nconst example = 1;\n```').blocks[0]!;
    assert.equal(readonly.kind, 'other');
  });
  it('缺少围栏不能被当成空文件，缺正文元数据也保持诊断', () => {
    for (const source of ['### 文件：a.ts\n### 操作：新建', '### 文件：a.ts\n### 操作：覆盖全文\ncontent']) {
      const parsed = parseModelReply(source);
      assert.equal(parsed.blocks.length, 1);
      assert.match(parsed.blocks[0]?.validationError ?? '', /缺少完整代码围栏/);
      assert.equal(parsed.hasUnresolved, true);
    }
    assert.equal(parseModelReply('普通说明').blocks.length, 0);
    assert.equal(parseModelReply('').blocks.length, 0);
  });
});

describe('明确操作和独立元数据', () => {
  it('三种操作有明确枚举，语言不推断操作', () => {
    assert.equal(block('替换', pair('old', 'new')).operation, 'replace');
    assert.equal(block('新建', 'text').operation, 'create');
    assert.equal(block('覆盖全文', 'text').operation, 'overwrite');
    assert.equal(block('新建', 'text').language, 'typescript');
  });
  it('新建和覆盖的SEARCH样本文字按字面写入，不再二次解释', () => {
    const body = '// src/another.ts\n' + pair('', 'literal marker') + '\n';
    for (const operation of ['新建', '覆盖全文']) {
      const parsed = block(operation, body);
      assert.equal(parsed.code, body);
      assert.equal(parsed.edits, undefined);
      assert.equal(parsed.strippedPathLine, null);
      const result = computeApply('before', parsed);
      assert.equal(result.ok && result.text, body);
    }
  });
  it('SEARCH/REPLACE正文首行路径注释是实际匹配文本，绝不剥除', () => {
    const oldText = '// src/another.ts\nconst value = 1;';
    const parsed = block('替换', pair(oldText, '// src/another.ts\nconst value = 2;'));
    assert.equal(parsed.edits?.[0]?.oldText, oldText);
    assert.equal(parsed.filePath, 'src/a.ts');
    assert.equal(parsed.strippedPathLine, null);
    assert.equal(computeApply(oldText, parsed).ok, true);
  });
  it('文件/操作标题之间的空行合法，正文形成元数据边界', () => {
    const parsed = block('新建', 'A');
    assert.equal(parsed.filePath, 'src/a.ts');
    const separated = parseModelReply('### 文件：a.ts\n说明是一个示例\n````ts\nA\n````').blocks[0]!;
    assert.equal(separated.filePath, null);
    assert.equal(separated.kind, undefined);
    assert.match(separated.validationError ?? '', /缺少完整代码围栏/);
    assert.equal(parseModelReply('### 文件：a.ts\n说明是一个示例\n````ts\nA\n````').blocks[1]?.kind, 'other');
  });
  it('缺操作、未知操作、缺文件路径不会自动推断', () => {
    for (const source of [
      '### 文件：a.ts\n````ts\nA\n````',
      reply('update', 'A'),
      reply('toString', 'A'),
      reply('__proto__', 'A'),
      '### 操作：新建\n````ts\nA\n````',
    ]) {
      const parsed = parseModelReply(source);
      assert.equal(parsed.hasUnresolved, true);
      assert.ok(parsed.blocks[0]?.validationError);
      assert.equal(parsed.blocks[0]?.kind, undefined);
      assert.equal(computeApply('', parsed.blocks[0]!).ok, false);
    }
  });
  it('文件/操作重复冲突阻塞本块，下个文件仍有独立合法操作', () => {
    const source = '### 文件：a.ts\n### 文件：b.ts\n### 操作：新建\n### 操作：覆盖全文\n````ts\nA\n````\n' + reply('新建', 'C', 'c.ts');
    const parsed = parseModelReply(source);
    assert.match(parsed.blocks[0]?.validationError ?? '', /路径相互冲突/);
    assert.match(parsed.blocks[0]?.validationError ?? '', /操作相互冲突/);
    assert.equal(parsed.blocks[1]?.filePath, 'c.ts');
    assert.equal(parsed.blocks[1]?.validationError, undefined);
  });
  it('相同文件大小写和相同操作重复不构造歧义', () => {
    const parsed = parseModelReply('### 文件：SRC/a.ts\n### 文件：src/A.ts\n### 操作：新建\n### 操作：新建\n````ts\nA\n````').blocks[0]!;
    assert.equal(parsed.filePath, 'SRC/a.ts');
    assert.equal(parsed.validationError, undefined);
  });
  it('旧范围不能与新协议混写，旧范围独自也不能落盘', () => {
    for (const source of [
      '### 文件：a.ts\n### 范围：10-10\n````ts\nA\n````',
      '### 文件：a.ts\n### 操作：替换\n### 范围：1-1\n````ts\n' + pair('A', 'B') + '\n````',
      '### 范围：1-x\n````bash\necho hello\n````',
    ]) {
      const parsed = parseModelReply(source).blocks[0]!;
      assert.equal(parsed.range, null);
      assert.match(parsed.validationError ?? '', /旧行号/);
      assert.equal(parsed.kind, undefined);
      assert.equal(computeApply('A', parsed).ok, false);
    }
  });
  it('正文路径唯一提及和上个块的文件都不能补足下个块', () => {
    const source = reply('新建', 'A') + '\n请把 `src/a.ts` 修改：\n````ts\n' + pair('A', 'B') + '\n````';
    const parsed = parseModelReply(source);
    assert.equal(parsed.blocks[1]?.filePath, null);
    assert.match(parsed.blocks[1]?.validationError ?? '', /缺少明确文件/);
    assert.equal(parsed.blocks[1]?.kind, undefined);
  });
  it('旧首行路径注释只有诊断含义，不再提供新协议写入能力', () => {
    for (const line of ['// a.ts', '// a.ts b.ts', '# file:']) {
      const parsed = parseModelReply('````ts\n' + line + '\nA\n````').blocks[0]!;
      assert.ok(parsed.validationError);
      assert.equal(parsed.kind, undefined);
      assert.equal(parsed.code, line + '\nA');
    }
  });
});

describe('只读上下文与附属内容', () => {
  it('上下文头部允许原文含协议示例，仍只读且不解释为修改', () => {
    const source = '### 上下文文件：src/a.ts\n### 上下文：完整原文\n````ts\n' + pair('A', 'B') + '\n````';
    const parsed = parseModelReply(source);
    assert.equal(parsed.blocks[0]?.kind, 'other');
    assert.equal(parsed.hasUnresolved, false);
    assert.equal(parsed.blocks[0]?.edits, undefined);
    assert.equal(computeApply('', parsed.blocks[0]!).ok, false);
  });
  it('上下文与操作混用明确阻塞，不能被只读归类隐藏', () => {
    const parsed = parseModelReply('### 上下文文件：a.ts\n### 文件：a.ts\n### 操作：新建\n````ts\nA\n````').blocks[0]!;
    assert.equal(parsed.kind, undefined);
    assert.match(parsed.validationError ?? '', /不能混用/);
  });
  it('无修改线索的命令/流程图/ASCII/代码示例和无语言内容只读', () => {
    for (const language of ['bash', 'mermaid', 'text', 'ts', '']) {
      const parsed = parseModelReply(`\`\`\`\`${language}\nplain text\n\`\`\`\``);
      assert.equal(parsed.blocks[0]?.kind, 'other');
      assert.equal(parsed.hasUnresolved, false);
    }
  });
  it('无路径但有SEARCH标记属于待补充修改，不是普通只读内容', () => {
    const parsed = parseModelReply('````text\n' + pair('A', 'B') + '\n````');
    assert.equal(parsed.blocks[0]?.kind, undefined);
    assert.equal(parsed.hasUnresolved, true);
    assert.match(parsed.blocks[0]?.validationError ?? '', /缺少明确文件/);
  });
});

describe('SEARCH/REPLACE结构', () => {
  it('单个与多个替换对保留原文和新文中的首尾空白', () => {
    const parsed = block('替换', pair('\n\t old  \n', '\n\t new  \n\n') + '\n\n' + pair('tail', 'end'));
    assert.deepEqual(parsed.edits, [
      { oldText: '\n\t old  \n', newText: '\n\t new  \n\n' },
      { oldText: 'tail', newText: 'end' },
    ]);
    assert.equal(parsed.validationError, undefined);
  });
  it('空SEARCH拒绝，空REPLACE用于删除', () => {
    assert.match(block('替换', pair('', 'A')).validationError ?? '', /不能为空/);
    assert.deepEqual(block('替换', pair('A', '')).edits, [{ oldText: 'A', newText: '' }]);
  });
  it('残缺对、结构外文本及标记行冲突拒绝，不猜分隔位置', () => {
    for (const body of [
      '<<<<<<< SEARCH\nA\n=======\nB',
      'A', pair('A', 'B') + '\nextra',
      pair('A\n<<<<<<< SEARCH\nC', 'B'),
      pair('A\n=======\nC', 'B'),
      pair('A', 'B\n>>>>>>> REPLACE\nC'),
      '<<<<<<< SEARCH\nA\n>>>>>>> REPLACE',
    ]) assert.ok(block('替换', body).validationError, body);
  });
  it('1|等行号文本按字面保留，不能清理为可匹配的其他代码', () => {
    const parsed = block('替换', pair('  1| old  ', '  1| new  '));
    assert.equal(parsed.edits?.[0]?.oldText, '  1| old  ');
    assert.equal(computeApply('old', parsed).ok, false);
    assert.equal(computeApply('  1| old  ', parsed).ok, true);
  });
});

describe('唯一精确匹配与原子计算', () => {
  it('行内删除与包含末尾换行的替换按真实换行数报告增量', () => {
    const inline = apply('foo old bar', [{ oldText: 'old', newText: '' }]);
    assert.equal(inline.ok, true); if (!inline.ok) return;
    assert.equal(inline.text, 'foo  bar'); assert.equal(inline.locations[0]!.lineDelta, 0);
    assert.equal(inline.locations[0]!.newRange, null);
    const join = apply('foo\r\nbar', [{ oldText: 'foo\n', newText: 'NEW' }]);
    assert.equal(join.ok, true); if (!join.ok) return;
    assert.equal(join.text, 'NEWbar'); assert.equal(join.locations[0]!.lineDelta, -1);
    assert.deepEqual(join.locations[0]!.oldRange, { start: 1, end: 1 });
    assert.deepEqual(join.locations[0]!.newRange, { start: 1, end: 1 });
  });
  it('行内替换不补换行，区间外文本完整保留', () => {
    const result = apply('before old after', [{ oldText: 'old', newText: 'NEW' }]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, 'before NEW after');
    assert.equal(result.mode, 'replace');
    assert.equal(result.replaced, 'old');
    assert.deepEqual(result.locations, [{ start: 7, end: 10, oldRange: { start: 1, end: 1 }, newRange: { start: 1, end: 1 }, lineDelta: 0 }]);
  });
  it('10行位置替换为十行新内容，后续原文只按结果偏移', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `原第 ${i + 1} 行`);
    const added = Array.from({ length: 10 }, (_, i) => `新第 ${i + 1} 行`).join('\n');
    const result = apply(lines.join('\n'), [{ oldText: lines[9]!, newText: added }]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.text.split('\n').slice(19), lines.slice(10));
    assert.deepEqual(result.locations[0]?.oldRange, { start: 10, end: 10 });
    assert.deepEqual(result.locations[0]?.newRange, { start: 10, end: 19 });
  });
  it('没有匹配和重复匹配均拒绝，包含重叠出现的重复也不能默选', () => {
    const no = apply('old', [{ oldText: 'OLD', newText: 'new' }]);
    assert.equal(!no.ok && no.reason, 'search-not-found');
    const repeated = apply('old old', [{ oldText: 'old', newText: 'new' }]);
    assert.equal(!repeated.ok && repeated.reason, 'search-ambiguous');
    const overlapping = apply('aaa', [{ oldText: 'aa', newText: 'b' }]);
    assert.equal(!overlapping.ok && overlapping.reason, 'search-ambiguous');
  });
  it('缩进、Tab和尾部空格必须精确，不因空白清理获得错误匹配', () => {
    for (const search of ['old', ' old', '  old', '\told']) {
      const result = apply('  old  ', [{ oldText: search, newText: 'new' }]);
      // 子串本来精确存在时允许；多/少空白不能被“扩大”替换范围。
      if (search !== '\told') {
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.replaced, search);
      } else assert.equal(!result.ok && result.reason, 'search-not-found');
    }
    assert.equal(apply('old', [{ oldText: 'old ', newText: 'new' }]).ok, false);
  });
  it('多对先在原基线定位，不让前对的新内容成为后对SEARCH', () => {
    const result = apply('old tail', [{ oldText: 'old', newText: 'brandnew' }, { oldText: 'brandnew', newText: 'BAD' }]);
    assert.equal(!result.ok && result.reason, 'search-not-found');
  });
  it('多对按原文位置计算，返回位置仍与输入对顺序一致', () => {
    const result = apply('first\nsecond\nthird', [
      { oldText: 'third', newText: 'T' }, { oldText: 'first', newText: 'F\nF2' },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, 'F\nF2\nsecond\nT');
    assert.deepEqual(result.locations[0]?.oldRange, { start: 3, end: 3 });
    assert.deepEqual(result.locations[0]?.newRange, { start: 4, end: 4 });
    assert.deepEqual(result.locations[1]?.newRange, { start: 1, end: 2 });
  });
  it('重叠SEARCH拒绝整块，相邻SEARCH不重叠', () => {
    const overlap = apply('abcdef', [{ oldText: 'abc', newText: 'X' }, { oldText: 'cde', newText: 'Y' }]);
    assert.equal(!overlap.ok && overlap.reason, 'overlap');
    const adjacent = apply('abcdef', [{ oldText: 'abc', newText: 'X' }, { oldText: 'def', newText: 'Y' }]);
    assert.equal(adjacent.ok && adjacent.text, 'XY');
  });
  it('插入保留真实上下文，删除可删除全部或最后一行且不留额外换行', () => {
    const inserted = apply('head\ntail', [{ oldText: 'head', newText: 'head\ninserted' }]);
    assert.equal(inserted.ok && inserted.text, 'head\ninserted\ntail');
    const all = apply('all', [{ oldText: 'all', newText: '' }]);
    assert.equal(all.ok && all.text, '');
    if (all.ok) assert.equal(all.locations[0]?.newRange, null);
    assert.equal(apply('head\ntail', [{ oldText: '\ntail', newText: '' }]).ok, true);
    const last = apply('head\ntail', [{ oldText: '\ntail', newText: '' }]);
    assert.equal(last.ok && last.text, 'head');
  });
  it('无末尾换行、首尾空白与Unicode逐字保留', () => {
    const result = apply('\n\t你好😀  \nend ', [{ oldText: '你好😀', newText: '世界🌍' }]);
    assert.equal(result.ok && result.text, '\n\t世界🌍  \nend ');
  });
  it('新文代码围栏作为普通字符计算，不二次解析', () => {
    const parsed = parseModelReply(reply('替换', pair('old', '```ts\nconst value = 1;\n```'), 'a.md', '`````')).blocks[0]!;
    const result = computeApply('old', parsed);
    assert.equal(result.ok && result.text, '```ts\nconst value = 1;\n```');
  });
  it('手工构造的空SEARCH也由计算入口拒绝', () => {
    const parsed = block('替换', pair('A', 'B'));
    parsed.edits = [{ oldText: '', newText: 'B' }];
    const result = computeApply('A', parsed);
    assert.equal(!result.ok && result.reason, 'empty-search');
  });
});

describe('换行映射与全文操作', () => {
  it('LF原文可匹配CRLF SEARCH，新增换行继承原文件风格', () => {
    const result = apply('head\nold\ntail', [{ oldText: 'old\r\ntail', newText: 'NEW\r\nTAIL' }]);
    assert.equal(result.ok && result.text, 'head\nNEW\nTAIL');
  });
  it('CRLF文件返回原字符偏移，并正确显示以换行结尾的原区域', () => {
    const result = apply('head\r\nold\r\ntail', [{ oldText: 'old\n', newText: 'NEW\nEXTRA\n' }]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, 'head\r\nNEW\r\nEXTRA\r\ntail');
    assert.deepEqual(result.locations[0], { start: 6, end: 11, oldRange: { start: 2, end: 2 }, newRange: { start: 2, end: 3 }, lineDelta: 1 });
    assert.equal(result.replaced, 'old\r\n');
  });
  it('CR文件与混合换行仅规范匹配，区间外原字符保持不变', () => {
    const cr = apply('head\rold\rtail', [{ oldText: 'old\ntail', newText: 'NEW\nTAIL' }]);
    assert.equal(cr.ok && cr.text, 'head\rNEW\rTAIL');
    const mixed = apply('head\r\nold\rtail\nend', [{ oldText: 'old', newText: 'NEW\nMORE' }]);
    assert.equal(mixed.ok && mixed.text, 'head\r\nNEW\r\nMORE\rtail\nend');
  });
  it('新建按全文字面计算，覆盖全文继承原文件换行，空覆盖结果为空', () => {
    const create = computeApply('', block('新建', '\n a  \r\n\t\n'));
    assert.equal(create.ok && create.text, '\n a  \r\n\t\n');
    if (create.ok) assert.equal(create.locations[0]?.oldRange, null);
    const overwrite = computeApply('before\r\nend', block('覆盖全文', '\nnew\n'));
    assert.equal(overwrite.ok && overwrite.text, '\r\nnew\r\n');
    const empty = computeApply('before', block('覆盖全文', ''));
    assert.equal(empty.ok && empty.text, '');
    if (empty.ok) assert.equal(empty.locations[0]?.newRange, null);
  });
  it('只读、缺操作、旧range和解析失败的对象不能绕过计算入口', () => {
    const valid = block('新建', 'A');
    for (const unsafe of [
      { ...valid, kind: 'other' as const }, { ...valid, operation: undefined },
      { ...valid, range: { start: 1, end: 1 } }, { ...valid, validationError: 'invalid' },
      { ...valid, filePath: null },
    ]) assert.equal(computeApply('before', unsafe).ok, false);
  });
});

describe('元数据及非法标记不被只读归类隐藏', () => {
  it('同回复中漏围栏文件单独显示错误，后续合法文件可正常处理', () => {
    const source = '### 文件：missing.ts\n### 操作：新建\n缺少代码框\n\n' + reply('新建', 'C', 'c.ts');
    const parsed = parseModelReply(source);
    assert.equal(parsed.blocks.length, 2);
    assert.match(parsed.blocks[0]?.validationError ?? '', /缺少完整代码围栏/);
    assert.equal(parsed.blocks[1]?.filePath, 'c.ts');
    assert.equal(parsed.blocks[1]?.validationError, undefined);
  });
  it('旧的裸文件标题仅作路径诊断，不自动兼容新协议写入', () => {
    const parsed = parseModelReply('### a.ts\n### 操作：新建\n````ts\nA\n````').blocks[0]!;
    assert.equal(parsed.filePath, 'a.ts');
    assert.match(parsed.validationError ?? '', /显式声明/);
    assert.equal(computeApply('', parsed).ok, false);
  });
  it('无标题但有非法SEARCH标记的块仍需补充新协议', () => {
    for (const content of [' <<<<<<< SEARCH\nA', '<<<<<<<< SEARCH\nA', '========\nA', '>>>>>>>  REPLACE']) {
      const parsed = parseModelReply('````text\n' + content + '\n````').blocks[0]!;
      assert.equal(parsed.kind, undefined);
      assert.ok(parsed.validationError);
    }
  });
});
