/** 主进程与编辑器之间的软件更新状态；发布说明仅作为普通文本。 */
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'confirming' | 'installing' | 'error';
export interface ReleaseInfo { version: string; notes: string }
export interface UpdateState {
  status: UpdateStatus;
  release: ReleaseInfo | null;
  percent: number;
  busy: boolean;
  error: string | null;
  checked: boolean;
  revision: number;
}
export interface ApplicationUpdateState extends UpdateState {
  currentVersion: string;
  disabledReason: string | null;
}
