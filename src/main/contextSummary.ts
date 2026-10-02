/**
 * 工作环境摘要（主进程专用，**只读**）
 *
 * 用途：为"复制 prompt"提供上下文——当前工作目录、目录树摘要、运行环境。
 * 这些信息由用户手动粘贴到提示词里（程序不写网页，见 ADR-0003）。
 *
 * 边界：
 *  - 只读取**已打开根目录**内的结构，不越界；
 *  - 只输出相对路径（不把绝对路径以外的隐私信息写进 prompt 之外的任何地方）；
 *  - 刻意**不包含"当前打开的文件"** —— 编辑器里打开的文件与待改文件未必相关，
 *    把它塞进上下文会让模型误以为要改那个文件（用户明确要求排除）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ContextSummary } from '../shared/contract';
import { DEFAULT_LIST_POLICY } from '../shared/pathGuard';

const MAX_TREE_LINES = 120;
const MAX_DEPTH = 3;

/** 运行环境摘要（如实给出，不伪造） */
export function describeEnvironment(): string {
  const osPart = `${os.type()} ${os.release()} (${process.arch})`;
  const nodePart = `Node ${process.versions.node}`;
  const chromium = process.versions.chrome;
  const chromiumPart = chromium ? `Chromium ${chromium.split('.')[0]}` : '';
  return [osPart, nodePart, chromiumPart].filter((s) => s.length > 0).join('；');
}

/**
 * 生成目录树摘要（相对路径，目录在前，深度与数量均截断）。
 * 返回 `{ tree, truncated }`；无法读取时 tree 为 null。
 */
export function describeTree(root: string | null): { tree: string | null; truncated: boolean } {
  if (!root) return { tree: null, truncated: false };

  const lines: string[] = [];
  let truncated = false;

  const walk = (absDir: string, depth: number, prefix: string): void => {
    if (truncated || depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const kept = entries
      .filter((e) => {
        if (DEFAULT_LIST_POLICY.hideDotfiles && e.name.startsWith('.')) return false;
        if (e.isDirectory() && DEFAULT_LIST_POLICY.skipDirs.includes(e.name)) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });

    for (const e of kept) {
      if (lines.length >= MAX_TREE_LINES) {
        truncated = true;
        return;
      }
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      // 注意：Node 的 Dirent.isDirectory() 是**方法**（不是属性）
      const isDir = e.isDirectory();
      lines.push(isDir ? `${rel}/` : rel);
      if (isDir) walk(path.join(absDir, e.name), depth + 1, rel);
    }
  };

  walk(root, 1, '');
  if (lines.length === 0) return { tree: null, truncated: false };
  return { tree: lines.join('\n'), truncated };
}

export function buildContextSummary(root: string | null): ContextSummary {
  const { tree, truncated } = describeTree(root);
  return {
    root,
    environment: describeEnvironment(),
    tree,
    treeTruncated: truncated,
  };
}
