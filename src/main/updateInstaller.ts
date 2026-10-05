/** 仅启动已下载并校验的 NSIS 完整安装器，等待操作系统确认进程创建成功。 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type InstallerSpawner = (command: string, args: readonly string[], options: SpawnOptions) => Pick<ChildProcess, 'once' | 'unref'>;

export function launchUpdateInstaller(options: { installerPath: string; installDirectory: string },
  spawnProcess: InstallerSpawner = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    // NSIS /D 必须最后且不能带引号，即使目录含空格。仅对 argv0 引用 exe 路径。
    // windowsVerbatimArguments 禁止 Node 改写 /D；shell:false 不解释任何 shell 字符。
    const child = spawnProcess(options.installerPath, ['--updated', '--force-run', `/D=${options.installDirectory}`], {
      argv0: `"${options.installerPath}"`, windowsVerbatimArguments: true,
      shell: false, detached: true, stdio: 'ignore', windowsHide: true,
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
