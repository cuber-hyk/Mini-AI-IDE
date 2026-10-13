---
artifact_type: plan
status: archived
created: 2026-10-12
updated: 2026-10-12
owner: Mini-AI-IDE contributors
plan_readiness: ready
source_audit: docs/audits/archived/2026-10-12-ai-temp-json-recovery-review.md
covered_findings: [ATR-002, ATR-005, ATR-006]
---

# AI 临时文件管理与错误 JSON 局部修复实施计划

## 目标与边界

在 Mini-AI-IDE 当前项目内按需提供可复用的 AI 临时目录；仅对单一完整正式 mini-ai-tools 围栏内 JSON.parse 失败且整批尚未执行的调用提供受控、版本化、局部修复，并继续使用原执行、权限、去重及结果回传链路。

不改变构建、测试、Git 或现有命令的默认 cwd；不改变正式源码、测试和脚本的文件布局；不自动清理、不增加并行任务系统、命令局部修复或整批重放；不提交、合并、删分支、push 或发布。

本计划依据用户 2026-10-12 的确认及五项补充约束。原讨论材料 docs/references/discussions/archived/2026-10-12-ai-temporary-files-and-tool-call-recovery.md 仅作为参考，不作为已批准实施路径。

## 已确认的决定

### A. AI 临时目录

1. 新增按需调用的 get_ai_temp_dir({task_id})，在当前打开项目的真实根目录下管理 .mini-ai-ide/ai-temp/<task_id>/。task_id 由 AI 在第一次申请当前任务目录时选择，使用简短、可验证、稳定的任务标识；成功回执同时返回 task_id 和经过核验的绝对路径，后续同一任务必须原样复用，禁止每轮生成新 ID。对不合法或冲突标识直接拒绝。
2. 目录属于用户项目，不属于 IDE 安装或用户全局缓存。主进程专用 owner 按需创建，不通过全局 cwd 重定向实现；继续复用既有文件工具与 run_command。正式文件操作仍受现有路径、权限与未保存内容规则约束。
3. 创建前检查项目真实根路径、每一级既存父目录及目标；创建后再次检查 lstat/realpath 和实际归属，识别 Windows junction、符号链接、悬空链接、越界及路径别名。真实路径必须在已确认的项目根内，不能凭归属标记判定安全。复用已有目录需要验证真实边界和专用归属标记；不明归属、对象变化或冲突时失败，不认领、不搬迁、不覆盖已有文件。
4. 在专用临时目录树内使用独立 .gitignore，只忽略本专用运行时文件，不编辑项目现有 .gitignore，也不忽略仓库 Dev Flow 文档。现有用户文件不迁移、不删除。
5. 不执行自动清理、不设置自动过期、容量淘汰或退出删除；文件保留至用户自行处理。目录创建失败返回明确错误，不假称成功。验收时说明敏感脚本、日志和输出由用户项目自行保管，以及磁盘占用和 Git 忽略不等于安全删除。

### B. 错误 JSON 局部修复

1. 第一版只接受一个完整、顶层、正式 mini-ai-tools 围栏中的 JSON.parse 失败。未闭合围栏、多正式围栏、协议字段或参数错误、已经形成执行批次的失败，继续走原有诊断与执行回执。补丁自身必须是合法 JSON；非法补丁不递归创建可修复草稿。
2. 在主进程内存维护原始回复的不可变快照、JSON 正文的当前修订稿、草稿标识、从 1 开始的修订版本、当前诊断以及当前项目/官网平台/会话/采集代次作用域。原始输出永不被补丁改写；版本只对应修订稿。离开有效作用域、用户取消、原有诊断被新独立输出取代或进程重启时使草稿失效；不落盘原始正文。
3. 经原有正式回复采集入口接受单个 repair_draft 指令，必须包含 draft_id、version、old_string、new_string。只允许当前修订稿中恰好一次匹配的非空 old_string，基于严格版本检查生成下一修订稿。错误标识、版本过期、歧义、无匹配、重复补丁、超界输入及失效作用域明确拒绝且不修改草稿、不执行工具。
4. 成功替换但 JSON 仍非法时，保留已递增的修订版本，给出该版本的新错误定位，允许继续修补；不构造批次或执行账本。修复成功后完整重新解析，执行协议及请求参数校验，然后继续原有静态整批冲突检查、路径实体验证、权限批准、执行前复核和持久去重。草稿修改本身不代表批准执行。
5. 恢复批次必须携带不可混淆的来源证明：原草稿标识及原文摘要、修订版本及修订稿摘要、最新补丁回复原文及摘要、恢复后完整批次及身份、项目/官网平台/会话/采集代次。ToolResultReturn 的发送前核验必须重新读取官网最新已完成回复，要求它与本次有效 repair_draft 来源严格相符，并核对保存的恢复关联与当前选中批次；不能错误要求官网补丁原文等于恢复后整批 JSON，也不得因修复而跳过来源核验。历史补丁、已变动回复、取消和作用域切换不能恢复发送资格。
6. 有效恢复批次只经既有 ToolHarness 队列执行、ToolStore.reserve 去重和 ToolResultReturn / AutoContinuation 反馈。无竞争的重试、独立执行或第二发送入口；相同恢复批次不重复执行或上传。草稿编辑、错误和重新诊断不重置连续批次错误次数；第六次的暂停限制仍适用。关闭自动继续不产生补执行或发送。正常合法 JSON 原流程不变。
7. JSON 合法后 run_command 启动失败、脚本语法错误、非零退出或运行失败仍以真实工具结果回传，由 AI 通过新必要请求修正；不得对命令正文套用 repair_draft 或重放已经成功的请求。

## 事实来源与主要 owner

- 协议与诊断：src/shared/toolProtocol.ts、src/shared/toolJsonDiagnostic.ts、src/shared/formatSpec.ts。
- 解析、选中、执行与诊断：src/main/tools/harness.ts。
- 来源接线、平台/会话身份、IPC、工具分派：src/main/tools/integration.ts。
- 文件路径：src/main/tools/files.ts；工作区根：src/main/workspaceService.ts、FileService。
- 执行去重与持久状态：src/main/tools/store.ts；不得持久保存错误回复全文。
- 自动采集与历史隔离：src/main/tools/autoCollector.ts、replyObservation.ts、replyChangeWatcher.ts。
- 结果来源复核与发送：src/main/tools/resultReturn.ts、autoContinuation.ts、webResultSender.ts；唯一网页写入 owner 仍为 webComposerSender.ts。
- 主规范：AGENTS.md、CONTEXT.md、docs/ai/context-map.md、docs/capabilities/tool-harness.md、local-file-access.md、return-path-and-format-contract.md、human-machine-boundary.md，以及 docs/adr/2026-10-09-batch-error-auto-return.md。
- 相关已有测试：test/toolProtocol.test.ts、toolJsonDiagnostic.test.ts、toolHarness.test.ts、toolIntegration.test.ts、toolResultReturn.test.ts、autoContinuation.test.ts、toolProcesses.test.ts。

## 实施步骤与验收

1. [done] 记录基线 Git 状态、现存未跟踪文件和相关测试表现；定位现有 owner，识别大文件边界并遵循 /dev-split 约束（如适用）。验证：真实 Git 输出、定位记录和基线测试退出码。
2. [done] 在 codex/ai-temp-json-recovery 独立任务分支实现临时目录专用 owner、协议工具、接线及提示词，按已确认的路径和保留策略处理。验证：按需创建、稳定 task_id、同任务复用、多项目隔离、真实路径边界、符号链接与 junction、创建失败、无关文件保全、cwd 不变和正式操作不变。
3. [done] 实现严格的 JSON 解析错误草稿状态、局部补丁解析、版本校验、修订稿与诊断；非法及重复补丁均不执行。验证：多请求长 JSON、修复前零执行、错误和歧义拒绝、旧版本与失效作用域、仍非法继续修复、无法递归修补补丁。
4. [done] 补齐恢复批次来源关联、最新官网回复复核和原回传/权限/去重闭环。验证：最新合法补丁可回传真实结果，历史或变动补丁不可回传；自动继续关闭、人工取消、项目/会话/平台切换、重复恢复、5 次错误限制，以及合法 JSON 后命令失败不重放。
5. [done] 运行与修改相称的专门测试、集成测试、typecheck、build，并检查真实 IDE 运行条件；记录每条命令及退出码、通过失败跳过数量。离线夹具与真正 IDE/官网验收严格区分，不能把模拟当成线上结果。
6. [done] 按 /dev-branch 检查设计、changelog、distill、ADR 和 dev-check，记录文档增量与既有全仓诊断；无关改动保留。无 UI 变更，ADR accepted，全仓文档不能宣称通过。
7. [done] 完成独立只读代码评审和离线结果报告，提供人工验收案例及差异入口；不提交、合并、删分支、push 或发布。真实官网验收另由下方接手步骤跟踪。

## 最终验证与收尾

### 外部审核后接手（2026-10-12）

用户明确要求 Codex 接替 IDE 完成后续任务。沿用当前独立分支及所有已授权实现，不覆盖原工作；无关审计及讨论材料保持原样，不自动提交、合并、删分支或推送。

- [done] ATR-005 及根值分类 ATR-006 回归先失败后通过；只在现有 toolProtocol 内做根属性识别，不猜测修复内容，畸形补丁保留原草稿 ID/版本。
- [done] 固化 40 请求长 JSON、连续错误额度、关开自动、平台/会话/reset 和取消回归；沿用原执行和发送链路。
- [done] 最终 958 测试、类型与构建通过，原生本地 DOM 11 项通过；独立只读评审确认无剩余代码阻断。审核、ADR 与能力文档同步。
- [done] 2026-10-12 用户确认两平台普通新会话均完成验收，错误 JSON 零执行、短补丁恢复、临时目录复用和文件读取成功，且错误诊断、恢复及后续结果全程自动采集并回传，没有手动辅助。验收按用户确认记录，磁盘文件另经 Codex 只读核验。

dev-split 分类 no split：协议解析为内聚顺序逻辑，根对象识别函数留在 toolProtocol，副作用保持 integration/jsonDraft 所有权；不向 index 或通用 utils 添加逻辑。新增事实及临时文件不扩展第一版功能范围。

最终全量测试 958/958 通过，构建与类型检查通过，渲染器未绑定标识符 0，另有 115 条非阻断参考诊断；原生本地 ChatGPT DOM/composer 11 项通过。独立评审确认 ATR-005 / ATR-006 修复，无剩余代码阻断；用户已确认两平台真实常规闭环全程自动成功。文档和 CHANGELOG 已同步，ADR accepted，计划与审核归档。正式 Dev Flow CLI 保留 6 项既有错误、3 项既有警告，退出码 1，当前任务无新增，不修改无关归档及讨论材料，也不宣称全仓检查通过。Git 未提交、合并或推送。证据见 `docs/audits/archived/2026-10-12-ai-temp-json-recovery-review.md`。

## 分支与工作区约束

2026-10-13 收尾复核：本功能与最新 ChatGPT 修复组合后全量 975/975 通过，0 失败/取消/跳过；构建（含类型检查）、原生离线恢复 11 项、独立专项 31 项及正式文档检查均通过。此前两平台用户自动验收继续作为官网证据，本轮未重复官网验收。原功能成果从主目录保留到 master 基线的 codex/ai-temp-docs-closeout 分支整理，相关 docs 归档整理另组提交；具体 Git 结果以实际记录为准。收尾证据见 `2026-10-13-uncommitted-work-closeout.md`。

用户确认任务分支名为 codex/ai-temp-json-recovery，覆盖 /dev-branch 的默认 task/ 前缀建议。基线 master 的当前 HEAD 为 073756a849b7485f71f1ddd675d1980dc5305018；创建分支前必须再次核实。保留现有未跟踪讨论记录和三份其他审计文档，不 stash、不覆盖、不清理、不把无关文件纳入任务差异。若任务分支已存在、基线变化或工作区出现新冲突，先核对，不强行切换。

## 风险、文档路由与审核门禁

- 主要风险：修复补丁来源与执行批次不一致、重复执行、异步项目/会话切换、Windows 路径重解析竞争、临时目录敏感内容积累、错误回传额度被意外重置。
- 决策涉及工具协议和生命周期，实施完成时进行 ADR 门禁；现有 ADR 不无故修改。用户可见变化记入 CHANGELOG.md 的 Unreleased；当前事实更新 docs/capabilities/，必要时更新 docs/ai/context-map.md。
- 验证规则进入 test/；人工运行及独立审核证据记录于 docs/audits/archived/2026-10-12-ai-temp-json-recovery-review.md，区分用户现场确认、独立磁盘核验与离线证据。
- 计划 archived 表示实施与验收收尾，不表示用户已批准 Git 操作；仍需单独批准提交、合并、删除分支或推送。
