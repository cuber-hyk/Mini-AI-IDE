/**
 * 跨进程契约（主进程 / preload / 渲染进程共用）
 *
 * 设计约束（ADR-0002）：IPC 只暴露**窄接口** —— 声明式参数，不接受任意表达式，
 * 也不接受任意路径。渲染进程没有任何直接的文件系统能力。
 */
import type { TextMeta } from './limits';

export const CHANNELS = {
  /** 渲染进程请求系统目录选择对话框（唯一取得路径的合法入口） */
  chooseRoot: 'fs:choose-root',
  /** 查询当前已打开的根目录 */
  getRoot: 'fs:get-root',
  /** 设置根目录（仅供主进程内部/自检使用，渲染进程不暴露此能力） */
  setRootInternal: 'fs:set-root-internal',
  /** 列出某个目录（路径必须落在已打开的根目录内） */
  listDir: 'fs:list-dir',
  /** 读取文件内容（返回纯文本 + 元信息） */
  readFile: 'fs:read-file',
  /** 分片读取（超限时由用户确认后调用） */
  sliceFile: 'fs:slice-file',
  /** 写回文件（编辑后保存） */
  writeFile: 'fs:write-file',
  /** 调整左右分栏比例（拖动分隔条时由编辑器渲染进程上报） */
  setSplit: 'ui:set-split',
  /** 主进程 → 渲染进程：根目录已变更 */
  rootChanged: 'fs:root-changed',
} as const;

export interface DirEntry {
  name: string;
  /** 相对根目录的路径（用 / 分隔） */
  relPath: string;
  isDirectory: boolean;
  /** 目录为 null */
  textLike: boolean | null;
}

export interface ListDirResult {
  ok: boolean;
  entries: DirEntry[];
  truncated: boolean;
  error?: string;
}

export interface ReadFileResult {
  ok: boolean;
  /** 相对根目录的路径 */
  relPath?: string;
  text?: string;
  encoding?: string;
  fellBack?: boolean;
  meta?: TextMeta;
  /** 超限时只返回元信息，text 为空 */
  tooLarge?: boolean;
  limit?: number;
  error?: string;
}

export interface SliceFileResult {
  ok: boolean;
  text?: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  error?: string;
}

export interface WriteFileResult {
  ok: boolean;
  relPath?: string;
  byteLength?: number;
  error?: string;
}

export interface RootInfo {
  /** 用户可见的根目录绝对路径（仅用于界面显示） */
  root: string | null;
}

export interface SplitResult {
  /** 主进程实际采用的编辑器宽度（已被最小宽度约束收敛） */
  editorWidth: number;
}

/** preload 通过 contextBridge 暴露给渲染进程的唯一接口面 */
export interface EditorBridge {
  chooseRoot(): Promise<RootInfo>;
  getRoot(): Promise<RootInfo>;
  listDir(relPath: string): Promise<ListDirResult>;
  readFile(relPath: string): Promise<ReadFileResult>;
  sliceFile(relPath: string, startLine: number, endLine: number): Promise<SliceFileResult>;
  writeFile(relPath: string, text: string): Promise<WriteFileResult>;
  /** 上报期望的编辑器宽度（像素）；主进程会做最小宽度约束并回传实际值 */
  setSplit(editorWidth: number): Promise<SplitResult>;
  onRootChanged(listener: (info: RootInfo) => void): void;
}

declare global {
  interface Window {
    /** 由 preload 注入；除此外渲染进程不得假设任何能力 */
    editorBridge: EditorBridge;
  }
}
