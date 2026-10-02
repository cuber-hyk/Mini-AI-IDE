/**
 * 安装 Electron 二进制（约 246MB）
 *
 * 为什么需要单独一步：pnpm 默认拦截依赖的 `postinstall` 脚本，而 electron 包正是靠
 * postinstall 下载二进制的，因此 `pnpm install` 之后 node_modules/electron/dist 是空的。
 *
 * 本脚本做两件事（按顺序尝试）：
 *   1. 调用 electron 官方 install.js（走镜像，见 .npmrc 注释）；
 *   2. 若失败，尝试从 tools/ 目录复制一份已下载好的二进制（本仓库的开发机就是这种情形）。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const target = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const fallbackSource = path.join(repoRoot, 'tools', 'node_modules', 'electron', 'dist');

function exists(p) {
  return fs.existsSync(p);
}

if (exists(target)) {
  console.log(`[setup:electron] 已存在，跳过：${target}`);
  process.exit(0);
}

const installer = path.join(repoRoot, 'node_modules', 'electron', 'install.js');
if (exists(installer)) {
  console.log('[setup:electron] 调用 electron install.js（镜像：npmmirror）...');
  try {
    execFileSync(process.execPath, [installer], {
      stdio: 'inherit',
      cwd: path.join(repoRoot, 'node_modules', 'electron'),
      env: {
        ...process.env,
        ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
        ELECTRON_RUN_AS_NODE: undefined,
      },
    });
  } catch (err) {
    console.warn(`[setup:electron] install.js 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

if (!exists(target) && exists(fallbackSource)) {
  console.log(`[setup:electron] 从 tools/ 复制已下载的二进制：${fallbackSource}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(fallbackSource, path.dirname(target), { recursive: true });
}

if (!exists(target)) {
  console.error('[setup:electron] 仍无法获得 electron.exe。请检查网络/代理后重试。');
  process.exit(1);
}
console.log(`[setup:electron] 完成：${target}`);
