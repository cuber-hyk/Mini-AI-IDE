---
artifact_type: plan
status: archived
created: 2026-10-05
updated: 2026-10-05
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 应用内更新图标与浮层

## Goal And Scope

以编辑器顶部更新图标和暗色浮层替换更新原生对话框，启动发现版本仅点亮提示，用户查看说明并明确下载和重启安装。关闭浮层不中断下载，普通退出不安装，未保存保护与安装器成功启动后退出保持不变。

不改安装向导、更新源、Portable支持范围、版本号或发布产物；不提交、合并或push。既有发布验证计划的未提交证据保留在本分支。

## Assumptions And Decisions

- 用户已确认图标加浮层方案、工具栏右侧入口、启动不弹窗。样式复用DESIGN.md、ui.css和design-tokens.json；窄编辑区内自适应。
- 主进程UpdateService是唯一更新状态源，编辑器仅通过四个无参数IPC查询/检查/下载/安装，事件同步状态并支持帮助菜单打开同一浮层。
- 每次状态变更递增revision，避免初始查询的旧快照覆盖事件状态；远程发布说明始终以textContent显示，摘要截取普通文本，全文折叠可展开。
- 帮助菜单更新入口与图标汇聚到同一浮层。已有原生更新对话框被移除，不保留两套确认流程。
- 从已发布0.1.1提交创建codex/update-popover，当前master尚无本任务依赖的更新代码；不自动合并之前分支。
- ADR gate: not needed，更新网络和安装边界不变，仅增加编辑器受限操作IPC。Design system impact: 更新通知和浮层交互规则。

## Code Placement

dev-split: no split。既有状态机和更新后端保持责任；Do not add to: src/main/index.ts 的浮层逻辑、下载逻辑、状态机；入口只接线。

| Owner | Responsibility | Verification |
|---|---|---|
| src/shared/applicationUpdate.ts | 两进程更新状态数据契约 | 类型检查、快照顺序测试 |
| src/main/updateService.ts、appUpdater.ts | 显式用户动作、状态和网络副作用 | 状态机业务测试 |
| src/main/applicationUpdateIpc.ts | 编辑器主frame来源及无参数守卫 | 非编辑器/子frame/参数注入被拒绝 |
| src/renderer/applicationUpdate.js、applicationUpdate.css | 更新图标、浮层、键盘焦点、说明和进度 | 渲染业务测试、真实Electron截图和几何 |
| contract.ts、preload.ts、index.ts、selfTest.ts | 窄桥与入口接线 | 类型、启动自检 |

## Steps And Verification

| ID | Status | Work | Verification |
|---|---|---|---|
| UI-1 | done | 定位现有确认、状态和工具栏，确认边界并创建分支 | 未提交发布证据可归属；用户设计方向明确 |
| UI-2 | done | 改更新状态为显式动作，添加受限IPC与事件 | 显式动作、互斥、失败重试、未保存与销毁测试通过；IPC拒绝非编辑器主frame及额外参数 |
| UI-3 | done | 实现图标、浮层、摘要/全文和状态按钮 | 10项渲染行为测试通过；首次查询失败可重试读取，旧快照被忽略；摘要160字/前三非空行，全文自身滚动 |
| UI-4 | done | 构建与真实本地视图验收 | 全量344测试、0跳过；typecheck/build通过；隔离实际应用160项启动自检通过；真实Electron本地视图四状态截图与360px几何通过 |
| UI-5 | done | 更新设计/能力/变更记录、独立只读评审 | 设计/README/能力/ADR/路由/Unreleased已更新；review mode=subagent，无剩余阻塞；原11项文档历史错误不在任务范围，本次无新增 |

## Verification Evidence

- 分支codex/update-popover；未提交、未合并、未push、未修改版本号或发布产物。
- pnpm test：344/344，30 suites，0 skipped；pnpm run typecheck和build通过，裸标识符未绑定0。scope扫描新增浮层owner；81条其它语义诊断仅报告，其中新增文件7条为DOM元素与Window挂载的静态类型推断问题，未作为运行时正确性证据。
- 初次启动自检L1d失败：旧静态按钮检查器未加载浮层owner；添加owner与按钮映射后，隔离userData的实际应用启动自检160/160 PASS，无失败。未使用真实用户设置或AI会话。
- 真实Electron使用实际preload、applicationUpdateIpc、UpdateService与本地页面/CSS，backend为固定测试数据：检查只发现版本不自动打开面板/下载；点击下载后46%进度截图；关闭继续下载、下载完成不安装；安装前取消返回ready，install和quit调用均0；操作前聚焦主按钮，忙碌更新不自动关闭面板；Escape恢复btn-update。
- 360px编辑视口：浮层左右10/350px，底部574.09px<650px，主按钮左右244/331px，入口左右320/350px。全说明在220px说明区域内滚动；无渲染错误。
- 独立评审UPDATE-UI-001已verified：摘要CSS四行裁剪可能导致150字单行中文无展开入口而内容丢失；已移除默认摘要CSS裁剪，仍用前三非空行/160字摘要规则；360px真实页面验证长度150、scrollHeight<=clientHeight=true、expandHidden=true。最终plan compliance/related changes/verification/Design/Changelog均pass，audit coverage为not applicable；Check仅无新增，不代表整库通过。
- 四状态截图与结果位于忽略目录release-before-update/update-ui-qa/，初始状态/网络/安装模拟不替代真实安装升级。上一轮公开更新网络与下载已验证，实际安装和数据保留仍由原发布计划跟踪。

## Acceptance And Closeout

启动发现更新只显示蓝色提示；点击可查看与下载，下载完成由按钮重启安装；最新版本与不支持模式可解释，错误可重试。主进程防并发、保留未保存保护；网页不获桥接口和更新权限。

完成所有步骤并记录证据后归档到docs/plans/archived/，不以UI模拟替代真实安装验收。旧发布任务仍保留active直到用户验证安装与数据保留。
