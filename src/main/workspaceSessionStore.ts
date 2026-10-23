import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sameWorkspaceConversation, workspaceConversationUrl } from '../shared/workspaceSessions';
import type { WorkspaceConversation, WorkspaceSession } from '../shared/workspaceSessions';

function sessionTitle(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('会话名称须为 1–160 个字符，且不能包含控制字符');
  const title = value.trim();
  if (!title.length || title.length > 160) throw new Error('会话名称须为 1–160 个字符，且不能包含控制字符');
  return title;
}

function sessionRoot(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('会话绑定需要有效的项目绝对路径');
  return path.resolve(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === keys.sort().join(',');
}

/** 仅保存用户显式绑定的身份和本地展示信息；损坏文件不重置，保存失败不更改内存。 */
export class WorkspaceSessionStore {
  private data: WorkspaceSession[];

  constructor(private readonly file: string) { this.data = this.load(); }

  get sessions(): WorkspaceSession[] { return this.data.map(session => ({ ...session })); }

  bind(root: string, conversation: WorkspaceConversation, title: string): WorkspaceSession {
    const normalizedRoot = sessionRoot(root);
    workspaceConversationUrl(conversation);
    const existing = this.data.find(session => sameWorkspaceConversation(session, conversation));
    if (existing) {
      if (existing.root.toLowerCase() !== normalizedRoot.toLowerCase()) throw new Error('该网页会话已绑定其他项目');
      return { ...existing };
    }
    const session: WorkspaceSession = {
      id: randomUUID(), root: normalizedRoot, title: sessionTitle(title),
      platform: conversation.platform, accountId: conversation.accountId, conversationId: conversation.conversationId,
    };
    const next = [...this.data, session];
    this.save(next);
    this.data = next;
    return { ...session };
  }

  unbind(id: string): void {
    if (typeof id !== 'string' || !this.data.some(session => session.id === id)) throw new Error('会话绑定不存在，请刷新后重试');
    const next = this.data.filter(session => session.id !== id);
    this.save(next);
    this.data = next;
  }

  private load(): WorkspaceSession[] {
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`会话绑定读取失败（原文件保留）：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('格式无效');
      const data = parsed as Record<string, unknown>;
      if (!hasKeys(data, ['version', 'sessions']) || data.version !== 1 || !Array.isArray(data.sessions)) throw new Error('格式无效');
      const sessions: WorkspaceSession[] = [];
      const ids = new Set<string>();
      for (const value of data.sessions) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('会话格式无效');
        const entry = value as Record<string, unknown>;
        if (!hasKeys(entry, ['id', 'root', 'title', 'platform', 'accountId', 'conversationId'])
          || typeof entry.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.id)
          || ids.has(entry.id)) throw new Error('会话编号无效或重复');
        const session = entry as unknown as WorkspaceSession;
        workspaceConversationUrl(session);
        if (sessionRoot(session.root) !== session.root || sessionTitle(session.title) !== session.title) throw new Error('项目路径或会话名称无效');
        if (sessions.some(existing => sameWorkspaceConversation(existing, session))) throw new Error('网页会话重复绑定');
        ids.add(session.id);
        sessions.push({ ...session });
      }
      return sessions;
    } catch (err) {
      throw new Error(`会话绑定读取失败（原文件保留）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private save(next: WorkspaceSession[]): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, sessions: next }, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } catch (err) {
      try { fs.unlinkSync(temporary); } catch { /* 未创建或已替换，无需清理 */ }
      throw new Error(`会话绑定保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
