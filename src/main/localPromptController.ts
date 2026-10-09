/** 本地需求、技能及发送选项的唯一受控入口；不猜测会话初始化状态。 */
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import type { SettingsStore } from './settings';
import type { SkillService } from './skills';
import type { WebComposerSender } from './webComposerSender';
import type { LocalPromptInput, LocalPromptOptions, LocalPromptResult, PromptAttachment, PromptAttachmentData } from '../shared/localPrompt';
import { LocalPromptAttachments, MAX_PROMPT_ATTACHMENTS } from './localPromptAttachments';
import { validSkillName } from '../shared/skills';
import { CHANNELS } from '../shared/contract';
import { buildPrompt, resolveFormatSpec } from '../shared/formatSpec';
import { buildContextSummary } from './contextSummary';
import { traceCollection } from './tools/collectionTrace';

interface Options {
  ipc: Pick<IpcMain, 'handle'>; editor: Pick<WebContents, 'mainFrame'>; settings: SettingsStore;
  skills: Pick<SkillService, 'list' | 'load'>;
  sender: { send: (text: string, session: string, kind: 'prompt', current: () => boolean, attachments?: readonly PromptAttachmentData[]) => ReturnType<WebComposerSender['send']>; cancel: WebComposerSender['cancel'] };
  attachments: LocalPromptAttachments; chooseFiles: () => Promise<string[]>; resolveWorkspacePath: (path: string) => Promise<{ ok: boolean; absolute?: string; error?: string }>;
  root: () => string | null; session: () => string; busy: () => boolean;
  disabled?: boolean;
}
export class LocalPromptController {
  private generation = 0;
  private rootGeneration = 0;
  private sending = false;
  constructor(private readonly options: Options) {}
  getOptions(): LocalPromptOptions { return { ...this.options.settings.get().localPrompt }; }
  cancel(rootChanged = true): void { this.generation++; if (rootChanged) { this.rootGeneration++; this.options.attachments.clear(); } void this.options.sender.cancel('prompt'); }
  setOptions(raw: unknown): LocalPromptOptions {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('本地提示词选项无效');
    const patch = raw as Record<string, unknown>;
    if (Object.entries(patch).some(([key, value]) => key !== 'includeInitialization' || typeof value !== 'boolean')) throw new Error('本地提示词选项无效');
    const next = { ...this.getOptions(), ...patch } as LocalPromptOptions;
    this.cancel(false); this.options.settings.update({ localPrompt: next }); return next;
  }
  private input(raw: unknown): LocalPromptInput {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('需求参数无效');
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some(key => !['requirement', 'root', 'skills', 'attachments'].includes(key)) ||
      typeof value.requirement !== 'string' || !value.requirement.trim() || value.requirement.length > 100000 || value.requirement.includes('\0') ||
      (value.root !== null && typeof value.root !== 'string') || !Array.isArray(value.skills) || value.skills.length > 8 ||
      value.skills.some(name => !validSkillName(name)) || new Set(value.skills).size !== value.skills.length ||
      (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.length > MAX_PROMPT_ATTACHMENTS || value.attachments.some(id => typeof id !== 'string')))) throw new Error('需求、项目或技能参数无效');
    if (value.root !== this.options.root()) throw new Error('项目已切换，请重新选择技能后发送');
    return value as unknown as LocalPromptInput;
  }
  private async compose(raw: unknown): Promise<string> {
    const input = this.input(raw); const generation = this.generation;
    const preferences = this.getOptions();
    const chosen = [];
    for (const name of input.skills) {
      if (!new RegExp('(?:^|\\s)/' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|\\s|[，。；：！？,.!?;:])').test(input.requirement)) throw new Error('技能引用已删除或变化，请重新选择');
      chosen.push(await this.options.skills.load(input.root, name));
    }
    let prompt = input.requirement.trim();
    if (preferences.includeInitialization) {
      const context = buildContextSummary(input.root); const settings = this.options.settings.get();
      prompt = buildPrompt({ requirement: input.requirement, context: {
        root: context.root, environment: context.environment,
        tree: context.tree ? context.tree + (context.treeTruncated ? '\n…（目录较多，已截断）' : '') : null,
      }, formatSpec: resolveFormatSpec({ short: settings.customFormatSpecShort, full: settings.customFormatSpecFull }, settings.formatSpecVariant) });
      const catalog = await this.options.skills.list(input.root);
      if (catalog.skills.length) prompt += '\n\n## 可用技能（摘要）\n需要技能时先用 load_skill({name}) 加载完整说明，再按说明操作；技能脚本仍遵守IDE工具权限。\n' +
        catalog.skills.map(skill => '- /' + skill.name + ' [' + skill.source + ']：' + skill.description).join('\n');
      if (catalog.errors.length) prompt += '\n\n## 技能目录诊断\n' + catalog.errors.join('\n');
    }
    for (const skill of chosen) prompt += '\n\n## 用户指定技能：' + skill.name + '\n资源目录：' + skill.resourceRoot + '\n' + skill.content;
    if (input.root !== this.options.root() || generation !== this.generation) throw new Error('项目或选项已变化，需求未提交');
    if (prompt.length > 1000000) throw new Error('提示词与技能内容过长，请减少所选技能');
    return prompt;
  }
  async send(raw: unknown): Promise<LocalPromptResult> {
    if (this.options.disabled) return { ok: false, error: '当前运行模式不支持发送需求' };
    if (this.sending || this.options.busy()) return { ok: false, error: '需求或工具结果正在处理，请等待当前操作结束' };
    const session = this.options.session(); const generation = this.generation; this.sending = true;
    try {
      const prompt = await this.compose(raw);
      if (generation !== this.generation || session !== this.options.session() || this.options.busy()) return { ok: false, error: '选项、会话或工具状态已变化，需求未发送' };
      // 会话作用域由 integration/sender 核验，允许它们证明首页首发的地址分配。
      const current = () => generation === this.generation && !this.options.busy();
      const attachments = await this.options.attachments.resolve((raw as LocalPromptInput).attachments ?? []);
      if (generation !== this.generation || session !== this.options.session()) return { ok: false, error: '项目或会话已变化，需求未发送' };
      traceCollection('local-prompt.attachments-resolved', { count: attachments.length, totalBytes: attachments.reduce((sum, item) => sum + item.size, 0) });
      const result = await this.options.sender.send(prompt, session, 'prompt', current, attachments);
      if (result.ok) for (const attachment of attachments) this.options.attachments.remove(attachment.id);
      return { ...result, length: prompt.length };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    finally { this.sending = false; }
  }
  register(): string[] {
    const trusted = (event: IpcMainInvokeEvent) => {
      if (event.sender !== this.options.editor || event.senderFrame !== this.options.editor.mainFrame) throw new Error('本地需求操作仅供编辑器主 frame');
    };
    const handle = (channel: string, action: (...args: unknown[]) => unknown) => this.options.ipc.handle(channel, (event, ...args: unknown[]) => { trusted(event); if (args.length !== action.length) throw new Error('本地需求参数数量无效'); return action(...args); });
    handle(CHANNELS.getLocalPromptOptions, () => this.getOptions());
    handle(CHANNELS.setLocalPromptOptions, patch => this.setOptions(patch));
    handle(CHANNELS.choosePromptAttachments, async () => {
      const root = this.options.root(); const generation = this.rootGeneration;
      const paths = await this.options.chooseFiles();
      if (generation !== this.rootGeneration || root !== this.options.root()) throw new Error('项目已切换，未添加附件');
      const staged = paths.length ? await this.options.attachments.stage(paths) : [];
      if (generation !== this.rootGeneration || root !== this.options.root()) { for (const item of staged) this.options.attachments.remove(item.id); throw new Error('项目已切换，未添加附件'); }
      return staged;
    });
    handle(CHANNELS.stagePromptAttachments, async paths => {
      const root = this.options.root(); const generation = this.rootGeneration;
      if (!Array.isArray(paths) || paths.some(item => typeof item !== 'string')) throw new Error('拖入附件无效');
      const staged = await this.options.attachments.stage(paths as string[]);
      if (generation !== this.rootGeneration || root !== this.options.root()) { for (const item of staged) this.options.attachments.remove(item.id); throw new Error('项目已切换，未添加附件'); }
      return staged;
    });
    handle(CHANNELS.stageWorkspacePromptAttachments, async (paths, requestedRoot) => {
      const root = this.options.root(); const generation = this.rootGeneration;
      if (typeof requestedRoot !== 'string' || requestedRoot !== root || !Array.isArray(paths) || paths.length === 0 || paths.some(item => typeof item !== 'string'))
        throw new Error('工作区已变化或拖入路径无效');
      const resolved: string[] = [];
      for (const relative of paths as string[]) {
        const target = await this.options.resolveWorkspacePath(relative);
        if (!target.ok || !target.absolute) throw new Error(target.error || '无法读取工作区文件');
        resolved.push(target.absolute);
      }
      if (generation !== this.rootGeneration || root !== this.options.root()) throw new Error('项目已切换，未添加附件');
      const staged = await this.options.attachments.stage(resolved);
      if (generation !== this.rootGeneration || root !== this.options.root()) { for (const item of staged) this.options.attachments.remove(item.id); throw new Error('项目已切换，未添加附件'); }
      return staged;
    });
    handle(CHANNELS.stageClipboardPromptImage, (name, mediaType, bytes) => this.options.attachments.stageClipboardImage(name, mediaType, bytes));
    handle(CHANNELS.removePromptAttachment, id => this.options.attachments.remove(id));
    handle(CHANNELS.getSkillCatalog, async () => {
      const root = this.options.root(); const generation = this.rootGeneration;
      const catalog = await this.options.skills.list(root);
      if (generation !== this.rootGeneration || root !== this.options.root()) throw new Error('项目已切换，技能目录失效');
      return catalog;
    });
    handle(CHANNELS.loadSkill, async name => {
      const root = this.options.root(); const generation = this.rootGeneration;
      try {
        if (typeof name !== 'string') throw new Error('技能名称无效');
        const skill = await this.options.skills.load(root, name);
        if (generation !== this.rootGeneration || root !== this.options.root()) throw new Error('项目已切换，技能说明失效');
        return { ok: true, skill };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    handle(CHANNELS.sendPrompt, raw => this.send(raw));
    return [CHANNELS.getLocalPromptOptions, CHANNELS.setLocalPromptOptions, CHANNELS.choosePromptAttachments, CHANNELS.stagePromptAttachments, CHANNELS.stageWorkspacePromptAttachments, CHANNELS.stageClipboardPromptImage,
      CHANNELS.removePromptAttachment, CHANNELS.getSkillCatalog, CHANNELS.loadSkill, CHANNELS.sendPrompt];
  }
}
