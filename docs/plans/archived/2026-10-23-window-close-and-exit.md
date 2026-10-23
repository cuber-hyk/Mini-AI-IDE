---
artifact_type: plan
status: archived
created: 2026-10-23
updated: 2026-10-23
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 窗口关闭设置与完整退出

## Goal / Scope

增加直接退出／缩小至托盘设置，修复关闭后的资源残留，并验证退出后可立即重启。不改变官网、工具权限、更新安装授权和文件保存规则，不发布版本。

## Assumptions And Decisions

- 用户同意保留三个已有未跟踪文件原样，在独立分支执行；后续明确要求默认缩小至托盘，已保存的直接退出选择不覆盖。
- 设置复用原生设置菜单；托盘恢复原窗口，后台任务继续；显式退出始终执行完整退出。
- 未保存确认取消时完整保留工作状态；清理失败保留可操作窗口，允许重试。
- 事实源：index.ts、settings.ts、tools/integration.ts、EditorSession、SharedSessionInstance、app-shell 能力与 DESIGN.md。
- dev-split：defer 对 index.ts 的整体拆分；本次新增 applicationLifecycle.ts 持有关闭／托盘／退出状态，index.ts 仅接线。Do not add to: src/main/index.ts（复杂生命周期逻辑）。未来生命周期继续扩展时重新评估；不以行数为目标。
- design_system_impact: none；复用原生菜单、单选项和系统托盘，不引入页面或样式。
- ADR gate: not needed；局部可逆偏好，不改变既有安全边界。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 核对关闭与视图释放路径 | 确认当前无托盘，BaseWindow 子视图未完整释放；工具退出测试仅覆盖模拟 app |
| PLAN-2 | done | 生命周期协调与设置持久化 | 生命周期6项及最终全量1265项通过，0失败、0跳过 |
| PLAN-3 | done | 接线菜单、托盘资源和完整释放 | 构建通过；真实应用4场景19检查通过；启动10场景76检查通过 |
| PLAN-4 | done | 更新当前能力、变更记录并评审 | 当前能力/路由/变更记录已更新，文档校验通过；独立只读评审通过；用户已明确批准提交合并，不推送 |

## Acceptance Criteria / Closeout

默认缩小至托盘；显式关闭选择重启后保留，隐藏不销毁工作状态，二次启动恢复窗口；显式退出处理未保存文件并等待真实工具清理；取消和失败不产生不可操作残留；全部自有视图关闭，应用进程退出并可重新启动。原生夹具隔离资料目录，不连接官网。验证完成后计划归档到 docs/plans/archived/，能力更新 app-shell.md，面向用户记录 CHANGELOG.md。

## Verification / Review

- 最终 `pnpm test`：1265通过、0失败、0跳过；`pnpm run build` 通过（含类型与渲染作用域检查）。
- `node tools/verify-application-lifecycle.cjs`：4场景19检查通过，报告 `C:/WINDOWS/TEMP/mini-lifecycle-report-21108.json`。同一资料目录真实退出／重启，真实后台PowerShell在隐藏时继续、退出后消失；故障注入真实preview关闭5秒超时，保留编辑器，调整窗口并重试退出，最终全部WebContents已销毁。
- `node tools/verify-startup-sequence.cjs`：10场景76检查通过，报告 `C:/WINDOWS/TEMP/mini-editor-startup-verify.json`。
- 原生迭代暴露并修复了close异步、提前显示、迟到布局、已销毁View属性访问和重复工具清理的问题。工具入口夹具须等待离线网页实际加载，避免把初始化导航取消误当成进程清理失败。
- 独立评审 mode=subagent；plan compliance/related changes only/verification/changelog 均pass，audit coverage不适用，无剩余代码阻断。设计沿用原生菜单与托盘，无新增设计系统规则；局部偏好与生命周期修复无需ADR。
- 能力、上下文路由与CHANGELOG同步；文档校验与diff空白检查通过；三个已有无关文件保留原样。
- 验证使用隔离资料的开发构建；没有打包安装或发布，不代表用户安装版现场根因已完全复现。计划归档保留故障与收敛证据。
- 用户后续指定默认缩小至托盘：缺省、旧配置缺项和非法值统一采用托盘，明确保存的quit保留；相关17项测试、构建、文档校验与原生4场景19检查再次通过（报告 `C:/WINDOWS/TEMP/mini-lifecycle-report-34204.json`），增量人工评审通过。
- 收尾：README补充托盘恢复与完全退出说明，更新能力明确隐藏主窗口不取消下载。用户明确批准提交合并；master在既有独立工作区检出，使用该工作区快进合并，不改动其他未跟踪文件、不推送远端。
