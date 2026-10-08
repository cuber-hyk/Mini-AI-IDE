/** 仅启动已下载并校验的 NSIS 完整安装器，等待操作系统确认进程创建成功。 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type InstallerSpawner = (command: string, args: readonly string[], options: SpawnOptions) => Pick<ChildProcess, 'once' | 'unref'>;

export function launchUpdateInstaller(options: { installerPath: string; installDirectory: string },
  spawnProcess: InstallerSpawner = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    // 让 Node 在 Windows 上负责参数转义；手动开启 windowsVerbatimArguments 会让
    // 含空格的 /D=安装目录 被拆成多个参数，NSIS 随后可能静默退出。
    const child = spawnProcess(options.installerPath, ['--updated', '--force-run', `/D=${options.installDirectory}`], {
      shell: false, detached: true, stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      try {
        child.unref();
        resolve();
      } catch (error) { reject(error); }
    });
  });
}
