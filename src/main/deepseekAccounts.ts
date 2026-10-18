import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DEEPSEEK_ACCOUNT_ID, deepseekAccountPartition } from '../shared/deepseekAccounts';
import type { DeepSeekAccount } from '../shared/deepseekAccounts';

interface AccountData { nextId: number; accounts: DeepSeekAccount[] }

function accountName(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('账号备注须为 1–32 个字符，且不能包含控制字符');
  const name = value.trim();
  if (!name.length || name.length > 32) throw new Error('账号备注须为 1–32 个字符，且不能包含控制字符');
  return name;
}

/** 只存本地备注和单调编号；登录资料仍由 Chromium 独立分区持有。 */
export class DeepSeekAccountStore {
  private data: AccountData;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  get accounts(): DeepSeekAccount[] {
    return this.data.accounts.map(account => ({ ...account }));
  }

  add(value: unknown): DeepSeekAccount {
    const name = accountName(value);
    if (this.data.accounts.some(account => account.name === name)) throw new Error('账号备注已存在');
    if (!Number.isSafeInteger(this.data.nextId + 1)) throw new Error('DeepSeek 账号编号已用尽');
    const account = { id: `account-${this.data.nextId}`, name };
    const next = { nextId: this.data.nextId + 1, accounts: [...this.data.accounts, account] };
    this.save(next);
    this.data = next;
    return { ...account };
  }

  private load(): AccountData {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { nextId: 1, accounts: [{ id: DEFAULT_DEEPSEEK_ACCOUNT_ID, name: '默认账号' }] };
      }
      throw new Error(`DeepSeek 账号读取失败（原文件保留）：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('格式无效');
      const data = parsed as Record<string, unknown>;
      if (!Number.isSafeInteger(data.nextId) || (data.nextId as number) < 1 || !Array.isArray(data.accounts)) throw new Error('格式无效');
      const ids = new Set<string>();
      const names = new Set<string>();
      const accounts: DeepSeekAccount[] = [];
      for (const value of data.accounts) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('账号格式无效');
        const entry = value as Record<string, unknown>;
        if (typeof entry.id !== 'string') throw new Error('账号编号无效');
        deepseekAccountPartition(entry.id);
        const name = accountName(entry.name);
        if (name !== entry.name || ids.has(entry.id) || names.has(name)) throw new Error('账号备注或编号重复/无效');
        if (entry.id !== DEFAULT_DEEPSEEK_ACCOUNT_ID && Number(entry.id.slice('account-'.length)) >= (data.nextId as number)) throw new Error('账号编号顺序无效');
        ids.add(entry.id); names.add(name);
        accounts.push({ id: entry.id, name });
      }
      if (!ids.has(DEFAULT_DEEPSEEK_ACCOUNT_ID)) throw new Error('默认账号缺失');
      return { nextId: data.nextId as number, accounts };
    } catch (err) {
      throw new Error(`DeepSeek 账号读取失败（原文件保留）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private save(next: AccountData): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } catch (err) {
      try { fs.unlinkSync(temporary); } catch { /* 未创建或已替换，无需清理 */ }
      throw new Error(`DeepSeek 账号保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
