---
artifact_type: plan
status: archived
created: 2026-10-09
updated: 2026-10-09
owner: 胡运宽
---

# 工具结果复制与发送合并

## Goal And Scope

将工具栏的复制结果和手动附件发送合并为一个自适应图标按钮：无可手动发送附件时复制；有且可手动发送时复制结果并发送当前批次及附件。

## Assumptions And Decisions

- 已确认：有可手动发送附件时用发送图标；普通复制或 automatic 已开启时用复制图标。
- 复制与官网发送独立执行并分别反馈；复制失败不阻止发送，发送失败保留剪贴板结果。
- automatic 开启时由既有自动回传 owner 处理发送，按钮仅复制，避免重复发送。
- 继续使用现有零参数 IPC 和 `ToolResultReturn` 资格核验，不改变网页写入边界。
- 本次不新增或运行测试（用户未要求）；使用构建、语法、差异检查与独立只读评审。

## Fact Sources

- `src/renderer/toolHarness.js`、`src/renderer/index.html`、`src/renderer/toolHarness.css`。
- `src/main/tools/resultReturn.ts`、`src/main/tools/integration.ts`、`src/main/webComposerSender.ts`。
- `docs/capabilities/tool-harness.md`、`docs/capabilities/human-machine-boundary.md`、`DESIGN.md`、`AGENTS.md`。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 核对手动发送和复制的现有 owner/资格 | 确认手动 IPC 无参数，主进程复核当前批次及官网状态。 |
| PLAN-2 | done | 合并按钮，按状态切换图标与动作，并保留失败隔离反馈 | 静态检查各模式分支；没有改 sender 或授权资格。 |
| PLAN-3 | done | 同步当前行为文档，构建、语法检查并独立评审 | 构建、`node --check`、`git diff --check` 与独立静态评审通过；无真实 Electron 视觉验收。 |

## Acceptance Criteria

- 无附件或 automatic 开启时，按钮只复制并显示复制图标。
- 有附件且 manual send 资格有效时，按钮复制并调用现有手动回传入口，显示发送图标。
- 任一动作失败不会跳过另一项；官网发送 uncertain 时仍不重试。

## Artifact Routing

- Capability updates: tool-harness 与 human-machine-boundary。
- Design system: 更新工具结果主操作规则。
- Changelog: 更新 Unreleased。
- ADR: 不需要，沿用当前附件回传 owner 与边界。
- Tests: 不新增、不运行；按用户要求进行构建与静态检查。

## Closeout

评审及验证后归档计划。提交、合并和 push 需用户另行明确授权。
