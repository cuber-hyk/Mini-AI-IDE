---
artifact_type: plan
status: archived
created: 2026-10-13
updated: 2026-10-14
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 顶部文件标签栏滚动条优化

## Goal And Scope

消除右侧文件工作区顶部标签栏多余的灰色滚动条，保持单行标签、稳定高度和暗色外观，同时保留横向滚动、键盘导航、活动标签定位、关闭标签和右侧布局按钮。

范围：标签栏样式、布局和必要的滚动行为及测试。非目标：修改 Monaco、文件保存、工具执行、官网视图、主进程几何或增加常驻左右箭头。

## Assumptions And Decisions

- 已确认单行标签、隐藏原生滚动条、保留横向滚动的 UI 方向。
- style.css 的 .editor-tabs 使用 overflow-x:auto 和 5px WebKit 横向滚动条；竖向灰条根因尚待运行时测量，实施前必须分别确认。
- workspaceNavigation.css 同时设置标签栏高度、flex 和 toolbar 覆盖规则，需检查最终计算样式。
- editorTabs.js 已支持滚轮横向移动、Ctrl 保留、方向键、Home/End、Delete 与活动标签 scrollIntoView；优先复用。
- 最大化、收起和目录树恢复按钮应保持固定；文件、工具与本批改动标签继续共享标签栏。
- dev-split: no split。仅局部调整现有文件，不新建通用模块、不进行无关重构；如果新增行为超出局部边界则停止重新评估。
- design_system_impact: update。实施验收后同步 DESIGN.md 关于标签栏细滚动滑块的旧规则；沿用设计 token。
- ADR gate: not needed，无架构、权限、数据和状态 owner 变更。
- 技能引用的专用计划模板不存在；本计划 frontmatter 使用仓库现有计划格式。

## Fact Sources

AGENTS.md、CONTEXT.md、docs/ai/context-map.md、docs/capabilities/app-shell.md、DESIGN.md、src/renderer/index.html、src/renderer/style.css、src/renderer/workspaceNavigation.css、src/renderer/ui.css、src/renderer/editorTabs.js、test/editorTabs.test.ts、package.json。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| TS-1 | done | 运行时测量标签栏及祖先尺寸、计算样式、横纵溢出，确认两条灰条来源 | 记录 scrollWidth/clientWidth、scrollHeight/clientHeight、overflow-x/y，包含普通宽度和窄文件区 |
| TS-2 | done | 局部调整相关 CSS，固定单行布局、隐藏多余滚动条、保留横向滚动 | 无灰条或标签裁切，关闭按钮和右侧布局控件仍完整可用 |
| TS-3 | done | 仅在证明必要时调整 editorTabs.js 的滚动与活动标签定位 | 滚轮、触控板、Ctrl、键盘和自动定位正常，不引起外层容器滚动 |
| TS-4 | done | 为标签滚动边界、导航和关闭行为补充回归测试 | npm test；标签焦点、草稿和语义不退化 |
| TS-5 | done | 类型检查、构建和运行时布局验收，更新经确认的设计与变更文档 | npm run typecheck、npm run build、npm test；普通/窄文件区、缩放、工具及改动标签验证并记录结果 |

## Acceptance Criteria

- 顶部标签栏不再出现截图中的两个多余灰色滚动条；竖向灰条真实来源有测量证据。
- 标签始终单行，内容超宽时仍可通过滚轮、触控板、键盘访问全部标签。
- 活动标签自动进入视口，不引发祖先容器意外滚动。
- 文件、工具、改动切换、关闭、未保存状态、焦点和草稿保持原行为。
- 右侧固定布局按钮在窄窗口和缩放时可操作，标签内容无裁切。
- 构建、类型检查和相关测试通过；未完成的 GUI 验收如实注明。

## Artifact Routing And Closeout

Plan: docs/plans/archived/2026-10-13-editor-tabs-scrollbar.md。
Source audit: none；covered_findings/deferred_findings: none。
Tests: test/editorTabs.test.ts，必要时现有布局测试。
Design: 通过验收后更新 DESIGN.md；能力文档仅同步实际变化，context-map 仅在入口改变时调整。
CHANGELOG: 完成后记录可见界面变化。
Distill/check: 实施后执行文档及生命周期检查；无需新增 ADR。
下一步进入 /dev-branch，未经用户明确批准不得提交、合并、推送或发布。

## Verification Status

2026-10-14 收尾：src/renderer/style.css 隐藏标签栏横纵原生滚动条，保留 overflow-x:auto；复用 editorTabs.js 的现有滚轮、键盘与活动标签定位实现，未修改该文件。src/main/workspaceProbe.ts 增加真实 Electron DOM 普通宽度及 150px 窄宽度测量、无滚动条与横向访问断言，并更新原有滚轮和标签可见性检查。普通宽度测得 clientWidth=433、scrollWidth=433、clientHeight=35、scrollHeight=35；窄宽度测得 clientWidth=150、scrollWidth=167、clientHeight=35、scrollHeight=35，overflow-x=auto、overflow-y=hidden、scrollbar-width=none。npm run typecheck、npm run build（通过 verify:workspace）、npm run verify:workspace 通过；npm test 共 1064 项通过、0 失败；Electron 布局探针各场景通过。DESIGN.md 与 CHANGELOG.md 已同步。TS-3 经检查无需代码调整；TS-4 使用既有单元测试及新增真实 Electron 回归断言，未单独新增单元测试。限制：修复前纵向灰条的独立运行时起因没有完整基线测量，证据主要是原 CSS 和修复后的实测，不将其记作已确定根因。无 ADR 需求，不涉及持久化及权限。此计划归档仅代表实施与验证阶段结束，不代表 Git 已提交或合并。
