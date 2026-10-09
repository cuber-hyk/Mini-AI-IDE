/** 本地需求附件暂存：只接收用户选择/拖入的文件，主进程持有真实路径并按需流式读取。 */
import { createReadStream } from 'node:fs';
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

interface StoredAttachment extends PromptAttachment { path?: string; bytes?: Uint8Array }

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
      prepared.push({ id: randomUUID(), name: path.basename(absolute), size: stat.size, mediaType, path: absolute });
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
    if (!Array.isArray(ids) || ids.length > MAX_PROMPT_ATTACHMENTS || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length)
      throw new Error('附件列表无效');
    const result: PromptAttachmentData[] = [];
    for (const id of ids as string[]) {
      const file = this.files.get(id);
      if (!file) throw new Error('附件已失效，请重新添加');
      if (file.bytes) {
        if (file.bytes.byteLength !== file.size || file.size > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error(`附件已变化，请重新添加：${file.name}`);
      } else {
        const stat = await fs.stat(file.path!);
        if (!stat.isFile() || stat.size !== file.size || stat.size > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error(`附件已变化，请重新添加：${file.name}`);
      }
      result.push({ id: file.id, name: file.name, size: file.size, mediaType: file.mediaType,
        stream: async function* () {
          if (file.bytes) { for (let offset = 0; offset < file.bytes.length; offset += 1024 * 1024) yield file.bytes.slice(offset, offset + 1024 * 1024); }
          else for await (const chunk of createReadStream(file.path!, { highWaterMark: 1024 * 1024 })) yield chunk;
        } });
    }
    return result;
  }
}
