# Context Map — 上下文路由

给代理用的路由表：做哪类任务时，**先读什么、别读什么**。默认上下文不得指向计划、审计或归档目录。

## 默认上下文（任何任务先读）

| 顺序 | 文件 | 用途 |
|---|---|---|
| 1 | `AGENTS.md` | 仓库级硬性约束、允许/禁止清单 |
| 2 | `CONTEXT.md` | 稳定词汇表，避免同名异义 |
| 3 | `docs/capabilities/` 下相关能力文档 | 模块当前事实与边界 |

## 按任务类型路由

| 任务类型 | 读这些 | 不要读 |
|---|---|---|
| 外壳 / 进程架构 / IPC | `docs/capabilities/app-shell.md`、`docs/adr/` 下架构类决策 | 历史计划、审计归档 |
| 构建 / 运行 / 自检 | `docs/capabilities/app-shell.md` 的「已知实现陷阱」「依赖安装注意」、`package.json` 的 scripts | 历史计划 |
| Windows 打包 / Release 发布 / 软件更新 | `docs/capabilities/windows-packaging.md`、`docs/capabilities/application-update.md`、`docs/adr/2026-10-05-application-update-source-and-boundary.md`、`electron-builder.config.cjs`、`src/main/appUpdater.ts`、`src/main/updateService.ts`、`src/main/applicationUpdateIpc.ts`、`src/main/updateInstaller.ts`、`src/renderer/applicationUpdate.js` | 历史计划、AI 网页采集实现 |
| 本地文件读取 / 编码 / 大小控制 | `docs/capabilities/local-file-access.md` | 无关能力文档 |
| 目录恢复 / 最近目录 / 文件管理 / 多文件标签 / 未保存保护 | `docs/capabilities/local-file-access.md`、`src/main/workspaceService.ts`、`workspaceController.ts`、`fileManagement.ts`、`editorSession.ts`、`src/renderer/editorWorkspace.js`、`editorTabs.js`、`fileExplorer.js` | 历史计划、官方网页实现 |
| 人机边界 / 出程（什么由人做） | `docs/capabilities/human-machine-boundary.md`、`docs/adr/2026-10-02-zero-injection-and-automation-trace-baseline.md`（ADR-0003） | 回程解析细节 |
| 回程解析 / 新增文件 / 一键应用 / 输出格式 | `docs/capabilities/return-path-and-format-contract.md`、`src/main/replyCollector.ts`、`src/shared/returnPath.ts`、`src/main/returnPathService.ts`、`src/main/fileService.ts`、`src/renderer/editorWorkspace.js`、`docs/adr/2026-10-02-return-path-contract-and-trust-boundary.md` | 指纹与网络层细节 |
| 指纹与环境特征 | `docs/adr/2026-10-02-honest-electron-identity.md`（ADR-0001）、`docs/adr/2026-10-02-zero-injection-and-automation-trace-baseline.md`（ADR-0003） | 实现细节代码（`src/shared/userAgent.ts` 为落地实现） |
| 会话 / 登录持久化 | `docs/capabilities/session-persistence.md`（会话分区命名 ADR 为**候选未建项**，暂由该能力文档承载） | 计划文档 |
| UI / 设计规则 | `DESIGN.md`、`design-tokens.json`、`src/renderer/ui.css`、`docs/capabilities/app-shell.md` 的「布局规则」「左侧编辑器与目录树的当前行为」「底部需求输入区的当前行为」 | — |

## 过程证据（非默认上下文）

- `docs/plans/` — 任务计划。只读当前任务的活跃计划。
- `docs/audits/` — 审计与发现。只读直接驱动本次任务的活跃审计。
- `docs/plans/archived/`、`docs/audits/archived/`、`docs/adr/archived/` — 历史归档，默认不读。

## 当前入口点

| 领域 | 入口 |
|---|---|
| 需求来源（初步想法，非最终裁决） | `IDE接入网页版AI.md` |
| 活跃计划 | `docs/plans/2026-10-02-mini-ai-ide-poc.md` |
| 决策记录 | `docs/adr/` |
| 回程机制（一键同步） | `docs/capabilities/return-path-and-format-contract.md` |
| 明确编辑协议与复制上下文 | `src/shared/returnPath.ts`、`snippet.ts`、`formatSpec.ts`；应用与基线 owner `src/main/returnPathService.ts`；默认面板资源由 `scripts/copy-static.mjs` 生成 |
| 应用实现（P2 已落地） | `src/main/`、`src/renderer/`、`src/shared/`；脚本 `scripts/`；测试 `test/` |
| 视图与入口对照（4 个 WebContentsView） | `src/renderer/index.html`（编辑器）、`preview.*`（回程预览面板）、`webbar.*`（网页区顶栏 / 网页隐藏时的恢复把手）；preload 各自独立 |
| 需求输入与版本切换 | `src/renderer/promptComposer.js`；结构/样式 `index.html`、`style.css`，状态 IPC `src/main/index.ts`、`preload.ts` |
| 目录和文件管理 | `src/main/workspaceService.ts`（目录状态）、`workspaceController.ts`（统一入口）、`fileManagement.ts`（条目操作）、`editorSession.ts`（离开保护）；渲染 owner `src/renderer/fileExplorer.js`、`editorWorkspace.js`、`editorTabs.js` |
| 自动化特征核验工具 | `tools/trace-verifier/` |
| 可达性与会话实测工具 | `tools/reachability-probe/` |

## 常用命令

| 目的 | 命令 |
|---|---|
| 安装 | `pnpm install` + `node scripts/install-electron.mjs` |
| 构建 | `npm run build` |
| 类型检查 | `npm run typecheck` |
| 单元测试 | `npm test` |
| 启动自检（不联网，115 项） | `npm run self-test` |
| 会话/网络诊断（需先关闭应用） | `npm run diagnose` |
| 界面运行时探针（读回 Monaco 实际选项） | `npm run ui-probe` |
| 目录和文件管理验收（隔离临时数据、离线） | `pnpm run verify:workspace` |
| 启动应用 | `npm start`（**需在普通 PowerShell，勿在 AI 沙箱内**） |
| 打包与发布准备 | `pnpm run package:win`，随后 `pnpm run prepare:release`（离线校验，不上传） |
| 会话是否仍需登录 | `pwsh -File tools\run-p0b-reachability.ps1 -ProbeOnly` |

> ⚠️ **AI 沙箱内跑不了 `self-test` 与 `start`**：`GPU process isn't usable. Goodbye.`
> （GPU 缓存目录被占用，GPU 进程反复 `exit_code=-1073741819`；`--disable-gpu` 无效）。
> 这是环境限制而非代码缺陷（改动前的基线同样失败）。沙箱内请用
> `npm test` + `npm run typecheck` 验证；需要跑完整自检时在普通 PowerShell 执行。

## 维护规则

- 新增能力、ADR 或关键入口后必须更新本文件。
- 本文件**不得**把默认上下文指向 `docs/plans/`、`docs/audits/` 或任何 `archived/` 目录。
- 引用的路径必须真实存在。
- 脚手架阶段的例外：能力文档的 `source_of_truth` 曾同时列出活跃计划（因当时尚无实现代码）。**P2 落地后已改为以代码为主**；后续实现完成时，能力文档的 `source_of_truth` 应指向代码与测试，计划仅作为过程证据（清理由 `/dev-distill` 执行）。
