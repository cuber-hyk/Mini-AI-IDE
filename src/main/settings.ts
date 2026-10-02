/**
 * 应用设置持久化（主进程专用）
 *
 * 用途：
 *  - 记录"上次打开的目录"，启动时自动恢复（与其他编辑器的习惯一致）；
 *  - 记录分栏宽度。
 *
 * 存储位置：`app.getPath('userData')/settings.json`
 * 边界：只存应用自身配置，**不写入会话分区**（见 session-persistence 能力文档第 6 条）。
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Settings {
  /** 上次打开的根目录（绝对路径）；目录不存在时启动会忽略并清空 */
  lastRoot: string | null;
  /** 编辑器面板宽度（像素） */
  editorWidth: number | null;
  /** 左侧目录树是否显示 */
  sidebarVisible: boolean;
  /** 左侧目录树宽度（像素） */
  sidebarWidth: number | null;
}

const DEFAULTS: Settings = { lastRoot: null, editorWidth: null, sidebarVisible: true, sidebarWidth: null };

/**
 * 生产设置文件名。
 *
 * **自检/测试必须使用另一个文件名**（见 `SELF_TEST_SETTINGS_FILE`）：
 * 早期两者共用同一个文件，导致**每跑一次自检就把用户"上次打开的目录"覆盖掉**
 * （实测踩过：用户报告"每次都是打开 Mini-AI-IDE 而不是我上次的项目"，
 * 真因不是恢复逻辑，而是**测试写坏了生产设置**）。
 */
export const PRODUCTION_SETTINGS_FILE = 'settings.json';
export const SELF_TEST_SETTINGS_FILE = 'settings.selftest.json';

export class SettingsStore {
  private readonly file: string;
  private cache: Settings;

  constructor(fileName = PRODUCTION_SETTINGS_FILE) {
    this.file = path.join(app.getPath('userData'), fileName);
    this.cache = this.load();
  }

  get filePath(): string {
    return this.file;
  }

  get(): Settings {
    return { ...this.cache };
  }

  /** 合并写入并落盘；返回写入后的完整设置 */
  update(patch: Partial<Settings>): Settings {
    this.cache = { ...this.cache, ...patch };
    this.save();
    return this.get();
  }

  private load(): Settings {
    try {
      if (!fs.existsSync(this.file)) return { ...DEFAULTS };
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const out: Settings = { ...DEFAULTS };
      if (typeof parsed.lastRoot === 'string' && parsed.lastRoot.length > 0) out.lastRoot = parsed.lastRoot;
      if (typeof parsed.editorWidth === 'number' && Number.isFinite(parsed.editorWidth) && parsed.editorWidth > 0) {
        out.editorWidth = Math.round(parsed.editorWidth);
      }
      if (typeof parsed.sidebarVisible === 'boolean') out.sidebarVisible = parsed.sidebarVisible;
      if (typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth) && parsed.sidebarWidth > 0) {
        out.sidebarWidth = Math.round(parsed.sidebarWidth);
      }
      return out;
    } catch (err) {
      process.stderr.write(
        `[settings] 读取失败，使用默认值：${err instanceof Error ? err.message : String(err)}\n`
      );
      return { ...DEFAULTS };
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2), 'utf8');
    } catch (err) {
      process.stderr.write(`[settings] 写入失败：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

/**
 * 判断记录的目录是否仍可用。
 * 目录被删除/改名/换盘符时要静默忽略，不能让"记忆"变成启动阻塞。
 */
export function isUsableRoot(candidate: string | null): candidate is string {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
