# Context Map — 上下文路由

给代理用的路由表：做哪类任务时，**先读什么、别读什么**。默认上下文不得指向计划、审计或归档目录（not read by default）。

## 默认上下文（任何任务先读）

| 顺序 | 文件 | 用途 |
|---|---|---|
| 1 | `AGENTS.md` | 仓库级硬性约束、允许/禁止清单 |
| 2 | `CONTEXT.md` | 稳定词汇表，避免同名异义 |
| 3 | `docs/capabilities/` 下相关能力文档 | 模块当前事实与边界 |

## 按任务类型路由

技能与本地需求先读 `docs/capabilities/skills-and-local-prompt.md`、`docs/adr/2026-10-08-skills-and-local-demand-send.md` 和 `docs/adr/2026-10-08-local-prompt-attachments.md`。固定目录 owner 为 `src/main/skills.ts`，附件暂存 owner 为 `src/main/localPromptAttachments.ts`，组装与窄 IPC 为 `localPromptController.ts`，本地 UI 为 `src/renderer/localPrompt.js/css`；唯一官网写入运输为 `src/main/webComposerSender.ts`，`tools/webResultSender.ts` 保留工具门面。技能工具与独立采集/发送入口由 `tools/integration.ts` 接线。附件已上传而正文未发送时，可由用户在内嵌官网 Console 手动执行只读 `tools/inspect-composer-attachments.js`，返回附件区祖先、预览和上传标记的结构与数量；开启 collection trace 后，`composer.attachment-status` 仅在等待状态变化时记录确认依据，不记录正文或文件内容。

通用工具协作先读 `docs/capabilities/tool-harness.md`、`docs/adr/2026-10-06-native-tool-harness-boundary.md`；入口为 `src/shared/toolProtocol.ts`、`src/main/tools/integration.ts`，执行及状态 owner 为同目录 files/processes/changes/harness/store/autoCollector，只读回复状态/快照为 replyObservation，隔离世界变化通知、历史DOM基线与用于取消旧回传的真实动作通知由 replyChangeWatcher 管理，UI 为 `src/renderer/toolHarness.js`。结束控件现场诊断可由用户在 IDE 内嵌 AI 网页 Console 手动执行 `tools/inspect-reply-state.js` 并返回结构文本。

工具本地 UI 的尺寸、浮层、焦点和拖动由 `src/renderer/toolPanelLayout.js` 管理，纯结果摘要由 `src/renderer/toolResultPresentation.js` 管理；样式为 `src/renderer/toolHarness.css`，状态接线仍为 `toolHarness.js`。对应验收为 `test/toolPanelLayout.test.ts`、`test/toolResultPresentation.test.ts`、`test/toolHarnessUi.test.ts`。

工具实际文件变更由 `src/main/tools/changeReview.ts` 留存本批执行快照，`changes.ts` 提供实际修改与撤销事件，`integration.ts` 绑定项目／会话／批次；右侧文件正文的只读 Diff 界面为 `src/renderer/preview.*` 和 `src/main/previewPreload.ts`。回归入口为 `test/toolChangeReview.test.ts`、`test/toolReviewIntegration.test.ts`、`test/changeTree.test.ts`。文件树类型图标由 `src/renderer/fileIcons.js` 和 `fileExplorer.css` 管理。

自动继续先读 `docs/adr/2026-10-08-output-driven-collection.md`、`docs/capabilities/human-machine-boundary.md`、`docs/adr/2026-10-07-automatic-result-return-boundary.md`：`src/main/tools/autoContinuation.ts` 拥有完成事件、作用域与计时，`webResultSender.ts` 调用唯一运输 `src/main/webComposerSender.ts`，`integration.ts` 接线和发送前复核。UI 单开关和间隔仍由 `src/renderer/toolHarness.js` 管理；测试为 `test/autoContinuation.test.ts`、`test/webResultSender.test.ts`，原生本地夹具为 `tools/verify-web-result-sender.cjs`，不替代真实官网验收。差异连续阅读、可收起导航、上下文展开、换行及主动临时拓宽由 `preview.js/css` 管理，读 `test/changeTree.test.ts` 和 `src/main/layoutProbe.ts`。

继续生成的共用只读控件谓词由 `src/main/tools/replyContinuation.ts` 管理，供 replyObservation 的中断状态与 replyChangeWatcher 的真实续写动作使用；等待及补全调度由 autoCollector 管理。回归入口为 `test/deepseekReplyState.test.ts`、`test/replyChangeWatcher.test.ts`、`test/toolAutoCollector.test.ts`、`test/replyObservation.test.ts`、`test/toolIntegration.test.ts`。

需要工具协议测试原文时读 `docs/工具调用测试样例.md`，验证 owner 为 `test/toolSamples.test.ts`；样例不作为当前能力或默认上下文。

| 任务类型 | 读这些 | 不要读 |
|---|---|---|
| 外壳 / 进程架构 / IPC | `docs/capabilities/app-shell.md`、`docs/adr/` 下架构类决策 | 历史计划、审计归档 |
| 构建 / 运行 / 自检 | `docs/capabilities/app-shell.md` 的「已知实现陷阱」「依赖安装注意」、`package.json` 的 scripts | 历史计划 |
| Windows 打包 / Release 发布 / 软件更新 | `docs/capabilities/windows-packaging.md`、`docs/capabilities/application-update.md`、`docs/adr/2026-10-05-application-update-source-and-boundary.md`、`electron-builder.config.cjs`、`src/main/appUpdater.ts`、`src/main/updateService.ts`、`src/main/applicationUpdateIpc.ts`、`src/main/updateInstaller.ts`、`src/renderer/applicationUpdate.js` | 历史计划、AI 网页采集实现 |
| 本地文件读取 / 编码 / 大小控制 | `docs/capabilities/local-file-access.md` | 无关能力文档 |
| 多项目工作区 / 目录恢复 / 最近目录 / 文件管理 / 多文件标签 / 未保存保护 | `docs/capabilities/local-file-access.md`、`src/main/workspaceService.ts`、`workspaceController.ts`、`fileManagement.ts`、`editorSession.ts`、`src/renderer/workspaceNavigation.js`、`editorWorkspace.js`、`editorTabs.js`、`fileExplorer.js` | 历史计划、官方网页实现 |
| 人机边界 / 自动继续 / 结果回传 | `docs/capabilities/human-machine-boundary.md`、`docs/adr/2026-10-07-automatic-result-return-boundary.md`、`src/main/tools/autoContinuation.ts`、`src/main/tools/webResultSender.ts`、`integration.ts` | 无关文件读取细节 |
| 回程解析 / 工具修改与查看 / 输出格式 | `docs/capabilities/return-path-and-format-contract.md`、`src/main/replyCollector.ts`、`src/main/tools/changes.ts`、`src/main/tools/changeReview.ts`、`src/main/returnPathService.ts`、`src/renderer/preview.js`、`docs/adr/2026-10-06-native-tool-harness-boundary.md` | 指纹与网络层细节 |
| 指纹与环境特征 | `docs/adr/2026-10-02-honest-electron-identity.md`（ADR-0001）、`docs/adr/2026-10-02-zero-injection-and-automation-trace-baseline.md`（ADR-0003） | 实现细节代码（`src/shared/userAgent.ts` 为落地实现） |
| 会话 / 登录持久化 | `docs/capabilities/session-persistence.md`（会话分区命名 ADR 为**候选未建项**，暂由该能力文档承载） | 计划文档 |
| 工作区布局 / 原生视图遮挡 / 显隐与宽度持久化 | `docs/adr/2026-10-07-workspace-ui-shell-layout.md`、`src/main/windowLayout.ts`、`src/main/workspaceLayoutController.ts`、`src/renderer/workspaceLayout.js`、`src/renderer/fileWorkspace.js`、`test/fileWorkspace.test.ts`、`test/windowLayout.test.ts`、`test/workspaceLayoutController.test.ts` | 历史布局计划、并行开发议题 |
| UI / 设计规则 | `DESIGN.md`、`design-tokens.json`、`src/renderer/ui.css`、`docs/capabilities/app-shell.md` 的「布局规则」「右侧编辑器与目录树的当前行为」「中间本地需求编写区的当前行为」 | — |

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
| 视图与入口对照（5 个 WebContentsView） | 官方网页、`src/renderer/index.html`（编辑器）、`preview.*`（变更查看）、`webbar.*`（中间官网常驻顶栏 / 只读采集）、独立提示词设置视图；preload 各自独立 |
| 需求输入与版本切换 | `src/renderer/promptComposer.js`；结构/样式 `index.html`、`style.css`，状态与组装 owner `src/main/localPromptController.ts`、`preload.ts` |
| 自动继续与限定结果回传 | `src/main/tools/autoContinuation.ts`、`webResultSender.ts`、`integration.ts`；本地验收 `tools/verify-web-result-sender.cjs` |
| 目录和文件管理 | `src/main/workspaceService.ts`（当前根与工作区列表）、`src/renderer/workspaceNavigation.js`（左项目导航）、`workspaceController.ts`（统一入口）、`fileManagement.ts`（条目操作）、`editorSession.ts`（离开保护）；渲染 owner `src/renderer/fileExplorer.js`、`editorWorkspace.js`、`editorTabs.js` |
| 自动化特征核验工具 | `tools/trace-verifier/` |
| 可达性与会话实测工具 | `tools/reachability-probe/` |

## 常用命令

| 目的 | 命令 |
|---|---|
| 安装 | `pnpm install` + `node scripts/install-electron.mjs` |
| 构建 | `npm run build` |
| 类型检查 | `npm run typecheck` |
| 单元测试 | `npm test` |
| 启动自检（不联网，数量以运行结果为准） | `npm run self-test` |
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

JSON 解析定位由 `src/shared/toolJsonDiagnostic.ts` 负责；本地执行秒数由 `src/renderer/toolExecutionClock.js` 负责；主进程完成事件的自动复制与提示由 `src/main/tools/resultClipboard.ts` 负责。回归入口为 `test/toolJsonDiagnostic.test.ts`、`test/toolExecutionClock.test.ts`、`test/toolResultClipboard.test.ts`、`test/toolExecutionIntegration.test.ts`。
