# Context Map — 上下文路由

给代理用的路由表：做哪类任务时，**先读什么、别读什么**。默认上下文不得指向计划、审计或归档目录（not read by default）。

## 默认上下文（任何任务先读）

| 顺序 | 文件 | 用途 |
|---|---|---|
| 1 | `AGENTS.md` | 仓库级硬性约束、允许/禁止清单 |
| 2 | `CONTEXT.md` | 稳定词汇表，避免同名异义 |
| 3 | `docs/capabilities/` 下相关能力文档 | 模块当前事实与边界 |

## 按任务类型路由

Markdown 实时/源码编辑、数学公式及 Mermaid 先读 `docs/capabilities/markdown-editing.md` 和 `docs/adr/2026-10-17-markdown-document-kernel.md`。文件/保存 owner 仍为 `src/renderer/editorWorkspace.js`；Markdown 内核为 `markdownEditor.js`，源码装饰为 `markdownPresentation.js`，数学/图表分别归 `markdownMath.js`、`markdownMermaid.js`，图片路径读取归 `markdownImages.js`。本地 ESM 构建归 `scripts/build-markdown.mjs`，只由静态资源构建调用；原生验收为 `tools/verify-markdown-editor.cjs`，不使用官网、CDP 或外部资源。真实 OS 中文候选窗仍需人工验收，合成 composition 不替代该证据。

本地工作区缩放/需求区越界先读`docs/capabilities/app-shell.md`的本地布局验收及工作区布局说明；原生几何归`windowLayout.ts`、应用/广播归`workspaceLayoutController.ts`，CSS映射与dock测量归`src/renderer/workspaceLayout.js`，输入增高归`promptComposer.js`。验收owner为`src/main/layoutProbe.ts`，离线生命周期/故障注入入口`tools/verify-workspace-zoom.cjs`；先区分原生与CSS视口、实际缩放及遮挡状态，不将后台旧帧直接当作产品布局错误。

自动流程停滞与有限恢复先读 `docs/adr/2026-10-14-automatic-recovery.md`、`docs/capabilities/tool-harness.md` 与 `docs/capabilities/human-machine-boundary.md`。来源/实际接纳归 replySource、replyChangeWatcher、replyObservation/chatgptPage 与 integration；监听/读取恢复归 replyChangeWatcher/autoCollector，未运输预检复核归 resultReturn/autoContinuation，运输阶段与取消归 webComposerSender。collection 健康由 integration 投影，顶栏/工具摘要归 toolWorkspaceStatus/toolHarness。回归使用对应 owner 测试及 `tools/verify-chatgpt-tools.cjs` 的30轮离线故障注入；真实官网另验。

官网切回白页/网络加载失败先读`docs/capabilities/web-platforms.md`及平台切换ADR。两平台主frame失败与手动重载owner为`webPlatformController.ts`，顶栏恢复入口为`webbar.js/html`及`webbarPreload.ts`，本地需求可用性为`promptComposer.js`与index的webAvailable。回归为`test/webPlatformController.test.ts`、`test/webPlatformUi.test.ts`及离线`tools/verify-web-platform.cjs`；chrome-error完成不是官网成功，不改CSP或TLS来猜测网络原因。

ChatGPT工具纯文本回传前的草稿备份读 `docs/capabilities/human-machine-boundary.md`、`docs/adr/2026-10-13-chatgpt-composer-draft-backup.md`；附件批要求空输入，不适用备份替换。主进程留底 owner 为 `src/main/composerDraftBackup.ts`，唯一网页运输为 `webComposerSender.ts`，当前项目注入由 index/tools-integration 管理，路径反馈归 resultReturn。验证为 `test/composerDraftBackup.test.ts`、`test/chatgptComposerSender.test.ts`、`tools/verify-chatgpt-composer.cjs`。

备份自动展示读同一人机边界能力及`DESIGN.md`；编辑器单向通知经contract/preload，界面owner为`src/renderer/composerDraftFeedback.js`，文件缓冲/非聚焦打开归editorWorkspace，正文显隐归fileWorkspace。验证为`test/composerDraftFeedback.test.ts`、`test/editorWorkspace.test.ts`、`test/fileWorkspace.test.ts`。

后台运行读 `docs/capabilities/app-shell.md` 的“官网后台运行”，owner 为 `index.ts` / `webPlatformView.ts` 原生视图配置，验收为 `test/webBackgroundPolicy.test.ts`、`tools/verify-web-background.cjs`。历史回看/重挂载读 `docs/capabilities/tool-harness.md` 的“回复来源与历史隔离”；只读来源 owner 为 `src/main/tools/replySource.ts`，由 replyChangeWatcher 持有、replyObservation 与 chatgptPage 同步读取，AutoCollector 保存已接纳正文指纹，integration 按快照身份封存。回归为 `test/replySource.test.ts`、`test/replyChangeWatcher.test.ts`、`test/toolAutoCollector.test.ts`、`tools/audit-background-history.cjs`。

目录树原生文件拖拽先读 `docs/adr/2026-10-11-native-workspace-file-drag.md`、`docs/capabilities/local-file-access.md`。运输 owner 为 `src/main/workspaceFileDrag.ts`，只允许编辑器主 frame 交付当前项目普通文件给系统；UI 为 `src/renderer/fileExplorer.js`，本地接收复用 `localPrompt.js` 的 Files 入口。验证为 `test/workspaceFileDrag.test.ts`、`test/fileExplorer.test.ts`、`test/localPrompt.test.ts`、`tools/verify-workspace-file-drag.cjs`，物理跨进程拖放/官网接收另需手动验收。
技能与本地需求先读 `docs/capabilities/skills-and-local-prompt.md`、`docs/adr/2026-10-08-skills-and-local-demand-send.md`、`docs/adr/2026-10-09-default-local-prompt-send.md` 和 `docs/adr/2026-10-08-local-prompt-attachments.md`。固定目录 owner 为 `src/main/skills.ts`，附件暂存 owner 为 `src/main/localPromptAttachments.ts`，组装与窄 IPC 为 `localPromptController.ts`，本地 UI 为 `src/renderer/localPrompt.js/css`；唯一官网写入运输为 `src/main/webComposerSender.ts`，`tools/webResultSender.ts` 保留工具门面。技能工具与独立采集/发送入口由 `tools/integration.ts` 接线。附件已上传而正文未发送时，可由用户在内嵌官网 Console 手动执行只读 `tools/inspect-composer-attachments.js`，返回附件区祖先、预览和上传标记的结构与数量；开启 collection trace 后，`composer.attachment-status` 仅在等待状态变化时记录确认依据，不记录正文或文件内容。

AI 临时目录及 JSON 草稿恢复先读 `docs/capabilities/tool-harness.md`、`docs/capabilities/return-path-and-format-contract.md`；生命周期与来源边界由已接受的 `docs/adr/2026-10-12-ai-temp-json-recovery.md` 管理。专用 owner 分别为 `src/main/tools/aiTempDirectory.ts` 与 `src/main/tools/jsonDraft.ts`；协议由 `src/shared/toolProtocol.ts` 定义，项目、平台、会话与官网最新来源核验由 `src/main/tools/integration.ts` 接线，执行和回传继续使用 `harness.ts`、`resultReturn.ts`、`autoContinuation.ts`。回归入口为 `test/aiTempDirectory.test.ts`、`test/aiTempIntegration.test.ts`、`test/jsonDraft.test.ts`、`test/toolAutoContinueIntegration.test.ts`，原生本地夹具为 `tools/verify-chatgpt-tools.cjs`。本地夹具与用户官网现场确认分开记录。

通用工具协作先读 `docs/capabilities/tool-harness.md`、`docs/adr/2026-10-06-native-tool-harness-boundary.md`；入口为 `src/shared/toolProtocol.ts`、`src/main/tools/integration.ts`，执行及状态 owner 为同目录 files/processes/changes/harness/store/autoCollector，只读回复状态/快照为 replyObservation，隔离世界变化通知、历史DOM基线与用于取消旧回传的真实动作通知由 replyChangeWatcher 管理，UI 为 `src/renderer/toolHarness.js`。结束控件现场诊断可由用户在 IDE 内嵌 AI 网页 Console 手动执行 `tools/inspect-reply-state.js` 并返回结构文本。

右侧工具更多菜单的定位与焦点由 `src/renderer/toolPanelLayout.js` 管理，纯结果摘要由 `src/renderer/toolResultPresentation.js` 管理；样式为 `src/renderer/toolHarness.css`，状态接线仍为 `toolHarness.js`。工具关注事件判定与去重由 `src/renderer/toolAttention.js` 管理，文件／工具／改动标签由 `src/renderer/fileWorkspace.js` 和 `editorTabs.js` 管理；官网顶栏只读摘要与零参数打开工具入口由 `src/main/toolWorkspaceStatus.ts` 管理。对应验收为 `test/toolAttention.test.ts`、`test/toolWorkspaceStatus.test.ts`、`test/fileWorkspace.test.ts`、`test/toolPanelLayout.test.ts`、`test/toolResultPresentation.test.ts`、`test/toolHarnessUi.test.ts`。工具设置独立原生窗口的几何和生命周期由 `src/main/toolSettingsWindow.ts` 管理，窄 IPC 为 `toolSettingsIpc.ts`、`toolSettingsPreload.ts`，契约为 `src/shared/toolSettings.ts`，内容为 `src/renderer/toolSettings.html/js/css`，共用音效为 `toolCompletionSound.js`；配置 owner 仍为 tools/integration、harness、store。验证为 `test/toolSettingsWindow.test.ts`、`test/toolSettingsIpc.test.ts`、`test/toolSettingsUi.test.ts` 和 `src/main/workspaceProbe.ts`。

工具实际文件变更由 `src/main/tools/changeReview.ts` 留存本批执行快照，`changes.ts` 提供实际修改与撤销事件，`integration.ts` 绑定项目／会话／批次；右侧文件正文的只读 Diff 界面为 `src/renderer/preview.*` 和 `src/main/previewPreload.ts`。回归入口为 `test/toolChangeReview.test.ts`、`test/toolReviewIntegration.test.ts`、`test/changeTree.test.ts`。文件树类型图标由 `src/renderer/fileIcons.js` 和 `fileExplorer.css` 管理。 文件树局部刷新与稳定节点归 `src/renderer/fileExplorer.js`，创建/删除的AI事件由 `renderer.js` 在项目修订核验后定向刷新，改名/删除只消费主进程事件；回归为 `test/fileExplorer.test.ts`、离线原生 `tools/verify-file-tree-refresh.cjs`，手动仍重读全部展开目录。

工具附件回传先读 `docs/adr/2026-10-09-tool-attachment-return.md`；协议唯一入口 `attach_file` 在 `src/shared/toolProtocol.ts`，当前选择附件由 `src/main/tools/attachments.ts` 持有并复用 `localPromptAttachments.ts`，自动/手动批次发送资格由 `src/main/tools/resultReturn.ts` 管理，`integration.ts` 核验官网最新正式批次并接线。两平台共用暂存与权限；ChatGPT 图片/文档只读识别归 `src/main/chatgptPage.ts` 的 `CHATGPT_ATTACHMENT_READER`，唯一网页写入归 `webComposerSender.ts`。`sendToolResults` 只供编辑器主 frame 零参数调用，不接收任意路径或正文；验证为 `test/toolAttachmentIntegration.test.ts`、`test/toolAttachments.test.ts`、`test/toolResultReturn.test.ts`、`test/chatgptComposerSender.test.ts` 及 UI/原生运输夹具。

自动继续先读 `docs/adr/2026-10-08-output-driven-collection.md`、`docs/capabilities/human-machine-boundary.md`、`docs/adr/2026-10-07-automatic-result-return-boundary.md`：`src/main/tools/autoContinuation.ts` 拥有完成事件、作用域与计时，`webResultSender.ts` 调用唯一运输 `src/main/webComposerSender.ts`，`integration.ts` 接线和发送前复核。UI 单开关仍由 `src/renderer/toolHarness.js` 管理，间隔由原生工具设置窗口调整；测试为 `test/autoContinuation.test.ts`、`test/webResultSender.test.ts`，原生本地夹具为 `tools/verify-web-result-sender.cjs`，不替代真实官网验收。差异连续阅读、可收起导航、上下文展开、换行及主动临时拓宽由 `preview.js/css` 管理，读 `test/changeTree.test.ts` 和 `src/main/layoutProbe.ts`。

解析层 `batchError` 与执行前整批校验失败自动回传另读 `docs/adr/2026-10-09-batch-error-auto-return.md`；诊断来源及当前完成事件的 validation_failed 标记由 `src/main/tools/harness.ts` 持有，整批未执行资格谓词为 `src/shared/toolProtocol.ts` 的 isBatchValidationFailure，发送资格归 `src/main/tools/resultReturn.ts`，连续上限归 `src/main/tools/autoContinuation.ts`，官网原文复核及接线归 `src/main/tools/integration.ts`。回归入口为上述 owner 测试和 `test/toolAttachmentIntegration.test.ts`。

继续生成的共用只读控件谓词由 `src/main/tools/replyContinuation.ts` 管理，供 replyObservation 的中断状态与 replyChangeWatcher 的真实续写动作使用；等待及补全调度由 autoCollector 管理。回归入口为 `test/deepseekReplyState.test.ts`、`test/replyChangeWatcher.test.ts`、`test/toolAutoCollector.test.ts`、`test/replyObservation.test.ts`、`test/toolIntegration.test.ts`。

需要工具协议测试原文时读 `docs/工具调用测试样例.md`，验证 owner 为 `test/toolSamples.test.ts`；样例不作为当前能力或默认上下文。

| 任务类型 | 读这些 | 不要读 |
|---|---|---|
| 外壳 / 进程架构 / IPC | `docs/capabilities/app-shell.md`、`docs/adr/` 下架构类决策 | 历史计划、审计归档 |
| 构建 / 运行 / 自检 | `docs/capabilities/app-shell.md` 的「已知实现陷阱」「依赖安装注意」、`package.json` 的 scripts | 历史计划 |
| Windows 打包 / Release 发布 / 软件更新 | `docs/capabilities/windows-packaging.md`、`docs/capabilities/application-update.md`、`docs/adr/2026-10-05-application-update-source-and-boundary.md`、`electron-builder.config.cjs`、`src/main/appUpdater.ts`、`src/main/updateService.ts`、`src/main/applicationUpdateIpc.ts`、`src/main/applicationUpdateWindow.ts`、`src/main/updatePreload.ts`、`src/renderer/updateDialog.js`、`docs/adr/2026-10-09-independent-update-window.md`、`src/main/updateInstaller.ts`、`src/renderer/applicationUpdate.js` | 历史计划、AI 网页采集实现 |
| 本地文件读取 / 编码 / 大小控制 | `docs/capabilities/local-file-access.md` | 无关能力文档 |
| 图片 / PDF / DOCX 本地只读预览 | `docs/capabilities/local-file-access.md`、`src/main/filePreview.ts`、`filePreviewIpc.ts`、`docxArchive.ts`、`src/shared/filePreview.ts`、`imageDimensions.ts`、`src/renderer/filePreview.js`、`filePreview.css`、`tools/verify-file-preview.cjs` | 官网附件上传、历史计划 |
| 多项目工作区 / 目录恢复 / 最近目录 / 文件管理 / 多文件标签 / 未保存保护 | `docs/capabilities/local-file-access.md`、`src/main/workspaceService.ts`、`workspaceController.ts`、`fileManagement.ts`、`editorSession.ts`、`src/renderer/workspaceNavigation.js`、`editorWorkspace.js`、`editorTabs.js`、`fileExplorer.js` | 历史计划、官方网页实现 |
| 人机边界 / 自动继续 / 结果回传 | `docs/capabilities/human-machine-boundary.md`、`docs/adr/2026-10-07-automatic-result-return-boundary.md`、`src/main/tools/autoContinuation.ts`、`src/main/tools/webResultSender.ts`、`integration.ts` | 无关文件读取细节 |
| 回程解析 / 工具修改与查看 / 输出格式 | `docs/capabilities/return-path-and-format-contract.md`、`src/main/replyCollector.ts`、`src/main/tools/changes.ts`、`src/main/tools/changeReview.ts`、`src/main/returnPathService.ts`、`src/renderer/preview.js`、`docs/adr/2026-10-06-native-tool-harness-boundary.md` | 指纹与网络层细节 |
| 指纹与环境特征 | `docs/adr/2026-10-02-honest-electron-identity.md`（ADR-0001）、`docs/adr/2026-10-02-zero-injection-and-automation-trace-baseline.md`（ADR-0003） | 实现细节代码（`src/shared/userAgent.ts` 为落地实现） |
| 会话 / 登录持久化 | `docs/capabilities/session-persistence.md`（会话分区命名 ADR 为**候选未建项**，暂由该能力文档承载） | 计划文档 |
| DeepSeek / ChatGPT 平台切换及活动门禁 | `docs/capabilities/web-platforms.md`、`docs/adr/2026-10-11-web-platform-switching.md`、`src/main/webPlatformController.ts`、`src/main/webPlatformView.ts`、`src/shared/webPlatform.ts`、`test/webPlatformController.test.ts`、`test/toolPlatformActivity.test.ts`、`tools/verify-web-platform.cjs` | 登录凭据与官网正文 |
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
| 活跃计划 | 按具体任务读取 plans；ChatGPT已有会话采集与回传修复已按用户确认验收归档，不将过程记录加入默认能力上下文 |
| 决策记录 | `docs/adr/` |
| 回程机制（一键同步） | `docs/capabilities/return-path-and-format-contract.md` |
| 明确编辑协议与复制上下文 | `src/shared/returnPath.ts`、`snippet.ts`、`formatSpec.ts`；应用与基线 owner `src/main/returnPathService.ts`；默认面板资源由 `scripts/copy-static.mjs` 生成 |
| 应用实现（P2 已落地） | `src/main/`、`src/renderer/`、`src/shared/`；脚本 `scripts/`；测试 `test/` |
| 视图与入口对照（5 个 WebContentsView） | 官方网页、`src/renderer/index.html`（编辑器）、`preview.*`（变更查看）、`webbar.*`（中间官网常驻顶栏 / 只读采集）、独立提示词设置视图；preload 各自独立 |
| 紧凑需求输入与单一提示词 | `src/renderer/promptComposer.js`；结构/样式 `index.html`、`style.css`，状态与组装 owner `src/main/localPromptController.ts`、`preload.ts`；单一模板 `src/shared/formatSpec.ts`，升级备份与设置 `src/main/settings.ts` |
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

ChatGPT 普通对话文本及附件适配：平台 URL 规则为 `src/shared/webConversation.ts`，只读 DOM 及附件卡规则为 `src/main/chatgptPage.ts`，正文/完成快照为 `tools/replyObservation.ts`，监听生命周期为 `tools/replyChangeWatcher.ts`，唯一 DOM 写入仍为 `src/main/webComposerSender.ts`；活动绑定由 `tools/integration.ts` 管理。验证为 `test/chatgptToolIntegration.test.ts`、`test/chatgptComposerSender.test.ts` 与 `tools/verify-chatgpt-composer.cjs`；源站手动添加图文的结构核验与真实程序上传、连续对话验收是不同证据。

ChatGPT 原生只读结构诊断为 `tools/chatgpt-page-structure.cjs`，由 `tools/chatgpt-ide-preview.cjs` 在显式诊断开关开启时运行，不记录正文、输入或凭据；离线两轮真实工具验证为 `tools/verify-chatgpt-tools.cjs`。

官网启动/切换的本地加载反馈先读 `docs/capabilities/web-platforms.md` 与 `docs/adr/2026-10-11-web-platform-switching.md`；状态 owner 为 `src/main/webPlatformController.ts`，展示 owner 为 `src/main/webLoadingView.ts` 与 `src/renderer/webLoading.html/css`，统一几何仍归 `workspaceLayoutController.ts`。回归入口为 `test/webPlatformController.test.ts`、`tools/verify-web-loading.cjs`。

手动粘贴工具JSON先读 `docs/capabilities/tool-harness.md` 与 `docs/adr/2026-10-13-manual-tool-json.md`。原文单次提交及协议入口归 `src/main/tools/manualToolJson.ts`，执行及manual诊断来源归harness/store，integration接线；按设置复制归resultClipboard，回传资格归autoContinuation/resultReturn。UI归 `src/renderer/toolJsonPanel.js`，toolHarness只接线。回归入口为 `test/manualToolJson.test.ts`、`test/manualToolJsonIntegration.test.ts`、`test/toolResultClipboard.test.ts`、`test/toolJsonPanel.test.ts`。

共享登录与重复启动先读 `docs/capabilities/session-persistence.md`、`docs/adr/2026-10-13-shared-session-instance.md`。锁/激活owner为 `src/main/sharedSessionInstance.ts`，index在配置/session初始化前接线；unit入口 `test/sharedSessionInstance.test.ts`，隔离原生互斥/存储夹具为 `tools/verify-shared-session-instance.cjs`。此机制不读取认证值、不更改分区，不保证旧二进制参与新增保护。
