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

# DeepSeek 首次加载恢复与顶栏错误去重

## Goal

本次启动首次 DeepSeek 首页遇到连接关闭时自动恢复一次；最终失败仅显示一处警告和手动重载入口，不刷新正常会话。

## Scope

- 启动加载、平台生命周期、顶栏提示及相应测试和当前文档。
- 当前任务分支已有用户授权的 UI 改动全部保留，不提交/合并/push、不清理未跟踪文件。
- 不改 UA、登录分区、凭据、代理/TLS、官网 DOM 或工具执行与发送授权，不发 Node AI HTTP。

## Assumptions And Decisions

- 用户已明确选择：首次打开 DeepSeek 遇到 ERR_CONNECTION_CLOSED 时约 1 秒后自动重新加载一次。
- 只针对首个官方首页主 frame、-100 与 ERR_CONNECTION_CLOSED 同时匹配；不自动处理证书、取消、未知错误、ChatGPT 或后续导航。
- 恢复复用同一网页视图和现有重载准备/门禁，成功/换平台/新导航/关闭取消待恢复；不刷新正常页面。
- 当前截图与代码可证明缺少首次恢复及重复提示，不能证明关闭连接的具体网络根因；既有日志未找到该现场的失败记录。
- 顶栏右侧 collect-status 为平台错误唯一可见提示，左侧工具摘要不重复；恢复后回到真实工具状态。
- ADR gate: not needed；增加用户已确认、可撤销的窄启动恢复，不改变网页权限或运输边界；同步当前能力文档。

## Code Placement Constraints

- dev-split: no split。webPlatformController 仍单独拥有导航、错误、计时和原生重载；不新建通用重试层。
- index 仅调用启动入口；webbar 只呈现权威状态。原生与内存测试不接触用户官网会话。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 查明启动流程及重复提示来源，确认恢复决策 | 当前单次loadURL；webbar两处重复同一平台原因；用户明确答复采用一次恢复 |
| PLAN-2 | done | 增加仅首次连接关闭的一次恢复，守护异步和取消 | 四组相关测试57/57、0跳过；首次原生恢复11/11，真实-100约1001ms后重载一次，二次失败不第三次请求；准备期同文档与同URL导航回归通过 |
| PLAN-3 | done | 平台错误只显示一处且窄列仍可见 | 顶栏UI22/22（包含于57项），原生平台24/24，加载反馈16/16；恢复中单处提示、420px错误可见、恢复后真实工具摘要 |
| PLAN-4 | done | 构建、同步当前说明并独立复审 | pnpm build通过，三组原生夹具合计51/51；DESIGN/能力/CHANGELOG已同步，validate-docs及diff检查通过；独立subagent复审pass、无阻断 |

## Acceptance Criteria

- 每次启动最多一次自动恢复，初次连接失败到成功无需用户再次点击。
- 恢复仍失败时保留真实错误与手动重载，不无限重试、不报告假成功。
- 平台切换、导航、退出与工具/发送忙状态阻止迟到恢复；正常已加载页面不自动重载。
- 权限、UA、分区、官网写入与回传能力保持不变；顶栏错误只有一份。

## Artifact Routing

- Capability: docs/capabilities/web-platforms.md。
- UI design: DESIGN.md；主题与原控件复用。
- CHANGELOG.md: Unreleased Fixed。
- Tests: webPlatformController、webPlatformUi与原生离线平台/加载夹具。
- Context-map无需变更，生命周期owner不变。

## Git Visibility

- 计划创建后验证 Git 可见，不改 ignore 规则。

## Closeout

- 实现与离线验证已完成，归档保留证据；用户已授权本轮提交合并。实际连接关闭根因和现场成功率仍需用户实际启动反馈。
- 最初原生探针错误使用协议注册，未接管主导航并误触官网（隔离新profile，未使用用户登录）；已更正为原生HTTPS拦截和失效本机代理，最终51项仅采用完整重跑的离线报告。
- 隐藏顶栏可选截图捕获不可用，已撤下非验收截图代码并完整重跑24项平台检查；不将截图作为验证证据。
- 构建检查未绑定标识符0处，另有116条非阻断语义诊断，本任务不声称整个仓库诊断清零。
