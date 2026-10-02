/**
 * UA 处理（纯逻辑，可单测）
 *
 * 规则来源：ADR-0001「受控实验结论与 UA 规则」。受控实验证明：UA 中**我方自报**的
 * `Electron/<ver>` 与应用名标记会直接触发平台告警；移除后告警消失，而
 * `window.chrome` 缺失、`userAgentData` 无 `Google Chrome`、TLS 差异
 * 全部照旧存在却未触发告警。
 *
 * 因此本模块只做一件事：**移除自我声明标记**。
 *  - 保留真实的 `Chrome/<真实内核版本>`、平台段、`AppleWebKit/537.36`、`Safari/537.36`；
 *  - **禁止**把版本号改成"最新 Chrome"，**禁止**伪造平台。
 *
 * 注意：这是"不自报"，不是"伪装"。内核本来就是该 Chromium 版本。
 */

export interface UserAgentPlan {
  /** 原始 UA（来自 Electron 会话默认值） */
  original: string;
  /** 实际要使用的 UA */
  effective: string;
  /** 被移除的标记 */
  removed: string[];
}

/** 需要移除的自我声明标记（按先后顺序） */
export function stripSelfDeclarations(userAgent: string, appName: string): UserAgentPlan {
  const removed: string[] = [];
  let ua = userAgent;

  const electronMatch = /\s*Electron\/[\d.]+/i.exec(ua);
  if (electronMatch) {
    removed.push(electronMatch[0].trim());
    ua = ua.replace(electronMatch[0], '');
  }

  if (appName) {
    const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const appRe = new RegExp(`\\s*${escaped}\\/[\\d.]+`, 'i');
    const appMatch = appRe.exec(ua);
    if (appMatch) {
      removed.push(appMatch[0].trim());
      ua = ua.replace(appMatch[0], '');
    }
  }

  ua = ua.replace(/\s{2,}/g, ' ').trim();
  return { original: userAgent, effective: ua, removed };
}

/**
 * 自洽性断言：UA 声明的内核主版本必须等于实际内核主版本。
 * 用于启动自检 —— 不一致即告警（app-shell 能力文档第 7 条）。
 */
export interface UaConsistency {
  ok: boolean;
  uaMajor: string | null;
  kernelMajor: string | null;
}

export function checkUaConsistency(userAgent: string, chromiumVersion: string): UaConsistency {
  const m = /Chrome\/(\d+)\./.exec(userAgent);
  const uaMajor = m ? (m[1] as string) : null;
  const kernelMajor = chromiumVersion ? (chromiumVersion.split('.')[0] as string) : null;
  return { ok: uaMajor !== null && kernelMajor !== null && uaMajor === kernelMajor, uaMajor, kernelMajor };
}
