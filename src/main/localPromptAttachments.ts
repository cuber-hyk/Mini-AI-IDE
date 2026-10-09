/** 主进程附件暂存：调用 owner 负责用户选择或工具授权，真实路径与字节不进入网页桥。 */
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PromptAttachment, PromptAttachmentData } from '../shared/localPrompt';

export const MAX_PROMPT_ATTACHMENTS = 50;
export const MAX_PROMPT_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.pdf': 'application/pdf',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

interface FileIdentity { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
interface StoredAttachment extends PromptAttachment { path?: string; requestedPath?: string; identity?: FileIdentity; bytes?: Uint8Array }
const identity = ({ dev, ino, size, mtimeMs, ctimeMs }: Stats): FileIdentity => ({ dev, ino, size, mtimeMs, ctimeMs });
const sameFile = (stat: Stats, expected: FileIdentity) => stat.isFile() && Object.entries(expected).every(([key, value]) => stat[key as keyof FileIdentity] === value);

async function verifyFile(file: StoredAttachment): Promise<void> {
  const real = await fs.realpath(file.requestedPath!);
  const stat = await fs.lstat(file.path!);
  if (real !== file.path || !sameFile(stat, file.identity!)) throw new Error(`附件已变化，请重新添加：${file.name}`);
}

export class LocalPromptAttachments {
  private readonly files = new Map<string, StoredAttachment>();
  private generation = 0;

  async stage(paths: readonly string[]): Promise<PromptAttachment[]> {
    const generation = this.generation;
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PROMPT_ATTACHMENTS || this.files.size + paths.length > MAX_PROMPT_ATTACHMENTS)
      throw new Error(`一次最多添加 ${MAX_PROMPT_ATTACHMENTS} 个附件`);
    const prepared: StoredAttachment[] = [];
    const seen = new Set<string>();
    for (const candidate of paths) {
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0')) throw new Error('附件路径无效');
      const absolute = await fs.realpath(candidate);
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) throw new Error('只能添加文件，不能添加文件夹');
      if (stat.size <= 0) throw new Error(`文件为空：${path.basename(absolute)}`);
      if (stat.size > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error(`单个附件不能超过 100 MB：${path.basename(absolute)}`);
      const mediaType = TYPES[path.extname(absolute).toLowerCase()];
      if (!mediaType) throw new Error(`暂不支持此文件类型：${path.basename(absolute)}`);
      const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
      if (seen.has(key)) continue;
      seen.add(key);
      prepared.push({ id: randomUUID(), name: path.basename(absolute), size: stat.size, mediaType, path: absolute, requestedPath: candidate, identity: identity(stat) });
    }
    if (generation !== this.generation) throw new Error('项目已切换，未添加附件');
    if (this.files.size + prepared.length > MAX_PROMPT_ATTACHMENTS) throw new Error(`一次最多添加 ${MAX_PROMPT_ATTACHMENTS} 个附件`);
    for (const file of prepared) this.files.set(file.id, file);
    return prepared.map(({ id, name, size, mediaType }) => ({ id, name, size, mediaType }));
  }

  stageClipboardImage(name: unknown, mediaType: unknown, value: unknown): PromptAttachment[] {
    if (typeof name !== 'string' || !/^clipboard-image\.(png|jpe?g|webp|gif)$/i.test(name) ||
      typeof mediaType !== 'string' || !mediaType.startsWith('image/') ||
      !(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_PROMPT_ATTACHMENT_BYTES ||
      this.files.size >= MAX_PROMPT_ATTACHMENTS) throw new Error('剪贴板图片无效或附件限制已达到');
    const extension = path.extname(name).toLowerCase();
    if (TYPES[extension] !== mediaType) throw new Error('剪贴板图片格式不支持');
    const id = randomUUID();
    const file: StoredAttachment = { id, name, size: value.byteLength, mediaType, bytes: new Uint8Array(value) };
    this.files.set(id, file);
    return [{ id, name, size: file.size, mediaType }];
  }

  remove(id: unknown): boolean {
    if (typeof id !== 'string') return false;
    return this.files.delete(id);
  }

  clear(): void { this.generation++; this.files.clear(); }

  async resolve(ids: unknown): Promise<PromptAttachmentData[]> {
    const generation = this.generation;
    if (!Array.isArray(ids) || ids.length > MAX_PROMPT_ATTACHMENTS || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length)
      throw new Error('附件列表无效');
    const result: PromptAttachmentData[] = [];
    for (const id of ids as string[]) {
      const file = this.files.get(id);
      if (!file) throw new Error('附件已失效，请重新添加');
      if (file.bytes) {
        if (file.bytes.byteLength !== file.size || file.size > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error(`附件已变化，请重新添加：${file.name}`);
      } else {
        await verifyFile(file);
      }
      const current = () => generation === this.generation && this.files.get(id) === file;
      if (!current()) throw new Error('附件已失效，请重新添加');
      result.push({ id: file.id, name: file.name, size: file.size, mediaType: file.mediaType,
        stream: async function* () {
          if (!current()) throw new Error('附件已失效，请重新添加');
          if (file.bytes) {
            for (let offset = 0; offset < file.bytes.length; offset += 1024 * 1024) {
              if (!current()) throw new Error('附件已失效，请重新添加');
              yield file.bytes.slice(offset, offset + 1024 * 1024);
            }
          } else {
            await verifyFile(file);
            const handle = await fs.open(file.path!, 'r');
            try {
              if (!sameFile(await handle.stat(), file.identity!)) throw new Error(`附件已变化，请重新添加：${file.name}`);
              let offset = 0;
              while (offset < file.size) {
                if (!current()) throw new Error('附件已失效，请重新添加');
                const buffer = Buffer.alloc(Math.min(1024 * 1024, file.size - offset));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
                if (!bytesRead) throw new Error(`附件已变化，请重新添加：${file.name}`);
                offset += bytesRead; yield buffer.subarray(0, bytesRead);
              }
              if (!current()) throw new Error('附件已失效，请重新添加');
              if (!sameFile(await handle.stat(), file.identity!)) throw new Error(`附件已变化，请重新添加：${file.name}`);
              await verifyFile(file);
            } finally { await handle.close(); }
          }
        } });
    }
    return result;
  }
}
