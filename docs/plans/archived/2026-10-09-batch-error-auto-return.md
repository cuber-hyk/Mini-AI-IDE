---
artifact_type: plan
status: archived
created: 2026-10-09
updated: 2026-10-09
owner: 胡运宽
---

# 计划：解析层 batchError 自动回传

## 目标

把工具 JSON 解析失败（`state.batchError`）改为自动回传，发送内容与「复制本批结果」按钮字节一致。执行层的权限拒绝、取消/中断、状态未知、命令被停止仍保持暂停。最多连续自动回传 5 次，第 6 次停止，等待人工。

## 非目标

- 不放开发送 permission_denied / cancelled / unknown / stopped。
- 不改 `formatToolResults` 输出格式。
- 不新增 UI 状态枚举（复用现有 `paused`）。

## 决策（用户已确认）

- 发送正文：原样使用 `formatToolResults`，与「复制本批结果」字节一致，含出错片段与修复指令。
- 连续上限：前 5 次诊断可自动回传，第 6 次暂停。重复广播不计数。
- 重置：发送成功一次正常工具结果，或切换项目/会话。
- 暂停文案：「连续 5 次格式错误，已停止自动发送，等待你处理」。

## 步骤

1. done：用 integration 测试复现无 selection/completion 的坏 JSON 无法回传；修复前失败、修复后通过。
2. done：Harness 为解析诊断保存主进程内的 ID、项目、会话及原文；去重重复采集。Harness 回归验证来源与取消，复制正文和共享协议未变化。
3. done：resultReturn 接纳真实批次/解析诊断两类来源；integration 统一正文比较，复核官网回复完成且原文匹配。integration 回归验证复制字节一致、空附件、取消和一次发送。
4. done：AutoContinuation 消费真实诊断 ID；批次取消不重置计数，正常结果成功发送或实际 scope 变化才清零。单测及 integration 验证前五次发送、第六次暂停、去重及执行层守卫；补齐开启/关闭期间快速会话往返、无中间广播和同会话 query/hash 回归。
5. done：同步既有 ADR、能力文档、AGENTS、context-map 和 CHANGELOG；类型检查及全量测试通过，独立代码评审通过，归档计划。

## 验证

- `pnpm run typecheck`：通过。
- `pnpm test`：741 项通过、0 失败、0 跳过。
- 独立评审 mode=subagent：实现及回归符合计划、仅任务相关变更、验证证据通过、无剩余代码阻断；导航往返清零与关闭态保持问题均验证关闭。
- `git diff --check`：通过。
- Dev Flow 文档校验：本任务文件无错误或警告；仓库整体仍有既有错误 `docs/plans/2026-10-09-file-tree-icons.md` 缺 `created`（已核对 HEAD 同样缺失），以及既有 DESIGN 源路径、图标计划决策警告。范围外保留，不代表仓库整体文档检查通过。
- Design system gate：无 UI 组件、样式或设计规则变更。
- 真实官网验收不在本地夹具验证范围；未连接官网发送消息。

## 代码归属（dev-split）

分类：no split。诊断来源归 `harness.ts`；一次发送资格归 `resultReturn.ts`；计时与连续计数归 `autoContinuation.ts`；`replyChangeWatcher.ts` 在导航事件同步通知真实会话切换；`integration.ts` 仅接线和网页只读复核。不新增通用模块，不修改网页运输 owner，不改变 ToolState 或格式化协议。新增回归放在对应 owner 测试及现有 integration 夹具。
