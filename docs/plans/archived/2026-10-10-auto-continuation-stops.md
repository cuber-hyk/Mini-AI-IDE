---
artifact_type: plan
status: archived
created: 2026-10-10
updated: 2026-10-10
owner: 胡运宽
plan_readiness: ready
source_audit: docs/audits/archived/2026-10-10-timeout-auto-continuation-audit.md
covered_findings: [AUD-1, AUD-2, AUD-3]
deferred_findings: []
---

# 修复自动继续的可回传终态识别

## Goal

让已完整结束的超时/单条停止命令结果及权限拒绝回执按自动继续设置正常回传，同时保留整批取消、未知状态和未清理进程的暂停保护。

## Scope

- In scope: 自动继续准入、工具结果回传资格、符合既有自动复制策略的已完成命令结果，以及对应仓库规则、能力文档和变更记录。
- Out of scope: 改变工具权限、发送器行为、整批取消语义、状态未知处理、发布。

## Plan Readiness

- Goal clear: yes
- Scope clear: yes
- Source of truth known: yes
- Critical decisions confirmed: yes; 用户同意允许超时/单条命令中断与权限拒绝回执继续回传
- Validation path known: yes; 静态边界审查与构建/类型检查

## Assumptions And Decisions

- 超时或用户停止的单条命令仅在当前批次完成、具有真实 `started_at`、进程已终止且 `cleanup_pending` 不为 true 时可回传。
- `completion.cancelled` 仍无条件阻断；普通 cancelled 与 unknown 结果仍阻断。
- 只包含权限拒绝/依赖跳过的完整批次可回传拒绝回执，但不改变自动复制“至少有实际执行结果”的既有规则，也不读取或上传附件。
- 手动附件回传只在整批仍满足原有资格时开放；发送仍复核官网批次、权限、草稿及来源，且不重试不确定运输。

## Confirmed Decisions

| Decision | Chosen route | Confirmed by | ADR gate |
|---|---|---|---|
| 自动继续遇到超时、单条命令停止及权限拒绝时如何处理 | 回传完整真实结果/拒绝回执；整批取消及 unknown 保持暂停 | 用户在本会话确认“同意，那就先修复这个” | not needed；既有回传边界不变 |

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 建立同源的终态判定，供自动继续、结果回传和自动复制复用 | pnpm typecheck 通过；最终代码检查确认超时/单条停止精确放行，整批取消与 unknown 仍拦截 |
| PLAN-2 | done | 调整三个消费端：自动继续、结果回传资格、自动复制 | pnpm build 通过；逐条审查拒绝、停止、超时、cleanup_pending、completion.cancelled 与附件条件 |
| PLAN-3 | done | 更新能力文档、CHANGELOG 与本审计结论 | 能力文档、AGENTS.md、CHANGELOG 与实现一致；Dev Flow 校验运行但报告了仓库中既有的其他生命周期错误 |
| PLAN-4 | done | 手动审查最终差异并汇报待用户审核 | `git status --short --branch --untracked-files=all` 与 `git diff` 已检查；用户已实测通过并明确授权提交合并 |

## Acceptance Criteria

- 超时命令和已清理的单条命令停止结果不再因 `data.status: stopped` 被误暂停，真实部分输出可回传。
- 完整批次的权限拒绝回执可自动回传，但不会执行被拒绝工具或自动上传被拒绝附件。
- 整批取消、普通 cancelled、unknown、运行中进程和清理未结束仍不发送/不复制。
- 发送时仍复核当前来源与官网状态，未知运输不重试。

## Artifact Routing

- Capability updates: `AGENTS.md`, `docs/capabilities/human-machine-boundary.md`, `docs/capabilities/tool-harness.md`
- Audit output: 更新 `docs/audits/archived/2026-10-10-timeout-auto-continuation-audit.md`
- Source audit: `docs/audits/archived/2026-10-10-timeout-auto-continuation-audit.md`
- Covered findings: AUD-1, AUD-2, AUD-3
- Deferred findings: none
- ADR gate: not needed; 不变更网页写入或权限边界，只精确区分已结束的结果类别
- Tests: autoContinuation、toolResultReturn、toolResultClipboard 共 36 项通过；toolExecutionIntegration 的 Windows 真实进程测试 7 项通过；无跳过。

## Git Visibility

- After creating this file, run `git status --short --branch --untracked-files=all`.
- If this file is ignored, add a minimal allow rule or report that the plan is not tracked.

## Closeout

43 项针对性测试及构建通过；用户在修复版确认三项官网测试通过，并授权提交合并。知识已写入 AGENTS.md、能力文档与 CHANGELOG；本计划与对应审计归档。仓库其他历史文档校验错误已告知用户，未混入本次修复。
