/**
 * 打包 Windows 产物（NSIS 安装包 + portable 免安装 exe）。
 *
 * 为什么不直接 `electron-builder --win`：本机需要几个环境变量才打得动，
 * 写成脚本是为了让「打包」这件事在别人机器上也是一条命令、且行为确定。
 *
 * 本脚本负责三件事：
 *   1. 设下载镜像（见下方「镜像」段）；
 *   2. 先跑 `npm run build`（tsc + copy-static + 生成渲染进程作用域报告）
 *      —— electron-builder 不会替你编译，`dist/` 必须是新鲜的；
 *   3. 顺带先跑一次 typecheck，让类型错误在打包前就暴露，而不是变成
 *      "打包成功了但一运行就白屏"。
 *
 * 产物（默认 x64）：
 *   release/Mini-AI-IDE-Setup-<ver>-x64.exe
 *   release/Mini-AI-IDE-Portable-<ver>-x64.exe
 *
 * 用法：
 *   node scripts/package-win.mjs             # 完整打包
 *   node scripts/package-win.mjs --dir       # 只出解包目录（快速验证能启动）
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const passthrough = process.argv.slice(2);

/**
 * 镜像设置。
 *
 * 背景：electron-builder 除了 Electron 运行时本身，还要下载 **NSIS 工具链**
 * （makensis）与 **winCodeSign**（改 exe 版本信息/图标用的工具），这两个默认从
 * GitHub Releases 拉，国内直连经常卡住，切到 npmmirror 更快更稳。
 *
 * ⚠️ 只镜像**构建期二进制**，刻意**不设** `ELECTRON_MIRROR`：镜像地址参与
 * electron 缓存目录的 key 计算（`%LOCALAPPDATA%/electron/Cache/<sha256>`），
 * 一旦改动就会 miss 掉本机已有的 Electron 运行时缓存，导致重新下载 151MB
 * 并在解压后尝试删除临时文件 —— 那一步容易被环境的安全删除守卫拦下，
 * 表现为 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`。
 * 不设它就能命中已有缓存（若该 zip 不存在，则回落到官方源，功能不受影响）。
 *
 * 变量名是 electron-builder 官方约定的，勿改：
 *   ELECTRON_BUILDER_BINARIES_MIRROR → NSIS / winCodeSign 等构建期二进制
 */
const MIRRORS = {
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

const env = { ...process.env, ...MIRRORS };

/** 跑一条命令；失败直接退出并透传退出码，不吞错误。 */
function run(command, args, label) {
  console.log(`\n[package-win] ${label}：${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(`[package-win] ${label} 无法执行：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[package-win] ${label} 失败，退出码 ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

/* Windows 上优先用 pnpm（仓库的包管理器），找不到再退回 npm。 */
function packageManager() {
  const probe = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return probe.status === 0 ? 'pnpm' : 'npm';
}

const pm = packageManager();
console.log(`[package-win] 包管理器：${pm}`);

/* 1) 先编译 —— electron-builder 不会替你跑 tsc */
run(pm, ['run', 'build'], '编译主进程与渲染进程');

/* 2) 类型检查放在编译之后：此时 dist 已是最新，跑起来最接近真实构建 */
run(pm, ['run', 'typecheck'], '类型检查');

/* 3) 图标缺失时自动生成，避免忘记跑 gen-icon 就打出一个 Electron 默认图标的包。
 *    生成后立刻校验：electron-builder 在图标不合格时**不报错**，只是静默沿用
 *    默认图标，等到用户看到 exe 才发现就太晚了。 */
const iconPath = path.join(repoRoot, 'build', 'icon.ico');
if (!fs.existsSync(iconPath)) {
  console.log('[package-win] build/icon.ico 不存在，先生成一次');
  run(process.execPath, [path.join('tools', 'gen-icon.mjs')], '生成图标');
}
run(process.execPath, [path.join('tools', 'verify-icon.mjs')], '校验图标');

/* 4) 打包。`--dir` 只解包不压缩，用来快速验证「能不能起得来」
 *
 * 直接 node 跑 builder 的 CLI 而不用 `pnpm exec`：一是省掉 `--` 分隔在
 * Windows/pnpm 下的麻烦（pnpm 的 exec 参数转发规则在不同版本上不一致，
 * 多余的 `--` 会被 builder 当成未知参数）。二是能确定性地把
 * `--config` 传下去 —— 配置文件名一旦被误改，自动发现会**静默失败**，
 * 显式传路径能把它变成硬错误。
 *
 * 注意 `--config` 必须放在 `--win` 之前：builder 按位置解析，先给配置文件
 * 才能确保后续 target 参数作用在它上面。
 */
/* 前置检查：输出目录非空时 electron-builder 必然失败。
 *
 * 原因：builder 每次都会先清空输出目录（`emptyDir`），而 Windows 上文件被占用时
 * 清空会失败，报错信息却指向某个无辜的中间文件（如 `LICENSE.electron.txt`），
 * 完全看不出「上次残留没清干净」这个真实原因。
 *
 * 这里提前判定并给出可执行的提示，而不是让用户去猜日志。
 * 注意不做自动清理：输出目录里可能有上一版的好产物，静默删掉不合适。 */
const outRoot = path.join(repoRoot, 'release');
if (fs.existsSync(outRoot)) {
  const stale = fs.readdirSync(outRoot);
  if (stale.length > 0) {
    console.error(`[package-win] 输出目录 release/ 里已有 ${stale.length} 项产物。`);
    console.error('[package-win] electron-builder 需要先清空它才能打包，请先删除 release/ 后重试。');
    process.exit(1);
  }
}

const builderCli = path.join('node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(path.join(repoRoot, builderCli))) {
  console.error(`[package-win] 找不到 ${builderCli}，请先安装依赖（pnpm install）`);
  process.exit(1);
}
const configPath = path.join(repoRoot, 'electron-builder.config.cjs');

/**
 * 复用本地已有的 Electron 发行版（`node_modules/electron/dist`）。
 *
 * 为什么加这条：electron-builder 默认会**重新下载**一份 Electron zip 再解压。
 * 本仓库的 `scripts/install-electron.mjs` 已经把发行版放进 node_modules 了，
 * 让 builder 再下一遍是纯浪费（151MB）；更糟的是解压后它会尝试清理临时文件，
 * 若该删除被环境的安全守卫拦下，整个打包会以
 * `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` 收场 —— 成品其实已经打好，
 * 退出码却是 1，非常误导。
 *
 * 指定 electronDist 后走「直接拷贝本地发行版」的分支，既不下载也不删除。
 * 该目录由 `pnpm install` + `npm run setup:electron` 保证存在；不存在时
 * 静默跳过，退回 builder 自己的下载流程（只是慢一点）。
 */
const localElectronDist = path.join(repoRoot, 'node_modules', 'electron', 'dist');
if (fs.existsSync(path.join(localElectronDist, 'electron.exe'))) {
  console.log('[package-win] 复用本地 Electron 发行版：node_modules/electron/dist');
  run(process.execPath, [
    builderCli,
    '--config', configPath,
    `--config.electronDist=${localElectronDist}`,
    '--win',
    '--x64',
    ...passthrough,
  ], 'electron-builder');
} else {
  console.log('[package-win] 未找到本地 Electron 发行版，交给 electron-builder 自行下载');
  run(process.execPath, [
    builderCli,
    '--config', configPath,
    '--win',
    '--x64',
    ...passthrough,
  ], 'electron-builder');
}

/* 5) 汇报产物，让用户不用自己去翻 release/ */
const outDir = path.join(repoRoot, 'release');
if (!fs.existsSync(outDir)) {
  console.log('[package-win] 未发现 release/ 目录，请检查上一步日志');
  process.exit(0);
}
const artifacts = fs.readdirSync(outDir).filter((name) => name.endsWith('.exe') || name.endsWith('.blockmap'));
console.log('\n[package-win] 产物：');
for (const name of artifacts) {
  const size = fs.statSync(path.join(outDir, name)).size;
  console.log(`  ${name}  ${(size / 1024 / 1024).toFixed(1)} MB`);
}
if (artifacts.length === 0) {
  console.log('  （无 .exe 产物；若用了 --dir，解包目录在 release/win-unpacked/）');
}
