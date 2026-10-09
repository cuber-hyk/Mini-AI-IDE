---
artifact_type: plan
status: archived
created: 2026-10-09
updated: 2026-10-09
owner: agent
plan_readiness: ready
source_audit: docs/audits/archived/2026-10-09-deep-thinking-reply-state-audit.md
covered_findings: [DT-001]
deferred_findings: []
---

# 深度思考回复完成识别修复

## Goal

深度思考区与正式答案共享回复框时，正确确认完整正式答案已结束，使自动采集及手动采集后的自动回传使用同一有效结束状态。

## Scope

- In scope: 完成判据、现场结构回归、相关能力文档和变更记录。
- Out of scope: 发送运输、权限、会话绑定、自动重试及历史基线的行为调整。

## Plan Readiness

- Goal clear: 修复 DT-001。
- Scope clear: 仅正式答案分支中的回复数量判断。
- Source of truth known: replyObservation、replyContinuation、integration 及其测试；现场结构见用户诊断。
- Critical decisions confirmed: 用户已授权修复；根据现有正式答案 class 区分答案与思考区，无未决产品决策。
- Validation path known: 先使现场结构回归失败，再修复并运行相关测试、类型检查及文档校验。

## Assumptions And Decisions

- 使用现场明确的 `ds-assistant-message-main-content` 判断同框正式答案数量。
- 保留 REPLY_NODES 的共用候选与顺序语义，不改变变化监听、历史连续性及正文选择。
- 保留生成、中断、唯一输入区及完整结束控件检查；两条正式答案同框仍为未知。
- 代码落在现有状态 owner，改动很小，不引入新模块或拆分。

## 已确认路线

| Decision | Chosen route | Confirmed by | ADR gate |
|---|---|---|---|
| 如何识别同框多回复 | 只在 DeepSeek 正式答案分支统计正式答案候选 | 用户现场结构、replyContinuation 的现有规则 | not needed：局部缺陷修复 |

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 固化现场思考区与正式答案结构，增加行为回归 | 修复前新增完成用例失败：actual unknown、expected complete，其余 11 项通过 |
| PLAN-2 | done | 修复正式答案分支的数量判断 | 相关 106 项测试通过、无跳过；覆盖完成、生成、中断、缺少控件及同框多答案；构建通过 |
| PLAN-3 | done | 验证相关采集和发送链路，更新文档并评审 | 106 项测试通过，构建含 TypeScript 编译通过，diff 检查通过；全库文档校验存在 HEAD 已有的元数据错误，详见评审记录 |

## Acceptance Criteria

- 用户现场的两个 markdown 区域不再造成完成状态 unknown。
- 生成中、中断或结束控件不完整时不判完成。
- 同框多条正式答案及来自历史回复的控件不能确认最新回复完成。
- 当前自动采集与发送前完整快照均使用修复后的同一识别器。
- 用户已于 2026-10-09 确认官网实际运行验收通过。

## Artifact Routing

- Capability updates: docs/capabilities/tool-harness.md。
- Audit output / Source audit: docs/audits/archived/2026-10-09-deep-thinking-reply-state-audit.md（用户确认官网复测通过，已归档）。
- Covered findings: DT-001；Deferred findings: 无。
- ADR gate: not needed；不改变架构或授权边界。
- Tests: test/deepseekReplyState.test.ts 与结构夹具。
- Changelog: Unreleased / Fixed。

## Git Visibility

在 codex/fix-deep-thinking-reply-state 分支核对计划、审计及现场资料可见性；用户诊断原文件保留。

## Closeout

实现、离线验证与用户官网验收完成，计划和审计归档；用户已批准提交、合并及版本发布。推送仍遵循用户的 Git 规则。

## 评审记录

- Mode: manual；实现仅调整一处完成条件，采用人工差异审查。
- Plan compliance: pass；按先失败回归、再修复、再相关验证的顺序完成。
- Audit coverage: pass；DT-001 的具体误判条件已修复，用户已确认官网复测通过。
- Related changes only: pass；源代码、行为回归、最小结构夹具、能力说明、变更记录与本次过程证据。
- Verification evidence: pass；相关九个测试文件 106 项通过、0 失败、0 跳过；pnpm run build 通过；git diff --check 通过。
- Changelog: pass；Unreleased / Fixed 已记录用户可见修复。
- Distill: pass；能力文档描述当前判据，审计记录 fixed，用户验收通过后归档；无需 ADR、布局规则或上下文路由调整。
- Check gate: fail（仓库既有问题）；validate-docs 报 docs/plans/2026-10-09-file-tree-icons.md 缺 created，并有该计划与 DESIGN.md 的警告。git show HEAD 已确认这些文件的相关内容先于本任务存在，按任务范围保留。
- Blocking issues: 无已知实现阻断；全库文档门禁未通过，不宣称全部工程门禁通过。
