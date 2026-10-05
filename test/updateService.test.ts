import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EditorSession } from '../src/main/editorSession';
import { releaseNotesText, UpdateService, updateDisabledReason, type ReleaseInfo, type UpdateState } from '../src/main/updateService';

const release: ReleaseInfo = { version: '0.2.0', notes: '修复保存问题' };
const deferred = <T>() => {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(disabledReason: string | null = null) {
  const calls = { check: 0, download: 0, install: 0, quit: 0, approve: 0, dispose: 0, available: 0, downloaded: 0, current: 0, errors: [] as string[], unsupported: [] as string[] };
  const choices = { download: false, install: false, approve: true };
  const operations = { check: async (): Promise<ReleaseInfo | null> => release,
    download: async (): Promise<void> => {}, approve: async () => choices.approve, install: async (): Promise<void> => {} };
  const states: UpdateState[] = [];
  const service = new UpdateService({
    check: async () => { calls.check++; return operations.check(); },
    download: async () => { calls.download++; await operations.download(); },
    install: async () => { calls.install++; await operations.install(); }, quit: () => { calls.quit++; }, dispose: () => { calls.dispose++; },
  }, {
    available: async () => { calls.available++; return choices.download; },
    downloaded: async () => { calls.downloaded++; return choices.install; },
    current: async () => { calls.current++; }, error: async error => { calls.errors.push(error); },
    unsupported: async reason => { calls.unsupported.push(reason); },
  }, async () => { calls.approve++; return operations.approve(); }, state => { states.push(state); }, disabledReason);
  return { service, calls, choices, operations, states };
}

it('发现版本后选择稍后不会下载或触碰未保存文件；下载后稍后也不会安装', async () => {
  const f = fixture(); await f.service.check();
  assert.equal(f.calls.download, 0); assert.equal(f.calls.approve, 0); assert.equal(f.service.current.status, 'available');
  await f.service.download(); assert.equal(f.service.current.status, 'ready');
  assert.equal(f.calls.install, 0); assert.equal(f.calls.approve, 0);
  f.service.dispose(); assert.equal(f.calls.install, 0);
});

it('只有下载已校验完成且用户选择安装，才确认未保存文件并启动安装一次', async () => {
  const f = fixture(); const pending = deferred<void>(); f.operations.download = () => pending.promise;
  await f.service.install(); assert.equal(f.calls.approve, 0);
  await f.service.check(); const downloading = f.service.download();
  await f.service.install(); assert.equal(f.calls.approve, 0);
  pending.resolve(); await downloading; await f.service.install();
  assert.equal(f.calls.approve, 1); assert.equal(f.calls.install, 1); assert.equal(f.service.current.status, 'installing');
  await f.service.install(); assert.equal(f.calls.install, 1);
});

it('启动仅查一次；无更新或网络失败不打扰，手动检查有明确结果', async () => {
  const f = fixture(); const pending = deferred<ReleaseInfo | null>(); f.operations.check = () => pending.promise;
  f.service.start(); f.service.start(); assert.equal(f.calls.check, 1);
  pending.resolve(null); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.calls.current, 0);
  f.operations.check = async () => null; await f.service.check(); assert.equal(f.calls.current, 1);
  f.operations.check = async () => { throw new Error('network unreachable'); };
  await f.service.check(false); assert.equal(f.calls.errors.length, 0);
  await f.service.check(); assert.equal(f.calls.errors.length, 1);
});

it('启动提醒确认下载后失败必须提示；不安装且可以重新下载', async () => {
  const f = fixture(); f.choices.download = true;
  f.operations.download = async () => { throw new Error('SHA512 checksum mismatch'); };
  await f.service.check(false); assert.equal(f.calls.errors.length, 1); assert.equal(f.service.current.status, 'error');
  await f.service.install(); assert.equal(f.calls.approve, 0); assert.equal(f.calls.install, 0);
  f.operations.download = async () => {}; await f.service.download(); assert.equal(f.service.current.status, 'ready');
});

it('下载期间重复查询与下载不产生第二条更新任务；失败清除进度', async () => {
  const f = fixture(); await f.service.check(); const pending = deferred<void>(); f.operations.download = () => pending.promise;
  const downloading = f.service.download(); f.service.progress(32.9);
  assert.equal(f.service.current.percent, 32);
  await f.service.download(); await f.service.check(); assert.equal(f.calls.download, 1); assert.equal(f.calls.check, 1);
  pending.reject(new Error('connection reset')); await downloading;
  assert.equal(f.service.current.percent, 0); assert.equal(f.service.current.busy, false);
  f.service.progress(90); assert.equal(f.service.current.percent, 0);
});

it('取消离开、保存失败都保留已下载更新，不退出安装；成功保存才能继续', async () => {
  const f = fixture(); let choice: 'cancel' | 'save' = 'cancel'; let sent = 0;
  const session = new EditorSession(async () => choice, id => { sent = id; });
  session.update({ root: 'A', path: 'a.txt', documents: [{ path: 'a.txt', dirty: true }] });
  f.operations.approve = () => session.canLeave(); await f.service.check(); await f.service.download();
  await f.service.install(); assert.equal(f.calls.install, 0); assert.equal(f.service.current.status, 'ready');
  choice = 'save'; const failed = f.service.install(); await Promise.resolve(); await Promise.resolve(); session.reply(sent, false); await failed;
  assert.equal(f.calls.install, 0); assert.equal(f.service.current.status, 'ready');
  const saved = f.service.install(); await Promise.resolve(); await Promise.resolve();
  session.update({ root: 'A', path: 'a.txt', documents: [{ path: 'a.txt', dirty: false }] }); session.reply(sent, true); await saved;
  assert.equal(f.calls.install, 1);
});

it('安装 gate 期间重复点击不会重复确认；disposed 后 gate 的批准不能再安装', async () => {
  const f = fixture(); await f.service.check(); await f.service.download(); const pending = deferred<boolean>();
  f.operations.approve = () => pending.promise; const installing = f.service.install();
  await f.service.install(); assert.equal(f.calls.approve, 1); assert.equal(f.service.current.status, 'confirming');
  f.service.dispose(); const count = f.states.length; pending.resolve(true); await installing;
  assert.equal(f.calls.install, 0); assert.equal(f.states.length, count);
});

it('安装启动同步或异步失败均不退出，重新检查下载后可以再次安装', async () => {
  const f = fixture(); await f.service.check(); await f.service.download();
  f.operations.install = () => { throw new Error('installer unavailable'); };
  await f.service.install(); assert.equal(f.service.current.status, 'error'); assert.equal(f.service.current.release, null); assert.equal(f.calls.errors.length, 1);
  f.operations.install = async () => { throw new Error('spawn failed'); }; await f.service.check(); await f.service.download(); await f.service.install();
  assert.notEqual(f.service.current.status, 'installing'); assert.equal(f.calls.quit, 0);
  assert.equal(f.calls.errors.length, 2);
  assert.equal(f.service.current.release, null); await f.service.install(); assert.equal(f.calls.install, 2);
  f.operations.install = async () => {};
  await f.service.check(); await f.service.download(); await f.service.install(); assert.equal(f.calls.install, 3); assert.equal(f.calls.quit, 1);
});

it('关闭后在途查询、下载和进度不弹出对话框、不改变状态、不安装', async () => {
  const checking = fixture(); const check = deferred<ReleaseInfo | null>(); checking.operations.check = () => check.promise;
  const query = checking.service.check(); checking.service.dispose(); const queryStates = checking.states.length;
  check.resolve(release); await query; assert.equal(checking.calls.available, 0); assert.equal(checking.states.length, queryStates);
  const downloading = fixture(); await downloading.service.check(); const download = deferred<void>(); downloading.operations.download = () => download.promise;
  const task = downloading.service.download(); downloading.service.dispose(); const downloadStates = downloading.states.length;
  downloading.service.progress(80); download.resolve(); await task;
  assert.equal(downloading.calls.downloaded, 0); assert.equal(downloading.states.length, downloadStates);
  assert.equal(downloading.calls.install, 0); downloading.service.dispose(); assert.equal(downloading.calls.dispose, 1);
});

it('等待安装器进程启动时仍保持普通退出保护，并禁止重复确认与并发更新', async () => {
  const f = fixture(); await f.service.check(); await f.service.download();
  const pending = deferred<void>(); f.operations.install = () => pending.promise;
  const installing = f.service.install(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.service.current.status, 'confirming'); assert.equal(f.calls.quit, 0);
  await f.service.install(); await f.service.check(); await f.service.download(); assert.equal(f.calls.approve, 1); assert.equal(f.calls.install, 1);
  pending.reject(new Error('ENOENT')); await installing;
  assert.equal(f.service.current.status, 'error'); assert.equal(f.service.current.release, null);
  assert.equal(f.service.current.busy, false); assert.equal(f.calls.errors.length, 1);
  assert.equal(f.calls.quit, 0);
  assert.match(f.calls.errors[0]!, /重新检查更新/);
});

it('安装器已成功创建后才标记安装并退出；期间关闭应用不再调用quit', async () => {
  const f = fixture(); await f.service.check(); await f.service.download(); const pending = deferred<void>(); f.operations.install = () => pending.promise;
  const installing = f.service.install(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.service.current.status, 'confirming'); pending.resolve(); await installing;
  assert.equal(f.service.current.status, 'installing'); assert.equal(f.calls.quit, 1);
  const closing = fixture(); await closing.service.check(); await closing.service.download(); const late = deferred<void>(); closing.operations.install = () => late.promise;
  const task = closing.service.install(); await Promise.resolve(); await Promise.resolve(); closing.service.dispose();
  late.resolve(); await task; assert.equal(closing.calls.quit, 0);
});

it('开发、诊断、Portable、非 Windows 与 win-unpacked 均禁止后台检查和安装', async () => {
  const installed = { packaged: true, platform: 'win32', disabled: false, portable: false, installed: true };
  assert.equal(updateDisabledReason(installed), null);
  for (const override of [{ packaged: false }, { platform: 'linux' }, { disabled: true }, { portable: true }, { installed: false }]) {
    const reason = updateDisabledReason({ ...installed, ...override }); assert.ok(reason);
    const f = fixture(reason); f.service.start(); await f.service.check(); await f.service.download(); await f.service.install();
    assert.equal(f.calls.check, 0); assert.equal(f.calls.download, 0); assert.equal(f.calls.install, 0); assert.equal(f.calls.unsupported.length, 1);
  }
});

it('远程说明显示为有长度限制的普通文本，不保留 HTML 和 Markdown 图片地址', () => {
  assert.equal(releaseNotesText('# 新版本\n**保存** [说明](https://example.test) <b>稳定</b> ![图](https://example.test/a.png)'), '新版本\n保存 说明 稳定 图');
  assert.equal(releaseNotesText([{ version: '0.2.0', note: null }]), '0.2.0');
  assert.equal(releaseNotesText('a'.repeat(5_000)).length, 4_000);
});
