/**
 * 路径白名单（纯逻辑，可单测）
 *
 * 规则（ADR-0002）：文件系统访问仅限主进程；目标路径必须落在用户显式打开的根目录之内。
 * 越界一律拒绝 —— 包括 `..` 穿越、绝对路径越界、大小写/分隔符变体。
 *
 * 本模块只做**字符串与路径语义**判断，不触碰文件系统，因此可独立测试。
 */
import * as path from 'node:path';

/** 文件及目录创建统一使用 Windows 条目名称规则。 */
export function validateEntryName(name: unknown): string | null {
  if (typeof name !== 'string' || !name || name !== name.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) return '名称不能为空或包含 Windows 不允许的字符';
  if (name === '.' || name === '..' || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) return '不能使用 Windows 保留名称';
  if (name.length > 255) return '名称过长';
  return null;
}

export type PathVerdict =
  | { ok: true; absolute: string; relative: string }
  | { ok: false; reason: 'outside-root' | 'invalid'; detail: string };

/**
 * 归一化根目录（用于后续比较）。
 * 在 Windows 上大小写不敏感，统一小写比较；同时统一分隔符。
 */
function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 判断 target 是否位于 root 之内（含 root 自身） */
export function isInsideRoot(root: string, target: string): boolean {
  const r = normalizeForCompare(root);
  const t = normalizeForCompare(target);
  if (t === r) return true;
  const withSep = r.endsWith(path.sep) ? r : r + path.sep;
  return t.startsWith(withSep);
}

/**
 * 校验一个待访问路径。
 * @param root 用户显式打开的根目录（绝对路径）
 * @param candidate 待访问路径（绝对或相对 root 的路径）
 */
export function resolveWithinRoot(root: string, candidate: string): PathVerdict {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return { ok: false, reason: 'invalid', detail: '路径为空' };
  }
  if (candidate.includes('\0')) {
    return { ok: false, reason: 'invalid', detail: '路径包含 NUL 字符' };
  }

  const absoluteRoot = path.resolve(root);
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(absoluteRoot, candidate);

  if (!isInsideRoot(absoluteRoot, absolute)) {
    return {
      ok: false,
      reason: 'outside-root',
      detail: `目标路径不在已打开的根目录内：${absolute}`,
    };
  }

  const relative = path.relative(absoluteRoot, absolute);
  return { ok: true, absolute, relative };
}

/**
 * 列出根目录下的条目（纯逻辑部分：过滤 + 排序 + 深度/数量限制）。
 * 实际的 fs 读取由调用方完成，这里只决定"该展示哪些、以什么顺序"。
 */
export interface DirEntryLike {
  name: string;
  isDirectory: boolean;
}

export interface ListPolicy {
  /** 单目录最多返回多少条 */
  maxEntries: number;
  /** 是否隐藏以点开头的条目 */
  hideDotfiles: boolean;
  /** 跳过的目录名（与 node_modules 同理的大目录） */
  skipDirs: readonly string[];
}

export const DEFAULT_LIST_POLICY: ListPolicy = {
  maxEntries: 500,
  hideDotfiles: true,
  skipDirs: ['node_modules', '.git', 'dist', 'out', 'build'],
};

export function filterAndSortEntries(
  entries: readonly DirEntryLike[],
  policy: ListPolicy = DEFAULT_LIST_POLICY
): { shown: DirEntryLike[]; truncated: boolean } {
  const kept = entries.filter((e) => {
    if (policy.hideDotfiles && e.name.startsWith('.')) return false;
    if (e.isDirectory && policy.skipDirs.includes(e.name)) return false;
    return true;
  });
  // 目录在前，再按名称排序（稳定、可预测）
  kept.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  const truncated = kept.length > policy.maxEntries;
  return { shown: truncated ? kept.slice(0, policy.maxEntries) : kept, truncated };
}
