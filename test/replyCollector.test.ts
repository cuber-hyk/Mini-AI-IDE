/**
 * 采集策略脚本的仿真测试
 *
 * 为什么需要：采集脚本是注入页面执行的字符串，**tsc 不会检查它的逻辑**，
 * 而它的正确性直接决定能不能采到干净的代码。实测踩过的坑：
 *  1. 早期策略取整个容器的 `innerText`，把页面上的「复制 / 下载」按钮文字、
 *     代码块左上角的语言标签一并抓了进来，解析器拿到的开头是 UI 垃圾；
 *  2. 早期判据"取含 <pre> 最多的 markdown 容器"在多轮对话里**全部平局** →
 *     停在文档序第一个（最旧回复），第二次采集拿到的仍是旧回复；
 *  3. 外围栏写死三反引号 → 内容里的内层 ``` 让解析器 splitFences 提前闭合 → 截断。
 *
 * 这里用**模拟的目标站 DOM**（含 UI 噪音、多轮回复、嵌套围栏）真跑一遍策略脚本，
 * 断言输出干净、定位到**最新回复**、围栏长度自适应。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';

import { COLLECT_STRATEGIES, collectReply, normalizeStrategyOutput } from '../src/main/replyCollector';

/** 取指定策略脚本（按 id，避免下标写死） */
function scriptOf(id: string): string {
  const s = COLLECT_STRATEGIES.find((x) => x.id === id);
  assert.ok(s, `未找到策略 ${id}`);
  return s.script;
}

/**
 * 最小可用的假 DOM 节点。
 *
 * 关键：必须提供 `tagName` —— 策略会用它排除 `<pre>`/`<code>`（
 * `[class*="markdown"]` 是子串匹配，`<code class="language-markdown">` 也会命中）。
 */
interface FakeNode {
  tagName: string;
  className: string;
  innerText: string;
  textContent: string;
  children: FakeNode[];
  parent: FakeNode | null;
  querySelectorAll(sel: string): FakeNode[];
  querySelector(sel: string): FakeNode | null;
  closest(sel: string): FakeNode | null;
}

const MARKDOWN_RE = /markdown/;

function fakeEl(tag: string, className = '', innerText = '', children: FakeNode[] = []): FakeNode {
  const self: FakeNode = {
    tagName: tag.toUpperCase(),
    className,
    innerText,
    textContent: innerText,
    children,
    parent: null,
    querySelectorAll(sel: string) {
      const out: FakeNode[] = [];
      const walk = (n: FakeNode): void => {
        for (const c of n.children) {
          if (sel === '*') out.push(c);
          else if (sel === 'pre' && c.tagName === 'PRE') out.push(c);
          else if (sel === 'code' && c.tagName === 'CODE') out.push(c);
          else if (sel.includes('markdown') && MARKDOWN_RE.test(c.className)) out.push(c);
          walk(c);
        }
      };
      walk(self);
      return out;
    },
    querySelector(sel: string) {
      return self.querySelectorAll(sel)[0] ?? null;
    },
    closest(sel: string) {
      let n: FakeNode | null = self;
      while (n) {
        if (sel.includes('markdown') && MARKDOWN_RE.test(n.className)) return n;
        n = n.parent;
      }
      return null;
    },
  };
  for (const c of children) c.parent = self;
  return self;
}

/** 把子节点挂到父节点上（同时维护 parent 指针） */
function link(parent: FakeNode, child: FakeNode): FakeNode {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

/** 造一个带代码块的回复容器（模拟目标站：路径标题与代码块是兄弟节点，代码在 <pre> 里） */
function makeReply(
  pathTitle: string | null,
  blocks: Array<{ lang: string; text: string }>,
): { node: FakeNode; container: FakeNode } {
  const container = fakeEl('div', 'ds-markdown', 'reply-container');
  if (pathTitle) link(container, fakeEl('div', 'ds-markdown-title', pathTitle));
  for (const b of blocks) {
    const pre = link(container, fakeEl('pre', '', b.text));
    link(pre, fakeEl('code', b.lang ? `language-${b.lang}` : '', b.text));
  }
  return { node: container, container };
}

/** 用给定的一串回复容器搭出页面 */
function pageOf(replies: Array<{ node: FakeNode }>): { document: unknown } {
  const body = fakeEl('body', '', 'page');
  for (const r of replies) link(body, r.node);
  return { document: { querySelectorAll: (s: string) => body.querySelectorAll(s) } };
}

/** 兼容旧测试的单回复页面 */
function makePage(): { document: unknown } {
  const code1 = fakeEl('code', 'language-python', 'def bubble_sort(arr):\n    return arr');
  const pre1 = fakeEl('pre', '', 'def bubble_sort(arr):\n    return arr', [code1]);
  const markdown = fakeEl('div', 'ds-markdown', '冒泡排序:\n```python\ndef bubble_sort(arr):\n    return arr', [pre1]);
  const heading = fakeEl('div', 'ds-markdown-title', '文件： Mini-AI-IDE-test.md');
  const container = fakeEl('div', 'ds-markdown', 'wrap', [heading, markdown]);
  void container;
  // 让标题与代码块同处一个容器：路径线索只从容器内取
  const outer = fakeEl('div', 'ds-markdown', 'outer', [heading, pre1]);
  void markdown;
  const body = fakeEl('body', '', 'page', [outer]);
  return { document: { querySelectorAll: (s: string) => body.querySelectorAll(s) } };
}

/** 页面里没有 `### 文件：` 标题时的版本（用于验证降级） */
function makePageWithoutPath(): { document: unknown } {
  const r = makeReply(null, [{ lang: 'python', text: 'print(1)' }]);
  return pageOf([r]);
}

/** 模型按约定回显行区间的页面：容器内有「范围：2-10」文本（单代码块） */
function makePageWithRange(): { document: unknown } {
  const r = makeReply('文件： Mini-AI-IDE-test.md', [
    { lang: 'python', text: 'def bubble_sort(arr):\n    return arr' },
  ]);
  link(r.container, fakeEl('div', 'ds-markdown-title', '范围：2-10'));
  return pageOf([r]);
}

/** 多代码块 + 容器内「范围」的页面：区间无法与各块对应，不应注入 */
function makePageWithTwoBlocksAndRange(): { document: unknown } {
  const r = makeReply(null, [
    { lang: 'python', text: 'print(1)' },
    { lang: 'python', text: 'print(2)' },
  ]);
  link(r.container, fakeEl('div', 'ds-markdown-title', '范围：2-10'));
  return pageOf([r]);
}

/** 多轮对话页面：旧回复（3 个 pre，数量更多）在前，新回复（1 个含嵌套围栏的 pre）在后 */
function makeTwoRoundPage(): { document: unknown } {
  const oldReply = makeReply('文件： old-file.py', [
    { lang: 'python', text: 'print(1)' },
    { lang: 'python', text: 'print(2)' },
    { lang: 'python', text: 'print(3)' },
  ]);
  const nested = '冒泡排序：\n```python\ndef bubble_sort(arr):\n    return arr\n```';
  const newReply = makeReply('文件： Mini-AI-IDE-test.md', [{ lang: 'markdown', text: nested }]);
  return pageOf([oldReply, newReply]);
}

function runScript(script: string, page: { document: unknown } = makePage()): unknown {
  const sandbox: Record<string, unknown> = { document: page.document };
  return vm.runInNewContext(script, sandbox, { timeout: 3000 });
}

describe('采集策略脚本（模拟目标站 DOM）', () => {
  it('latest-reply-container：带上容器内的路径标题（路径与代码是兄弟节点）', () => {
    const raw = runScript(scriptOf('latest-reply-container'));
    const texts = normalizeStrategyOutput(raw);
    assert.equal(texts.length, 1);
    const text = texts[0] as string;

    assert.ok(text.includes('### 文件：Mini-AI-IDE-test.md'), `应带上路径标题，实际：${text}`);
    assert.ok(text.includes('```python'), text);
    assert.ok(!text.includes('复制'), text);
    assert.ok(!text.includes('下载'), text);
  });

  it('页面没有路径标题时，仍返回纯代码（不伪造路径）', () => {
    const raw = runScript(scriptOf('latest-reply-container'), makePageWithoutPath());
    const texts = normalizeStrategyOutput(raw);
    assert.equal(texts.length, 1);
    const text = texts[0] as string;
    assert.ok(!text.includes('### 文件：'), `不应凭空造路径，实际：${text}`);
    assert.ok(text.includes('```python'), text);
  });

  it('单代码块 + 容器内「范围：2-10」→ 注入范围指令（修整文件覆盖的根因之一）', async () => {
    const raw = runScript(scriptOf('latest-reply-container'), makePageWithRange());
    const texts = normalizeStrategyOutput(raw);
    const text = texts[0] as string;
    assert.ok(text.includes('### 范围：2-10'), `应带上范围指令，实际：${text}`);
    assert.ok(text.includes('### 文件：Mini-AI-IDE-test.md'), text);

    // 端到端：解析器据此得到行区间，应用层走 replace-lines 而非 replace-whole-file
    const { parseModelReply } = await import('../src/shared/returnPath');
    const parsed = parseModelReply(text);
    assert.equal(parsed.blocks.length, 1);
    assert.deepEqual(parsed.blocks[0]?.range, { start: 2, end: 10 });
  });

  it('多代码块 + 容器内「范围」→ 不注入（区间无法与各块对应，宁可交给选区记忆/人工）', () => {
    const raw = runScript(scriptOf('latest-reply-container'), makePageWithTwoBlocksAndRange());
    const texts = normalizeStrategyOutput(raw);
    const text = texts[0] as string;
    assert.ok(!text.includes('### 范围：'), `多块时不应注入区间，实际：${text}`);
    assert.ok(text.includes('```python'), text);
  });

  it('采集结果可直接被解析器识别出路径与语言（端到端一致性）', async () => {
    const raw = runScript(scriptOf('latest-reply-container'));
    const texts = normalizeStrategyOutput(raw);
    const replyText = texts[0] as string;

    const { parseModelReply } = await import('../src/shared/returnPath');
    const parsed = parseModelReply(replyText);
    assert.equal(parsed.blocks.length, 1);
    assert.equal(parsed.blocks[0]?.filePath, 'Mini-AI-IDE-test.md', '路径必须被解析出来（用户不该手填）');
    assert.equal(parsed.blocks[0]?.language, 'python');
    assert.ok((parsed.blocks[0]?.code ?? '').includes('def bubble_sort'));
  });

  /* ---- 核心回归：新鲜度优先（修"多轮对话采到旧回复"） ---- */

  it('多轮对话：采到**最新**一条回复，旧回复 pre 更多也不干扰', () => {
    const raw = runScript(scriptOf('latest-reply-container'), makeTwoRoundPage());
    const texts = normalizeStrategyOutput(raw);
    assert.equal(texts.length, 1);
    const text = texts[0] as string;

    assert.ok(text.includes('### 文件：Mini-AI-IDE-test.md'), `必须取最新回复的路径，实际：${text}`);
    assert.ok(!text.includes('old-file.py'), `不得命中旧回复的路径，实际：${text}`);
    assert.ok(!text.includes('print(1)'), `不得命中旧回复的代码，实际：${text}`);
    assert.ok(text.includes('bubble_sort'), `应取到最新回复的代码，实际：${text}`);
  });

  it('多轮对话：整页兜底策略（last-pre-in-document）也取最新回复', () => {
    const raw = runScript(scriptOf('last-pre-in-document'), makeTwoRoundPage());
    const text = normalizeStrategyOutput(raw)[0] as string;
    assert.ok(text.includes('bubble_sort'), text);
    assert.ok(!text.includes('print(3)'), `最后一个 pre 属于最新回复，实际：${text}`);
  });

  /* ---- 核心回归：围栏自适应（修"嵌套围栏被截断"） ---- */

  it('最新回复内嵌 ```python → 外围栏自动加长为四反引号，解析不截断', async () => {
    const raw = runScript(scriptOf('latest-reply-container'), makeTwoRoundPage());
    const text = normalizeStrategyOutput(raw)[0] as string;

    assert.ok(text.includes('````markdown'), `外层围栏应为四个反引号，实际：${text}`);
    assert.ok(text.includes('```python'), '内层围栏应原样保留');

    const { parseModelReply, splitFences } = await import('../src/shared/returnPath');
    assert.equal(splitFences(text).length, 1, '嵌套围栏不得被拆成多块');
    const parsed = parseModelReply(text);
    assert.equal(parsed.blocks.length, 1);
    const code = parsed.blocks[0]?.code ?? '';
    assert.ok(code.includes('```python'), '内层围栏行是 .md 内容本身，必须保留');
    assert.ok(code.trimEnd().endsWith('```'), '内层闭合围栏必须保留（未被截断）');
    assert.equal(parsed.blocks[0]?.language, 'markdown', '语言标注跟文件类型走');
  });

  it('纯 python 回复：外围栏保持三反引号（不无谓加长）', () => {
    const raw = runScript(scriptOf('latest-reply-container'));
    const text = normalizeStrategyOutput(raw)[0] as string;
    assert.ok(!text.includes('````'), `无嵌套时不应加长围栏，实际：${text}`);
    assert.ok(text.includes('```python'), text);
  });

  /* ---- 核心回归：首行缩进保护（修"应用后缩进错乱"） ----
   *
   * 用户实测（2026-10-03）：选区落在函数体内部，AI 回显的首行是带 4 空格缩进的
   * "    n = len(arr)"，页面上 n 与 for 明明对齐，应用回文件后 n 却顶格了、
   * for 还缩进着 —— diff 里表现为"只有首行缩进丢失"。
   * 根因：textOf 用 trim() 清理 pre 的结构性首尾换行时，把首行的**合法前导缩进**
   * 一并吃掉（trim 剥掉开头所有空白直到第一个非空白字符）。其余行在字符串中间
   * 不受影响，所以错位形态是"仅首行缩进丢失"。
   * 修复：只剥「首部一行纯空白+换行」「尾部换行+纯空白」，首行缩进绝不动。
   */

  /** 用户实测场景的片段：选区 9-14（函数体内部），首行带 4 空格缩进 */
  const INDENTED_SNIPPET_LINES = [
    '    n = len(arr)  # 注释',
    '    for i in range(n - 1):  # 注释',
    '        for j in range(n - 1 - i):',
    '            if arr[j] > arr[j + 1]:',
    '                arr[j], arr[j + 1] = arr[j + 1], arr[j]',
    '    return arr',
  ];

  it('pre 首部带结构性换行 + 首行带缩进 → 采集后首行缩进保留（n 与 for 对齐）', async () => {
    // 模拟高亮 <pre> 的常见结构：内容首尾各有一个标签带来的换行
    const preText = '\n' + INDENTED_SNIPPET_LINES.join('\n') + '\n';
    const r = makeReply('文件： sort.py', [{ lang: 'python', text: preText }]);
    const raw = runScript(scriptOf('latest-reply-container'), pageOf([r]));
    const replyText = normalizeStrategyOutput(raw)[0] as string;

    const { parseModelReply } = await import('../src/shared/returnPath');
    const code = parseModelReply(replyText).blocks[0]?.code ?? '';
    const lines = code.split('\n');
    assert.equal(lines[0], INDENTED_SNIPPET_LINES[0], `首行缩进必须保留，实际：${JSON.stringify(code)}`);
    assert.equal(lines[1], INDENTED_SNIPPET_LINES[1], '次行缩进必须保留');
    assert.ok(lines[0].startsWith('    '), '首行必须与 for 同为 4 空格缩进（页面上对齐）');
  });

  it('pre 无结构性换行、内容直接以缩进行开始 → 首行缩进同样保留', async () => {
    const r = makeReply('文件： sort.py', [{ lang: 'python', text: INDENTED_SNIPPET_LINES.join('\n') }]);
    const raw = runScript(scriptOf('latest-reply-container'), pageOf([r]));
    const replyText = normalizeStrategyOutput(raw)[0] as string;

    const { parseModelReply } = await import('../src/shared/returnPath');
    const code = parseModelReply(replyText).blocks[0]?.code ?? '';
    assert.ok(code.startsWith('    n = len(arr)'), `首行缩进必须保留，实际：${JSON.stringify(code)}`);
  });

  it('端到端：首行缩进的片段 → 采集 → 解析 → replace-lines 应用，缩进逐行一致', async () => {
    // 原文件 16 行：第 8 行 def，第 9-14 行选区（函数体内部），第 15 行结尾
    const originalLines = [
      '"""mod"""', 'import os', '', 'def other():', '    pass', '', '',
      'def bubble_sort(arr):',
      ...INDENTED_SNIPPET_LINES,
      'print(bubble_sort([3, 1, 2]))',
      '',
    ];
    const original = originalLines.join('\n');

    // 页面：pre 首部带结构性换行；容器内带「文件 / 范围」线索（模型回显区间）
    const preText = '\n' + INDENTED_SNIPPET_LINES.join('\n') + '\n';
    const r = makeReply('文件： sort.py', [{ lang: 'python', text: preText }]);
    link(r.container, fakeEl('div', 'ds-markdown-title', '范围：9-14'));
    const raw = runScript(scriptOf('latest-reply-container'), pageOf([r]));
    const replyText = normalizeStrategyOutput(raw)[0] as string;

    const { parseModelReply, computeApply } = await import('../src/shared/returnPath');
    const parsed = parseModelReply(replyText);
    const block = parsed.blocks[0];
    assert.ok(block, '必须解析出代码块');
    assert.deepEqual(block?.range, { start: 9, end: 14 }, '容器内「范围：9-14」应被解析');

    const outcome = computeApply(original, block!, {
      kind: 'replace-lines',
      start: 9,
      end: 14,
      expectedOriginal: INDENTED_SNIPPET_LINES.join('\n'),
      contextPrev: 'def bubble_sort(arr):',
      contextNext: 'print(bubble_sort([3, 1, 2]))',
    });
    assert.ok(outcome.ok, `三向校验应通过，实际：${JSON.stringify(outcome)}`);
    if (!outcome.ok) return;

    const applied = outcome.text.split('\n');
    assert.equal(applied[8], INDENTED_SNIPPET_LINES[0], `应用后第 9 行必须保留 4 空格缩进（n 与 for 对齐），实际：${JSON.stringify(applied[8])}`);
    assert.equal(applied[9], INDENTED_SNIPPET_LINES[1], '应用后第 10 行 for 与 n 必须同级缩进');
    assert.equal(applied[7], 'def bubble_sort(arr):', '区间上一行（def）保持原样');
    assert.equal(applied[14], 'print(bubble_sort([3, 1, 2]))', '区间下一行保持原样');
  });

  it('pre 只有空白内容（结构性换行/空格）→ 判空过滤，不产出空代码块', () => {
    const r = makeReply('文件： sort.py', [{ lang: 'python', text: '\n   \n  \n' }]);
    const raw = runScript(scriptOf('latest-reply-container'), pageOf([r]));
    const texts = normalizeStrategyOutput(raw);
    assert.equal(texts.length, 0, '纯空白 pre 不得产出代码块');
  });

  it('latest-reply-container-text：容器无 <pre> 时回退到整体文本', () => {
    const plain = fakeEl('div', 'ds-markdown', '这是一段纯文本回复，没有代码块。');
    const page = pageOf([{ node: plain }]);
    const raw = runScript(scriptOf('latest-reply-container-text'), page);
    const text = normalizeStrategyOutput(raw)[0] as string;
    assert.ok(text.includes('纯文本回复'), text);
  });

  /* ---- 线索限定范围（修"历史回复路径错配"） ---- */

  it('线索只在最新容器内取：历史容器带不同路径不干扰', () => {
    // 旧回复有路径、新回复没有 → 不得把旧路径贴到新回复上
    const oldReply = makeReply('文件： old-file.py', [{ lang: 'python', text: 'print(1)' }]);
    const newReply = makeReply(null, [{ lang: 'python', text: 'print(2)' }]);
    const page = pageOf([oldReply, newReply]);
    const raw = runScript(scriptOf('latest-reply-container'), page);
    const text = normalizeStrategyOutput(raw)[0] as string;
    assert.ok(text.includes('print(2)'), text);
    assert.ok(!text.includes('old-file.py'), `不得取历史容器的路径，实际：${text}`);
  });

  it('采集脚本不误把 <code class="language-markdown"> 当成 markdown 容器', () => {
    // 若策略只做"取最后一个 [class*=markdown]"，会选中 <code>（文档序更靠后、内部无 pre）
    const raw = runScript(scriptOf('latest-reply-container'), makeTwoRoundPage());
    const texts = normalizeStrategyOutput(raw);
    assert.equal(texts.length, 1, '不得因选中 <code> 而返回空');
    assert.ok((texts[0] as string).includes('bubble_sort'), texts[0]);
  });

  /* ---- 核心回归：路径线索支持空格与中文文件名（用户实测 2026-10-04） ----
   * 真实文件名常见「BLIP 阅读笔记.md」形态；旧 pathRe 的 [^\s`]+ 不允许空格，
   * 在「BLIP」后断掉 → 路径线索全丢 → 面板显示「未确定目标文件」。
   */

  it('路径线索：文件名含空格与中文也能取到，端到端解析出 filePath', async () => {
    const r = makeReply('文件： BLIP 阅读笔记.md', [
      { lang: 'markdown', text: '- **ITC（对比损失）**：把配图文本拉到表示空间相近。' },
    ]);
    link(r.container, fakeEl('div', 'ds-markdown-title', '范围：113-113'));
    const raw = runScript(scriptOf('latest-reply-container'), pageOf([r]));
    const replyText = normalizeStrategyOutput(raw)[0] as string;

    assert.ok(replyText.includes('### 文件：BLIP 阅读笔记.md'), `路径线索必须被采集，实际：${replyText}`);

    const { parseModelReply } = await import('../src/shared/returnPath');
    const parsed = parseModelReply(replyText);
    assert.equal(parsed.blocks.length, 1);
    assert.equal(parsed.blocks[0]?.filePath, 'BLIP 阅读笔记.md', '端到端必须解析出中文空格文件名');
    assert.deepEqual(parsed.blocks[0]?.range, { start: 113, end: 113 });
  });

  /* ---- 结构性断言 ---- */

  it('策略表：id 唯一、每套都保持"最新"语义、空页面安全返回', () => {
    const ids = COLLECT_STRATEGIES.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `策略 id 必须唯一：${ids.join(',')}`);
    assert.equal(ids[0], 'latest-reply-container', '首条策略必须是最新回复容器');

    for (const s of COLLECT_STRATEGIES) {
      const sandbox: Record<string, unknown> = {
        document: { querySelectorAll: () => [], querySelector: () => null },
      };
      const raw = vm.runInNewContext(s.script, sandbox, { timeout: 3000 });
      assert.ok(Array.isArray(raw), `策略 ${s.id} 必须返回数组`);
      assert.equal((raw as unknown[]).length, 0, `策略 ${s.id} 在空页面应返回空数组`);
    }
  });

  it('已废弃"pre 最多 / 文本最长"判据（新鲜度是唯一判据）', () => {
    const all = COLLECT_STRATEGIES.map((s) => s.script).join('\n');
    assert.ok(!/bestCount/.test(all), '不应再出现"取 pre 最多"的计数逻辑');
    assert.ok(!/bestText/.test(all), '不应再出现"取文本最长"的逻辑');
  });

  it('collectReply：逐个策略降级，全部失败时报 null 且带诊断', async () => {
    const empty = { querySelectorAll: () => [], querySelector: () => null };
    const result = await collectReply({
      evaluate: async (script: string) => vm.runInNewContext(script, { document: empty, location: { href: 'https://x/y' }, documentTitle: '' }, { timeout: 3000 }),
      currentUrl: () => 'https://example.com/a/chat/s/abc?q=1',
    });
    assert.equal(result.strategyId, null);
    assert.equal(result.replyText, '');
    assert.equal(result.url, 'https://example.com/a/chat/s/abc');
  });
});
