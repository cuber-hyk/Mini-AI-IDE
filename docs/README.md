---
artifact_type: documentation_index
status: current
created: 2026-10-12
updated: 2026-10-12
owner: Codex
---

# 文档导航

当前能力以 [capabilities](capabilities/) 为准；代理按 [context-map](ai/context-map.md) 读取相关 owner。过程记录和原始资料不替代当前能力说明。

| 目录 | 内容 |
|---|---|
| [capabilities](capabilities/) | 当前模块行为、边界和代码事实 |
| [adr](adr/) | 架构与权限决定，模板放在 adr/templates |
| [plans](plans/) | 有明确剩余事项的计划；结束记录放 plans/archived |
| [audits](audits/) | 尚未闭合的发现或证据缺口；闭合记录放 audits/archived |
| [releases](releases/) | 已发布版本的说明，保留历史版本 |
| [references](references/) | 讨论、原始诊断和截图，均按资料使用 |

[工具调用测试样例](工具调用测试样例.md) 是可执行协议测试的数据源，路径保持固定。

## 保留的活动记录

- [ChatGPT 首批回传诊断](audits/2026-10-12-chatgpt-first-result-return-audit.md)：已修复并验收确定的生成/来源/输入归属误判；CGR-005 的原始空采集和取消未确认现场归因仍保留。
- [JSON 截断来源](audits/2026-10-11-json-truncation-audit.md)：已验证机制保留，JT-5 原始现场归因仍未关闭。
- [首轮采集审计](audits/2026-10-08-first-turn-auto-collection-audit.md)：FTA-04 状态文案覆盖已在当前工具面板复现，保留待修复。

active 表示记录尚有未关闭事项，不表示代理正在执行任务。不能仅为整齐把 open 发现标为已解决。

## 讨论与原始资料

- [多项目并行开发](references/discussions/2026-10-07-multi-project-parallel-development.md)、[变更记录与 Diff 后续议题](references/discussions/2026-10-07-changes-review-follow-up.md)：保留的未实施方向，不是已批准计划。
- [工具协作早期目标](references/discussions/archived/2026-10-06-tool-harness-goals.md)、[临时目录与 JSON 恢复早期讨论](references/discussions/archived/2026-10-12-ai-temporary-files-and-tool-call-recovery.md)：实现前讨论快照，已归档供追溯。
- [诊断资料说明](references/diagnostics/README.md)、[变更审阅截图](references/changes-review/)：历史采样，以采集时记录为准。

[ChatGPT 平台接入计划](plans/archived/2026-10-11-chatgpt-web-platform.md) 的实现与登录保持验收已完成，用户确认后归档。[ChatGPT 采集与回传误暂停修复](plans/archived/2026-10-12-chatgpt-collection-composer-pause.md) 已通过新版三轮官网自动闭环验收并归档。[ChatGPT 已有会话采集与回传修复](plans/archived/2026-10-12-chatgpt-existing-conversation-collection.md) 已通过原故障会话的自动闭环验收，并经用户确认归档；未知旧现场继续留存于活动审计，不阻止本次已确认范围收尾。

结束后的实施和审核记录按日期保留，方便核验当时的测试、用户反馈与决策；不批量删除归档、发布记录或原始实验证据。

P2/P3 旧审计已核对：旧分隔条和旧四策略方案退出，按明确关闭原因归档，未补称旧版人工验收通过。
