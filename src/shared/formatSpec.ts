/**
 * 输出格式要求模板（纯逻辑，可单测）
 *
 * 用途：让"一键同步"稳定成立。**由用户自己复制并粘贴到提示词里**——
 * 程序只把这段文本写进系统剪贴板，**绝不写入网页输入框**（ADR-0003 零注入边界）。
 *
 * 与解析器的关系：模板声明的格式要**正好落在解析器能识别的形态上**
 * （见 src/shared/returnPath.ts 的路径线索优先级）。因此这里的示例写法不是随便写的：
 *  - `### 文件：路径` 命中"标题式路径行"线索；
 *  - `### 范围：N-M` 命中"行区间指令"（决定是片段替换还是整文件替换）；
 *  - 围栏内首行 `// 路径` 命中"路径注释"线索。
 *
 * ------------------------------------------------------------------
 * 核心设计：输入与输出**结构完全对称**（同一条骨架）
 * ------------------------------------------------------------------
 *   ### 文件：<相对路径>
 *   ### 范围：<起始行>-<结束行>
 *   ````<语言标注>
 *   <内容，不含行号>
 *   ````
 *
 * 程序发出去的片段（src/shared/snippet.ts）与这里要求的输出形态逐字一致，
 * 模型只需学一套规则：**把收到的骨架原样抄回来，只改内容**。
 *
 * 两个不可动摇的不变量：
 *  1. **行号只出现在 `### 范围` 行里**，内容里绝不带行号。
 *     内容里带行号对"人定位"与"机器写回"都是冗余 —— 范围行已经说清楚了；
 *     而对 .md/.txt 这类纯文本，行号会与正文混淆、被原样写进文件。
 *     单一真相源（范围行）比双份（行号 + 范围行）更稳。
 *  2. **围栏至少四个反引号**（不是"固定四个"）。
 *     内容里若出现四个及以上连续反引号，外层必须比它更长，否则会被提前闭合、
 *     内容被截断。程序侧 fenceFor 同样按"最长连续反引号 + 1、最少 4"计算。
 */

/**
 * 输入/输出结构说明 + few-shot 示例（**两个变体共用同一份素材**）。
 *
 * 为什么要共用：SHORT 与 FULL 只在"示例数量 / 细节详略"上不同，
 * 骨架与规则必须一字不差 —— 若各写一遍，改一处漏一处，
 * 用户切换变体时会得到互相矛盾的规范。这里用函数按参数拼装。
 */

/** 一段 few-shot 示例：input 是用户侧片段，output 是模型应给出的形态 */
interface SpecExample {
  /** 场景标题 */
  title: string;
  /** 要点说明（一句话） */
  note: string;
  /** 用户给模型的输入（原样展示） */
  input: string;
  /** 模型应输出的内容（原样展示） */
  output: string;
  /** 是否纳入 SHORT 档（FULL 全含） */
  inShort: boolean;
}

const EX_MD_NESTED: SpecExample = {
  title: '示例 1｜.md 里内嵌代码块 —— 内层三反引号原样保留',
  note: '这是最容易出错的一种：内容里本来就有三反引号，外层仍用四个，不会被提前闭合。',
  inShort: true,
  input: [
    '### 文件：docs/notes.md',
    '### 范围：2-8',
    '````markdown',
    '# 说明',
    '',
    '```python',
    'def foo():',
    '    pass',
    '```',
    '````',
  ].join('\n'),
  output: [
    '### 文件：docs/notes.md',
    '### 范围：2-8',
    '````markdown',
    '# 说明',
    '',
    '```python',
    'def foo():',
    '    return 1',
    '```',
    '````',
  ].join('\n'),
};

const EX_TS_PARTIAL: SpecExample = {
  title: '示例 2｜.ts 局部替换几行 —— 只给那几行，不给整个文件',
  note: '范围是几行，内容就只有几行；行号只写在 ### 范围 里，内容里不写行号。',
  inShort: true,
  input: [
    '### 文件：src/counter.ts',
    '### 范围：10-12',
    '````typescript',
    'let n = 0;',
    'export function inc() {',
    '  n += 1;',
    '````',
  ].join('\n'),
  output: [
    '### 文件：src/counter.ts',
    '### 范围：10-12',
    '````typescript',
    'let n = 0;',
    'export function inc() {',
    '  n += 2;',
    '````',
  ].join('\n'),
};

const EX_WHOLE_FILE: SpecExample = {
  title: '示例 3｜整文件重写 —— 范围写成 1 到末行',
  note: '整体输出与局部输出**写法完全一样**，只是范围覆盖整个文件、内容放全文。行数变了，范围也跟着变。',
  inShort: true,
  input: [
    '### 文件：src/config.ts',
    '### 范围：1-2',
    '````typescript',
    'export const A = 1;',
    'export const B = 2;',
    '````',
  ].join('\n'),
  output: [
    '### 文件：src/config.ts',
    '### 范围：1-3',
    '````typescript',
    'export const A = 1;',
    'export const B = 2;',
    'export const C = 3;',
    '````',
  ].join('\n'),
};

const EX_PLAIN_TEXT: SpecExample = {
  title: '示例 4｜纯文本文件（.txt / 无扩展名）—— 四个反引号后不写语言标注',
  note: '纯文本没有语言可标：开头就是四个反引号，紧接着换行。',
  inShort: true,
  input: ['### 文件：docs/summary.txt', '### 范围：1-2', '````', '第一行纯文本。', '````'].join('\n'),
  output: ['### 文件：docs/summary.txt', '### 范围：1-2', '````', '第一行纯文本。', '第二行纯文本。', '````'].join('\n'),
};

const EX_NEW_FILE: SpecExample = {
  title: '示例 5｜新建文件 —— 目录结构里没有，也照常给三段式',
  note: '路径按我指定或按目录结构推断；范围写 1 到新增内容的末行。',
  inShort: true,
  input: '（目录结构里没有 src/util/format.ts，请新建一个导出 formatDate 的工具）',
  output: [
    '### 文件：src/util/format.ts',
    '### 范围：1-3',
    '````typescript',
    'export function formatDate(d: Date): string {',
    '  return d.toISOString().slice(0, 10);',
    '}',
    '````',
  ].join('\n'),
};

const EX_MULTI_FILE: SpecExample = {
  title: '示例 6｜一次改多个文件 —— 每个文件各写一遍三段式，顺序与输入一致',
  note: '不要把所有文件塞进一个代码块；一个文件一块。',
  inShort: false,
  input: [
    '### 文件：src/a.ts',
    '### 范围：1-1',
    '````typescript',
    'export const a = 1;',
    '````',
    '',
    '### 文件：docs/b.md',
    '### 范围：1-3',
    '````markdown',
    '# B',
    '',
    '正文',
    '````',
  ].join('\n'),
  output: [
    '### 文件：src/a.ts',
    '### 范围：1-1',
    '````typescript',
    'export const a = 2;',
    '````',
    '',
    '### 文件：docs/b.md',
    '### 范围：1-3',
    '````markdown',
    '# B',
    '',
    '新的正文',
    '````',
  ].join('\n'),
};

const EX_CONVERSATION: SpecExample = {
  title: '示例 7｜只是提问 / 讨论、不落文件 —— **不加锚点、不加围栏**',
  note: '我要是没让你改文件，就按普通文字回答；不要硬套 ### 文件 与围栏，否则会被误当成待写入内容。',
  inShort: true,
  input: '这个冒泡排序的时间复杂度是多少？',
  output: '平均和最坏情况都是 O(n²)，最好情况（已有序且带提前退出判断）是 O(n)。空间复杂度 O(1)。',
};

const EX_FOUR_BACKTICKS: SpecExample = {
  title: '示例 8｜内容里出现四个连续反引号 —— 外层加长到五个',
  note: '外层永远比内容里最长的连续反引号长一个，这样才不会被提前闭合。',
  inShort: false,
  input: [
    '### 文件：docs/raw.md',
    '### 范围：1-1',
    '`````markdown',
    '````（这一段本身就是四个反引号）',
    '`````',
  ].join('\n'),
  output: [
    '### 文件：docs/raw.md',
    '### 范围：1-1',
    '`````markdown',
    '````（这一段本身就是四个反引号，已按你的要求处理）',
    '`````',
  ].join('\n'),
};

const ALL_EXAMPLES: SpecExample[] = [
  EX_MD_NESTED,
  EX_TS_PARTIAL,
  EX_WHOLE_FILE,
  EX_PLAIN_TEXT,
  EX_NEW_FILE,
  EX_MULTI_FILE,
  EX_CONVERSATION,
  EX_FOUR_BACKTICKS,
];

/**
 * 把一段示例文本包进「五反引号」里。
 *
 * 为什么必须包：示例内部含四反引号（甚至三反引号），若不包裹，
 * 模型会把示例里的围栏读成"格式要求结束了"，从而输出被带偏
 * （这是本项目真实踩过的坑）。五反引号比示例内最长的四个更长，安全。
 *
 * 注意：包裹行必须**成对**。自检 F3b / 离线 X1 会断言模板里每段反引号都成对 ——
 * 这条断言曾经抓到过我自己在说明文字里写出的裸 opener。
 */
function block(text: string): string[] {
  return ['·····', ...text.split('\n'), '·····'];
}

/**
 * 渲染若干示例为行数组（每段之间空一行）。
 *
 * 示例编号**按本次渲染的顺序重排**（不是常量里的绝对序号）：SHORT 只挑 4 个场景，
 * 若直接用绝对序号会出现「示例 1 / 2 / 4 / 7」这种跳号，读者会以为漏了内容。
 * 重排后 SHORT 是 1–4、FULL 是 1–8，各自连续。
 */
function renderExamples(examples: SpecExample[]): string[] {
  const out: string[] = [];
  examples.forEach((ex, i) => {
    if (i > 0) out.push('');
    // 只替换标题开头的「示例 N｜」，保留后面的描述
    out.push(ex.title.replace(/^示例 \d+｜/, '示例 ' + (i + 1) + '｜'));
    out.push(ex.note);
    out.push('【我给你的】');
    out.push(...block(ex.input));
    out.push('【你该给我的】');
    out.push(...block(ex.output));
  });
  return out;
}

/** 语言标注对照表（按目标文件扩展名） */
const LANGUAGE_TABLE: string[] = [
  '   扩展名          语言标注        扩展名          语言标注',
  '   .md / .markdown  markdown        .ts / .tsx      typescript',
  '   .js / .jsx       javascript      .py             python',
  '   .json / .jsonc   json            .yaml / .yml    yaml',
  '   .sh / .bash      bash            .html / .htm    html',
  '   .css / .scss     css             .sql            sql',
  '   .c / .h          c               .cpp / .hpp     cpp',
  '   .java            java            .go             go',
  '   .rs              rust            .rb             ruby',
  '   .txt / 无扩展名 / 其它不认识 → **不写语言标注**（四个反引号后直接换行）',
];

/**
 * 简短版（日常默认）：核心规则 + 4 个最关键的示例。
 *
 * 为什么这几个进 SHORT：它们各自代表一类**高频且易错**的场景 ——
 * 带内嵌围栏的 .md、局部替换、纯文本、纯对话。
 * 其余场景（整文件 / 新建 / 多文件 / 含四个反引号）在 FULL 里给全。
 *
 * 用户保存的自定义内容（settings.json 的 customFormatSpec）会覆盖它；
 * 未设置时用的就是这一段 —— 见 resolveFormatSpec()。
 */
export const FORMAT_SPEC_SHORT = [
  '【输入/输出格式要求】',
  '',
  '你我会用**同一条骨架**来交换内容 —— 我给你什么结构，你就按同样的结构写回来：',
  '',
  '### 文件：相对路径',
  '### 范围：起始行-结束行',
  '````语言标注',
  '（内容，不含行号）',
  '````',
  '',
  '═══ 一、结构与规则 ═══',
  '',
  '1. 每个文件上方单独一行写：### 文件：相对路径',
  '   例：### 文件：src/main/index.ts',
  '   路径用相对路径、以 / 分隔，须与我的目录结构一致。',
  '',
  '2. 紧接下一行写：### 范围：起始行-结束行（用我给你的行号）',
  '   例：### 范围：80-92',
  '   - 我只改几行 → 范围就是那几行，内容**只放那几行**（不要给我整个文件）；',
  '   - 我给整个文件 → 范围就是该文件的完整行范围（1 到末行），内容放全文。',
  '   ### 范围 是**替换哪几行**的唯一依据，**必须写**。',
  '',
  '3. 围栏内**只放内容本身**：',
  '   - **绝不在行首写行号**（不要写成 ` 80| xxx`）——行号已经由 ### 范围 表达了；',
  '   - 不要省略号（...）、不要"以下是……"之类的前后缀。',
  '',
  '4. 一次涉及多个文件时，每个文件都按上面三段式各写一遍，一个文件一块。',
  '',
  '5. **围栏固定用四个反引号**（不是三个）：开头 = 四个反引号 + 语言标注，',
  '   结尾 = 同样四个反引号，**必须成对闭合**。语言标注按目标文件扩展名给：',
  ...LANGUAGE_TABLE,
  '',
  '6. 内容里若出现四个及以上**连续**反引号，外层就比它再多一个（内层四个 → 外层五个）；',
  '   内容里的三反引号（如 .md 内嵌代码块）**原样保留**，外面有四个就不会被提前闭合。',
  '',
  '7. 锚点（### 文件 / ### 范围）一律写在围栏**外面**，不得出现在围栏内容里。',
  '',
  '═══ 二、示例（输入 → 输出） ═══',
  '',
  '下面每段都用五反引号包着，**只是示范，不是你要输出的内容**。',
  '注意看【我给你的】与【你该给我的】之间的差别 —— 结构完全相同，只有内容变了。',
  '',
  ...renderExamples(ALL_EXAMPLES.filter((e) => e.inShort)),
].join('\n').replace(/·····/g, '`````');

/**
 * 完整版：与简短版**同一份规则与素材**，示例给全 8 个（含整文件 / 新建 / 多文件 / 含四反引号）。
 *
 * 适用：改动较大、文件较多、或模型上一次没按规范输出时，贴这一版更稳。
 */
export const FORMAT_SPEC_FULL = [
  '【输入/输出格式要求】',
  '',
  '你我会用**同一条骨架**来交换内容 —— 我给你什么结构，你就按同样的结构写回来：',
  '',
  '### 文件：相对路径',
  '### 范围：起始行-结束行',
  '````语言标注',
  '（内容，不含行号）',
  '````',
  '',
  '→ 这条骨架就是**唯一**的输入结构，也是你唯一需要给出的输出结构。',
  '',
  '═══ 一、结构与规则 ═══',
  '',
  'A. 路径与范围（三段式的头两行）',
  '  1. 每个文件上方单独一行：### 文件：相对路径',
  '     例：### 文件：src/main/index.ts',
  '     路径一律相对路径、以 / 分隔，须与我给的目录结构一致。',
  '     目录结构里没有的文件视为新建，路径按我指定或按结构推断。',
  '  2. 紧接下一行：### 范围：起始行-结束行（用我给你的行号）',
  '     - 局部替换：范围 = 被替换的那几行，内容只放替换后的那几行；',
  '     - 整体输出：范围 = 该文件的完整行范围（1 到末行），内容放全文。',
  '     ### 范围 是**替换哪几行**的唯一依据，**必须写**。',
  '',
  'B. 围栏内容（第三段）',
  '  3. 围栏内**只放内容本身**：',
  '     - **绝不在行首写行号**（不要写成 ` 80| xxx`）；',
  '     - 不要省略号、不要"以下是……"之类的前后缀。',
  '  4. 锚点（### 文件 / ### 范围）一律写在围栏**外面**，不得出现在围栏内容里。',
  '',
  'C. 围栏怎么写',
  '  5. **固定用四个反引号**（不是三个）：开头 = 四个反引号 + 语言标注；',
  '     结尾 = 同样四个反引号，**必须成对闭合**。',
  '     语言标注按目标文件扩展名给：',
  ...LANGUAGE_TABLE,
  '  6. 内容里若出现四个及以上**连续**反引号，外层比它多一个（内层四个 → 外层五个）。',
  '  7. 内容里的三反引号（如 .md 内嵌代码块）**原样保留**，外层四个不会被提前闭合。',
  '',
  'D. 多文件与对话',
  '  8. 多文件：每个文件各写一遍三段式，顺序与我给出的一致，一个文件一块。',
  '  9. 我若只是提问、讨论、不要求落文件 → **不加 ### 文件、不加围栏**，按普通文字回答。',
  '     只要涉及改动文件，就必须带 ### 文件 与 ### 范围。',
  '',
  'E. 关于长度',
  '  10. 每次输出都要把该给的内容给**完整**。若确实太长，',
  '      宁可**分多轮、每轮给某个文件的完整内容**（仍带它的 ### 文件 与 ### 范围），',
  '      也不要在中间截断 —— 半截的内容无法被采用。',
  '',
  '═══ 二、示例（输入 → 输出，共 ' + String(ALL_EXAMPLES.length) + ' 个场景） ═══',
  '',
  '下面每段都用五反引号包着，**只是示范，不是你要输出的内容**。',
  '注意看【我给你的】与【你该给我的】之间的差别 —— 结构完全相同，只有内容变了。',
  '',
  ...renderExamples(ALL_EXAMPLES),
].join('\n').replace(/·····/g, '`````');

export type FormatSpecVariant = 'short' | 'full';

/** 版本判定：任何非 'full' 的值都归一为 'short'（IPC 入参不可信） */
export function normalizeVariant(v: unknown): FormatSpecVariant {
  return v === 'full' ? 'full' : 'short';
}

/**
 * 自定义格式要求的长度上限（字符）。
 * 8000 字足够写进整套约定与示例；再长会挤占 prompt 里"用户需求 + 目录结构"的注意力。
 * 超限时**截断而不是拒绝**：用户点保存时提示一次，内容仍保留（不让他白写一遍）。
 */
export const MAX_CUSTOM_FORMAT_SPEC_LENGTH = 8000;

/**
 * 分版本的自定义内容。
 *
 * 为什么**每个版本各存一份**而不是共用一个：用户在"简洁版"和"完整版"上想改的东西
 * 往往不同（简洁版可能只想留三条硬规则，完整版才有余地放长注解）。共用一个字段的结果是
 * "拨到另一版发现内容也变了"，很反直觉。
 */
export interface CustomFormatSpecs {
  short?: string | null;
  full?: string | null;
}

/**
 * 取最终使用的「输出格式要求」。
 *
 * 生效规则（**分版本、各自独立**）：
 *   当前版本的自定义非空 → 用该自定义；
 *   否则 → 回落该版本的内置默认。
 *
 * 这就是"用户可以改系统 prompt"的全部机制：**只影响拼进 prompt 的格式段**，
 * 其余固定文案（## 用户需求 / ## 工作环境 …）仍由程序生成，保证提示词骨架始终可被解析。
 *
 * 未设置或只写了空白时回落内置默认（见 settings.ts 的 load()：空串视同未设置）。
 *
 * @param customs 分版本自定义内容
 * @param variant 当前选择的版本
 */
export function resolveFormatSpec(customs: CustomFormatSpecs | null | undefined, variant: FormatSpecVariant = 'short'): string {
  const v = normalizeVariant(variant);
  const raw = customs ? (v === 'full' ? customs.full : customs.short) : null;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed.length > 0 ? (raw as string) : getFormatSpec(v);
}

export function getFormatSpec(variant: FormatSpecVariant = 'short'): string {
  return normalizeVariant(variant) === 'full' ? FORMAT_SPEC_FULL : FORMAT_SPEC_SHORT;
}

/* ------------------------------------------------------------------ *
 * 完整 prompt 组装（由用户在本应用内点击"复制 prompt"触发）
 * ------------------------------------------------------------------ */

export interface PromptContext {
  /** 工作目录（绝对路径，按用户机器如实给出） */
  root: string | null;
  /** 目录摘要（相对路径列表，已截断并注明） */
  tree: string | null;
  /** 运行环境摘要，如 "Windows 10.0.26200；Node 24.21.0" */
  environment: string | null;
}

export interface BuildPromptInput {
  /** 用户在应用内输入框里写的需求（唯一由人写的部分） */
  requirement: string;
  context: PromptContext;
  /** 输出格式要求；传入空字符串则不附 */
  formatSpec: string;
  /** 可选：要改的文件路径（用户手填），会单独成段 */
  targetFiles?: string[];
}

/**
 * 把"用户需求 + 环境上下文 + 输出格式要求"组装成完整 prompt。
 *
 * 说明：本函数只产出**文本**，由调用方写入系统剪贴板；
 * **绝不写入网页输入框** —— 最后那一下 Ctrl+V 必须由用户完成（ADR-0003）。
 */
export function buildPrompt(input: BuildPromptInput): string {
  const parts: string[] = [];

  if (input.requirement.trim().length > 0) {
    parts.push(`## 用户需求\n${input.requirement.trim()}`);
  }

  const envLines: string[] = [];
  if (input.context.environment) envLines.push(`- 运行环境: ${input.context.environment}`);
  if (input.context.root) envLines.push(`- 当前工作目录: ${input.context.root}`);
  if (envLines.length > 0) {
    parts.push(`## 工作环境\n${envLines.join('\n')}`);
  }

  if (input.context.tree) {
    parts.push(`## 目录结构（摘要）\n${input.context.tree}`);
  }

  if (input.targetFiles && input.targetFiles.length > 0) {
    parts.push(`## 要改的文件\n${input.targetFiles.map((f) => `- ${f}`).join('\n')}`);
  }

  if (input.formatSpec.trim().length > 0) {
    parts.push(input.formatSpec.trim());
  }

  return parts.join('\n\n');
}

