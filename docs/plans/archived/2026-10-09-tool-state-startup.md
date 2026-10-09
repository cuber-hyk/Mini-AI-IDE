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

# 工具状态读取失败时保留应用启动

## Goal

工具状态文件损坏、格式不兼容或无法读取时，应用仍能打开，明确显示原因并停止全部工具执行和自动继续，保留原始权限与去重记录。

## Scope

- In scope: ToolStore 加载错误状态、工具 integration 启动接线、harness 入口保护、现有工具栏错误反馈和禁用状态。
- Out of scope: 数据重置或迁移、未知工具记录容错、手动修复入口、UI 布局改版、提交和发布。

## Plan Readiness

- Goal clear: 用户已确认修复此前讨论的启动降级方案。
- Scope clear: 工具系统失败与整个应用退出解耦，不放宽权限或协议校验。
- Source of truth known: store.ts、harness.ts、integration.ts、toolProtocol.ts、toolHarness.js 及直接调用和现有测试。
- Critical decisions confirmed: 保留原文件、禁用工具并显示原因；正常编辑和官网访问继续可用。
- Validation path known: 构建、类型检查、差异及所有工具入口人工审查；本轮未明确要求测试，不新增或运行测试。

## Assumptions And Decisions

- 本机现有数据可通过 v0.2.3 校验；本次修复覆盖其他不兼容或损坏数据造成的启动退出。
- ToolStore.ready 保持拒绝语义，所有写入仍受该门槛保护，不以空账本替代异常数据。
- UI 仅增加错误提示与控件禁用；截图布局建议独立讨论。
- dev-split: no split；现有模块职责明确，新增状态由 store 拥有，执行保护由 harness 拥有，integration 仅处理启动接线，renderer 消费状态；不增加新模块或修改主窗口流程。
- ADR gate: not needed；沿用现有权限和去重的保守停止边界，不增加数据恢复策略。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 确认工具记录校验失败经 integration 传播至 bootstrap 导致 app.exit(2) | 已读取 v0.2.2/current 源码；此前只读校验确认 2 条 attach_file 记录导致旧版校验失败 |
| PLAN-2 | done | 将加载错误公开为稳定工具状态，保留 ready 的失败语义并阻止采集与自动继续 | 人工检查加载、预约、配置、规则清理及解析错误回传入口；所有存储写操作仍等待拒绝的 ready，采集在解析前停止，automatic 对外为 false |
| PLAN-3 | done | 显示持久错误并禁用工具设置，更新能力和变更记录 | pnpm run build 通过（含 TypeScript 编译、renderer 未绑定标识符 0）；node --check 通过；git diff --check 通过；人工差异审查完成 |

## Acceptance Criteria

- integration 不再因工具记录读取失败而拒绝应用启动。
- 异常期间无工具执行、权限变更、记录写入、自动采集或工具结果回传。
- 工具状态错误不被项目切换、取消或普通反馈覆盖；现有结果区显示错误原因并展开。
- 正常记录的加载、执行和去重路径保持原行为。
- 不读取或改写本机生产数据进行实现验证。

## Artifact Routing

- Capability updates: docs/capabilities/tool-harness.md。
- Changelog: Unreleased / Fixed。
- Tests: 本轮不新增或运行；真实坏数据启动验收仍需在隔离用户数据环境完成。

## Git Visibility

计划在 codex/fix-tool-state-startup 分支随修复审查；用户 docs/诊断json.md 保留且不纳入提交。

## Closeout

实现和构建完成，计划归档。未新增或运行测试，未进行真实坏数据启动验收；未修改生产用户数据。提交、合并和发布等待用户验收，版本号尚未调整。

## 评审记录

- Mode: manual；变更在现有 owner 内增加加载状态和入口保护，无新增模块。
- Plan compliance: pass；实现范围限于启动错误降级，不改变有效数据校验、保存、授权与执行规则。
- Related changes only: pass；store、harness、integration、共享状态、本地工具状态显示及相应文档。
- Verification evidence: pass（构建和静态检查）；未运行自动测试或真实坏数据启动，不宣称已通过运行时验收。
- Design system: pass（人工）；复用现有 is-error、状态区和原生 disabled，不增加布局或视觉规则。
- Changelog / Distill: pass；Unreleased / Fixed 和能力文档记录当前推荐行为，无需 ADR 或 DESIGN 更新。
- Check gate: 全库既有 file-tree-icons 计划缺 created 及 DESIGN 路径警告保留，最终校验结果以命令输出为准。
- Review checks: 持久错误优先于普通反馈；切换/取消不清除错误；解析错误不会获得回传资格；自动监听和继续以停用状态初始化；所有持久化操作仍受 ready 拒绝保护。

## 提交授权

2026-10-09 用户确认“可以了，提交合并”，批准本轮修复和 UI 调整提交并合并到 master；既有文档校验问题和未运行测试的限制已披露。该授权不包含推送或发布。
