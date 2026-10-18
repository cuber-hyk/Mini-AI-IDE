/** 正式工具容器内的具名原文。只做确定性运输解码，不授予执行资格。 */
export interface ToolTextBody { id: string; text: string }
export interface ToolTextEnvelope { manifest: string; bodies: ToolTextBody[] }
const bodyId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value) && value !== 'manifest';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const marker = (line: string) => /^\s*@@(?:body|end)(?:\s|$)/.test(line);

export function splitToolTextEnvelope(source: string): ToolTextEnvelope {
  const lines = source.split('\n');
  const first = lines.findIndex(marker);
  if (first < 0) return { manifest: source, bodies: [] };
  if (source.length > 200_000 || source.includes('\0')) throw new Error('带原文块的工具容器最多200000字符，不能包含空字符');
  const manifest = lines.slice(0, first).join('\n');
  const bodies: ToolTextBody[] = []; const seen = new Set<string>();
  for (let index = first; index < lines.length;) {
    const start = /^@@body ([a-zA-Z0-9][a-zA-Z0-9_.-]{0,99})$/.exec(lines[index]!);
    if (!start || !bodyId(start[1])) throw new Error('原文块起始行必须为 @@body 唯一ID，manifest为保留名称');
    const id = start[1]!;
    if (seen.has(id) || bodies.length >= 100) throw new Error('原文块ID重复或超过100块');
    seen.add(id); const begin = ++index;
    while (index < lines.length && !marker(lines[index]!)) index++;
    if (lines[index] !== '@@end ' + id) throw new Error(`原文块 ${id} 未完整闭合或正文包含歧义边界行；本批未执行`);
    bodies.push({ id, text: lines.slice(begin, index).join('\n') });
    index++;
    if (index < lines.length && !lines[index]!.startsWith('@@body ')) throw new Error('原文块之后只允许紧邻的下一原文块，不允许额外正文');
  }
  return { manifest, bodies };
}

export function joinToolTextEnvelope(envelope: ToolTextEnvelope): string {
  return [envelope.manifest, ...envelope.bodies.map(body => `@@body ${body.id}\n${body.text}\n@@end ${body.id}`)].join('\n');
}

/** 只访问明确声明的正文槽；不对路径、命令参数中的占位符或任意对象递归插值。 */
export function resolveToolTextBodies(value: unknown, bodies: ToolTextBody[]): void {
  const byId = new Map(bodies.map(body => [body.id, body.text])); const used = new Set<string>();
  const resolve = (owner: Record<string, unknown>, key: string) => {
    const reference = owner[key];
    if (!record(reference)) return;
    if (Object.keys(reference).length !== 1 || !bodyId(reference.text_ref)) throw new Error(`${key} 原文引用必须仅含有效 text_ref`);
    const id = reference.text_ref;
    if (!byId.has(id) || used.has(id)) throw new Error(`原文引用 ${id} 不存在或被重复引用`);
    used.add(id); owner[key] = byId.get(id)!;
  };
  if (record(value)) {
    if (record(value.repair_draft)) {
      resolve(value.repair_draft, 'content');
      resolve(value.repair_draft, 'old_string'); resolve(value.repair_draft, 'new_string');
    } else if (Array.isArray(value.requests)) {
      for (const request of value.requests) {
        if (!record(request) || !record(request.args)) continue;
        if (request.tool === 'run_command') resolve(request.args, 'command');
        if (request.tool === 'apply_changes' && Array.isArray(request.args.changes)) {
          for (const change of request.args.changes) {
            if (!record(change)) continue;
            resolve(change, 'content');
            if (Array.isArray(change.edits)) for (const edit of change.edits) {
              if (record(edit)) { resolve(edit, 'old_string'); resolve(edit, 'new_string'); }
            }
          }
        }
      }
    }
  }
  if (used.size !== byId.size) throw new Error('存在未被指定正文槽引用的原文块，本批未执行');
}

export function replaceToolTextBody(source: string, id: string, content: string): string {
  const envelope = splitToolTextEnvelope(source);
  if (id === 'manifest') {
    if (content.split('\n').some(marker)) throw new Error('清单不能包含原文边界行');
    envelope.manifest = content;
  } else {
    const target = envelope.bodies.find(body => body.id === id);
    if (!target) throw new Error('当前修订稿不存在指定原文块');
    if (content.split('\n').some(marker)) throw new Error('替换正文包含歧义边界行');
    target.text = content;
  }
  return joinToolTextEnvelope(envelope);
}

/** 恢复解析时避免正文内围栏提前结束正式容器。 */
export function wrapToolTextEnvelope(body: string): string {
  let longest = 0;
  for (const match of body.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(4, longest + 1));
  return `${fence}mini-ai-tools\n${body}\n${fence}`;
}
