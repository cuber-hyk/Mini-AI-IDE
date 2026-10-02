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
 * 采集内容刻意与"预览"处理分离：本模块只负责拿到**文本**，
 * 解析（围栏/路径/行区间）交给 src/shared/returnPath.ts 的纯函数。
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
 * 候选策略：从"最具体的助手消息容器"到"最泛的代码块"逐步降级。
 *
 * 说明：
 *  - 每套策略先排出若干候选节点，再从中取**最靠后**的一个（最新一条回复）；
 *  - 只读 `innerText` / `textContent`，不做任何 DOM 变更；
 *  - 不用 CSS 类名做语义判断（类名是构建产物，随时变），只用结构特征与属性标记。
 */
export const COLLECT_STRATEGIES: CollectStrategy[] = [
  {
    id: 'code-blocks-with-page-path',
    description: '页面里的路径标题（### 文件：…）+ markdown 容器内的 <pre> 代码块',
    script: `(() => {
      const build = (pres) => pres
        .map((p) => {
          const codeEl = p.querySelector('code');
          const src = ((p.innerText || '').trim() || (p.textContent || '').trim());
          if (!src) return '';
          let lang = '';
          try {
            const holder = codeEl || p;
            const m = /language-([\\w+#-]+)/.exec((holder.className || '').toString());
            if (m && m[1]) lang = m[1];
          } catch (e) { /* 忽略 */ }
          return '\`\`\`' + lang + '\\n' + src + '\\n\`\`\`';
        })
        .filter((t) => t.length > 0)
        .join('\\n\\n');

      // 1) 页面级路径：按“### 文件：xxx”扫描**整页文本节点**，取最后一条（最新回复）
      //    这样处理是刻意的：目标站点把标题与代码块渲染成**兄弟节点**，
      //    路径并不在代码块所在容器内部，只抓 <pre> 会丢掉它。
      let pathHint = '';
      try {
        const all = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,span,strong'));
        for (let i = all.length - 1; i >= 0; i -= 1) {
          const el = all[i];
          // 只取“自身文本很短”的节点，避免命中整页容器
          const own = (el.textContent || '').trim();
          if (own.length === 0 || own.length > 120) continue;
          const m = /(?:文件|文件名|路径|file|filename|path)\\s*[:：]\\s*([^\\s\`]+\\.[A-Za-z0-9]+)/.exec(own);
          if (m && m[1]) { pathHint = m[1]; break; }
        }
      } catch (e) { /* 忽略 */ }

      // 2) 代码块：选含 <pre> 最多的 markdown 容器
      const preOf = (root) => Array.from(root.querySelectorAll('pre'));
      let node = null;
      let bestCount = 0;
      for (const el of document.querySelectorAll('[class*="markdown"]')) {
        const n = preOf(el).length;
        if (n > bestCount) { bestCount = n; node = el; }
      }
      let code = node ? build(preOf(node)) : '';
      if (!code) {
        const groups = new Map();
        for (const p of document.querySelectorAll('pre')) {
          const holder = p.closest('[class*="markdown"]') || p.parentElement;
          if (!holder) continue;
          const arr = groups.get(holder) || [];
          arr.push(p);
          groups.set(holder, arr);
        }
        let chosen = null;
        let max = 0;
        for (const [holder, pres] of groups) {
          if (pres.length > max) { max = pres.length; chosen = holder; }
        }
        if (chosen) code = build(groups.get(chosen) || []);
      }

      if (!code) return [];
      // 把路径作为首行“### 文件：”带上，交给解析器的既有线索处理
      return [pathHint ? '### 文件：' + pathHint + '\\n\\n' + code : code];
    })()`,
  },
  {
    id: 'code-blocks-in-markdown',
    description: '仅 markdown 容器内的 <pre> 代码块（不含路径；无页面级路径时的次选）',
    script: `(() => {
      const preOf = (root) => Array.from(root.querySelectorAll('pre'));
      const build = (pres) => pres
        .map((p) => {
          const codeEl = p.querySelector('code');
          const src = ((p.innerText || '').trim() || (p.textContent || '').trim());
          if (!src) return '';
          let lang = '';
          try {
            const holder = codeEl || p;
            const m = /language-([\\w+#-]+)/.exec((holder.className || '').toString());
            if (m && m[1]) lang = m[1];
          } catch (e) { /* 忽略 */ }
          return '\`\`\`' + lang + '\\n' + src + '\\n\`\`\`';
        })
        .filter((t) => t.length > 0)
        .join('\\n\\n');

      let node = null;
      let bestCount = 0;
      for (const el of document.querySelectorAll('[class*="markdown"]')) {
        const n = preOf(el).length;
        if (n > bestCount) { bestCount = n; node = el; }
      }
      if (node) {
        const text = build(preOf(node));
        if (text) return [text];
      }
      const groups = new Map();
      for (const p of document.querySelectorAll('pre')) {
        const holder = p.closest('[class*="markdown"]') || p.parentElement;
        if (!holder) continue;
        const arr = groups.get(holder) || [];
        arr.push(p);
        groups.set(holder, arr);
      }
      let chosen = null;
      let max = 0;
      for (const [holder, pres] of groups) {
        if (pres.length > max) { max = pres.length; chosen = holder; }
      }
      if (chosen) return [build(groups.get(chosen) || [])];
      return [];
    })()`,
  },
  {
    id: 'last-message-text',
    description: '含围栏的最长一段容器文本（次选；可能夹带少量 UI 文本）',
    script: `(() => {
      let bestText = '';
      for (const el of document.querySelectorAll('[class*="markdown"]')) {
        const t = (el.innerText || '').trim();
        if (t.indexOf('\`\`\`') === -1) continue;
        if (t.length > bestText.length) bestText = t;
      }
      return bestText ? [bestText] : [];
    })()`,
  },
  {
    id: 'assistant-role-attr',
    description: '带 role/data-role/class 语义的助手消息（取最新一条）',
    script: `(() => {
      const sel = '[data-role="assistant"], [data-message-author-role="assistant"], [class*="assistant"], [class*="answer"]';
      const nodes = Array.from(document.querySelectorAll(sel));
      const texts = nodes.map((n) => (n.innerText || '').trim()).filter((t) => t.includes('\`\`\`'));
      return texts.length > 0 ? [texts[texts.length - 1]] : [];
    })()`,
  },
  {
    id: 'whole-page-fences',
    description: '整页 <pre> 代码块（最后手段，多轮对话里可能取错）',
    script: `(() => {
      const pres = Array.from(document.querySelectorAll('pre'));
      if (pres.length === 0) return [];
      const joined = pres
        .map((p) => {
          const src = ((p.innerText || '').trim() || (p.textContent || '').trim());
          return src ? '\`\`\`\\n' + src + '\\n\`\`\`' : '';
        })
        .filter((t) => t.length > 0)
        .join('\\n\\n');
      return joined ? [joined] : [];
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
