---
artifact_type: plan
status: archived
created: 2026-10-12
updated: 2026-10-12
owner: Codex
plan_readiness: ready
---

# docs 生命周期与资料整理

## Goal

纠正文档位置和生命周期，清理确实重复的旧副本，保留未关闭问题与历史证据；当前功能实现与未提交差异不被覆盖。

## Scope

- 仅 docs：状态与元数据、已结束审计归档、误归档记录恢复活动、讨论/诊断资料归类、引用和导航。
- 清理活动目录中的旧 timeout 审计副本；完整已归档版本保留原发现及验证结果。
- ChatGPT 登录保持验收、JSON 现场截断归因、首批回传诊断及历史未闭合审计继续保留，不借整理宣称问题解决。
- 无 src/test/tools 改动，无软件重启、源码重构、Git 提交/合并/推送或分支删除。

## Confirmed Route

用户明确授权整理、归档与清理 docs。沿用当前独立任务分支 codex/ai-temp-json-recovery，保留其未提交实现；按 dev-distill / dev-check 执行。不改产品决定。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| DOC-1 | done | 读取文件状态、生命周期、引用和重复记录 | 已识别六项校验错误、三项警告及错放资料，区分历史证据与当前能力 |
| DOC-2 | done | 元数据补齐、结束记录归档、未关闭记录恢复活动、重复清理 | 背景/历史重放审计已归档；三份含未闭合事项的旧审计恢复 active；清除旧 timeout 副本及 P2-7 被后续 verified 记录替代的重复条目 |
| DOC-3 | done | 讨论和原始诊断归类，更新引用及导航 | 四份讨论归入 references/discussions；两份原始诊断归入 references/diagnostics；三份原始实验数据随对应审计归档；五份原始数据的 SHA256 均保持不变 |
| DOC-4 | done | 正式文档校验、引用检查、差异复核并归档本计划 | validate-docs：No issues found；24 个本地 Markdown 链接及 282 个具体文档/数据引用无缺失；git diff --check 通过 |

## Artifact Routing

当前能力仍在 capabilities，稳定边界在 accepted ADR；讨论保留为 reference，原始快照放 references/diagnostics。过程证据保留在 plans/audits 对应生命周期目录。用户导航为 docs/README.md，不将讨论或归档记录接入默认上下文。

## Closeout

- 初始正式文档检查的六项错误、三项警告已消除：补齐历史计划元数据和 ADR 门禁说明，归类讨论资料，纠正误归档审计；没有以关闭未解决发现的方式消除校验错误。
- 活动目录保留一个 ChatGPT 登录保持验收计划和五份尚有证据缺口的审计；历史审计的状态不被解释为当前版本存在同一故障。
- 新增 docs/README.md 用户导航和原始诊断说明，修复因历史归档及本次移动产生的引用；原始诊断是控制台文本，按 txt 保留而非伪装为可解析 JSON。
- 本轮仅调整 docs。此前 AI 临时目录/JSON 恢复的源代码、测试、工具和 CHANGELOG 未被本轮修改。未提交、未合并、未推送，未清理任务分支。
- 目录与生命周期整理是可逆资料维护，不产生新的架构或产品决定，不新增 ADR 或用户功能变更日志。本计划保留验证证据并归档。
