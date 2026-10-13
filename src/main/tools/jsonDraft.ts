import { createHash, randomUUID } from 'node:crypto';
import { parseToolBatch, type ToolBatch, type ToolDraftPatch } from '../../shared/toolProtocol';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const MAX_SOURCE = 200_000;

export interface RecoveredToolOrigin {
  draft_id: string;
  version: number;
  originalHash: string;
  revisedHash: string;
  patchHash: string;
  patchSourceText: string;
  batchHash: string;
  scope: string;
}

interface Draft {
  id: string;
  root: string;
  session: string;
  scope: string;
  originalSource: string;
  originalBody: string;
  revisedBody: string;
  version: number;
  completed: boolean;
}
export type DraftPatchOutcome =
  | { kind: 'rejected'; error: string }
  | { kind: 'diagnostic'; error: string; draft_id: string; version: number }
  | { kind: 'batch'; batch: ToolBatch; origin: RecoveredToolOrigin };

/** In-memory owner for a single unexecuted syntax-error draft, never an execution path. */
export class JsonDraft {
  private value: Draft | null = null;
  private recovered: RecoveredToolOrigin | null = null;

  invalidate(): void { this.value = null; this.recovered = null; }

  matchesRecovery(root: string | null, session: string, scope: string, origin: RecoveredToolOrigin): boolean {
    const draft = this.value; const stored = this.recovered;
    return !!root && !!draft && draft.completed && draft.root === root && draft.session === session && draft.scope === scope &&
      stored === origin && origin.scope === scope && origin.draft_id === draft.id && origin.version === draft.version &&
      hash(draft.originalSource) === origin.originalHash && hash(draft.revisedBody) === origin.revisedHash &&
      hash(origin.patchSourceText) === origin.patchHash;
  }

  current(root: string | null, session: string, scope: string): { draft_id: string; version: number } | null {
    const draft = this.value;
    if (!draft || draft.root !== root || draft.session !== session || draft.scope !== scope || draft.completed) return null;
    return { draft_id: draft.id, version: draft.version };
  }

  capture(root: string | null, session: string, scope: string, sourceText: string, jsonBody: string): { draft_id: string; version: number } | null {
    if (!root || !sourceText || sourceText.length > MAX_SOURCE || jsonBody.length > MAX_SOURCE) { this.invalidate(); return null; }
    if (this.value && !this.value.completed && this.value.root === root && this.value.session === session &&
        this.value.scope === scope && this.value.originalSource === sourceText) {
      return { draft_id: this.value.id, version: this.value.version };
    }
    this.recovered = null;
    this.value = { id: randomUUID(), root, session, scope, originalSource: sourceText,
      originalBody: jsonBody, revisedBody: jsonBody, version: 1, completed: false };
    return { draft_id: this.value.id, version: 1 };
  }

  static instruction(metadata: { draft_id: string; version: number }): string {
    return `草稿 ${metadata.draft_id}；修订稿版本 ${metadata.version}。原始回复保持不变。可用单个完整 mini-ai-tools 围栏发送 {"repair_draft":{"draft_id":"${metadata.draft_id}","version":${metadata.version},"old_string":"当前修订稿中的唯一原文","new_string":"替换内容"}}。只能更改当前修订稿中的唯一片段；本指令尚未执行任何工具。`;
  }

  apply(root: string | null, session: string, scope: string, sourceText: string, patch: ToolDraftPatch): DraftPatchOutcome {
    const draft = this.value;
    if (!draft || !root || draft.root !== root || draft.session !== session || draft.scope !== scope || draft.completed)
      return { kind: 'rejected', error: '没有当前项目和会话中可恢复的未执行 JSON 草稿；补丁未应用' };
    if (draft.id !== patch.draft_id || draft.version !== patch.version)
      return { kind: 'rejected', error: `草稿 ID 或版本不匹配，当前修订版本为 ${draft.version}；补丁未应用` };
    if (!patch.old_string || patch.old_string === patch.new_string || patch.new_string.length > MAX_SOURCE || sourceText.length > MAX_SOURCE)
      return { kind: 'rejected', error: '修复片段无效或超过限制；补丁未应用' };
    const offset = draft.revisedBody.indexOf(patch.old_string);
    if (offset < 0 || draft.revisedBody.indexOf(patch.old_string, offset + 1) !== -1)
      return { kind: 'rejected', error: 'old_string 在当前修订稿中不存在或不唯一；补丁未应用' };
    const revised = draft.revisedBody.slice(0, offset) + patch.new_string + draft.revisedBody.slice(offset + patch.old_string.length);
    if (revised.length > MAX_SOURCE) return { kind: 'rejected', error: '修订稿超过 200000 字符；补丁未应用' };
    draft.revisedBody = revised;
    draft.version++;
    const parsed = parseToolBatch('```mini-ai-tools\n' + revised + '\n```');
    if (parsed.kind !== 'batch') {
      const detail = parsed.kind === 'error' ? parsed.error : '修订稿未形成合法的完整工具批次';
      if (parsed.kind !== 'error' || parsed.jsonBody === undefined) {
        this.invalidate();
        return { kind: 'rejected', error: `修订稿已不属于可继续局部修复的 JSON 语法错误：${detail}；草稿已失效，未执行工具。请重新提交新的完整合法批次。` };
      }
      return { kind: 'diagnostic', error: `${detail}\n${JsonDraft.instruction({ draft_id: draft.id, version: draft.version })}`, draft_id: draft.id, version: draft.version };
    }
    draft.completed = true;
    const origin: RecoveredToolOrigin = {
      draft_id: draft.id, version: draft.version, originalHash: hash(draft.originalSource),
      revisedHash: hash(draft.revisedBody), patchHash: hash(sourceText), patchSourceText: sourceText,
      batchHash: hash(JSON.stringify(parsed.batch)), scope,
    };
    this.recovered = origin;
    return { kind: 'batch', batch: parsed.batch, origin };
  }
}
