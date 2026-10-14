---
artifact_type: plan
status: archived
created: 2026-10-14
updated: 2026-10-14
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 手动工具 JSON 单次提交

## Goal

粘贴完整工具请求后只点击一次“执行”；工具层统一完成校验、权限和执行，错误与成功都提供同源可复制回执。

## Scope

- 替换手动入口的预览、令牌与二次确认流程，保留一个 executeToolJson 原始文本提交接口。
- 移除预览区域和接口，同步真实工具层的手动诊断归属、复制和测试。
- 保留当前分支及此前授权未提交改动，不提交、合并、push或清理其他文件。
- 不改工具协议、权限设置、去重范围、官网采集或发送运输；手动来源仍只复制，不能获得官网回传资格。

## Assumptions And Decisions

- 用户已确认手动入口只是补上采集；具体实现由代理决定。
- 后台继续使用正式协议和同一 harness；原始 JSON 仅包裹正式围栏，不修补语法或命令。
- 格式错误进入 manual 批次诊断，包含 batch_error、空 tool_results，不猜测批次或请求 ID。
- 手动操作回执按当前自动复制设置处理，手动复制始终保留；不改变其他网页来源的复制/运输资格。
- 忙、无项目、存储故障、上下文失效等入口拒绝不覆盖正在执行的批次；原始输入保留供再次提交。
- 纯输入展示只使用文本；点击后不自动重试，结果与原始请求绑定，不随输入后续编辑改变。

## Code Placement Constraints

- dev-split: no split；现有 owner 已清晰，不引入通用辅助模块。
- ManualToolJson 拥有手动原文入口，harness 继续拥有协议结果与权限执行；integration 仅接线。
- ResultClipboard 拥有按设置复制的完成/手动诊断事件；UI 不读写剪贴板、不写官网。
- ToolResultReturn/AutoContinuation 必须明确拒绝 manual 诊断，防止错误回执获得官网来源资格。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 确认原预览/令牌路径与用户认可范围 | 当前校验错误仅本地提示、不能复制；用户确认单次提交及原工具层 |
| PLAN-2 | done | 替换后端与IPC，统一手动校验回执及复制 | 单元/集成验证错误零执行、权限与去重、来源、复制设置、上下文/忙守卫 |
| PLAN-3 | done | 简化面板为执行和关闭，保留忙与原文 | UI测试和离线真实布局夹具，XSS纯文本与防重复提交 |
| PLAN-4 | done | 构建、回归与文档收口、独立评审 | 针对测试、必要全量测试、原生离线夹具、validate-docs、diff与评审；计划归档 |

## Acceptance Criteria

- 无预览、二次确认、短期令牌或残留旧预览接口，只有一个明确手动执行入口。
- 原工具层处理结果与错误，复制格式与正常工具结果一致；格式错误可复制且未执行工具。
- 保留权限、存储预约及去重、busy与上下文守卫；等待与后台命令不提前复制，不自动重试。
- 手动执行/诊断/恢复均不进入自动发送或附件上传；其后新官网批次仍正常处理。
- 开关关闭不自动复制；打开时每次当前有效手动回执仅复制一次，历史与状态查询不重放。

## Artifact Routing

- DESIGN.md、docs/capabilities/tool-harness.md、CHANGELOG.md 与已有手动 JSON ADR同步当前单次入口。
- 测试以既有 ManualToolJson、harness、复制/运输和UI owner为主，tools/verify-tool-panel.cjs验证布局。
- ADR gate: 更新原手动JSON来源隔离决策，不另建重复ADR；context-map移除预览令牌旧描述。

## Git Visibility

- 创建后验证 Git 可见，不修改 ignore 规则。

## Closeout

- 实现与回归通过，用户已验收并授权提交合并；计划归档保留验证证据。

## Verification Evidence

- 最终 pnpm test：1087 项通过，0 失败、0 跳过；后端六个关联测试文件110项通过，前端单入口10项通过。
- pnpm run build通过；renderer scope未绑定标识符0处，116条已有非阻断语义诊断。
- 最终离线原生工具面板夹具235/235通过，覆盖240/320/460/620/900宽度、嵌入输入框的执行图标、标题关闭、长错误和缩放、原文单次提交及拒绝保留输入；未请求网络。
- 独立只读subagent评审通过，聚焦关联77项、导航修复后59项通过，无剩余发现。评审发现的同平台主frame导航A→B→A审批守卫已修复并验证，子frame和已完成工具行为保持。
- DESIGN、CHANGELOG、能力文档、原ADR与AGENTS复制边界同步；没有新增架构或稳定术语。dev-check与diff检查通过。
- 不访问真实官网、不执行截图中的用户命令。用户已验收并授权提交合并；参考HTML与本地运行目录保留，不纳入本次提交。