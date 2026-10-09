---
artifact_type: plan
status: archived
created: 2026-10-08
updated: 2026-10-08
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 本地需求附件提交

## Goal

允许用户从本地工作区选取文件，并把外部拖入的文件或图片暂存到本地需求中；用户主动开启回车发送时，仅由受控网页 owner 将这些附件提交给 DeepSeek 官方上传控件并发送需求。

## Scope

- In scope: 本地需求编写区的附件选择、外部/工作区文件树拖放、剪贴板图片粘贴、待发送附件列表/移除；限定的主进程文件读取；DeepSeek 官方页面的附件控件识别、提交与发送确认；可复现离线夹具、测试及必要的边界文档更新。
- Out of scope: 工具结果自动回传附件、自动继续发送附件、任意网页、剪贴板附件、文件夹/目录上传、修改官网网络请求或模型 API。

## Plan Readiness

- Goal clear: 用户同意扩展为用户主动选择/拖入附件后，通过受限的官网上传流程提交。
- Scope clear: 仅本地需求通道；自动采集和工具结果回传不变。
- Source of truth known: `LocalPromptController`、`WebComposerSender`、现有文件路径守卫与本地需求 UI/测试。
- Critical decisions confirmed: 仅 DeepSeek 官方 origin；网页不得取得本地路径或通用文件桥；附件只能来自用户本次选择/拖入；网页实际上传控件仍需唯一识别，否则安全失败并停止。
- Validation path known: 单测、离线上传夹具、类型检查、构建及适用的自检。
- External validation: 用户已在真实官网登录态确认文档与图片需求发送成功；离线夹具另覆盖上传等待与失败边界。

## Assumptions And Decisions

- 工作区文件可通过选择入口或右侧文件树拖入添加；工作区外文件及图片可拖入需求区；剪贴板图片可粘贴为附件。
- 附件以待发送条目显示，用户可在发送前移除；切换工作区/关闭需求发送或清空需求时不得把路径转交网页。
- 只有显式本地需求发送可携带附件。自动继续及 `WebResultSender` 仍仅处理纯文本结果。
- 文件字节只由主进程在用户明确选择/拖入后读取；网页侧只收到受限附件数据并通过官网自身上传 UI 接收，不获得路径、文件系统桥或任意 IPC。
- 采用官网文件输入控件，不经 Node 网络请求、CDP、键盘模拟或剪贴板代送。上传控件无法唯一验证、草稿/附件状态不为空或会话改变时停止，不猜测、不重试。
- 本轮修复的结构评估为 `no split`：附件区域与接收状态仍由 `WebComposerSender` 负责，只在已有 owner 内修正局部谓词；回归留在原生 DOM 夹具，不引入新发送入口或通用模块。

## Confirmed Routes

| Decision | Chosen route | Confirmed by | ADR gate |
|---|---|---|---|
| 是否扩展网页边界以支持用户主动上传附件 | 扩展唯一受控网页 owner，仅用于本地需求的明确附件；不扩展自动回传 | 用户“同意” | needed |
| `deepseek-harness` 的复用范围 | 参考附件条、缩略图、顺序和移除交互；不移植其持久化/协议层 | 用户要求参考，已检查源码和文档 | not needed |
| 文件来源与路径可见范围 | 当前工作区文件选择 + OS 拖入的单个文件；主进程校验读取，网页不见路径 | 用户原始需求及项目边界 | needed |

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 核实 Electron 进程/路径能力；定义严格的文件类型、大小、数量校验及安全失败条件 | 主进程路径/大小/类型单测通过；官网的异步上传完成信号仍需真实页面确认 |
| PLAN-2 | done | 增加本地需求附件选择/拖放、待发列表与移除状态；只通过窄 IPC 传递用户选择 | renderer 测试覆盖选择、外部和工作区文件树拖放、移除；主进程以不透明 ID 管理路径 |
| PLAN-3 | done | 扩展 `WebComposerSender` 的本地需求分支，通过唯一官网文件输入控件提交附件；等待官网可见附件且上传结束后再发送文本 | sender 单测及离线 fixture 覆盖会话、草稿、控件歧义、上传延迟/无确认、取消清理和一次发送；未证明真实官网接受 |
| PLAN-4 | done | 更新安全边界、能力文档、上下文路由、ADR 与变更记录 | Dev Flow 文档校验通过；automatic 和结果回传仍为纯文本 |
| PLAN-5 | done | 跑相关测试、typecheck、build、离线夹具与代码差异审查 | 全量 694 项通过、构建/33 项离线夹具通过；trace 定位并修复 sender 丢附件参数及官网消费 input.files 后误报失败；真实官网复测待用户执行 |
| PLAN-6 | done | 在真实 DeepSeek 登录页面验证选择/拖入至少一种文档和图片，确认上传完成后随本地需求发送 | 用户于本次对话确认“终于成功了”；前次已确认文档发送成功，本次修复图片后确认通过 |
| PLAN-7 | done | 按用户诊断 JSON 修正附件区域为控件共同容器的局部外层，保留无回复正文/唯一输入框边界；逐类确认文档文件名与图片预览，避免零图片放行 | 诊断显示 depth=1 含 textarea/file input/send，depth=2 才有图片；旧代码在同结构的文档后图片夹具中失败，修复后 37 项原生夹具通过，覆盖连续发送、混合延迟、缺文档、既有图片/回复边界；用户随后确认官网复测成功 |
| PLAN-8 | done | 按用户新要求在确认发送成功后清空本次本地需求，同步技能状态、预览和输入高度；失败/未知及等待期间的新需求保留 | 新规则在旧代码中导致 2 项回归失败，修复后本地输入/提示词 34 项通过且无跳过；构建通过；回车与按钮成功清空、失败/异常保留、迟到成功回执保护新需求均验证 |

## Acceptance Criteria

- 用户可在本地需求区选择工作区文件，或从资源管理器/右侧文件树拖入文件与图片，看到有序附件并单独移除。
- 开启本地需求发送后，附件随该需求经 DeepSeek 官方上传 UI 提交；附件不进入技能组装文本或工具结果回传。
- 主进程仅读取用户明确选择的文件；官网只收到对应文件字节，不接触路径、任意磁盘读取或通用 IPC。
- 官网控件识别、文件校验、会话、空草稿及附件状态任一不确定时停止，不重复上传或重复发送。
- 自动继续和工具结果回传的既有文本行为保持通过现有回归验证。
- 真实官网登录态下附件上传与发送通过验收（用户已确认 PLAN-6）。

## Artifact Routing

- Capability updates: `docs/capabilities/human-machine-boundary.md`；本地需求能力文档（按实际 owner 确认）。
- Audit output: none.
- Source audit: none.
- Covered findings: none.
- Deferred findings: none.
- ADR gate: needed; 用户主动文件上传是网页接触面与本地文件授权的持久扩展。
- Tests: `test/localPrompt.test.ts`、`test/webComposerSender.test.ts`、相关 renderer/IPC 测试和新增附件校验测试。
- Context map: 更新本地需求附件 owner 与测试路由。
- Design system impact: update; 复用现有需求区控件/附件条模式，需验证窄宽度、键盘移除和屏幕阅读器名称。

## Git Visibility

- After creating this file, run `git status --short --branch --untracked-files=all`.
- If this file is ignored, add a minimal allow rule or report that the plan is not tracked.

## Closeout

已归档至 `docs/plans/archived/`；全部步骤已验证。保留官网结构诊断、旧逻辑复现、自动回归及用户真实验收作为过程证据。用户追加的发送成功清空行为已同步能力文档、DESIGN 和测试。提交/合并/推送在用户“等等”后暂停，本次归档不执行 Git 发布操作。
