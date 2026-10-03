/**
 * 采集消费判定（L2，主进程专用）
 *
 * 目标：**一次采集消费一条回复**。同一条回复被采集过后，再次点「采集回复」
 * 应明确提示「最新回复已采集过，无新内容」，而不是把同一条回复反复解析成变更。
 *
 * ------------------------------------------------------------------
 * 为什么不能把「已消费」标记打在页面上（关键约束）
 * ------------------------------------------------------------------
 * 零注入（ADR-0003）：程序对网页**只读不写**，不能往 DOM 加任何"已读"标记。
 * 因此消费状态只能放在**主进程内存**里，用**内容指纹**比对实现 ——
 * 页面一个字节都不动，状态天然与"用户看到的那条回复"对应。
 *
 * ------------------------------------------------------------------
 * 会话键
 * ------------------------------------------------------------------
 * 用 sanitize 后的 URL pathname（DeepSeek 的会话 ID 在路径里）。
 * 切换会话 → 键变了 → 各自独立，互不干扰；同 URL 换 query（如 ?foo=1）不影响。
 *
 * ------------------------------------------------------------------
 * 生命周期：只放内存，不做持久化
 * ------------------------------------------------------------------
 * 重启后清空 —— 重启后对同一回复需要再确认一次，这是**可接受**的：
 * 持久化会带来"跨会话残留导致的静默不采集"，风险高于收益。
 *
 * ------------------------------------------------------------------
 * 「应用」与「放弃」都算消费（指纹方案自动满足）
 * ------------------------------------------------------------------
 * 采集成功那一刻就记指纹，与用户之后点「应用」还是「放弃」无关。
 *  - 放弃后继续对话 → 页面出现新回复 → 新指纹 → 正常采集；
 *  - 放弃后不对话再采集 → 指纹相同 → 提示无新内容（符合"一次采集一条"的语义）。
 */

export interface ConsumptionRecord {
  /** 内容指纹（sha256 截断） */
  fingerprint: string;
  /** 文本长度（诊断用，不参与判定） */
  length: number;
  /** 记录时间（ISO） */
  at: string;
}

export interface ConsumptionVerdict {
  /** 是否判定为"已消费过（无新内容）" */
  consumed: boolean;
  /** 当前文本指纹（便于诊断） */
  fingerprint: string;
  /** 上一次记录的指纹（没有记录时为 null） */
  previous: string | null;
}

/**
 * 内容指纹：sha256 → 取前 16 位十六进制。
 *
 * 截断到 16 位（64 bit）对"同一会话内避免误判重复"这个用途绰绰有余，
 * 且短、便于写进日志与备注。碰撞概率在实际使用规模下可忽略。
 */
export function fingerprintOf(text: string): string {
  // 用 node:crypto，但保持函数可直接在任意环境调用（惰性 require 避免循环依赖）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 会话键：取 URL 的 origin + pathname（去掉 query / hash）。
 *
 * DeepSeek 的会话 ID 在路径里，因此 pathname 天然区分会话；
 * query 常带追踪参数（会变），必须去掉，否则同一会话会被判成多个键。
 */
export function sessionKeyOf(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(rawUrl);
  }
}

export class ConsumptionStore {
  /** 会话键 → 最近一次已消费的回复记录 */
  private readonly records = new Map<string, ConsumptionRecord>();

  /**
   * 判断"这条回复是否已消费过"，**并在未消费时立刻记录**（一次采集消费一条）。
   *
   * 之所以把"判断"与"记录"合成一步：两者必须原子发生 ——
   * 若分成 `isConsumed()` + `mark()` 两次调用，任何一条分支忘了 mark()
   * 就会导致同一条回复被反复消费（难查的静默缺陷）。
   */
  consume(sessionKey: string, text: string): ConsumptionVerdict {
    const fingerprint = fingerprintOf(text);
    const previous = this.records.get(sessionKey) ?? null;
    if (previous && previous.fingerprint === fingerprint) {
      return { consumed: true, fingerprint, previous: previous.fingerprint };
    }
    this.records.set(sessionKey, { fingerprint, length: text.length, at: new Date().toISOString() });
    return { consumed: false, fingerprint, previous: previous ? previous.fingerprint : null };
  }

  /** 只读查询（不记录）；供诊断与测试 */
  peek(sessionKey: string): ConsumptionRecord | null {
    const r = this.records.get(sessionKey);
    return r ? { ...r } : null;
  }

  /** 清空（供测试与"重新开始"使用） */
  clear(): void {
    this.records.clear();
  }

  /** 当前记录条数（供诊断） */
  get size(): number {
    return this.records.size;
  }
}
