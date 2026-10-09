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

# 更新面板遮挡修复：独立本地窗口

## Goal

按用户确认，将更新内容从侧栏浮层移到居中独立本地窗口，解决网页视图遮挡与窄侧栏裁切。

## Scope

- In scope: 更新窗口 owner、专用 preload、主 frame IPC 权限、图标/窗口渲染与生命周期、既有用例适配和当前行为文档。
- Out of scope: 更新服务的网络与安装协议、官网、生产用户数据；发布过程见归档的 v0.2.4 重发计划。

## Plan Readiness

- Goal clear: 用户明确同意独立居中弹窗并要求开始。
- Scope clear: 替换侧栏浮层实现；唯一 UpdateService、下载安装流程保留。
- Source of truth known: ApplicationUpdateWindow、applicationUpdateIpc、updatePreload、applicationUpdate/updateDialog renderer。
- Critical decisions confirmed: 460px 独立非模态窗口，复用、关闭不取消下载；专用权限窄桥。
- Validation path known: 构建、语法、diff、调用与生命周期人工审查；未要求新增或运行测试。

## Assumptions And Decisions

- 原因：本地 DOM z-index 不能覆盖更上层的原生官网视图，侧栏限宽仍影响内容阅读。
- dev-split: focused owner；窗口生命周期归 ApplicationUpdateWindow，不将新窗口逻辑堆入 index.ts，主界面与窗口各有渲染入口。
- 单一实现：移除主页面更新面板、侧栏限宽变量与旧浮层关闭路径；专用更新 renderer 承载原状态与操作逻辑。
- 主界面只查询、打开；更新窗口只查询、检查、下载、安装、关闭；各自仅可信主 frame，参数数量严格为零。
- 窗口关闭仅隐藏，主窗口真正关闭才销毁；安装确认期间临时隐藏，结束后恢复。
- ADR gate: needed；用户确认的独立窗口与新的更新 UI 权限分工记录为 accepted ADR。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| UP-1 | done | 独立窗口与窄 IPC | 编译通过；主 frame、参数和唯一窗口/服务人工审查 |
| UP-2 | done | 分离主界面和窗口渲染，移除旧浮层 | 旧面板 DOM 和旧通知路径检索；保留纯文本说明、revision 与显式操作 |
| UP-3 | done | 同步设计、能力、ADR、变更与既有用例 | 语法与 diff；既有用例按新分工适配，未新增或执行测试 |

## Acceptance Criteria

- 更新窗口在原生官网上方独立显示，不依赖侧栏宽度；显示器边界钳制。
- 关闭后下载继续，重新打开保留状态；失焦不关闭，关闭/Escape 回到编辑器。
- 安装仍经过真实未保存文件确认；窗口不提供文件、工具、官网或任意 URL 能力。

## Artifact Routing

DESIGN、application-update 能力、AGENTS、accepted ADR、CHANGELOG 0.2.4；计划归档。

## Git Visibility

codex/fix-update-panel-clipping 分支；用户诊断文件不纳入修改。

## Closeout

实现与构建完成，计划归档。用户明确批准后，修复以 aaec41bd1f240dbd858b2f65f442e98355b2131d 提交合并并纳入重新发布的 0.2.4；发布证据见 2026-10-09-v0.2.4-republish.md。未新增或运行测试，未在真实 Electron 窗口执行运行验收；文档校验既有品牌字体/文件树元数据错误保留。

## 评审记录

- Mode: subagent；独立只读评审窗口生命周期、IPC 权限与安装确认；主代理复核全部结论。
- Plan compliance / Related changes only: pass；替换用户批准的更新 UI 展示方式，不改变 updater 业务。
- Design system / Changelog / Distill: pass；独立窗口与当前权限分工写入设计、能力和 ADR，旧浮层推荐已移除。
- Verification evidence: pass（构建、语法、diff）；真实多显示器、父窗口关闭、下载恢复与安装确认需运行验收。
- Check gate: 全库既有元数据错误不宣称通过；本次新增文档元数据有效。

独立评审仅发现错误提示引用旧 --warn 变量（新窗口未加载旧 style.css）；已改为共用 --ui-warning 并由主代理核对主题定义。未发现阻断问题。最终构建、脚本语法与差异检查通过；既有 TypeScript 用例仅检查语法，未执行测试。
