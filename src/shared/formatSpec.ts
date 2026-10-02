/**
 * 输出格式要求模板（纯逻辑，可单测）
 *
 * 用途：让"一键同步"稳定成立。**由用户自己复制并粘贴到提示词里**——
 * 程序只把这段文本写进系统剪贴板，**绝不写入网页输入框**（ADR-0003 零注入边界）。
 *
 * 与解析器的关系：模板声明的格式要**正好落在解析器能识别的形态上**
 * （见 src/shared/returnPath.ts 的路径线索优先级）。因此这里的示例写法不是随便写的：
 *  - `### 文件：路径` 命中"标题式路径行"线索；
 *  - 围栏内首行 `// 路径` 命中"路径注释"线索。
 * 两者任一存在即可被自动识别。
 */

/** 简短版：贴一次就够，适合日常（约 150 字） */
export const FORMAT_SPEC_SHORT = [
  '【输出格式要求】',
  '（前提：我粘贴的每段代码前都会写一行“这个文件是 <相对路径>”，请据此确定文件名）',
  '1. 要改的文件请在代码块上方单独一行写：### 文件：相对路径（例如 ### 文件：src/main/index.ts）',
  '2. 或把路径写在代码块第一行注释里（例如 // src/main/index.ts）',
  '3. 每个文件一个代码块，块内只放该文件的完整内容，不要行号、不要省略号',
  '4. 不要输出解释性前后缀；文件名一律用相对路径',
  '5. 若涉及多个文件，**每个文件都单独标注** ### 文件：相对路径，一个文件一个代码块',
].join('\n');

/** 完整版：需要严谨改动时使用（含"只改片段"的说明） */
export const FORMAT_SPEC_FULL = [
  '【输出格式要求】',
  '',
  '前提：我粘贴的每段代码前面都会写一行“这个文件是 <相对路径>”，请据此确定文件名。',
  '',
  'A. 若你给出某个文件的**完整新内容**：',
  '   - 代码块上方单独一行写：### 文件：相对路径（例如 ### 文件：src/main/index.ts）',
  '   - 或者把路径写在代码块第一行注释里（例如 // src/main/index.ts）',
  '   - 每个文件单独一个代码块，块内只放该文件内容，不要行号、不要“...”省略',
  '',
  'B. 若你只给出**局部改动**：',
  '   - 同样用上述方式标明文件路径；',
  '   - 并在代码块上方写一行：### 位置：插入到第 N 行之后（或 ### 位置：替换第 N–M 行）',
  '',
  'C. 通用约定：',
  '   - 路径一律使用相对路径，用 / 分隔；',
  '   - 只输出代码，不要额外的解释性前后缀；',
  '   - 有多处改动时，按文件分别给出代码块。',
].join('\n');

export type FormatSpecVariant = 'short' | 'full';

export function getFormatSpec(variant: FormatSpecVariant = 'short'): string {
  return variant === 'full' ? FORMAT_SPEC_FULL : FORMAT_SPEC_SHORT;
}

/* ------------------------------------------------------------------ *
 * 完整 prompt 组装（由用户在本应用内点击"复制 prompt"触发）
 * ------------------------------------------------------------------ */

export interface PromptContext {
  /** 工作目录（绝对路径，按用户机器如实给出） */
  root: string | null;
  /** 目录摘要（相对路径列表，已截断并注明） */
  tree: string | null;
  /** 运行环境摘要，如 "Windows 10.0.26200；Node 24.21.0" */
  environment: string | null;
}

export interface BuildPromptInput {
  /** 用户在应用内输入框里写的需求（唯一由人写的部分） */
  requirement: string;
  context: PromptContext;
  /** 输出格式要求；传入空字符串则不附 */
  formatSpec: string;
  /** 可选：要改的文件路径（用户手填），会单独成段 */
  targetFiles?: string[];
}

/**
 * 把"用户需求 + 环境上下文 + 输出格式要求"组装成完整 prompt。
 *
 * 说明：本函数只产出**文本**，由调用方写入系统剪贴板；
 * **绝不写入网页输入框** —— 最后那一下 Ctrl+V 必须由用户完成（ADR-0003）。
 */
export function buildPrompt(input: BuildPromptInput): string {
  const parts: string[] = [];

  if (input.requirement.trim().length > 0) {
    parts.push(`## 用户需求\n${input.requirement.trim()}`);
  }

  const envLines: string[] = [];
  if (input.context.environment) envLines.push(`- 运行环境: ${input.context.environment}`);
  if (input.context.root) envLines.push(`- 当前工作目录: ${input.context.root}`);
  if (envLines.length > 0) {
    parts.push(`## 工作环境\n${envLines.join('\n')}`);
  }

  if (input.context.tree) {
    parts.push(`## 目录结构（摘要）\n${input.context.tree}`);
  }

  if (input.targetFiles && input.targetFiles.length > 0) {
    parts.push(`## 要改的文件\n${input.targetFiles.map((f) => `- ${f}`).join('\n')}`);
  }

  if (input.formatSpec.trim().length > 0) {
    parts.push(input.formatSpec.trim());
  }

  return parts.join('\n\n');
}

