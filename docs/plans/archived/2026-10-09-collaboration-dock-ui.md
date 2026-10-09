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

# 协作区布局与主动发送优化

## Goal

按用户确认效果图实现紧凑协作区、右下角箭头发送、权限图标和分组设置浮层；默认 Enter 发送，保护输入法和技能选择。

## Scope

- In scope: 本地需求、工具结果及设置布局、主动发送行为、相关说明与已有验证用例适配。
- Out of scope: 官网运输、权限语义、启动修复回退、提交或发布。

## Plan Readiness

- Goal clear: 用户确认效果图和最终去掉菱形及键盘说明的调整。
- Source of truth known: index.html、localPrompt、promptComposer、toolHarness、toolPanelLayout、LocalPromptController、SettingsStore 与共享契约。
- Critical decisions confirmed: Enter 发送、Shift+Enter 换行，输入法及技能确认不发送；仅保留初始化选项；移除复制提示词及需求更多菜单；权限用手掌/盾牌；设置自动保存。
- Validation path known: 构建、语法、差异、文档与静态视觉检查；未要求新增或运行测试。

## Assumptions And Decisions

- 不要的图标指截图额外菱形，权限手掌和盾牌保留。
- 沿用 neutral dark 和现有 token；窄列工具栏允许换行，发送操作靠右。
- 官网为上层原生视图，浮层限定本地 dock；现有布局 owner 根据浮层测量临时预留 dockHeight，需求区贴底，关闭后恢复官网高度，不增原生视图。
- dev-split: no split；输入事件属于 localPrompt，浮层与高度属于 toolPanelLayout，权限显示属于 toolHarness；保持 IPC 名和官网唯一运输稳定。
- 移除 sendOnEnter 字段与判断，规范化仅读取初始化选择，无双轨行为。
- ADR gate: needed；记录用户确认的默认主动发送行为。
- 保留当前分支已完成启动修复；原始诊断文件不改动。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| UI-1 | done | 移除回车开关并简化主动发送契约 | 人工审查输入法、菜单、附件等待、取消和主进程发送门槛；发送入口及运输 owner 保持唯一 |
| UI-2 | done | 实现发送按钮、权限图标、空态收缩和设置分组 | 通过仅含真实 HTML/CSS 的本地预览审查 960px 与 420px 列宽和设置浮层；真实 Electron 原生视图叠放尚未运行验收 |
| UI-3 | done | 更新设计、能力、ADR、变更记录并评审 | 构建通过，renderer 未绑定标识符 0；既有验证用例适配但未新增或执行测试；最终语法、diff 与文档校验结果见输出 |

## Acceptance Criteria

- 无回车开关、菱形或常驻键盘说明；发送按钮有可访问名称及加载/禁用状态。
- 设置使用规整齿轮；移除复制提示词及其专属菜单、接口和忙状态，工具结果复制保留。
- 用户输入经现有 LocalPromptController/WebComposerSender 唯一链路发送。
- 空结果不固定占 160px；真实结果仍可调高、滚动和展开。
- 设置限制视口和高度，Escape、外点及失焦关闭，展开不撑开输入区。
- 工具结果更多菜单只在撤销项存在或正在撤销时显示；无菜单项则隐藏并关闭。

## Artifact Routing

DESIGN.md、能力文档、ADR、AGENTS.md 当前行为、CHANGELOG.md；计划完成后归档。

## Git Visibility

当前 codex/fix-tool-state-startup 分支可见；用户诊断文件不纳入提交。

## Closeout

实现与静态视觉审查完成，计划归档；不自动提交、合并或推送。当前代码仍是开发构建 0.2.3，未准备 0.2.4 产物。生产用户数据未修改；临时静态预览不进入版本产物。

## 评审记录

用户确认的追加调整：检查齿轮、复制 DOM 与直接调用 → 移除复制提示词、专属菜单和接口 → 适配既有验证脚本与文档。验证采用构建、语法、残留引用与差异检查；未要求新增或执行测试，真实 Electron 交互仍待验收。

追加调整已实现：构建通过，renderer 未绑定标识符 0，相关 JavaScript 语法和差异检查通过；实现代码、既有验证脚本无旧复制入口或需求更多菜单引用。文档校验仍受既有 file-tree-icons 计划缺 created 及 DESIGN 路径警告影响；未提交或发布。

- Mode: manual；逐入口、调用和差异审查。
- Plan compliance: pass；实现用户确认的需求，保持官网唯一写入、权限与初始化独立。
- Related changes only: pass；本地输入、工具布局、设置状态及直接相关文档/既有用例；原启动修复保留。
- Design system / Changelog / Distill: pass；已有主题控件复用，警示色集中为 token，DESIGN 和能力说明记录当前行为；默认主动发送已有用户批准的 ADR。
- Verification evidence: pass（构建与静态预览）；未执行自动测试，不宣称真实官网发送、中文输入法或原生 Electron 浮层运行验收通过。
- Check gate: 仓库已有 file-tree-icons 计划缺 created、DESIGN 路径警告仍保留，无本次新增元数据错误。
- Known limitation: 官网是上层原生视图，浮层需通过现有 dockHeight 临时预留区域；关闭恢复官网高度，文件编辑区域不变。需要用户在正常 Electron 启动时确认遮挡和高度恢复。

## 提交授权

2026-10-09 用户确认“可以了，提交合并”，批准本轮修复和 UI 调整提交并合并到 master；既有文档校验问题和未运行测试的限制已披露。该授权不包含推送或发布。
