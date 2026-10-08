import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { load as parseYaml, JSON_SCHEMA } from 'js-yaml';
import { validSkillName, type SkillCatalog, type LoadedSkill, type SkillSummary } from '../shared/skills';

const MAX_SKILL_BYTES = 256 * 1024;
const inside = (root: string, target: string) => { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
interface Scan { entries: Map<string, LoadedSkill>; blocked: Set<string>; errors: string[]; failed: boolean }

/** 只读授权目录中的 SKILL.md，不提供附件文件桥或脚本执行入口。 */
export class SkillService {
  constructor(private readonly globalRoot = path.join(os.homedir(), '.agents', 'skills')) {}

  async list(root: string | null): Promise<SkillCatalog> {
    const catalog = await this.catalog(root);
    return { root, skills: [...catalog.entries.values()].map(({ name, description, source }): SkillSummary => ({ name, description, source })), errors: catalog.errors };
  }

  async load(root: string | null, name: string): Promise<LoadedSkill> {
    if (!validSkillName(name)) throw new Error('技能名称无效，不能使用路径');
    // 不缓存文件内容；每次调用重新解析当前生效目录与内容。
    const catalog = await this.catalog(root);
    const skill = catalog.entries.get(name);
    if (!skill) throw new Error(`技能 ${name} 不可用${catalog.errors.length ? '：' + catalog.errors.join('；') : ''}`);
    return skill;
  }

  private async catalog(root: string | null): Promise<Scan> {
    const global = await this.scan(this.globalRoot, 'global');
    if (!root) return global;
    const project = await this.scan(path.join(root, '.mini-ide', 'skills'), 'project');
    const entries = new Map<string, LoadedSkill>();
    // 项目目录不可读取时不猜测是否有覆盖项，拒绝悄悄回退到全局。
    if (!project.failed) for (const [name, skill] of global.entries) if (!project.blocked.has(name) && !project.entries.has(name)) entries.set(name, skill);
    for (const [name, skill] of project.entries) entries.set(name, skill);
    return { entries: new Map([...entries].sort(([a], [b]) => a.localeCompare(b))), errors: [...project.errors, ...global.errors], blocked: project.blocked, failed: project.failed };
  }

  private async scan(directory: string, source: SkillSummary['source']): Promise<Scan> {
    const result: Scan = { entries: new Map(), blocked: new Set(), errors: [], failed: false };
    let authorizedRoot: string; let folders: string[];
    try {
      authorizedRoot = await fs.realpath(directory);
      folders = (await fs.readdir(authorizedRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name).sort();
      if (folders.length > 1000) throw new Error('技能目录超过 1000 项');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { result.failed = true; result.errors.push(`${directory}：${errorText(error)}`); }
      return result;
    }
    for (const folder of folders) {
      let declaredName: string | undefined;
      try {
        const resourceRoot = await fs.realpath(path.join(authorizedRoot, folder));
        const instructionPath = await fs.realpath(path.join(resourceRoot, 'SKILL.md'));
        // 用户全局目录可登记指向共享仓库的技能目录；正文仍限该技能的真实目录。
        if ((source === 'project' && !inside(authorizedRoot, resourceRoot)) || !inside(resourceRoot, instructionPath)) throw new Error('技能符号链接超出授权目录');
        const handle = await fs.open(instructionPath, 'r');
        let content: string;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) throw new Error('SKILL.md 必须为不超过 256 KiB 的普通文件');
          const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > MAX_SKILL_BYTES) throw new Error('SKILL.md 超过 256 KiB');
          content = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
        } finally { await handle.close(); }
        const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
        if (!header) throw new Error('缺少 YAML frontmatter');
        // 解析错误也保留可识别的名字作为遮蔽项，不执行同名全局技能。
        const nameLine = /^name:\s*['"]?([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})['"]?\s*$/m.exec(header[1]!);
        if (nameLine) declaredName = nameLine[1];
        const metadata = parseYaml(header[1]!, { schema: JSON_SCHEMA }) as { name?: unknown; description?: unknown } | null;
        if (metadata && validSkillName(metadata.name)) declaredName = metadata.name;
        if (!metadata || !validSkillName(metadata.name) || typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 4096) throw new Error('name 或 description 无效');
        const name = metadata.name;
        if (result.entries.has(name) || result.blocked.has(name)) throw new Error(`同一来源重复技能名称 ${name}`);
        result.entries.set(name, { name, description: metadata.description.trim(), source, content, instructionPath, resourceRoot });
      } catch (error) {
        for (const name of [folder, declaredName]) if (validSkillName(name)) { result.blocked.add(name); result.entries.delete(name); }
        result.errors.push(`${source}/${folder}：${errorText(error)}`);
      }
    }
    return result;
  }
}
