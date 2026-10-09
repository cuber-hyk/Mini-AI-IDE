---
artifact_type: audit
status: archived
created: 2026-10-09
updated: 2026-10-09
scope: "DeepSeek 深度思考模式下自动采集与手动采集后的结果发送暂停"
source_of_truth: code
---

# 深度思考回复状态识别排查

## Scope

检查深度思考开启后无法自动采集、手动采集执行工具后仍暂停发送的共同状态门槛，并记录修复、离线验证与用户官网复测结果。

## Fact Sources

- Code: `src/main/tools/replyObservation.ts`、`autoCollector.ts`、`integration.ts`、`resultReturn.ts`。
- Tests: `test/deepseekReplyState.test.ts`、`test/fixtures/deepseek-reply-controls.json`、`test/fixtures/deepseek-thinking-reply-structure.json`。
- Docs: `docs/capabilities/tool-harness.md`、`human-machine-boundary.md`。
- Runtime checks: 用户已复现深度思考开启后的两种症状，并更新 `docs/诊断json.md` 提供回复区诊断。现场 `candidateCount: 2`，`frameCandidateIndexes: [0, 1]`；两个顶层候选的 class 分别为 `ds-markdown` 和 `ds-markdown ds-assistant-message-main-content`。

## Findings

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| DT-001 | P1 | resolved | 完成判据将深度思考区和正式答案区的两个 markdown 候选误判为不明确的回复框，阻断自动采集及手动采集后的自动发送 | 现场 frameCandidateIndexes 为 [0, 1]；修复前 replyObservation 要求所有 markdown 候选数恰为 1；发送前 verify 要求 complete | docs/plans/archived/2026-10-09-deep-thinking-reply-state.md | codex/fix-deep-thinking-reply-state | 现场结构回归修复前 unknown、修复后 complete；相关 106 项测试通过；构建通过；用户于 2026-10-09 确认复测通过并批准提交合并发布 | fixed：正式答案分支仅统计正式答案候选；保留生成、中断及控件核验 |

状态识别选文档序最后一个顶层 markdown 候选。修复前 DeepSeek 主回复分支要求该回复 frame 内只有一个 markdown 候选，因而误计思考区。完成判断还要求复制、可用重新生成、朗读和已知发送图标同时存在。

现场同一 frame 有两个独立 markdown 候选，最新候选明确为正式答案。复制、可用重新生成、朗读和唯一已知发送箭头均存在；generatingNodes 为空。修复前数量检查在验证这些完成控件之前直接返回 unknown，根因已定位。

修复使用明确的正式答案节点判断是否混入多条回复，避免把思考区计为第二条回复；保留真实生成/中断检查、未知结构暂停与完成控件核验。REPLY_NODES、正文选择与历史基线未修改；发送前完整快照和采集摘要共用修复后的完成识别器。

新增现场结构夹具和三项行为回归，并扩展缺少重新生成控件及未知输入图标的用例到深度思考场景。

## ADR Gate

- Needed: no。
- Reason: 局部完成状态缺陷修复，未改变架构、权限、发送运输或历史加载策略。

## Verification

- Commands run: 现场结构最小 DOM 回放；`pnpm exec tsx --test test/deepseekReplyState.test.ts` 验证修复前新增完成用例失败；相关采集/继续/回传九个测试文件验证 106 项通过、0 失败、0 跳过；`pnpm run build` 验证编译和作用域检查通过。
- 修复后回归覆盖普通与深度思考完成、生成、中断、重新生成控件缺失/禁用/隐藏、未知输入图标、同框多条正式答案；已有历史与续写测试保持通过。
- 官网验收：用户于 2026-10-09 回复“通过，可以提交合并，然后发布最新版本”，确认修复通过。
- Not verified: 未提供的生成过程 DOM 及其他平台结构变更。
- 文档校验与最终差异审查记录在关联计划中。

## Git Visibility

审计文件创建后以 git status 核对可见性。

## Closeout

代码修复、离线回归及用户官网复测通过，DT-001 关闭，审计归档。用户已批准提交、合并及版本发布。
