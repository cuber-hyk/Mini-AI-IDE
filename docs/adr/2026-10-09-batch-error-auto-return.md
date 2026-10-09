---
artifact_type: adr
status: accepted
created: 2026-10-09
updated: 2026-10-09
owner: 胡运宽
source_of_truth: [src/shared/toolProtocol.ts, src/main/tools/harness.ts, src/main/tools/autoContinuation.ts, src/main/tools/resultReturn.ts, src/main/tools/integration.ts, src/main/tools/replyChangeWatcher.ts, src/main/tools/resultClipboard.ts, test/toolHarness.test.ts, test/autoContinuation.test.ts, test/toolResultReturn.test.ts, test/toolAttachmentIntegration.test.ts, test/replyChangeWatcher.test.ts, docs/adr/2026-10-07-automatic-result-return-boundary.md]
---

# ADR：批次校验错误自动回传

## Context

工具 JSON 解析失败和执行前整批校验失败都需要 AI 修正。用户明确要求开启自动继续时发送真实错误回执，避免每次手动复制。截图中同文件重复 apply_changes 被 prepare 拒绝，整批均未执行；失败回执没有 started_at，因此原资格检查不发送。

## Decision

1. 解析错误由 Harness 保存独立诊断 ID、项目、会话、采集原文与真实错误；重复原文不生成新 ID，取消后失效。不预约执行账本，不生成工具完成事件。ToolResultReturn 要求当前来源匹配、无 completion 和工具结果、官网原文及解析错误一致。
2. 执行前 prepare 全批校验失败仍逐项保存真实 failed 回执。全部保存成功后由 Harness 标记当前 selection.validationFailed，再将 validation_failed:true 放入唯一内存 completion；不持久化该标记，不允许历史恢复获得自动发送资格。
3. isBatchValidationFailure 要求当前 completion 为明确标记的 error、未取消、非 busy、无 batchError，且非空整批结果均属于该批、failed、包含真实错误、没有 started_at/finished_at/data。ToolResultReturn 同时核对当前项目/会话/selection、完整请求数量与官网最新正式批次。不能从错误文案或普通 failed 状态推断资格。
4. 两类校验错误的自动回传都不读取或上传附件，正文使用 formatToolResults，与手动复制字节一致。解析错误保留 batch_error；prepare 错误保留完整 tool_results。执行权限、整批拒绝与去重规则不变，不自动复制全部未执行的回执。
5. AutoContinuation 按诊断 ID 或当前 completion ID 去重，两类错误共享连续 5 次额度，进入发送时计数加一。第 6 次暂停，提示“连续 5 次批次校验失败，已停止自动发送，等待你处理”。取消倒计时不占额度；发送失败或未知暂停且不重试。
6. 计数仅在正常实际执行结果成功发送或实际项目/会话 scope 变化时归零。校验回传成功、新批次、用户新轮、关闭再开启、正常结果倒计时及发送失败均不清零。导航通知沿用只读 watcher；同会话 query/hash 变化不清零。
7. permission_denied、cancelled、unknown、停止进程、存储故障、无实际执行的普通请求失败仍不能自动发送。唯一网页写运输仍为 WebComposerSender，空输入框、生成结束、当前会话及一次发送边界不变。

## Alternatives Considered

- 所有 failed 均发送：无法区分权限、未知及普通未启动失败，采用 Harness 明确事实标记。
- 将整批校验错误压成一个解析诊断：丢失已知请求 ID 与现有完整复制回执，保留逐请求真实错误。
- 无连续上限：可能反复产生相同错误；解析与 prepare 错误共用既有额度。

## Consequences

- AI 可以收到执行前整批校验错误并生成修正后的新批次，用户无需每次复制发送。
- 同文件修改必须合并等校验仍严格整批不执行；历史和同 ID 已处理批次不会自动重放。
- 内存完成元数据扩大了当前错误回传资格，没有扩大工具权限或附件/网页写入能力。

## Verification Boundary

现有验证入口为 test/toolHarness.test.ts、test/autoContinuation.test.ts、test/toolResultReturn.test.ts 和 test/toolAttachmentIntegration.test.ts。本次执行前整批校验扩展仅进行构建、类型和调用路径审查，未新增或运行测试，未进行真实官网发送验收；独立评审证据记录在任务计划。不得将既有测试覆盖声明等同本次新规则已运行验证。
