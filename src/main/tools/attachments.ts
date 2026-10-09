import type { PromptAttachment, PromptAttachmentData } from '../../shared/localPrompt';
import type { ToolResult } from '../../shared/toolProtocol';
import { LocalPromptAttachments } from '../localPromptAttachments';
import { resolveToolPath } from './files';
import type { ToolSelection } from './harness';

/** 只持有当前已授权工具选择的附件；暂存成功不是官网上传成功。 */
export class ToolAttachments {
  private readonly files = new LocalPromptAttachments();
  private readonly staged = new Map<string, { attachment: PromptAttachment; filePath: string }>();
  private selection: ToolSelection | null = null;
  private generation = 0;

  begin(selection: ToolSelection | null): void {
    this.reset();
    this.selection = selection;
  }

  async stage(root: string, filePath: string, current: () => boolean): Promise<PromptAttachment> {
    const selection = this.selection; const generation = this.generation;
    const valid = () => !!selection && this.selection === selection && generation === this.generation && current();
    if (!valid() || selection!.root !== root || !selection!.batch.requests.some(request => request.tool === 'attach_file' && request.args.path === filePath))
      throw new Error('附件请求已失效');
    const absolute = await resolveToolPath(root, filePath);
    if (!valid()) throw new Error('附件请求已失效');
    const [attachment] = await this.files.stage([absolute]);
    if (!valid()) { this.files.remove(attachment!.id); throw new Error('附件请求已失效'); }
    this.staged.set(attachment!.id, { attachment: attachment!, filePath });
    return attachment!;
  }

  async resolve(results: readonly ToolResult[]): Promise<PromptAttachmentData[]> {
    const selection = this.selection; const generation = this.generation;
    const ids: string[] = [];
    for (const result of results) {
      if (result.tool !== 'attach_file' || result.status !== 'done') continue;
      const data = result.data as Partial<PromptAttachment> | null | undefined;
      const staged = data && typeof data.id === 'string' ? this.staged.get(data.id) : undefined;
      const request = selection?.batch.requests.find(item => item.id === result.request_id);
      if (!selection || result.batch_id !== selection.batch.batch_id || request?.tool !== 'attach_file' ||
        !staged || request.args.path !== staged.filePath ||
        Object.entries(staged.attachment).some(([key, value]) => data![key as keyof PromptAttachment] !== value))
        throw new Error('工具附件已失效，请重新请求 attach_file');
      ids.push(staged.attachment.id);
    }
    const attachments = await this.files.resolve(ids);
    if (generation !== this.generation || this.selection !== selection) throw new Error('工具附件已失效，请重新请求 attach_file');
    return attachments;
  }

  reset(): void {
    this.generation++;
    this.selection = null;
    this.staged.clear();
    this.files.clear();
  }
}
