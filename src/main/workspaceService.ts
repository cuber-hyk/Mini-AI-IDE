/** 单根目录生命周期：先验证与持久化，再切换文件服务和状态版本。 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { FileService } from './fileService';
import { normalizeRecentRoots, type SettingsStore } from './settings';

export interface WorkspaceState {
  root: string | null;
  recentRoots: string[];
  revision: number;
}

export interface WorkspaceResult extends WorkspaceState {
  ok: boolean;
  error?: string;
  stale?: boolean;
}

export class WorkspaceService {
  private revision = 0;

  constructor(
    private readonly files: FileService,
    private readonly settings: Pick<SettingsStore, 'get' | 'update'>,
  ) {}

  getState(): WorkspaceState {
    return {
      root: this.files.getRoot(),
      recentRoots: [...this.settings.get().recentRoots],
      revision: this.revision,
    };
  }

  open(absolutePath: string): WorkspaceResult {
    try {
      const root = this.validateRoot(absolutePath);
      const recentRoots = normalizeRecentRoots([root, ...this.settings.get().recentRoots]);
      this.settings.update({ lastRoot: root, recentRoots });
      if (this.files.getRoot() !== root) {
        this.files.setRoot(root);
        this.revision += 1;
      }
      return { ok: true, ...this.getState() };
    } catch (err) {
      return this.failure(err);
    }
  }

  openRecent(index: number): WorkspaceResult {
    const roots = this.settings.get().recentRoots;
    if (!Number.isInteger(index) || index < 0 || index >= roots.length) {
      return this.failure(new Error('最近目录条目无效，请刷新后重试'));
    }
    return this.open(roots[index] as string);
  }

  close(): WorkspaceResult {
    try {
      this.settings.update({ lastRoot: null });
      if (this.files.getRoot() !== null) {
        this.files.clearRoot();
        this.revision += 1;
      }
      return { ok: true, ...this.getState() };
    } catch (err) {
      return this.failure(err);
    }
  }

  restore(): WorkspaceResult {
    const lastRoot = this.settings.get().lastRoot;
    if (lastRoot === null) return { ok: true, ...this.getState() };
    let root: string;
    try {
      root = this.validateRoot(lastRoot);
    } catch (err) {
      try {
        this.settings.update({ lastRoot: null });
      } catch (saveError) {
        return { ...this.failure(saveError), stale: true };
      }
      return { ...this.failure(err), stale: true };
    }
    return this.open(root);
  }

  private validateRoot(candidate: string): string {
    if (typeof candidate !== 'string' || candidate.includes('\0') || !path.isAbsolute(candidate)) {
      throw new Error('打开目录需要有效的绝对路径');
    }
    const root = path.resolve(candidate);
    if (!fs.statSync(root).isDirectory()) throw new Error('所选路径不是文件夹');
    // stat 成功不代表有权限列出目录；不能先切换根目录再发现打不开。
    fs.readdirSync(root);
    return root;
  }

  private failure(err: unknown): WorkspaceResult {
    return {
      ok: false,
      ...this.getState(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
