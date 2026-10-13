---
artifact_type: plan
status: archived
created: 2026-10-13
updated: 2026-10-13
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 更新窗口只滚动说明正文

## Goal And Scope

消除更新面板外层滚动条，标题、关闭、展开/收起、下载进度与底部操作始终可见，长说明在内部滚动。用户截图明确要求外层不滚动。沿用现有窗口尺寸、控件、token 与状态；不改下载、安装、IPC 或发布，不沿用前次发布授权自动提交。

## Decisions

- 根因：update-panel 整体 overflow-y:auto，同时展开说明固定 max-height:220px；窗口内容总高度超过可用空间会出现双层滚动。
- 由 applicationUpdate.css 单一布局 owner 用 flex 列分配剩余高度，说明容器允许收缩、正文内部滚动；必要时只为小高度收紧间距。
- dev-split: no split，局部 CSS 布局调整；ADR gate: not needed，窗口和权限边界不变。Design gate 复用原共用按钮、主题与细滚动条。
- 分支 codex/update-panel-scroll，基线 master 37fdd47；主目录无关文件保留。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| US-1 | done | 复现双层滚动及遮挡按钮 | 原生离线 460x540 展开出现外层溢出；460x360 展开与下载时底部操作超出视口 |
| US-2 | done | 调整纵向布局与正文滚动 | 原生 460x540 收起/展开/下载、460x360 展开/下载共五种布局全部通过：外层与文档无溢出，关闭/操作/展开控件可见，长说明内部可滚动；360 高下载状态保留 26px 说明正文 |
| US-3 | done | 验证并整理当前文档 | 既有更新 UI 测试 10 通过、0 失败/跳过；任务树和主目录 TypeScript 构建通过、scope 未绑定 0（115 既有信息诊断）；文档及差异检查通过；手工评审通过 |

## Closeout

源码、DESIGN、能力与 CHANGELOG 已同步主目录并构建，用户可正常重开主目录开发 IDE 查看。主目录原四个目标文件逐项核对 37fdd47 后才复制；无关性能审计与临时目录忽略文件保持原样。任务分支改动保留未提交，不改已发布的 v0.3.0 资产。

原生探针使用系统 TEMP 独立 userData 和模拟更新状态，拒绝 HTTP，不执行检查、下载或安装。修复前后的布局测量分别见系统 TEMP 的 mini-update-layout-before/report.json 和 mini-update-layout-after/report.json。截图捕获返回 UnknownVizError，未伪称已完成截图视觉核验；真实面板视觉仍可由用户在开发版复验。测试日志 mini-update-layout-tests.log，构建日志 mini-update-layout-build.log、mini-update-layout-primary-build.log。

Review mode=manual：仅局部 CSS，未改 DOM、状态、权限及下载/安装逻辑；复用原按钮与 token，正文收缩同时保留操作控件，展开样式不再有固定高度。Design/changelog/distill/check 已执行。本计划归档保留验证证据；无新提交、合并、推送或发布授权。
