/**
 * 采集策略脚本的仿真测试
 *
 * 为什么需要：采集脚本是注入页面执行的字符串，**tsc 不会检查它的逻辑**，
 * 而它的正确性直接决定能不能采到干净的代码。实测踩过的坑：
 * 早期策略取整个容器的 `innerText`，把页面上的「复制 / 下载」按钮文字、
 * 代码块左上角的语言标签一并抓了进来，解析器拿到的开头是 UI 垃圾。
 *
 * 这里用**模拟的目标站 DOM**（含 UI 噪音）真跑一遍策略脚本，断言输出干净。
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
interface FakeNode {
  className?: string;
  innerText?: string;
  textContent?: string;
  children: FakeNode[];
  querySelectorAll(sel: string): FakeNode[];
  querySelector(sel: string): FakeNode | null;
  closest(sel: string): FakeNode | null;
}

function node(init: Partial<FakeNode> = {}): FakeNode {
  const self: FakeNode = {
    className: init.className ?? '',
    innerText: init.innerText ?? '',
    textContent: init.textContent ?? init.innerText ?? '',
    children: init.children ?? [],
    querySelectorAll(sel: string) {
      void sel;
      return self.children;
    },
    querySelector(sel: string) {
      void sel;
      return self.children[0] ?? null;
    },
    closest(sel: string) {
      // 如实模拟：没有匹配的祖先时返回 null（策略的退化分支依赖这个语义）
      void sel;
      return init.className && init.className.includes('markdown') ? self : null;
    },
  };
  return self;
}

/**
 * 模拟 DeepSeek 的一条回复容器：
 *  - 容器 innerText **包含**「复制 / 下载」按钮文字与语言标签（UI 噪音）
 *  - <pre> 里才是真正的代码
 */
function makePage(): { document: unknown } {
  const code1 = node({ className: 'language-python', innerText: 'def bubble_sort(arr):\n    return arr' });
  const pre1 = node({ innerText: 'def bubble_sort(arr):\n    return arr', children: [code1] });

  const markdown = node({
    className: 'ds-markdown',
    // 容器文本里带有按钮文字与语言标签（这是噪声来源）
    innerText: '冒泡排序:\n```python\ndef bubble_sort(arr):\n    return arr',
    children: [pre1],
  });

  // 路径标题是**代码块的兄弟节点**（实测形态）：只抓 <pre> 会丢掉它
  const heading = node({ className: 'ds-markdown-title', textContent: '文件： Mini-AI-IDE-test.md' });

  const documentStub = {
    querySelectorAll(sel: string) {
      if (sel.includes('markdown')) return [markdown];
      if (sel === 'pre') return [pre1];
      if (sel.includes('h1')) return [heading]; // 页面级路径扫描
      return [];
    },
  };
  return { document: documentStub };
}

/** 页面里没有 `### 文件：` 标题时的版本（用于验证降级） */
function makePageWithoutPath(): { document: unknown } {
  const code1 = node({ className: 'language-python', innerText: 'print(1)' });
  const pre1 = node({ innerText: 'print(1)', children: [code1] });
  const markdown = node({ className: 'ds-markdown', innerText: '```python\nprint(1)', children: [pre1] });
  return {
    document: {
      querySelectorAll: (sel: string) => {
        if (sel.includes('markdown')) return [markdown];
        if (sel === 'pre') return [pre1];
        return [];
      },
    },
  };
}

function runScript(script: string, page: { document: unknown } = makePage()): unknown {
  const sandbox: Record<string, unknown> = { document: page.document };
  return vm.runInNewContext(script, sandbox, { timeout: 3000 });
}

describe('采集策略脚本（模拟目标站 DOM）', () => {
  it('code-blocks-with-page-path：带上页面里的路径标题（路径与代码是兄弟节点）', () => {
    const raw = runScript(scriptOf('code-blocks-with-page-path'));
    const texts = normalizeStrategyOutput(raw);
    assert.equal(texts.length, 1);
    const text = texts[0] as string;

    assert.ok(text.includes('### 文件：Mini-AI-IDE-test.md'), `应带上路径标题，实际：${text}`);
    assert.ok(text.includes('```python'), text);
    assert.ok(!text.includes('复制'), text);
    assert.ok(!text.includes('下载'), text);
  });

  it('页面没有路径标题时，仍返回纯代码（不伪造路径）', () => {
    const raw = runScript(scriptOf('code-blocks-with-page-path'), makePageWithoutPath());
    const texts = normalizeStrategyOutput(raw);
    assert.equal(texts.length, 1);
    const text = texts[0] as string;
    assert.ok(!text.includes('### 文件：'), `不应凭空造路径，实际：${text}`);
    assert.ok(text.includes('```python'), text);
  });

  it('采集结果可直接被解析器识别出路径与语言（端到端一致性）', async () => {
    const raw = runScript(scriptOf('code-blocks-with-page-path'));
    const texts = normalizeStrategyOutput(raw);
    const replyText = texts[0] as string;

    const { parseModelReply } = await import('../src/shared/returnPath');
    const parsed = parseModelReply(replyText);
    assert.equal(parsed.blocks.length, 1);
    assert.equal(parsed.blocks[0]?.filePath, 'Mini-AI-IDE-test.md', '路径必须被解析出来（用户不该手填）');
    assert.equal(parsed.blocks[0]?.language, 'python');
    assert.ok((parsed.blocks[0]?.code ?? '').includes('def bubble_sort'));
  });

  it('code-blocks-in-markdown：只取 <pre> 代码，剔除 UI 文本', () => {
    const raw = runScript(scriptOf('code-blocks-in-markdown'));
    const texts = normalizeStrategyOutput(raw);
    assert.equal(texts.length, 1);
    const text = texts[0] as string;

    assert.ok(!text.includes('复制'), `不应包含按钮文字「复制」，实际：${text}`);
    assert.ok(!text.includes('下载'), `不应包含按钮文字「下载」，实际：${text}`);
    assert.ok(!text.includes('文件：'), '次选策略不承诺带路径');
    assert.ok(text.includes('```python'), text);
  });

  it('页面没有代码块时返回空（不伪造结果）', () => {
    const sandbox: Record<string, unknown> = {
      document: {
        querySelectorAll: () => [],
        querySelector: () => null,
      },
    };
    const raw = vm.runInNewContext(scriptOf('code-blocks-in-markdown'), sandbox, { timeout: 3000 });
    // 注意：vm 返回的数组来自另一个 realm，不能用 deepStrictEqual 与本地 [] 比较
    // （原型不同会失败），因此断言长度与归一化结果。
    assert.ok(Array.isArray(raw), '策略必须返回数组');
    assert.equal((raw as unknown[]).length, 0);
    assert.equal(normalizeStrategyOutput(raw).length, 0);
  });

  it('策略表包含 4 套以上、id 唯一、每个脚本都能在无 DOM 内容时安全返回', () => {
    assert.ok(COLLECT_STRATEGIES.length >= 4, `策略数量不足：${COLLECT_STRATEGIES.length}`);
    const ids = COLLECT_STRATEGIES.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `策略 id 必须唯一：${ids.join(',')}`);
    assert.equal(ids[0], 'code-blocks-with-page-path', '首条策略必须优先带上页面级路径');

    for (const s of COLLECT_STRATEGIES) {
      const sandbox: Record<string, unknown> = {
        document: { querySelectorAll: () => [], querySelector: () => null },
      };
      const raw = vm.runInNewContext(s.script, sandbox, { timeout: 3000 });
      assert.ok(Array.isArray(raw), `策略 ${s.id} 必须返回数组`);
      assert.equal((raw as unknown[]).length, 0, `策略 ${s.id} 在空页面应返回空数组`);
    }
  });
});
