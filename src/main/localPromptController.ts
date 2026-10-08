/** 本地需求、技能及发送选项的唯一受控入口；不猜测会话初始化状态。 */
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import type { SettingsStore } from './settings';
import type { SkillService } from './skills';
import type { WebComposerSender } from './webComposerSender';
import type { LocalPromptInput, LocalPromptOptions, LocalPromptResult } from '../shared/localPrompt';
import { validSkillName } from '../shared/skills';
import { CHANNELS } from '../shared/contract';
import { buildPrompt, resolveFormatSpec } from '../shared/formatSpec';
import { buildContextSummary } from './contextSummary';

interface Options {
  ipc: Pick<IpcMain, 'handle'>; editor: Pick<WebContents, 'mainFrame'>; settings: SettingsStore;
  skills: Pick<SkillService, 'list' | 'load'>;
  sender: { send: (text: string, session: string, kind: 'prompt', current: () => boolean) => ReturnType<WebComposerSender['send']>; cancel: WebComposerSender['cancel'] };
  root: () => string | null; session: () => string; busy: () => boolean;
  copy: (text: string) => void; disabled?: boolean;
}
export class LocalPromptController {
  private generation = 0;
  private rootGeneration = 0;
  private sending = false;
  constructor(private readonly options: Options) {}
  getOptions(): LocalPromptOptions { return { ...this.options.settings.get().localPrompt }; }
  cancel(rootChanged = true): void { this.generation++; if (rootChanged) this.rootGeneration++; void this.options.sender.cancel('prompt'); }
  setOptions(raw: unknown): LocalPromptOptions {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('本地提示词选项无效');
    const patch = raw as Record<string, unknown>;
    if (Object.entries(patch).some(([key, value]) => !['includeInitialization', 'sendOnEnter'].includes(key) || typeof value !== 'boolean')) throw new Error('本地提示词选项无效');
    const next = { ...this.getOptions(), ...patch } as LocalPromptOptions;
    this.cancel(false); this.options.settings.update({ localPrompt: next }); return next;
  }
  private input(raw: unknown): LocalPromptInput {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('需求参数无效');
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some(key => !['requirement', 'root', 'skills'].includes(key)) ||
      typeof value.requirement !== 'string' || !value.requirement.trim() || value.requirement.length > 100000 || value.requirement.includes('\0') ||
      (value.root !== null && typeof value.root !== 'string') || !Array.isArray(value.skills) || value.skills.length > 8 ||
      value.skills.some(name => !validSkillName(name)) || new Set(value.skills).size !== value.skills.length) throw new Error('需求、项目或技能参数无效');
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
  async copy(raw: unknown): Promise<LocalPromptResult> {
    try { const prompt = await this.compose(raw); this.options.copy(prompt); return { ok: true, prompt, length: prompt.length }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  async send(raw: unknown): Promise<LocalPromptResult> {
    if (this.options.disabled || !this.getOptions().sendOnEnter) return { ok: false, error: '回车发送未开启，请复制后手动发送' };
    if (this.sending || this.options.busy()) return { ok: false, error: '需求或工具结果正在处理，请等待当前操作结束' };
    const session = this.options.session(); const generation = this.generation; this.sending = true;
    try {
      const prompt = await this.compose(raw);
      if (generation !== this.generation || !this.getOptions().sendOnEnter || session !== this.options.session() || this.options.busy()) return { ok: false, error: '开关、会话或工具状态已变化，需求未发送' };
      // 会话作用域由 integration/sender 核验，允许它们证明首页首发的地址分配。
      const current = () => generation === this.generation && this.getOptions().sendOnEnter && !this.options.busy();
      return { ...await this.options.sender.send(prompt, session, 'prompt', current), length: prompt.length };
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
    handle(CHANNELS.copyPrompt, raw => this.copy(raw)); handle(CHANNELS.sendPrompt, raw => this.send(raw));
    return [CHANNELS.getLocalPromptOptions, CHANNELS.setLocalPromptOptions, CHANNELS.getSkillCatalog, CHANNELS.loadSkill, CHANNELS.copyPrompt, CHANNELS.sendPrompt];
  }
}
