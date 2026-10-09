---
artifact_type: adr
status: accepted
created: 2026-10-09
updated: 2026-10-09
owner: 胡运宽
source_of_truth: [src/main/tools/harness.ts, src/main/tools/autoContinuation.ts, src/main/tools/resultReturn.ts, src/main/tools/integration.ts, src/main/tools/replyChangeWatcher.ts, src/main/tools/resultClipboard.ts, test/toolHarness.test.ts, test/autoContinuation.test.ts, test/toolResultReturn.test.ts, test/toolAttachmentIntegration.test.ts, test/replyChangeWatcher.test.ts, docs/adr/2026-10-07-automatic-result-return-boundary.md]
---

# ADR：解析层格式错误自动回传

## Context

自动继续原先把 `state.batchError`（工具 JSON 解析失败、整批未执行）与执行层的 `permission_denied`、`cancelled`、`unknown`、`stopped` 一起放入 `blocked()`，一律暂停等人工。

但两者性质不同：`batchError` 是解析层事实——模型输出的 JSON 无法解析，IDE 根本没有可信请求、也没有执行任何工具，不涉及权限或安全边界。把它也暂停，用户需手动复制回执再发送，增加往返成本。用户明确要求：格式错误应自动回传，让 AI 自我修正；权限只应限制命令执行，不应限制格式错误。

## Decision

1. `AutoContinuation.blocked()` 只拦执行层结果（`permission_denied` / `cancelled` / `unknown` / `run_command` 的 `stopped`），不再包含 `batchError`。
2. Harness 为本次解析失败保存独立诊断来源：递增 ID、项目、会话、采集原文和真实解析错误；重复采集同一当前原文保持 ID，取消保持失效状态。诊断元数据仅在主进程流转，不生成工具执行 completion，不预约执行账本，不进入共享状态或复制正文。
3. `ToolResultReturn` 统一管理真实批次与解析诊断的一次发送资格。诊断只走自动入口，必须属于当前项目/会话、未取消、没有 completion 和工具结果；不读取或上传附件。正文使用 `formatToolResults(state.results, state.batchError)`，与「复制本批结果」按钮字节一致，保留真实诊断的行列、片段及修复说明。
4. `AutoContinuation` 按真实诊断 ID 去重；每次诊断通过计时结束复核、进入发送时连续计数加一。前 5 次可发送，第 6 次改为 `paused`，文案「连续 5 次格式错误，已停止自动发送，等待你处理」。重复广播不增加计数或解除暂停，取消倒计时不占额度，发送失败或未知暂停且不重试。
5. 计数仅在成功发送一次非 batchError 的正常工具结果或实际 scope（项目/会话）变化时归零。批次变化、用户新轮、关闭再开启、正常结果倒计时及发送失败均不清零。只读 watcher 在主 frame 的会话导航事件同步通知 scope，关闭 automatic 期间也观察切换，保持关闭状态；快速往返无中间结果广播也归零，同会话 query/hash 变化不归零。
6. integration 发送前复核最新官网回复已完成且会话相符；解析诊断还须与保存的采集原文及真实解析错误匹配。真实批次仍核验批次匹配与完整执行事实。唯一网页写运输仍为 `WebComposerSender`，执行层暂停规则不变。

## Alternatives Considered

- 保持 batchError 一律暂停：安全但增加往返；用户明确要求改为自动发送。
- 发送精简诊断（仅摘要 + SyntaxError 行）：正文更短，但与「复制本批结果」不一致，且丢失出错片段，AI 定位更难；采用与按钮同源的完整回执。
- 无连续上限，永远自动发送：可能形成坏 JSON 死循环、刷满对话；采用连续 5 次上限打断。
- 连 unknown / permission_denied 也自动发送：运输不确定可能重复提交、权限拒绝涉及安全边界；仍保持暂停。

## Consequences

- 模型偶发 JSON 语法错误时无需人工介入，AI 可在下一轮自我修正。
- 最多连续自动回传 5 次坏 JSON 的诊断，第 6 次暂停；切换项目/会话或正常结果成功发送后计数清零。
- `batchError` 回传沿用唯一网页写运输 owner 与来源复核，不新增网络、工具权限或网页动作边界。

## Verification Boundary

`test/toolHarness.test.ts` 验证诊断来源、去重和取消；`test/autoContinuation.test.ts` 验证计数、真实 scope、历史与失败不重试；`test/toolResultReturn.test.ts` 验证诊断资格、空附件及执行层隔离；`test/toolAttachmentIntegration.test.ts` 经真实接线验证无 selection/completion 的诊断自动发送、复制字节一致、连续上限、额度恢复与发送期间取消。真实官网尚未验收，本地测试不能等同官网可用。执行层暂停与网页边界见 `2026-10-07-automatic-result-return-boundary.md` 与 `docs/capabilities/human-machine-boundary.md`。
