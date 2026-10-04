/**
 * 格式要求模板的不变量测试（纯逻辑）。
 *
 * 演进历史（两次真实缺陷）：
 *
 *  ① **裸围栏带偏模型输出**：模板是"给模型看的自然语言"。早期在说明文字里
 *     直接写出孤立的三反引号，例如：
 *        8. 代码块的语言标注跟文件类型走：.py 用 ```python、.ts 用 ```typescript
 *     模型把 ` ```python ` 读成**代码块的开头**，而这段说明后面没有配对闭合，
 *     于是模型输出的代码块**有开头没结尾**（用户实测："第一次输出没有 ``` 结尾"）。
 *     → 修法：改用「三反引号 + python」这类文字描述。当时的不变量是"零反引号"。
 *
 *  ② **规则冲突无仲裁**：用户让 AI 改 .md 文件里的代码块（选区**连围栏行一起选**），
 *     模板同时给出"语言跟文件类型走（.md→markdown）"与"含反引号就用四反引号"，
 *     两条并列、没有优先级 → 模型只能折中、两头不讨好。
 *     → 修法（用户拍板的原则）：**输入片段长什么样，输出就照抄同样结构** ——
 *       不要求模型去"推理文件类型/含不含围栏行"，只要求它照抄输入的语言标注与围栏行，
 *       围栏长度按内容里最长反引号 + 1 自适应。规则更少、模型更不易错。
 *       同时用**五反引号包住示例**让正例直观。
 *
 *  ③ **输入与输出结构不一致**：程序发出去的片段用一种头部（局部片段带行号、
 *     整文件片段用「这个文件是 …」），提示词要求的输出又是另一套 → 模型要在两套
 *     格式间切换，且对 .md/.txt 纯文本，围栏内的行号会被当正文写回文件。
 *     → 修法（用户拍板，方案甲）：**输入输出共用同一条骨架**，
 *       行号只由 `### 范围` 表达、内容里绝不写行号；围栏最少四个反引号。
 *
 * 因此现在的不变量不再是"零反引号"（示例必须能写出围栏才直观），而是：
 *   **模板里出现的每一段反引号都必须与同长度的另一段配对** —— 绝不留一个
 *   没人闭合的 opener 去带偏模型。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeApply, parseModelReply } from '../src/shared/returnPath';

import {
  FORMAT_SPEC_FULL,
  FORMAT_SPEC_SHORT,
  MAX_CUSTOM_FORMAT_SPEC_LENGTH,
  getFormatSpec,
  normalizeVariant,
  resolveFormatSpec,
} from '../src/shared/formatSpec';

/** 三个及以上连续反引号 */
const FENCE_RUN = /`{3,}/g;

/**
 * 找出"未成对"的围栏长度：把 `{3,}` 按长度分组，条数为奇数即存在未闭合的围栏。
 * 例：五反引号开 + 五反引号闭 → 该长度 2 条（偶数）→ 平衡。
 */
function unbalancedFences(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of text.match(FENCE_RUN) || []) {
    counts[String(m.length)] = (counts[String(m.length)] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n % 2 !== 0));
}

test('格式模板：每段围栏都成对（不存在没人闭合的 opener）', () => {
  for (const [name, text] of [
    ['short', FORMAT_SPEC_SHORT],
    ['full', FORMAT_SPEC_FULL],
  ] as const) {
    const bad = unbalancedFences(text);
    assert.deepEqual(bad, {}, `${name} 版存在未闭合围栏：${JSON.stringify(bad)}`);
  }
});

test('格式模板：核心原则是「输入输出同构、照抄骨架」', () => {
  const all = FORMAT_SPEC_SHORT + FORMAT_SPEC_FULL;
  // 结构对称是用户拍板的最终原则：模型只需学一套骨架
  assert.match(all, /完全一致|同一条|照着它把结果写回来/, '缺"输入输出同构"这一核心原则');
  assert.match(all, /语言标注/, '缺语言标注的说明');
  assert.match(all, /原样保留/, '缺"内层围栏原样保留"的说明');
});

test('格式模板：明确要求围栏成对闭合', () => {
  const all = FORMAT_SPEC_SHORT + FORMAT_SPEC_FULL;
  assert.match(all, /成对|闭合/, '模板没有说明围栏必须闭合');
  assert.match(all, /同样长度|同长度|同样四个|同样.{0,4}反引号/, '模板没有说明结尾围栏与开头等长');
});

test('格式模板：围栏规则为「至少四个」且内容含更多反引号时加长', () => {
  const all = FORMAT_SPEC_SHORT + FORMAT_SPEC_FULL;
  assert.match(all, /四个反引号/, '未说明用四个反引号');
  assert.match(all, /多一个|比它再多/, '丢失了外层加长围栏的规则');
});

test('格式模板：给出正例（整体被五反引号包裹）', () => {
  const short = FORMAT_SPEC_SHORT;
  assert.match(short, /示例/, '模板没有示例小节');
  // 示例必须被五反引号包住（保证内部的四/三反引号不会被误认为"格式要求结束"）
  assert.match(short, /`{5}/, '示例未用五反引号包裹');
  assert.match(short, /````markdown/, '示例缺少四反引号语言标注块');
});

test('格式模板：解析器依赖的线索仍在（### 文件 + ### 范围）', () => {
  assert.match(FORMAT_SPEC_SHORT, /### 文件：/);
  assert.match(FORMAT_SPEC_SHORT, /### 范围：/);
  assert.match(FORMAT_SPEC_FULL, /### 文件：/);
  assert.match(FORMAT_SPEC_FULL, /### 范围：/);
});

test('格式模板：行号只由 ### 范围 表达，内容里不得写行号', () => {
  // 这是方案甲的核心不变量：内容里带行号对纯文本文件是真实风险
  const all = FORMAT_SPEC_SHORT + FORMAT_SPEC_FULL;
  assert.match(all, /绝不在行首写行号|不含行号/, '缺"内容里不写行号"的要求');
});

test('格式模板：示例覆盖全部 8 类场景（few-shot 够全）', () => {
  // 用户反馈：示例太少、没覆盖全，模型在提示词不严谨时就会跑偏。
  // FULL 版必须给出 8 类场景，且每类都是「输入 → 输出」成对。
  const full = FORMAT_SPEC_FULL;
  assert.equal((full.match(/示例 \d+｜/g) || []).length, 8, 'FULL 版示例数不是 8');
  const ins = (full.match(/【我给你的】/g) || []).length;
  const outs = (full.match(/【你该给我的】/g) || []).length;
  // 正文导语里会提到这两个词各一次，所以是 8 + 1；关键是输入/输出**成对**。
  assert.equal(ins, outs, '示例输入/输出标记数量不等，说明有段落缺失');
  assert.ok(ins >= 8, '示例对数不足 8');
  // 最刁钻的场景（内容里含四个反引号）必须在内
  assert.match(full, /四个连续反引号|四个反引号/, '缺"内容含四个反引号"场景');
});

test('格式模板：简洁版保留 6 个示例（高频易错场景不缺席）', () => {
  // SHORT 版按"高频且易错"挑选，用户反馈后从 4 个补到 6 个：
  // .md 内嵌围栏 / 局部替换 / 整文件 / 纯文本 / 新建文件 / 纯对话。
  const short = FORMAT_SPEC_SHORT;
  assert.equal((short.match(/示例 \d+｜/g) || []).length, 6, 'SHORT 版示例数不是 6');
  const ins = (short.match(/【我给你的】/g) || []).length;
  const outs = (short.match(/【你该给我的】/g) || []).length;
  assert.equal(ins, outs, 'SHORT 版输入/输出标记数量不等');
  // 两个最关键的教学点必须在：内嵌代码块、纯对话不落文件
  assert.match(short, /内嵌代码块/);
  assert.match(short, /不加锚点|不落文件/);
});

test('两版内置示例均保持原区间，新增行可通过真实解析与替换应用', () => {
  for (const spec of [FORMAT_SPEC_SHORT, FORMAT_SPEC_FULL]) {
    for (const exampleNumber of [2, 3]) {
      const example = spec.split(`示例 ${exampleNumber}｜`)[1]!.split('示例 ')[0]!;
      // 去掉示例展示用的外围五反引号，交给解析器实际交换的三段式内容。
      const inputText = example.split('【我给你的】')[1]!.split('【你该给我的】')[0]!.replace(/^`{5}$/gm, '');
      const outputText = example.split('【你该给我的】')[1]!.replace(/^`{5}$/gm, '');
      const input = parseModelReply(inputText).blocks[0]!;
      const output = parseModelReply(outputText).blocks[0]!;
      assert.deepEqual(output.range, input.range, '新增行不能把范围改为新内容占据的行号');
      const start = input.range!.start;
      const prefix = Array.from({ length: start - 1 }, (_, i) => `before ${i}`);
      const original = [...prefix, input.code, 'tail'].join('\n');
      const applied = computeApply(original, output, {
        kind: 'replace-lines', start, end: input.range!.end,
        expectedOriginal: input.code, contextNext: 'tail',
      });
      assert.equal(applied.ok, true, '示例必须可以应用');
      if (applied.ok) assert.equal(applied.text, [...prefix, output.code, 'tail'].join('\n'));
      if (exampleNumber === 2) assert.equal(output.code.split('\n').length, 10);
    }
  }
});

test('格式模板：不得出现解析器不认识的 ### 续： 约定', () => {
  // 解析器没有 `### 续：` 规则，写了只会误导模型。
  const all = FORMAT_SPEC_SHORT + FORMAT_SPEC_FULL;
  assert.doesNotMatch(all, /###\s*续/, '模板里出现了解析器不认识的续写锚点');
  // 取而代之：截断时改为"分多轮、每轮给某个文件的完整内容"
  assert.match(all, /分多轮/, '缺"分多轮给完整内容"的替代约定');
});

test('格式模板：保留语言标注对照表', () => {
  const all = FORMAT_SPEC_SHORT + FORMAT_SPEC_FULL;
  assert.match(all, /语言标注/, '缺语言标注说明');
  // 高频扩展名都要能查到
  for (const ext of ['.md', '.ts', '.py', '.json']) {
    assert.ok(all.includes(ext), `语言对照表缺 ${ext}`);
  }
  assert.match(all, /typescript/, '缺 typescript 标注');
});

test('getFormatSpec：默认返回短版，full 返回完整版', () => {
  assert.equal(getFormatSpec(), FORMAT_SPEC_SHORT);
  assert.equal(getFormatSpec('short'), FORMAT_SPEC_SHORT);
  assert.equal(getFormatSpec('full'), FORMAT_SPEC_FULL);
});

/* ------------------------------------------------------------------ *
 * 用户自定义格式要求（系统 prompt 可由用户修改）
 * ------------------------------------------------------------------ */

test('resolveFormatSpec：未设置或只有空白 → 一律回落该版本内置默认', () => {
  // 关键：空串必须**视同未设置**。若允许空格式要求，提示词里就少了唯一让
  // "一键同步"成立的约定，模型输出无法被解析，而且不会有任何报错。
  assert.equal(resolveFormatSpec(null), FORMAT_SPEC_SHORT);
  assert.equal(resolveFormatSpec(undefined), FORMAT_SPEC_SHORT);
  assert.equal(resolveFormatSpec({ short: '' }), FORMAT_SPEC_SHORT);
  assert.equal(resolveFormatSpec({ short: '   ' }), FORMAT_SPEC_SHORT);
  assert.equal(resolveFormatSpec({ short: '\n\t  \r\n' }), FORMAT_SPEC_SHORT);
  assert.equal(resolveFormatSpec(null, 'full'), FORMAT_SPEC_FULL);
  assert.equal(resolveFormatSpec({ full: '' }, 'full'), FORMAT_SPEC_FULL);
});

test('resolveFormatSpec：有自定义内容时原样返回（逐字，不做任何加工）', () => {
  const custom = '【输出格式要求｜我的版本】\n1. 只输出代码，不要解释\n2. 用 ### 文件： 标注';
  assert.equal(resolveFormatSpec({ short: custom }), custom);
  // 前后有空白时保留原文（只在**判断是否为空**时 trim，不 trim 返回值 ——
  // 用户可能有意用前后空行控制提示词里的段落间距）
  const padded = '\n\n' + custom + '\n\n';
  assert.equal(resolveFormatSpec({ short: padded }), padded);
});

test('resolveFormatSpec：简洁版与完整版的自定义互不影响（分版本隔离）', () => {
  // 这是本轮新增的核心不变量：给一版写自定义，另一版必须完全不受影响。
  const s = '简洁版自定义';
  const f = '完整版自定义';
  assert.equal(resolveFormatSpec({ short: s, full: null }, 'full'), FORMAT_SPEC_FULL);
  assert.equal(resolveFormatSpec({ short: null, full: f }, 'short'), FORMAT_SPEC_SHORT);
  assert.equal(resolveFormatSpec({ short: s, full: f }, 'short'), s);
  assert.equal(resolveFormatSpec({ short: s, full: f }, 'full'), f);
});

test('resolveFormatSpec：variant 只在回落默认时起作用', () => {
  assert.equal(resolveFormatSpec(null, 'full'), FORMAT_SPEC_FULL);
  assert.equal(resolveFormatSpec({ full: '自定义' }, 'full'), '自定义');
  // 完整版有自定义、但当前是简洁版 → 简洁版走自己的默认（不被完整版影响）
  assert.equal(resolveFormatSpec({ full: '自定义' }, 'short'), FORMAT_SPEC_SHORT);
});

test('normalizeVariant：任何非 full 的值都归一为 short（IPC 入参不可信）', () => {
  assert.equal(normalizeVariant('full'), 'full');
  assert.equal(normalizeVariant('short'), 'short');
  assert.equal(normalizeVariant('FULL'), 'short');
  assert.equal(normalizeVariant(undefined), 'short');
  assert.equal(normalizeVariant(null), 'short');
  assert.equal(normalizeVariant(123), 'short');
});

test('MAX_CUSTOM_FORMAT_SPEC_LENGTH：是一个足够写完整套约定的合理上限', () => {
  // 低于默认模板长度就说明"连默认都存不进去"，那是配置错误
  assert.ok(MAX_CUSTOM_FORMAT_SPEC_LENGTH >= FORMAT_SPEC_FULL.length, '上限不应小于内置完整版的长度');
  assert.ok(MAX_CUSTOM_FORMAT_SPEC_LENGTH <= 20000, '上限不应大到失去约束意义');
});
