---
artifact_type: plan
status: archived
created: 2026-10-11
updated: 2026-10-11
owner: Codex
---

# 手动中断撤回本批自动回传

## 目标与边界

用户已确认：手动中断任一当前命令后立即阻止本批自动回传，重新开启 automatic 不补发；保留已执行及中断命令的真实结果与复制。保留其他命令、后续无依赖请求、系统超时回传和现有自动复制设置。Git 提交与合并按用户显式授权执行，不推送。

## 事实与实现路线

- `integration.ts` 的 stopToolCommand 是用户中断入口，先核验项目/会话/批次/请求/进程身份。
- Harness 持有本批独立的 userInterrupted 标记，不混用整批取消，不改变执行结果或磁盘账本。
- AutoContinuation 在标记出现时取消待发送并暂停；ToolResultReturn 在自动发送前及异步运输资格检查时复核标记。
- isCompletedStoppedCommand 继续表示真实执行终态，供复制及非人工停止结果使用。
- 复用现有 owner，只有少量状态接线，无新模块、UI 布局或网页运输改动。

## 步骤与验证

1. done — 真实中断回归在修复前失败：预期 paused，实际 waiting_reply；已确认问题。
2. done — 独立批次标记与自动发送门禁已实现；87 项相关测试通过，覆盖立即暂停、停止失败、前后台命令、切换开关、复制和下一新批次。
3. done — 能力、仓库规则、现有 ADR 与 changelog 已同步；全量测试 802 通过、0 失败、0 跳过，类型检查和构建通过。独立只读评审未发现阻断问题。文档检查仍有 5 个历史归档错误，经修复前 HEAD 快照确认相同，本次无新增错误；不扩大范围修复。

## 风险与验收

不能用 completion.cancelled 屏蔽回传，否则会误取消后续工具及自动复制。标记在身份核验后、停止进程异步操作前发布，停止失败也不得恢复本批回传。新批次不继承标记，AI 的 stop_process 不冒充用户操作。真实官网未连接，由本地完整接线及真实 shell 进程测试验证。

## 产物与收尾

更新现有能力文档、自动回传 ADR、AGENTS、CHANGELOG 和测试；本次决策可局部撤回，复用已有 ADR，无新增 ADR/owner，context-map 无新入口需要路由。本计划已归档；两份未跟踪 timeout 与 JSON 截断审计保持原样，不纳入本次提交。用户已授权将 codex/20261011-manual-interrupt-return 的修复提交并合并至 master；不推送、不删除分支。
