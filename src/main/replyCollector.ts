/**
 * 从网页视图**只读**采集模型回复（回程通道）
 *
 * 铁律（ADR-0003 / ADR-0004）：
 *  - **只读**：不修改页面、不点击、不写入、不派发事件；
 *  - 不依赖任何模型侧接口，不逆向协议；
 *  - 采不到就如实报告"采不到"，**不猜、不退化到截图/OCR**。
 *
 * 现实约束：目标站点的 DOM 结构会变，且我们**不能**靠"改页面"来适配。
 * 因此这里用**多套候选策略**依次尝试，并把"用了哪套策略、命中几条"如实报出来，
 * 便于用户与开发者判断是否需要补策略。
 *
 * ------------------------------------------------------------------
 * 采集判据：**新鲜度优先**（2026-10-03 重设计）
 * ------------------------------------------------------------------
 * 早期判据是"取含 <pre> 最多的 markdown 容器"。它有一个致命缺陷：
 * 多轮对话里每条回复各含 1 个 <pre> 时**全部平局** → 停在文档序**第一个**，
 * 也就是**最旧的回复**；即使不平局，"pre 最多"与"最新"也毫无关系。
 * 实测症状：第一次采集正确（当时会话里只有一条回复），继续对话后再采集拿到的仍是旧回复。
 *
 * 现在的判据只有一条：**文档序最后**（`querySelectorAll` 返回的就是文档序）。
 * 一切与新鲜度无关的判据（pre 最多 / 文本最长）**全部废弃**。
 *
 * ------------------------------------------------------------------
 * 围栏自适应（L3）
 * ------------------------------------------------------------------
 * 最新回复若是 ````markdown 包裹、内容里内嵌 ```python，采集脚本若用写死的三反引号
 * 外围栏，解析器 splitFences 会把**内层的闭合行**误判为外层闭合 → 截断/多出空块。
 * 因此外围栏长度必须按内容自适应：**比内容中最长的连续反引号序列多 1，最少 4**
 * （与提示词组装侧 src/shared/snippet.ts 的 fenceFor 同一规则）。
 */

export interface CollectStrategy {
  /** 策略标识（写进结果，便于诊断） */
  id: string;
  /** 说明（人类可读） */
  description: string;
  /** 在页面里执行的只读脚本，必须返回 string[] */
  script: string;
}

/**
 * 采集脚本里共用的一段**内联工具函数源码**（字符串拼接，注入页面执行）。
 *
 * 抽成常量是为了让三套策略共用同一份实现，避免"围栏自适应只改了一处"这类漂移。
 * 里面的实现必须与 src/shared/snippet.ts 的 `fenceFor` 规则一致。
 */
const COLLECT_HELPERS = `
  // 围栏自适应：比内容中最长的连续反引号多 1，最少 4（与 snippet.ts 的 fenceFor 同规则）
  var fenceFor = function (content) {
    var longest = 0;
    var re = /\\\`+/g;
    var m;
    while ((m = re.exec(content)) !== null) {
      if (m[0].length > longest) longest = m[0].length;
    }
    var n = Math.max(4, longest + 1);
    return new Array(n + 1).join('\\\`');
  };
  // 用自适应围栏把一段纯文本包成代码块
  var fenced = function (lang, src) {
    var f = fenceFor(src);
    return f + (lang || '') + '\\n' + src + '\\n' + f;
  };
  // 从一个 <pre> 取语言标注（取不到就不标，不伪造）
  var langOf = function (pre) {
    try {
      var codeEl = pre.querySelector('code');
      var holder = codeEl || pre;
      var m = /language-([\\w+#-]+)/.exec((holder.className || '').toString());
      return m && m[1] ? m[1] : '';
    } catch (e) { return ''; }
  };
  // 正文用于元数据读取时可以清理展示性空白；代码正文必须逐字保留。
  var cleanText = function (s) {
    return String(s || '').trim();
  };
  // code 的 textContent 是实际代码文本；pre 包裹在 code 外的结构换行与控件自然排除。
  // 没有 code 时无法证明首尾空行是结构性空行，因此原样保留 pre 内容。
  var textOf = function (pre) {
    try {
      var code = pre.querySelector('code');
      var source = code || pre;
      return typeof source.textContent === 'string' ? source.textContent : String(source.innerText || '');
    } catch (e) { throw new Error('无法读取代码框正文'); }
  };
  // 最新 markdown 根语义容器，排除 code 语言类名和回复内嵌套标题。
  // 最新回复没有 pre 时不能回到历史回复；缺失代码框应留给解析器明确诊断。
  var lastMarkdownNode = function () {
    var nodes = document.querySelectorAll('[class*="markdown"]');
    for (var i = nodes.length - 1; i >= 0; i -= 1) {
      var el = nodes[i];
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'PRE' || tag === 'CODE') continue;
      var nested = false;
      var parent = el.parentElement;
      while (parent) {
        if (/markdown/.test(String(parent.className || ''))) { nested = true; break; }
        parent = parent.parentElement;
      }
      if (!nested) return el;
    }
    return null;
  };
  // 按 DOM 顺序保留正文与每个 pre 之前的标题，不能用整条回复最后的线索回填。
  // 非语义代码框控件（语言标签、复制、下载）不参与正文；pre 内只读 code 内容。
  var replyParts = function (root) {
    var parts = [];
    var walk = function (node) {
      var tag = String(node.tagName || '').toUpperCase();
      if (tag === 'PRE') {
        var src = textOf(node);
        parts.push({ pre: node, text: fenced(langOf(node), src) });
        return;
      }
      if (/^(BUTTON|SCRIPT|STYLE|INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (tag === 'HR') { parts.push({ text: '---' }); return; }
      var hasPre = false;
      try { hasPre = node.querySelectorAll('pre').length > 0; } catch (e) { hasPre = false; }
      var children = node.children || [];
      var semantic = /^(H[1-6]|P|LI|BLOCKQUOTE|DT|DD)$/.test(tag);
      var blockChildren = Array.from(children).some(function (child) {
        return !/^(SPAN|STRONG|EM|B|I|A|CODE|BR)$/.test(String(child.tagName || '').toUpperCase());
      });
      if (hasPre || (!semantic && blockChildren)) {
        for (var i = 0; i < children.length; i += 1) walk(children[i]);
        return;
      }
      var text = cleanText(node.innerText) || cleanText(node.textContent);
      if (!text) return;
      var metadata = /^(?:#{1,6}\\s*)?(?:文件|文件名|路径|file|filename|path|操作|operation|上下文文件|上下文|context\\s+file|context|范围|行号|lines?|range)\\s*[:：]/i.test(text.trim());
      var heading = /^H([1-6])$/.exec(tag);
      if (metadata) {
        // 渲染后的标题没有 Markdown #；统一恢复标题，路径不受扩展名或空格限制。
        text = text.trim().replace(/^#{1,6}\\s*/, '').replace(/^([^:：]+)\\s*[:：]\\s*/, '$1：');
        parts.push({ text: '### ' + text });
      } else if (heading) {
        parts.push({ text: new Array(Number(heading[1]) + 1).join('#') + ' ' + text.trim() });
      } else if (/^(P|LI|BLOCKQUOTE|DT|DD)$/.test(tag)) {
        parts.push({ text: text });
      } else {
        var nested = node.children || [];
        for (var j = 0; j < nested.length; j += 1) walk(nested[j]);
      }
    };
    walk(root);
    return parts;
  };
`;

/**
 * 候选策略：**每一层都必须保持「最新」语义**，不接受"有内容就行"。
 *
 *  - S1 最新回复容器（markdown 语义容器，文档序最后一个）内的全部 <pre> 及逐块前置正文；
 *  - S2 该容器整体文本（容器无 pre 时用：纯文本回复 / 结构变化）；
 *  - S3 文档序最后一个 <pre>（结构兜底：最后一个 pre 大概率属于最新回复）。
 */
export const COLLECT_STRATEGIES: CollectStrategy[] = [
  {
    id: 'latest-reply-container',
    description: '最新一条回复容器（文档序最后一个 markdown 容器）内的代码块 + 按文档顺序保留的逐块标题',
    script: `(() => {
      ${COLLECT_HELPERS}
      var node = lastMarkdownNode();
      if (!node) return [];

      var parts = replyParts(node);
      if (!parts.some(function (part) { return part.pre && part.text; })) return [];
      return [parts.map(function (part) { return part.text; }).filter(Boolean).join('\\n\\n')];
    })()`,
  },
  {
    id: 'latest-reply-container-text',
    description: '最新一条回复容器的整体文本（容器内没有 <pre> 时用：纯文本回复）',
    script: `(() => {
      ${COLLECT_HELPERS}
      var node = lastMarkdownNode();
      if (!node) return [];
      var parts = replyParts(node);
      if (parts.some(function (part) { return part.pre; })) {
        return [parts.map(function (part) { return part.text; }).filter(Boolean).join('\\n\\n')];
      }
      // 原样输出的围栏与正文不删首尾空白。没有代码框就不能凭空添加围栏，
      // 否则「只有文件/操作标题」会被伪造成可写入的代码块。
      var t = typeof node.textContent === 'string' ? node.textContent : String(node.innerText || '');
      if (t.indexOf('\\\`\\\`\\\`') !== -1) return [t];
      if (parts.length > 0) return [parts.map(function (part) { return part.text; }).filter(Boolean).join('\\n\\n')];
      return t.trim().length > 0 ? [t] : [];
    })()`,
  },
  {
    id: 'last-pre-in-document',
    description: '文档序最后一个 <pre>（结构兜底：最后一个代码块大概率属于最新回复）',
    script: `(() => {
      ${COLLECT_HELPERS}
      var pres = document.querySelectorAll('pre');
      if (pres.length === 0) return [];
      var last = pres[pres.length - 1];
      var latest = lastMarkdownNode();
      if (latest) {
        var latestPres = latest.querySelectorAll('pre');
        if (latestPres.length === 0 || latestPres[latestPres.length - 1] !== last) return [];
      }
      // 只保留上一代码块之后、目标代码块之前的上下文，不能跨块借用路径或操作。
      var holder = null;
      try { holder = last.closest('[class*="markdown"]'); } catch (e) { holder = null; }
      var parts = replyParts(holder || last);
      var start = 0;
      for (var i = 0; i < parts.length; i += 1) {
        if (parts[i].pre === last) {
          return [parts.slice(start, i + 1).map(function (part) { return part.text; }).filter(Boolean).join('\\n\\n')];
        }
        if (parts[i].pre) start = i + 1;
      }
      return [];
    })()`,
  },
];

export interface CollectAttempt {
  strategyId: string;
  description: string;
  /** 是否返回了非空文本 */
  ok: boolean;
  /** 返回文本的字符数 */
  length: number;
  error?: string;
}

/**
 * 页面结构诊断（只读）：采集失败时用来回答"页面上到底有什么"。
 *
 * 为什么需要：目标站点结构随时可能变化，而我们**不能改页面**去适配。
 * 失败时若只报"没采到"，就只能靠猜；报出各候选选择器的命中数，
 * 才能判断是"选择器过期"还是"页面确实没输出"。
 */
export const DIAGNOSTIC_SCRIPT = `(() => {
  const probe = (sel) => { try { return document.querySelectorAll(sel).length; } catch (e) { return -1; } };
  return {
    url: location.href,
    title: document.title,
    counts: {
      pre: probe('pre'),
      code: probe('code'),
      markdown: probe('[class*="markdown"]'),
      dsMarkdown: probe('[class*="ds-markdown"]'),
      assistant: probe('[class*="assistant"]'),
      dataRoleAssistant: probe('[data-role="assistant"]'),
      messageAuthorRole: probe('[data-message-author-role="assistant"]'),
      textarea: probe('textarea'),
    },
    bodyTextLength: (document.body && (document.body.innerText || '').length) || 0,
    bodyHasFence: Boolean(document.body && (document.body.innerText || '').includes('\`\`\`')),
  };
})()`;

/** 诊断结果形状 */
export interface PageDiagnostic {
  url: string;
  title: string;
  counts: Record<string, number>;
  bodyTextLength: number;
  bodyHasFence: boolean;
}

/** 采集结果里附加的诊断信息（仅失败时抓取，避免每次采集都多跑一次脚本） */
export interface CollectResult {
  collectedAt: string;
  /** 最终采用的策略 id；null 表示所有策略都没采到 */
  strategyId: string | null;
  strategyDescription: string | null;
  /** 采集到的回复原文（未解析） */
  replyText: string;
  /** 逐个策略的尝试记录（诊断用） */
  attempts: CollectAttempt[];
  /** 页面 URL（去掉 query） */
  url: string;
  /** 失败时抓取的页面结构诊断 */
  diagnostic?: PageDiagnostic;
}

/** 每个策略的返回值必须是 string[]；这里做类型收敛与安全兜底 */
export function normalizeStrategyOutput(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

export interface CollectRunner {
  /** 在页面里执行只读脚本；由调用方注入（便于单测与替换） */
  evaluate(script: string): Promise<unknown>;
  /** 取当前页面 URL */
  currentUrl(): string;
}

/**
 * 依次尝试各策略，返回第一个成功的采集结果。
 * 全部失败时 `strategyId` 为 null，并把每次尝试的失败原因报出来。
 */
export async function collectReply(runner: CollectRunner): Promise<CollectResult> {
  const attempts: CollectAttempt[] = [];
  const collectedAt = new Date().toISOString();
  const url = sanitize(runner.currentUrl());

  for (const strategy of COLLECT_STRATEGIES) {
    try {
      const raw = await runner.evaluate(strategy.script);
      const texts = normalizeStrategyOutput(raw);
      const text = texts.length > 0 ? (texts[texts.length - 1] as string) : '';
      attempts.push({
        strategyId: strategy.id,
        description: strategy.description,
        ok: text.length > 0,
        length: text.length,
      });
      if (text.length > 0) {
        return {
          collectedAt,
          strategyId: strategy.id,
          strategyDescription: strategy.description,
          replyText: text,
          attempts,
          url,
        };
      }
    } catch (err) {
      attempts.push({
        strategyId: strategy.id,
        description: strategy.description,
        ok: false,
        length: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 全部失败：抓一份页面结构诊断，便于判断"选择器过期"还是"页面没输出"
  let diagnostic: PageDiagnostic | undefined;
  try {
    const raw = (await runner.evaluate(DIAGNOSTIC_SCRIPT)) as Partial<PageDiagnostic> | null;
    if (raw && typeof raw === 'object') {
      diagnostic = {
        url: sanitize(String(raw.url ?? url)),
        title: String(raw.title ?? ''),
        counts: (raw.counts ?? {}) as Record<string, number>,
        bodyTextLength: typeof raw.bodyTextLength === 'number' ? raw.bodyTextLength : 0,
        bodyHasFence: Boolean(raw.bodyHasFence),
      };
    }
  } catch {
    /* 诊断本身失败不影响主流程 */
  }

  return {
    collectedAt,
    strategyId: null,
    strategyDescription: null,
    replyText: '',
    attempts,
    url,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function sanitize(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(rawUrl);
  }
}
