export interface SkillSummary { name: string; description: string; source: 'project' | 'global' }
export interface SkillCatalog { root: string | null; skills: SkillSummary[]; errors: string[] }
export interface LoadedSkill extends SkillSummary { content: string; instructionPath: string; resourceRoot: string }
/** 技能名字是引用标识，不能作为任意文件路径。 */
export const validSkillName = (name: unknown): name is string => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
