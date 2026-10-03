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
