---
artifact_type: design_system
status: current
updated: 2026-10-04
token_source: design-tokens.json
---

# Mini-AI-IDE UI 约定

## Authority And Scope

本文件记录用户已批准的三列概念图和输入区交互方向。基础数值是本次实现的暂定值，随运行效果交由用户审阅；未确认的新场景不在此定义。

## Layout Patterns

- 编辑器（内部含文件树）、AI 网页、变更列表从左到右排列，网页保持独立渲染进程；本地样式只作用于本地视图。
- 复制上下文归编辑器，采集归网页顶栏，应用与撤销归变更列。图标操作必须提供名称和提示。
- 变更按目录与文件组织，同文件多片段可展开。筛选只影响显示，选中片段在编辑器里预览；写盘须明确操作。
- 列独立收起，恢复入口常驻；分隔条支持拖动。输入区保留简洁/完整切换及复制状态反馈。
- 暗色、中性底色，主操作使用强调色；增加/删除统计同时用数字和颜色表达。

## Foundations

本地视图使用 `design-tokens.json` 的中性背景、文本、边框与强调色；有适用 token 时直接引用。

## Component Rules

共用按钮使用 `src/renderer/ui.css`，主操作加 `.primary`，图标操作加 `.ui-icon`。菜单复用既有复制链路，列表复用既有预览与应用链路。

## Sources

精确基础值只维护在 `design-tokens.json`，`scripts/copy-static.mjs` 生成 `dist/renderer/ui-tokens.css`。共享按钮使用 `src/renderer/ui.css` 的 `.ui-button`、`.primary`、`.ui-icon`；页面负责局部排列。

布局以 `src/main/windowLayout.ts` 为准；复制菜单由 `src/renderer/editorToolbar.js` 管理；变更数据树由 `src/renderer/changeTree.js` 管理，界面由 `src/renderer/preview.js` 管理；输入区交互由 `src/renderer/promptComposer.js` 管理。交互验收见对应 `test/` 测试与 `src/main/layoutProbe.ts` 的 Electron UI 探针。

## Provisional Rules

三列默认宽度、窗口最小宽度、控件尺寸与色值沿用当前实现，待用户实际使用后确认；不据此扩展未出现的页面。

## Known Gaps

触屏、浅色主题和独立移动端未设计。
