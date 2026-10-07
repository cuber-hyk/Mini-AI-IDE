---
artifact_type: capability
status: current
updated: 2026-10-05
owner: 胡运宽
source_of_truth: [electron-builder.config.cjs, scripts/package-win.mjs, scripts/prepare-release.mjs, test/releaseArtifacts.test.ts, tools/gen-icon.mjs, tools/verify-icon.mjs, tools/verify-icon-embedded.mjs, assets/icon-source.png, package.json, pnpm-lock.yaml, .gitignore, src/main/index.ts, src/main/selfTest.ts]
---

# 能力：Windows 打包与分发

ADR gate：现有 x64 打包、资源目录与图标生成属于可重新构建的实现约定，无需新增 ADR；GitHub 分发与更新边界依据已接受的 `docs/adr/2026-10-05-application-update-source-and-boundary.md`。

> 一句话：把仓库源码打成两个可直接双击的 Windows x64 产物 —— NSIS 安装程序与免安装单文件 exe。
> 入口：`pnpm run package:win`（编译 → 类型检查 → 图标校验 → 打包 → 发布产物一致性校验）。本地打包固定 `--publish never`，不会上传 GitHub。
> 快速验证（只解包不压缩）：`pnpm run package:win --dir`。

## 产物

| 文件 | 用途 |
|---|---|
| `release/Mini-AI-IDE-Setup-<version>-x64.exe` | NSIS 安装程序。允许自选安装目录，创建桌面与开始菜单快捷方式；安装版使用应用内更新 |
| `release/Mini-AI-IDE-Setup-<version>-x64.exe.blockmap` | NSIS 差分下载分块清单，与安装包一起发布 |
| `release/latest.yml` | 稳定版本更新元数据，只指向 NSIS 安装包，含版本、大小和 SHA-512 |
| `release/Mini-AI-IDE-Portable-<version>-x64.exe` | 免安装单文件，双击即用，不写安装注册表；暂不支持原地更新 |

解包目录 `release/win-unpacked/` 是安装包与 portable 的共同中间产物，可直接运行其中的 `Mini-AI-IDE.exe`。
安装后占用约 300–400 MB（Electron 运行时本体约 235 MB，不可裁剪）。

## 架构：只有 x64

Electron **44** 已删除 Windows ia32（32 位）发行版，arm64 需另出构建。本仓库只出 x64。

## 配置要点（`electron-builder.config.cjs`）

1. **输出目录是 `release/`，不能改成 `dist/`。** `dist/` 是 tsc 的输出目录，builder 会把自己的中间产物放进去，再把 `dist/**` 当输出目录排除，最后报「入口文件不存在」。这个报错完全看不出是目录选错，配置注释里已记下。
2. **`files` 里除 `dist/` 外还带 `src/`、`test/fixtures/`、`tools/renderer-scope-report.json`。** 因为 `selfTest.ts` 与 `workspaceProbe.ts` 会读源码原文与测试样本；打进 asar（不到 1 MB）就能让**打包版依然支持现场自检**：`Mini-AI-IDE.exe --self-test`。asar 内的相对路径与开发时一致，Electron 已 patch `fs`，`fs.readFileSync` 可直接读。electron-builder 同时默认收集生产依赖；`electron-updater` 是生产依赖，Monaco 仍在构建期复制到 `dist/renderer/vendor/monaco`。
3. **`deleteAppDataOnUninstall: false`。** NSIS 默认卸载时删掉整个 userData 目录，而那里放着用户设置（自定义格式要求、分栏宽度）和 `persist:postcheck` 分区里的**网页登录态**。删掉意味着重装必须重新登录；分区名刻意固定正是为了让登录态可复用。
4. **未配置代码签名。** 产物是未签名 exe，Windows SmartScreen 会提示「未知发布者」。这是刻意的 —— 证书采购与保管是独立决策。拿到证书后在 `win.signtoolOptions` 补配置即可。
5. **`asar: true`。** 单文件归档；配合 Electron 对 `fs` 的 asar 支持，第 2 条的路径假设才成立。
6. **`publish` 固定为公开 GitHub 仓库 `cuber-hyk/Mini-AI-IDE`。** 此配置用于生成更新源配置 `resources/app-update.yml` 与发布清单 `latest.yml`；实际上传不由本地打包命令执行。electron-builder 的 Portable 目标不写更新元数据，NSIS 与 Portable 同时构建时仍只有 NSIS 进入更新清单。

## 发布准备与更新源

完整打包会自动执行 `pnpm run prepare:release`。也可以在上传前单独运行该命令；它只读取本地文件，验证以下规则：

- package.json 版本与 latest.yml 版本一致，发布目录没有其他版本的 exe 或 blockmap。
- latest.yml 的 `files` 仅包含当前版本 x64 NSIS 安装包，`path` 与之相同，不能混入 Portable。
- 安装包实际大小与 SHA-512 同时匹配清单；blockmap 可以解压且分块覆盖整个安装包。
- 安装包、blockmap、latest.yml 与 Portable 均为非空文件，输出四个文件的大小和 SHA-512 供发布前核对。

GitHub 正式 Release 使用 `v<package.json版本>` 标签，附件为上述四个文件；不上传 `win-unpacked/` 或 builder 调试文件。标签关联的源码必须包含该版本更新实现，与产物对应，不能把新产物绑定到旧源码标签。发布后应用使用公开 GitHub Releases 获取稳定版本，无需内嵌 token。

已有旧 0.1.0 包没有更新代码，仍需手动安装一次含更新能力的新包；之后使用软件内更新。Portable 可以作为额外下载项，但不参与安装版更新。当前未签名，SHA-512 校验表示下载文件与清单一致，不代表发布者身份认证。

## 图标

图标由设计源图 `assets/icon-source.png` 转换而来（深蓝渐变圆角方块 + 蓝色轨道环 + 白色尖括号 + 中心光球），由 `tools/gen-icon.mjs` 处理成 `build/icon.ico`。

**为什么是「转换」而不是直接拿设计稿用**：设计稿是 RGB 无 alpha，把「透明」画成了棋盘格像素，还带平台水印与投影。直接转 ICO 会让任务栏里出现一块灰格子。转换链做四件事：

1. **识别主体包围盒** —— 按「每行主体像素数占 15% 宽度」判定，这样水印那点零星像素不会把边界撑大（曾用「连续 2 像素」判据，水印把包围盒撑大 150px 导致裁切错位）。
2. **重建 alpha** —— 用圆角矩形有向距离场生成抗锯齿遮罩；从弧上采样反解真实圆角半径（当前 23.3%），比硬编码比例稳。遮罩内缩 1.5px，避免把源图边缘与棋盘格的混合像素当内容留下。
3. **裁掉边界外的一切** —— 水印、投影都在主体之外，天然被排除。
4. **面积平均降采样** —— 用积分图（summed-area table）把任意矩形求和降到 O(1)；**预乘 alpha** 后再平均，否则透明区域的颜色会渗进 RGB，边缘出现灰边。

`pnpm run gen-icon` 可重新生成；`--variant=split|orbit|bracket` 可切到程序化绘制（无素材时的备选）；`--preview` 只出预览图。

### 两道校验（都必要）

| 工具 | 查什么 | 为什么必要 |
|---|---|---|
| `tools/verify-icon.mjs` | ICO 结构：头字段、各档 PNG 负载签名、是否含 256×256 | electron-builder 遇到不合格图标**不报错**，只是静默沿用默认图标 |
| `tools/verify-icon-embedded.mjs` | 图标数据是否真的出现在 exe 字节里 | 图标没生效时 builder 照样打印 `updating asar integrity executable resource`，看日志发现不了 |

`build/icon-preview.png` 是给人看的：同一图标在**浅色与深色两种背景**下的 168 / 48 / 32 / 16 表现。深色那行对应 Windows 深色任务栏 —— 图标在浅底上好看、在深底上糊掉是最常见的翻车点。

## 打包流程中的三个坑（都已在脚本里绕过）

1. **配置文件名必须是 `.cjs`，不能用 `.mjs`。** electron-builder 的配置自动发现只认 `electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}`。命名成 `.mjs` 会被**静默忽略**（不报错），于是 `directories.output` 退回默认的 `dist`，触发上面第 1 条的连锁错误。脚本额外显式传 `--config`，把静默失败变成硬错误。
2. **复用本地 Electron 发行版**（`--config.electronDist=node_modules/electron/dist`）。默认行为是重新下载 151 MB 的 zip 再解压，而 `scripts/install-electron.mjs` 已经把发行版装好了。复用后既不下载也不触发清理动作。
3. **输出目录先清空。** builder 每次会自己清 `release/`，但在 Windows 上文件被占用时失败，报错却指向某个中间文件（如 `LICENSE.electron.txt`），看不出真实原因。脚本改为**先自己清一遍**，失败时给出「关闭正在运行的程序后重试」这类可执行提示。删除前会检查目录内容是否「长得像打包产物」，避免 `directories.output` 被误配到仓库其他位置时误删。

## 验证记录与待验范围

更新发布配置新增的离线产物校验测试已通过（5 项，无跳过）。以下为加入更新能力前的打包记录；新产物还必须核对生产依赖与更新清单，并在真实 Windows 桌面完成两版本升级、用户数据与登录态保留验证后才能发布：

- ✅ `--dir` 解包成功；asar 内容已逐项核对（入口、4 个 preload、Monaco 150 个文件、`src/` 源码、测试样本、作用域报告均在）
- ✅ 主进程在打包版正常启动，UA 自洽检查输出 `UA自洽=true 移除标记=[Electron/44.5.1, mini-ai-ide/0.1.0]`，证明 asar 内路径假设成立
- ✅ 图标文件结构校验通过（7 档，含 256×256）
- ✅ 更新版 v0.1.0 完整 NSIS 与 Portable 构建通过；`latest.yml` 只指向 NSIS，文件大小、SHA-512 与 blockmap 校验通过。asar 内四个主进程更新入口的源码和编译结果与本地逐字节一致，生产依赖与无 token 的公开更新源配置存在。
- ✅ 更新版打包程序在隔离 user-data-dir 下运行 `--self-test`：160 项通过、失败 0；类型检查、构建及 329 项测试通过，无跳过。
- ✅ v0.1.1更新验证包完整构建与发布清单校验通过；包内版本为0.1.1，功能模块与0.1.0一致，隔离启动160项自检通过。该包仅提高版本号，真实升级结果由0.1.0客户端在Release发布后验收。
- 发布前仍须验证两个 NSIS 版本之间的真实更新、未保存文件交互、设置和网页登录态保留，以及用户网络下的 GitHub 下载。启动自检不能替代这些更新验收。

## 现场排障

打包版保留了完整自检能力，无需上传源码：

```bat
"Mini-AI-IDE.exe" --self-test
```

自检报告由 `src/main/selfTest.ts` 生成，其源码与测试样本已随包分发。
