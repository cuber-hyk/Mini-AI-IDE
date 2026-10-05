---
artifact_type: design_system
status: current
updated: 2026-10-05
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

- 文件树顶部放新建文件、新建文件夹和刷新图标；条目右键提供新建、改名和移入回收站，F2 改名；树和侧栏空白处右键提供根目录新建文件／文件夹和刷新，操作不继承此前条目选择。键盘打开菜单时，操作作用于当前聚焦条目。
- 编辑器顶部标签按打开顺序排列，切换保留每个文件的草稿、Monaco 撤销栈与视图位置；标签显示未保存点和具名关闭按钮，方向键／Home／End 切换，Delete 关闭。标签较多时横向滚动，不挤压编辑器宽度；使用透明轨道、细灰色滑块、无箭头的滚动条，悬停或聚焦增强显示，滚轮横向滚动且保留 Ctrl 缩放，切换活动标签自动滚入视口。
- 变更列表仅将明确目标计入文件数；有修改线索但信息缺失或冲突时显示阻塞原因；没有明确修改线索的围栏统一收进默认折叠的“其他内容（只读）”，展开查看全文，无应用入口且不参与全部应用。替换显示 IDE 实际匹配的原／新范围，多对显示位置列表；新建显示完整行数，覆盖全文明确显示操作和同名按钮。删除显示删除区域，协议标记不计入新增行数。
- 复制选区及全文用只读上下文头，保留当前 Monaco 草稿与原文空白；提示词面板展示三操作协议，自定义提示词提醒核对格式。人工修改目标路径后需先完成该目标预览再应用。
- 筛选框保留，顶部仅显示简短数量统计；采集说明和调试信息默认折叠在“诊断信息”入口，条目错误放详情，应用、撤销和采集失败提供简短可见反馈。
- AI 新增文件显示具名只读预览标签，全部内容以绿色增加行呈现，主按钮为“创建文件”；预览不写盘，退出或切换释放虚拟标签。创建成功转换为真实可编辑标签并刷新树，撤销关闭该标签且保留其他文件。
- 名称在树内输入：Enter 确认、Esc 取消；非法名称或重名保留输入并显示原因。文件创建后打开，文件夹创建后展开。
- 未打开文件时，编辑区域展示打开目录、新建文件及最近目录入口；最近目录与文件菜单使用同一份记录。
- 关闭未保存标签、切换／关闭目录或退出统一使用原生“保存／放弃／取消”确认；保存失败保留缓冲。删除经确认移入回收站，失败不转为永久删除。改名保留草稿并更新保存路径。

## Sources

精确基础值只维护在 `design-tokens.json`，`scripts/copy-static.mjs` 生成 `dist/renderer/ui-tokens.css`。共享按钮使用 `src/renderer/ui.css` 的 `.ui-button`、`.primary`、`.ui-icon`；页面负责局部排列。

布局以 `src/main/windowLayout.ts` 为准；复制菜单由 `src/renderer/editorToolbar.js` 管理；变更数据树由 `src/renderer/changeTree.js` 管理，界面由 `src/renderer/preview.js` 管理；输入区交互由 `src/renderer/promptComposer.js` 管理。交互验收见对应 `test/` 测试与 `src/main/layoutProbe.ts` 的 Electron UI 探针。

文件树、树内输入、右键菜单及空白编辑区域由 `src/renderer/fileExplorer.js` 管理；编辑缓冲及独立模型由 `src/renderer/editorWorkspace.js` 管理，标签呈现由 `src/renderer/editorTabs.js` 管理，原生确认由 `src/main/editorSession.ts` 与 `src/main/workspaceController.ts` 管理。验收入口为 `src/main/workspaceProbe.ts`（`pnpm run verify:workspace`）。

## Provisional Rules

三列默认宽度、窗口最小宽度、控件尺寸与色值沿用当前实现，待用户实际使用后确认；不据此扩展未出现的页面。

## Known Gaps

触屏、浅色主题和独立移动端未设计。
