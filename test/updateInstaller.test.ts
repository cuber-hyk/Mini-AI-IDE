import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchUpdateInstaller, type InstallerSpawner } from '../src/main/updateInstaller';
import { UpdateService } from '../src/main/updateService';

class FakeChild extends EventEmitter {
  unrefs = 0;
  unref(): void { this.unrefs++; }
}
const installerOptions = { installerPath: 'C:\\更新 缓存\\Mini-AI-IDE Setup & 0.2.0.exe', installDirectory: 'C:\\应用 目录\\Mini-AI-IDE' };

it('等待操作系统 spawn 事件，不能把获得 ChildProcess 对象当成启动成功', async () => {
  const child = new FakeChild(); let completed = false;
  const task = launchUpdateInstaller(installerOptions, () => child).then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false); assert.equal(child.unrefs, 0);
  child.emit('spawn'); await task; assert.equal(completed, true); assert.equal(child.unrefs, 1);
});

it('ENOENT 异步错误或 spawn 同步异常直接失败，不调用任何兜底启动方法', async () => {
  const child = new FakeChild(); const task = launchUpdateInstaller(installerOptions, () => child);
  child.emit('error', Object.assign(new Error('installer no longer exists'), { code: 'ENOENT' }));
  await assert.rejects(task, { code: 'ENOENT' }); assert.equal(child.unrefs, 0);
  await assert.rejects(launchUpdateInstaller(installerOptions, () => { throw new Error('spawn denied'); }), /spawn denied/);
});

it('直接执行已校验exe，路径与参数独立传递，NSIS安装目录在最后，无shell执行', async () => {
  const child = new FakeChild(); let called = 0;
  const spawnProcess: InstallerSpawner = (command, args, settings) => {
    called++; assert.equal(command, installerOptions.installerPath);
    assert.deepEqual(args, ['--updated', '--force-run', `/D=${installerOptions.installDirectory}`]);
    assert.deepEqual(settings, { argv0: `"${installerOptions.installerPath}"`, windowsVerbatimArguments: true,
      shell: false, detached: true, stdio: 'ignore', windowsHide: true });
    return child;
  };
  const task = launchUpdateInstaller(installerOptions, spawnProcess); child.emit('spawn'); await task;
  assert.equal(called, 1);
});

it('真实操作系统拒绝不存在的安装器路径，Promise保留ENOENT且不会启动替代程序', async () => {
  await assert.rejects(launchUpdateInstaller({ installerPath: join(tmpdir(), `Mini-AI-IDE-missing-${randomUUID()}.exe`),
    installDirectory: installerOptions.installDirectory }), { code: 'ENOENT' });
});

it('真实安装启动边界的失败不退出，成功之后才退出；保持用户确认在启动之前', async () => {
  const exercise = async (success: boolean) => {
    const child = new FakeChild(); const events: string[] = [];
    const service = new UpdateService({
      check: async () => ({ version: '0.2.0', notes: '' }), download: async () => {},
      install: () => { events.push('launch'); return launchUpdateInstaller(installerOptions, () => child); },
      quit: () => { events.push('quit'); }, dispose: () => {},
    }, {
      available: async () => false, downloaded: async () => false, current: async () => {}, unsupported: async () => {},
      error: async () => { events.push('error'); },
    }, async () => { events.push('approve'); return true; }, () => {}, null);
    await service.check(); await service.download(); const installing = service.install();
    await Promise.resolve(); await Promise.resolve(); assert.deepEqual(events, ['approve', 'launch']);
    assert.equal(service.current.status, 'confirming');
    if (success) child.emit('spawn');
    else child.emit('error', Object.assign(new Error('installer missing'), { code: 'ENOENT' }));
    await installing;
    assert.deepEqual(events, success ? ['approve', 'launch', 'quit'] : ['approve', 'launch', 'error']);
    assert.equal(service.current.status, success ? 'installing' : 'error');
  };
  await exercise(false); await exercise(true);
});
