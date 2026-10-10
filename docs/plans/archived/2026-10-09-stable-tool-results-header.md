---
artifact_type: plan
status: archived
created: 2026-10-09
updated: 2026-10-09
owner: 胡运宽
---

# 工具结果摘要固定两行

## Goal And Scope

固定工具摘要的两行高度，避免完成反馈出现、消失或状态文案变化推移官网与需求区域。范围仅为本地摘要结构、样式、完整文案提示及对应设计/能力文档；不改变采集、工具执行、自动继续或发送资格。

## Assumptions And Decisions

- 用户已确认：第一行标题、数量与操作；第二行统一显示状态，状态切换不改变栏高。
- 当前 activity 与各类反馈来自既有 owner，保留真实状态来源，在同一状态行显示；完成提示消失后仍有当前执行/发送状态。
- 窄列长文案省略；状态行显示优先级最高的反馈，悬停该项可查看同时存在的全部反馈。折叠/展开继续使用原生 details 和键盘行为。
- 仅布局修复，不需要拆分 owner 或新增 ADR；design_system_impact: update。
- 本次用户未要求测试，不新增或运行测试。使用构建、语法检查、差异检查与独立只读评审；真实 Electron 视觉由用户验收。

## Fact Sources

- DESIGN.md；docs/capabilities/tool-harness.md。
- src/renderer/index.html、toolHarness.css、toolHarness.js、toolPanelLayout.js；现有 test/toolHarnessUi.test.ts 仅作阅读参考。

## Steps And Verification

| Step | Status | Verification |
| --- | --- | --- |
| 核对现有摘要与尺寸 owner | done | CSS 中反馈 block/:empty 会改变摘要高度，ResizeObserver 随之重算预算。 |
| 固定两行结构和状态行，保留折叠、操作及错误反馈 | done | 检查状态/计时/音效调用链；保留既有反馈 ID 与原生 details。 |
| 保障多条长反馈同时出现时仍可查看 | done | 状态行只展示优先级最高反馈，悬停提示聚合所有反馈。 |
| 同步文档并完成静态验证与独立评审 | done | 构建、语法、差异检查通过；独立评审的反馈竞争和音效异步更新问题已修复并复核。 |

## Acceptance And Closeout

完成反馈、倒计时、等待回复及长错误均留在第二行，不增加第三行；第一行右侧操作保持可用，附件动作沿用现有窄列换行规则。记录未执行的真实视觉验收；实现和评审结束后归档计划，提交/合并等待用户显式授权。
