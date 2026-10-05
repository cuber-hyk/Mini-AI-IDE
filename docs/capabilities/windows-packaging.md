---
artifact_type: capability
status: current
updated: 2026-10-05
owner: 胡运宽
source_of_truth: [electron-builder.config.cjs, scripts/package-win.mjs, tools/gen-icon.mjs, tools/verify-icon.mjs, package.json, .gitignore, src/main/index.ts, src/main/selfTest.ts]
---

# 能力：Windows 打包与分发

> 一句话：把仓库源码打成两个可直接双击的 Windows x64 产物 —— NSIS 安装程序与免安装单文件 exe。
> 入口：`pnpm run package:win`（一条命令走完编译 → 类型检查 → 图标校验 → 打包）。
> 快速验证（只解包不压缩）：`pnpm run package:win --dir`。

## 产物

| 文件 | 体积 | 用途 |
|---|---|---|
| `release/Mini-AI-IDE-Setup-0.1.0-x64.exe` | ~111 MB | NSIS 安装程序。允许自选安装目录，创建桌面与开始菜单快捷方式 |
| `release/Mini-AI-IDE-Portable-0.1.0-x64.exe` | ~99 MB | 免安装单文件，双击即用，不写注册表 |

解包目录 `release/win-unpacked/` 是安装包与 portable 的共同中间产物，可直接运行其中的 `Mini-AI-IDE.exe`。
安装后占用约 300–400 MB（Electron 运行时本体约 235 MB，不可裁剪）。

## 架构：只有 x64

Electron **44** 已删除 Windows ia32（32 位）发行版，arm64 需另出构建。本仓库只出 x64。

## 配置要点（`electron-builder.config.cjs`）

1. **输出目录是 `release/`，不能改成 `dist/`。** `dist/` 是 tsc 的输出目录，builder 会把自己的中间产物放进去，再把 `dist/**` 当输出目录排除，最后报「入口文件不存在」。这个报错完全看不出是目录选错，配置注释里已记下。
2. **`files` 里除 `dist/` 外还带 `src/`、`test/fixtures/`、`tools/renderer-scope-report.json`。** 因为 `selfTest.ts` 与 `workspaceProbe.ts` 会读源码原文与测试样本；打进 asar（不到 1 MB）就能让**打包版依然支持现场自检**：`Mini-AI-IDE.exe --self-test`。asar 内的相对路径与开发时一致，Electron 已 patch `fs`，`fs.readFileSync` 可直接读。
3. **`deleteAppDataOnUninstall: false`。** NSIS 默认卸载时删掉整个 userData 目录，而那里放着用户设置（自定义格式要求、分栏宽度）和 `persist:postcheck` 分区里的**网页登录态**。删掉意味着重装必须重新登录；分区名刻意固定正是为了让登录态可复用。
4. **未配置代码签名。** 产物是未签名 exe，Windows SmartScreen 会提示「未知发布者」。这是刻意的 —— 证书采购与保管是独立决策。拿到证书后在 `win.signtoolOptions` 补配置即可。
5. **`asar: true`。** 单文件归档；配合 Electron 对 `fs` 的 asar 支持，第 2 条的路径假设才成立。

## 图标

`build/icon.ico` 由 `tools/gen-icon.mjs` **零依赖生成**（Node 内置 `zlib` 手写 PNG，再用 PNG-in-ICO 容器封装 7 档尺寸 16→256）。图案取自 `design-tokens.json` 配色，构图为 IDE 的「左编辑器 / 右网页」双栏。

`pnpm run gen-icon` 可重新生成。`tools/verify-icon.mjs` 校验其合法性 —— **这一检查是必要的**：electron-builder 遇到不合格图标时**不报错**，只是静默沿用 Electron 默认图标，直到用户看到 exe 才发现。

## 打包流程中的三个坑（都已在脚本里绕过）

1. **配置文件名必须是 `.cjs`，不能用 `.mjs`。** electron-builder 的配置自动发现只认 `electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}`。命名成 `.mjs` 会被**静默忽略**（不报错），于是 `directories.output` 退回默认的 `dist`，触发上面第 1 条的连锁错误。脚本额外显式传 `--config`，把静默失败变成硬错误。
2. **复用本地 Electron 发行版**（`--config.electronDist=node_modules/electron/dist`）。默认行为是重新下载 151 MB 的 zip 再解压，而 `scripts/install-electron.mjs` 已经把发行版装好了。复用后既不下载也不触发清理动作。
3. **输出目录必须为空。** builder 每次先 `emptyDir`；目录里有上次残留时会失败，而报错指向某个中间文件，极难定位。脚本改为前置检查并给出明确提示，不自动删除 —— 残留里可能有上一版的好产物。

## 验证状态

- ✅ `--dir` 解包成功；asar 内容已逐项核对（入口、4 个 preload、Monaco 150 个文件、`src/` 源码、测试样本、作用域报告均在）
- ✅ 主进程在打包版正常启动，UA 自洽检查输出 `UA自洽=true 移除标记=[Electron/44.5.1, mini-ai-ide/0.1.0]`，证明 asar 内路径假设成立
- ✅ 图标文件结构校验通过（7 档，含 256×256）
- ⛔ **GUI 冒烟未完成**：本开发沙箱无显示设备，Electron GPU 进程以 `exit_code=-1073741819` 崩溃并 `GPU process isn't usable`。已确认**开发版在同一沙箱内同样崩溃在同一处**，故为环境限制而非打包缺陷。首次在真实桌面上运行时应补一次：`release/win-unpacked/Mini-AI-IDE.exe --self-test`

## 现场排障

打包版保留了完整自检能力，无需上传源码：

```bat
"Mini-AI-IDE.exe" --self-test
```

自检报告由 `src/main/selfTest.ts` 生成，其源码与测试样本已随包分发。
