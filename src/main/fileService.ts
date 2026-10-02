/**
 * 文件读取服务（主进程专用）
 *
 * ADR-0002：文件系统访问**只在主进程**；渲染进程通过 IPC 请求纯文本结果。
 * 所有路径请求都先过 `resolveWithinRoot`，越界直接拒绝。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { decodeTextFile } from '../shared/encoding';
import { checkSize, isProbablyTextFile, sliceLines, type TextMeta } from '../shared/limits';
import { DEFAULT_LIST_POLICY, filterAndSortEntries, resolveWithinRoot, type DirEntryLike } from '../shared/pathGuard';
import type { DirEntry, ListDirResult, ReadFileResult, SliceFileResult, WriteFileResult } from '../shared/contract';

/** 单次返回内容上限（字符数）。超限只返回元信息，要求用户显式确认后分片读取。 */
export const DEFAULT_CHAR_LIMIT = 200_000;

export class FileService {
  private root: string | null = null;

  constructor(private readonly charLimit: number = DEFAULT_CHAR_LIMIT) {}

  getRoot(): string | null {
    return this.root;
  }

  /** 由主进程在用户通过系统对话框选择目录后调用 */
  setRoot(absoluteRoot: string): string {
    this.root = path.resolve(absoluteRoot);
    return this.root;
  }

  private requireRoot(): { ok: true; root: string } | { ok: false; error: string } {
    if (!this.root) return { ok: false, error: '尚未打开任何目录' };
    return { ok: true, root: this.root };
  }

  async listDir(relPath: string): Promise<ListDirResult> {
    const r = this.requireRoot();
    if (!r.ok) return { ok: false, entries: [], truncated: false, error: r.error };

    const verdict = resolveWithinRoot(r.root, relPath === '' ? '.' : relPath);
    if (!verdict.ok) return { ok: false, entries: [], truncated: false, error: verdict.detail };

    let dirents;
    try {
      dirents = await fs.readdir(verdict.absolute, { withFileTypes: true });
    } catch (err) {
      return { ok: false, entries: [], truncated: false, error: `无法读取目录：${err instanceof Error ? err.message : String(err)}` };
    }

    const like: DirEntryLike[] = dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
    const { shown, truncated } = filterAndSortEntries(like, DEFAULT_LIST_POLICY);

    const entries: DirEntry[] = shown.map((e) => {
      const childAbs = path.join(verdict.absolute, e.name);
      const childVerdict = resolveWithinRoot(r.root, childAbs);
      const rel = childVerdict.ok ? childVerdict.relative.split(path.sep).join('/') : '';
      return {
        name: e.name,
        relPath: rel,
        isDirectory: e.isDirectory,
        textLike: e.isDirectory ? null : isProbablyTextFile(e.name),
      };
    });

    return { ok: true, entries, truncated };
  }

  async readFile(relPath: string): Promise<ReadFileResult> {
    const r = this.requireRoot();
    if (!r.ok) return { ok: false, error: r.error };

    const verdict = resolveWithinRoot(r.root, relPath);
    if (!verdict.ok) return { ok: false, error: verdict.detail };

    let buf: Buffer;
    try {
      buf = await fs.readFile(verdict.absolute);
    } catch (err) {
      return { ok: false, error: `无法读取文件：${err instanceof Error ? err.message : String(err)}` };
    }

    const decoded = decodeTextFile(new Uint8Array(buf));
    if (!decoded.ok) {
      return { ok: false, relPath: verdict.relative, error: decoded.detail };
    }

    const sized = checkSize(decoded.text, decoded.byteLength, this.charLimit);
    if (sized.status === 'too-large') {
      return {
        ok: true,
        relPath: verdict.relative,
        encoding: decoded.encoding,
        fellBack: decoded.fellBack,
        meta: sized.meta,
        tooLarge: true,
        limit: sized.limit,
        text: '',
      };
    }

    return {
      ok: true,
      relPath: verdict.relative,
      text: decoded.text,
      encoding: decoded.encoding,
      fellBack: decoded.fellBack,
      meta: sized.meta,
    };
  }

  /**
   * 读取文件**原文**（不做"超限只返回元信息"的降级）。
   * 用途：回程应用前的 diff 预览与撤销快照 —— 必须拿到完整原文才能正确计算差异；
   * 若超限则返回错误，由调用方提示用户（避免在超大文件上生成不可读的 diff）。
   */
  async readRawText(relPath: string): Promise<{ ok: true; text: string; relPath: string } | { ok: false; error: string }> {
    const r = this.requireRoot();
    if (!r.ok) return { ok: false, error: r.error };

    const verdict = resolveWithinRoot(r.root, relPath);
    if (!verdict.ok) return { ok: false, error: verdict.detail };

    let buf: Buffer;
    try {
      buf = await fs.readFile(verdict.absolute);
    } catch (err) {
      return { ok: false, error: `无法读取文件：${err instanceof Error ? err.message : String(err)}` };
    }
    const decoded = decodeTextFile(new Uint8Array(buf));
    if (!decoded.ok) return { ok: false, error: decoded.detail };
    if (decoded.text.length > this.charLimit) {
      return {
        ok: false,
        error: `文件过大（${decoded.text.length} 字符 > 上限 ${this.charLimit}），暂不支持在预览中应用`,
      };
    }
    return { ok: true, text: decoded.text, relPath: verdict.relative };
  }

  /**
   * 写回文件。
   *
   * 边界说明（ADR-0004）：这是**用户在编辑器里明确编辑后保存**的通道，不是"程序自动落盘"。
   * 因此：只接受字符串内容；路径仍过白名单；大小上限与读取一致。
   * 回程解析的"预览后应用"复用此写入通道，并在调用前先做三向校验。
   */
  async writeFile(relPath: string, text: string): Promise<WriteFileResult> {
    const r = this.requireRoot();
    if (!r.ok) return { ok: false, error: r.error };
    if (typeof text !== 'string') return { ok: false, error: '内容必须是字符串' };

    const verdict = resolveWithinRoot(r.root, relPath);
    if (!verdict.ok) return { ok: false, error: verdict.detail };

    if (text.length > this.charLimit) {
      return { ok: false, error: `内容超出上限（${text.length} > ${this.charLimit} 字符）` };
    }

    try {
      await fs.writeFile(verdict.absolute, text, 'utf8');
    } catch (err) {
      return { ok: false, error: `写入失败：${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, relPath: verdict.relative, byteLength: Buffer.byteLength(text, 'utf8') };
  }

  /** 分片读取：仅接受行号，路径仍需过白名单 */
  async sliceFile(relPath: string, startLine: number, endLine: number): Promise<SliceFileResult> {
    const r = this.requireRoot();
    if (!r.ok) return { ok: false, error: r.error };

    const verdict = resolveWithinRoot(r.root, relPath);
    if (!verdict.ok) return { ok: false, error: verdict.detail };

    let buf: Buffer;
    try {
      buf = await fs.readFile(verdict.absolute);
    } catch (err) {
      return { ok: false, error: `无法读取文件：${err instanceof Error ? err.message : String(err)}` };
    }
    const decoded = decodeTextFile(new Uint8Array(buf));
    if (!decoded.ok) return { ok: false, error: decoded.detail };

    const s = sliceLines(decoded.text, startLine, endLine);
    return { ok: true, text: s.text, startLine: s.startLine, endLine: s.endLine, totalLines: s.totalLines };
  }
}

export type { TextMeta };

