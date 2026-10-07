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
import { parseToolBatch } from '../src/shared/toolProtocol';

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
  readonly parentElement: FakeNode | null;
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
    get parentElement() { return self.parent; },
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

/** 用给定的一串回复容器搭出页面 */
function pageOf(replies: Array<{ node: FakeNode }>): { document: unknown } {
  const body = fakeEl('body', '', 'page');
  for (const r of replies) link(body, r.node);
  return { document: { querySelectorAll: (s: string) => body.querySelectorAll(s) } };
}

function runScript(id: string, page: { document: unknown }): string[] {
  return Array.from(normalizeStrategyOutput(vm.runInNewContext(scriptOf(id), { document: page.document }, { timeout: 3000 })));
}

function appendBlock(container: FakeNode, file: string | null, operation: string | null, code: string, language = '', tag = 'h3'): FakeNode {
  if (file) link(container, fakeEl(tag, '', '文件： ' + file));
  if (operation) link(container, fakeEl(tag, '', '操作： ' + operation));
  const pre = link(container, fakeEl('pre', '', '\n' + code + '\n'));
  link(pre, fakeEl('code', language ? 'language-' + language : '', code));
  return pre;
}

function replyPage(code: string, operation = '覆盖全文', language = 'typescript'): { document: unknown } {
  const container = fakeEl('div', 'ds-markdown');
  appendBlock(container, 'src/example.ts', operation, code, language);
  return pageOf([{ node: container }]);
}

const ALL_STRATEGIES = COLLECT_STRATEGIES.map((strategy) => strategy.id);

describe('采集策略脚本（只读 DOM）', () => {
  for (const id of ALL_STRATEGIES) {
    it(`${id}：逐字保留缩进、Tab、尾部空格、首尾空行和末尾换行`, () => {
      const code = '\n\t  first();  \n\n  last();\t\n\n';
      const text = runScript(id, replyPage(code))[0] as string;
      assert.equal(text, '### 文件：src/example.ts\n\n### 操作：覆盖全文\n\n````typescript\n' + code + '\n````');
    });

    for (const operation of ['新建', '覆盖全文']) {
      it(`${id}：明确${operation}的空 pre 仍保留真实完整围栏`, () => {
        const text = runScript(id, replyPage('', operation, ''))[0] as string;
        assert.equal(text, `### 文件：src/example.ts\n\n### 操作：${operation}\n\n` + '````\n\n````');
      });
    }

    it(`${id}：只有空格、Tab 与换行的代码不当作空内容`, () => {
      const code = '  \t\n\t  \n';
      const text = runScript(id, replyPage(code))[0] as string;
      assert.ok(text.includes('````typescript\n' + code + '\n````'), JSON.stringify(text));
    });
  }

  it('替换、新建、覆盖全文及上下文标签均按 DOM 顺序保留，语言标签不参与操作推断', async () => {
    const container = fakeEl('div', 'ds-markdown');
    const replacement = '<<<<<<< SEARCH\n\told();  \n=======\n\tnew();  \n>>>>>>> REPLACE';
    appendBlock(container, 'src/first.ts', '替换', replacement, '', 'p');
    link(container, fakeEl('hr'));
    appendBlock(container, 'backend/.env', '新建', 'PORT=3000\n', 'text');
    appendBlock(container, 'backend/prisma/schema.prisma', '覆盖全文', 'model Product {\n  id Int @id\n}\n', 'prisma');
    link(container, fakeEl('p', '', '上下文文件：src/read-only.ts'));
    link(container, fakeEl('p', '', '上下文：完整原文'));
    link(container, fakeEl('pre', '', 'original()', [fakeEl('code', '', 'original()')]));
    link(container, fakeEl('h2', '', '手动运行'));
    link(container, fakeEl('pre', '', 'npm install', [fakeEl('code', 'language-bash', 'npm install')]));
    const text = runScript('latest-reply-container', pageOf([{ node: container }]))[0] as string;
    const { parseModelReply } = await import('../src/shared/returnPath');
    const parsed = parseModelReply(text);
    assert.equal(parsed.blocks.length, 5);
    assert.deepEqual(parsed.blocks.slice(0, 3).map((block) => block.filePath), ['src/first.ts', 'backend/.env', 'backend/prisma/schema.prisma']);
    assert.deepEqual(parsed.blocks.slice(0, 3).map((block) => block.operation), ['replace', 'create', 'overwrite']);
    assert.ok(parsed.blocks.slice(0, 3).every((block) => !block.validationError));
    assert.equal(parsed.blocks[3]?.kind, 'other');
    assert.equal(parsed.blocks[4]?.kind, 'other');
    assert.equal(parsed.blocks[4]?.filePath, null, '运行命令不能借用先前文件标题');
  });

  it('多块的路径、操作不会借给后续缺少元数据的代码框', async () => {
    const container = fakeEl('div', 'ds-markdown');
    appendBlock(container, 'src/first.ts', '新建', 'first()');
    appendBlock(container, null, null, 'second()');
    const page = pageOf([{ node: container }]);
    const { parseModelReply } = await import('../src/shared/returnPath');
    for (const id of ALL_STRATEGIES) {
      const text = runScript(id, page)[0] as string;
      const parsed = parseModelReply(text);
      const last = parsed.blocks[parsed.blocks.length - 1];
      assert.equal(last?.filePath, null, id);
      assert.equal(last?.operation, undefined, id);
      assert.equal(last?.kind, 'other', id);
    }
  });

  it('S3 只带最后块之前的标题，块之后的未来操作不能向前回填', async () => {
    const container = fakeEl('div', 'ds-markdown');
    appendBlock(container, 'first.ts', '新建', 'first()');
    appendBlock(container, 'last.ts', '覆盖全文', 'last()');
    link(container, fakeEl('h3', '', '文件：future.ts'));
    link(container, fakeEl('h3', '', '操作：新建'));
    const text = runScript('last-pre-in-document', pageOf([{ node: container }]))[0] as string;
    assert.equal(text, '### 文件：last.ts\n\n### 操作：覆盖全文\n\n````\nlast()\n````');
  });

  it('代码框复制、下载、语言工具栏与 pre 外包裹换行都不污染 code 内容', () => {
    const container = fakeEl('div', 'ds-markdown');
    link(container, fakeEl('h3', '', '文件：src/clean.ts'));
    link(container, fakeEl('p', '', '操作：新建'));
    const chrome = link(container, fakeEl('div', 'code-block'));
    link(chrome, fakeEl('div', 'toolbar', 'typescript 复制 下载', [fakeEl('span', '', 'typescript'), fakeEl('button', '', '复制'), fakeEl('button', '', '下载')]));
    link(chrome, fakeEl('pre', '', '\n复制\n下载\nwrong display\n', [fakeEl('code', 'language-typescript', '\tcorrect();  \n')]));
    for (const id of ALL_STRATEGIES) {
      const text = runScript(id, pageOf([{ node: container }]))[0] as string;
      assert.equal(text, '### 文件：src/clean.ts\n\n### 操作：新建\n\n````typescript\n\tcorrect();  \n\n````');
    }
  });

  it('正式工具语言只出现在代码框工具栏时，三套采集策略仍保留协议和完整 JSON', () => {
    const container = fakeEl('div', 'ds-markdown');
    const chrome = link(container, fakeEl('div', 'code-block'));
    link(chrome, fakeEl('div', 'toolbar', 'mini-ai-tools 复制 下载', [fakeEl('span', '', 'mini-ai-tools'), fakeEl('button', '', '复制'), fakeEl('button', '', '下载')]));
    const source = JSON.stringify({ protocol_version: 1, batch_id: 'visible-language', requests: [{ id: 'create', tool: 'apply_changes', args: { changes: [{ path: 'tool-samples/中文 空格.txt', operation: 'create', content: '第一行\nTODO literal a.*\n第三行\n' }] } }] });
    link(chrome, fakeEl('pre', '', source, [fakeEl('code', '', source)]));
    for (const id of ALL_STRATEGIES) {
      const text = runScript(id, pageOf([{ node: container }]))[0] as string;
      assert.equal(text, '````mini-ai-tools\n' + source + '\n````', id);
      assert.equal(parseToolBatch(text).kind, 'batch', id);
    }
  });

  it('正文提及协议、代码正文及另一代码框的标签不能给普通 JSON 授权', () => {
    const source = JSON.stringify({ protocol_version: 1, batch_id: 'discussion', requests: [{ id: 'query', tool: 'get_project_info', args: {} }] });
    const container = fakeEl('div', 'ds-markdown');
    link(container, fakeEl('p', '', 'mini-ai-tools'));
    const earlier = link(container, fakeEl('div', 'code-block'));
    link(earlier, fakeEl('div', 'toolbar', 'mini-ai-tools', [fakeEl('span', '', 'mini-ai-tools')]));
    link(earlier, fakeEl('pre', '', '示例资料', [fakeEl('code', 'language-text', '示例资料')]));
    const latest = link(container, fakeEl('div', 'code-block'));
    link(latest, fakeEl('div', 'toolbar', 'json 复制', [fakeEl('span', '', 'json'), fakeEl('button', '', '复制')]));
    link(latest, fakeEl('pre', '', source, [fakeEl('code', '', source)]));
    for (const id of ALL_STRATEGIES) {
      const text = runScript(id, pageOf([{ node: container }]))[0] as string;
      assert.equal(parseToolBatch(text).kind, 'none', id);
      assert.ok(text.includes('````json\n' + source), id);
    }
    const noLabel = fakeEl('div', 'ds-markdown');
    link(noLabel, fakeEl('pre', '', source, [fakeEl('code', '', source)]));
    assert.equal(parseToolBatch(runScript('latest-reply-container', pageOf([{ node: noLabel }]))[0]!).kind, 'none', '不能从 JSON 结构猜测正式协议');
  });

  it('没有 code 子节点时无法证明 pre 首尾空行属于结构，必须原样保留', () => {
    const container = fakeEl('div', 'ds-markdown');
    link(container, fakeEl('p', '', '文件：text.txt'));
    link(container, fakeEl('p', '', '操作：新建'));
    link(container, fakeEl('pre', '', '\n\ttext  \n\n'));
    for (const id of ALL_STRATEGIES) {
      const text = runScript(id, pageOf([{ node: container }]))[0] as string;
      assert.ok(text.endsWith('````\n\n\ttext  \n\n\n````'), JSON.stringify(text));
    }
  });

  it('代码含四反引号时围栏加长，正文与空行完整保留', async () => {
    const code = '\n示例：\n````typescript\n\tvalue();  \n````\n\n';
    const text = runScript('latest-reply-container', replyPage(code, '新建', 'markdown'))[0] as string;
    assert.ok(text.includes('`````markdown\n' + code + '\n`````'), text);
    const { parseModelReply } = await import('../src/shared/returnPath');
    assert.equal(parseModelReply(text).blocks[0]?.code, code);
  });

  it('S2 不添加不存在的代码围栏，只有操作标题时必须报告缺失内容', async () => {
    const rawText = '### 文件：empty.txt\n### 操作：新建';
    const container = fakeEl('div', 'ds-markdown', rawText);
    const text = runScript('latest-reply-container-text', pageOf([{ node: container }]))[0] as string;
    assert.equal(text, rawText);
    const { parseModelReply } = await import('../src/shared/returnPath');
    const parsed = parseModelReply(text);
    assert.ok(parsed.blocks.some((block) => block.validationError));
  });

  it('S2 原样回复包含围栏时不删主体的首尾空白', () => {
    const rawText = '\n### 文件：white.txt\n### 操作：新建\n````text\n\n\ttext  \n\n````\n';
    const container = fakeEl('div', 'ds-markdown', rawText);
    assert.equal(runScript('latest-reply-container-text', pageOf([{ node: container }]))[0], rawText);
  });

  it('最新回复优先，历史块更多也不能回填旧文件或操作', () => {
    const old = fakeEl('div', 'ds-markdown');
    appendBlock(old, 'old.ts', '新建', 'old1()');
    appendBlock(old, 'old.ts', '覆盖全文', 'old2()');
    const latest = fakeEl('div', 'ds-markdown');
    appendBlock(latest, '最新 阅读笔记.md', '覆盖全文', 'latest()', 'markdown');
    for (const id of ALL_STRATEGIES) {
      const text = runScript(id, pageOf([{ node: old }, { node: latest }]))[0] as string;
      assert.ok(text.includes('最新 阅读笔记.md'), text);
      assert.ok(!text.includes('old.ts'), text);
      assert.ok(text.includes('latest()'), text);
    }
  });

  it('最新只有文件/操作标题时，不采集历史代码且保留缺失代码诊断', async () => {
    const old = fakeEl('div', 'ds-markdown');
    appendBlock(old, 'old.ts', '覆盖全文', 'old()');
    const latest = fakeEl('div', 'ds-markdown');
    link(latest, fakeEl('h3', 'ds-markdown-title', '文件：empty.txt'));
    link(latest, fakeEl('p', '', '操作：新建'));
    const page = pageOf([{ node: old }, { node: latest }]);
    assert.equal(runScript('latest-reply-container', page).length, 0);
    assert.equal(runScript('last-pre-in-document', page).length, 0);
    const text = runScript('latest-reply-container-text', page)[0] as string;
    assert.equal(text, '### 文件：empty.txt\n\n### 操作：新建');
    const { parseModelReply } = await import('../src/shared/returnPath');
    assert.ok(parseModelReply(text).blocks.some((block) => block.validationError));
  });

  it('最新纯正文无 pre 时，不退回旧代码，嵌套 markdown 标题不冒充回复根', () => {
    const old = fakeEl('div', 'ds-markdown');
    appendBlock(old, 'old.ts', '新建', 'old()');
    const latest = fakeEl('div', 'ds-markdown');
    link(latest, fakeEl('h2', 'ds-markdown-title', '说明'));
    link(latest, fakeEl('p', '', '本次只解释，不修改文件。'));
    const page = pageOf([{ node: old }, { node: latest }]);
    assert.equal(runScript('latest-reply-container', page).length, 0);
    assert.equal(runScript('last-pre-in-document', page).length, 0);
    const text = runScript('latest-reply-container-text', page)[0] as string;
    assert.ok(text.includes('本次只解释'), text);
    assert.ok(!text.includes('old.ts'), text);
  });

  it('语言缺失和 shell 文件都保持显式操作，代码语言不决定是否是文件', async () => {
    const container = fakeEl('div', 'ds-markdown');
    appendBlock(container, 'scripts/setup.sh', '新建', 'npm install\n', 'bash');
    appendBlock(container, 'Dockerfile', '新建', 'FROM node\n', '');
    const text = runScript('latest-reply-container', pageOf([{ node: container }]))[0] as string;
    const { parseModelReply } = await import('../src/shared/returnPath');
    const parsed = parseModelReply(text);
    assert.equal(parsed.blocks[0]?.operation, 'create');
    assert.equal(parsed.blocks[1]?.operation, 'create');
    assert.ok(parsed.blocks.every((block) => block.kind !== 'other'));
  });

  it('普通回复无代码框时 S1 不伪造代码，S2 返回说明文本', () => {
    const container = fakeEl('div', 'ds-markdown', '没有代码，只是说明。');
    const page = pageOf([{ node: container }]);
    assert.deepEqual(runScript('latest-reply-container', page), []);
    assert.equal(runScript('latest-reply-container-text', page)[0], '没有代码，只是说明。');
  });

  it('正文读取失败不可伪装成合法空文件，三套策略都明确报错', async () => {
    const container = fakeEl('div', 'ds-markdown');
    const pre = appendBlock(container, 'empty.txt', '覆盖全文', 'original');
    const code = pre.querySelector('code')!;
    Object.defineProperty(code, 'textContent', { get() { throw new Error('unreadable'); } });
    const page = pageOf([{ node: container }]);
    const result = await collectReply({
      evaluate: async (script) => vm.runInNewContext(script, { document: page.document, location: { href: 'https://example.com' } }, { timeout: 3000 }),
      currentUrl: () => 'https://example.com',
    });
    assert.equal(result.replyText, '');
    assert.equal(result.strategyId, null);
    assert.ok(result.attempts.every((attempt) => !attempt.ok && /无法读取代码框正文/.test(attempt.error || '')));
  });

  it('策略 id 稳定且唯一，空页面安全返回；collectReply 全失败附带诊断', async () => {
    assert.deepEqual(ALL_STRATEGIES, ['latest-reply-container', 'latest-reply-container-text', 'last-pre-in-document']);
    const empty = { querySelectorAll: () => [], querySelector: () => null };
    for (const id of ALL_STRATEGIES) assert.deepEqual(runScript(id, { document: empty }), []);
    const result = await collectReply({
      evaluate: async (script) => vm.runInNewContext(script, { document: empty, location: { href: 'https://x/y' } }, { timeout: 3000 }),
      currentUrl: () => 'https://example.com/chat?q=1',
    });
    assert.equal(result.strategyId, null);
    assert.equal(result.replyText, '');
    assert.ok(result.diagnostic);
    assert.equal(result.url, 'https://example.com/chat');
  });
});
