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
    id: 'markdown-body',
    description: '带 markdown 渲染容器的助手消息（取最新一条）',
    script: `(() => {
      const nodes = Array.from(document.querySelectorAll('[class*="markdown"], [class*="ds-markdown"]'));
      const texts = nodes.map((n) => (n.innerText || '').trim()).filter((t) => t.length > 0 && t.includes('\`\`\`'));
      return texts.length > 0 ? [texts[texts.length - 1]] : [];
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
    id: 'pre-blocks-last-group',
    description: '页面里最后连续一组代码块（兜底：按 pre 元素聚合）',
    script: `(() => {
      const pres = Array.from(document.querySelectorAll('pre'));
      if (pres.length === 0) return [];
      // 从最后一个 pre 往上找共同父容器，把同一容器内的 pre 视为同一条回复
      let container = pres[pres.length - 1].parentElement;
      for (let depth = 0; depth < 6 && container; depth += 1) {
        const inside = Array.from(container.querySelectorAll('pre'));
        if (inside.length >= 1) {
          const text = (container.innerText || '').trim();
          if (text.includes('\`\`\`') || inside.length > 0) {
            const joined = inside.map((p) => '\`\`\`\\n' + (p.innerText || '') + '\\n\`\`\`').join('\\n\\n');
            return [joined];
          }
        }
        container = container.parentElement;
      }
      return ['\`\`\`\\n' + (pres[pres.length - 1].innerText || '') + '\\n\`\`\`'];
    })()`,
  },
  {
    id: 'whole-page-fences',
    description: '整页扫描代码块（最后手段，可能在多轮对话里取错）',
    script: `(() => {
      const pres = Array.from(document.querySelectorAll('pre'));
      if (pres.length === 0) return [];
      const joined = pres.map((p) => '\`\`\`\\n' + (p.innerText || '') + '\\n\`\`\`').join('\\n\\n');
      return [joined];
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
