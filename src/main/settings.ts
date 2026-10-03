/**
 * 应用设置持久化（主进程专用）
 *
 * 用途：
 *  - 记录"上次打开的目录"，启动时自动恢复（与其他编辑器的习惯一致）；
 *  - 记录分栏宽度；
 *  - 记录用户自定义的**输出格式要求**（系统 prompt 的格式段）。
 *
 * 存储位置：`app.getPath('userData')/settings.json`
 * 边界：只存应用自身配置，**不写入会话分区**（见 session-persistence 能力文档第 6 条）。
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { MAX_CUSTOM_FORMAT_SPEC_LENGTH, normalizeVariant, type FormatSpecVariant } from '../shared/formatSpec';

export interface Settings {
  /** 上次打开的根目录（绝对路径）；目录不存在时启动会忽略并清空 */
  lastRoot: string | null;
  /** 编辑器面板宽度（像素） */
  editorWidth: number | null;
  /** 左侧目录树是否显示 */
  sidebarVisible: boolean;
  /** 左侧目录树宽度（像素） */
  sidebarWidth: number | null;
  /**
   * 当前使用的提示词版本（底部双段开关的状态）。'short' = 简洁版、'full' = 完整版。
   *
   * 为什么要持久化：否则每次重启都回到简洁版，想长期用完整版的人每次都得再拨一次。
   */
  formatSpecVariant: FormatSpecVariant;
  /**
   * 用户自定义的**简洁版**输出格式要求；null = 用内置简洁版。
   *
   * 为什么存整段文本而不是"在默认模板上打补丁"：默认模板会随版本演进
   * （本项目已改过两轮围栏规则）。若存的是 diff/差异，模板一升级用户的补丁就会
   * 错位、甚至拼出一个自相矛盾的规格。存整段文本的语义则永远清晰：
   * 「这是用户此刻要用的那段」，升级默认模板**不会**悄悄改动用户已经写好的内容。
   */
  customFormatSpecShort: string | null;
  /** 用户自定义的**完整版**输出格式要求；null = 用内置完整版。分版本各存一份，互不影响。 */
  customFormatSpecFull: string | null;
  /** 自定义格式要求的保存时间（ISO 字符串），仅用于面板回显"上次修改于…"。两版共用最后一次修改时间。 */
  customFormatSpecUpdatedAt: string | null;
}

const DEFAULTS: Settings = {
  lastRoot: null,
  editorWidth: null,
  sidebarVisible: true,
  sidebarWidth: null,
  formatSpecVariant: 'short',
  customFormatSpecShort: null,
  customFormatSpecFull: null,
  customFormatSpecUpdatedAt: null,
};

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
      // 版本选择：只接受两个合法值，其余一律回落 'short'
      out.formatSpecVariant = normalizeVariant(parsed.formatSpecVariant);
      /*
       * 自定义格式要求：**空字符串视同未设置**。
       * 若允许空串，用户误清空内容就会得到"格式要求为空"的 prompt ——
       * 提示词里缺了唯一让"一键同步"成立的那段约定，模型输出将无法被解析，
       * 而这不会有任何报错（表现为"复制提示词后 AI 的输出识别不出来"）。
       * 因此空串一律回落默认值，与面板上的「恢复默认」语义保持一致。
       */
      const clampSpec = (v: unknown): string | null =>
        typeof v === 'string' && v.trim().length > 0
          ? v.slice(0, MAX_CUSTOM_FORMAT_SPEC_LENGTH)
          : null;
      out.customFormatSpecShort = clampSpec(parsed.customFormatSpecShort);
      out.customFormatSpecFull = clampSpec(parsed.customFormatSpecFull);
      /*
       * 旧格式迁移：早期只有一个 `customFormatSpec`（覆盖一切版本）。
       * 分版本后它没有归属，**只在两版都为空时**灌给「当前版本」那一格 ——
       * 这样老用户升上来后他写的那段仍然生效，不会"升个级内容就没了"。
       * 只读不写：不动 parsed，落盘会在用户下次保存时自然发生。
       */
      const legacy = clampSpec((parsed as Record<string, unknown>).customFormatSpec);
      if (legacy) {
        if (out.formatSpecVariant === 'full') {
          if (!out.customFormatSpecFull) out.customFormatSpecFull = legacy;
        } else if (!out.customFormatSpecShort) {
          out.customFormatSpecShort = legacy;
        }
      }
      if (typeof parsed.customFormatSpecUpdatedAt === 'string' && parsed.customFormatSpecUpdatedAt.length > 0) {
        out.customFormatSpecUpdatedAt = parsed.customFormatSpecUpdatedAt;
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
