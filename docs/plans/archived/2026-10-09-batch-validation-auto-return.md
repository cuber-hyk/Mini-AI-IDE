---
artifact_type: plan
status: archived
created: 2026-10-09
updated: 2026-10-09
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 执行前整批校验错误自动回传

## Goal

自动继续开启时，将截图中同文件重复修改等执行前整批校验失败的真实回执发送给 AI 修正，保留整批不执行规则。

## Scope

- In scope: harness 的当前内存完成事件标记、共享资格谓词、自动继续与结果发送、行为文档。
- Out of scope: 改变工具执行和权限规则、自动复制策略、历史重放、UI 改动、推送和发布。

## Plan Readiness

- Goal clear: 用户明确要求此类错误自动回传。
- Scope clear: 仅 prepare 全批校验失败且没有执行的当前批次。
- Source of truth known: harness、toolProtocol、autoContinuation、resultReturn；integration 沿用当前正式批次复核。
- Critical decisions confirmed: 错误仍显示完整请求回执；与解析错误共享连续 5 次上限。
- Validation path known: 构建、类型、资格/取消/计数路径审查；未新增或运行测试。

## Assumptions And Decisions

- 代码已确认 prepare 的失败回执没有 started_at，现有自动继续和结果发送均因此拒绝发送。
- 只由 harness 成功保存全部失败回执后标记 validation_failed；不从报错文字或 failed 状态猜测。
- 标记只属于当前内存完成事件，不写执行账本；重复采集和历史恢复不会生成新发送机会。
- 资格需整批均 failed、无执行时间、无取消/未知，保留项目/会话/批次匹配、一次发送与官网最新正式批次复核。
- 与解析诊断共用错误计数；校验错误发送成功不清零，正常执行结果成功或真正切换项目/会话后清零。
- dev-split: 无新 owner；小范围扩展现有 harness 完成事实和现有回传 owner，确定性资格归共享协议谓词。
- 原工作区更新面板 UI 的暂存/未提交改动保持原样；使用独立管理工作树和 codex/fix-batch-validation-return 分支。
- ADR gate: needed；在已有校验错误回传 ADR 内更新明确授权的范围。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| BVR-1 | done | 确认 prepare 失败与两个资格入口 | 失败回执无 started_at，两个入口均要求实际执行 |
| BVR-2 | done | 标记校验失败，接入统一发送与错误计数 | 编译通过；真实来源/历史/取消/未知路径审查 |
| BVR-3 | done | 同步规则、能力、ADR 和评审 | 差异通过；仅既有文档问题，独立只读评审无源码阻断；未运行测试 |

## Acceptance Criteria

- 当前整批校验失败回执按既有间隔自动发送一次，正文与复制字节一致，不执行工具或上传附件。
- 校验错误与解析错误合计最多连续自动回传 5 次；第 6 次暂停，校验失败不重置额度。
- 权限拒绝、用户取消、未知、未启动的普通请求失败和历史仍不能自动回传。

## Artifact Routing

CHANGELOG、AGENTS、tool-harness 与 human-machine-boundary 能力、已有批次错误回传 ADR；完成后归档计划。

## Closeout

实现与知识 distill 完成，计划归档。用户已明确批准本次提交并合并到 master，未授权推送或发布。独立工作树 codex/fix-batch-validation-return；原工作区的更新面板 UI 改动由其原任务持有。

- pnpm run build 通过：严格 TypeScript 编译、187 个静态文件复制、渲染作用域未绑定标识符 0 处；95 条其他既有语义诊断非失败项。
- git diff --check 通过。文档校验只报告既有品牌字体/文件树计划缺 created、DESIGN 路径等问题，本次文档无新增元数据错误；不宣称全库文档门通过。
- Independent review mode: subagent；源码、直接调用链与权限、取消、历史、去重、额度、附件路径只读审查。Plan compliance、related changes only、verification evidence 为 pass；UI/design gate 不适用，无 UI 修改；changelog/distill 完成。
- BVR-R1（P3）：本次插入重复 Fixed 分类标题；已由主代理核对并删除多余标题，保留原 UI 条目。
- 未新增或执行测试，未启动 Electron 或连接真实官网验证。本次新行为不能用构建或静态审查替代运行验收。
- Distill 核对：当前行为已写入 tool-harness、human-machine-boundary 能力及原批次校验回传 ADR；AGENTS 与 context-map 指向当前规则和资格 owner。无新增稳定术语或 UI 规则，不修改 CONTEXT/DESIGN。
