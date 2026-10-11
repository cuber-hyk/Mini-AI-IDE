---
artifact_type: plan
status: archived
created: 2026-10-11
updated: 2026-10-11
owner: Codex
---

# 附件预览底栏优化

## 已确认目标

用户确认所有附件控件固定到底部，缩放固定右下角。底栏在正文滚动区域之外：左侧只读标识和 PDF 翻页/页码，右侧缩小、百分比下拉、放大与更多；比例菜单包含适应宽度、适应窗口及常用比例，移除独立 100% 按钮。系统应用打开归更多菜单；Word 近似排版说明改提示图标，错误仍显示具体原因。

## 范围与事实

继续使用尚未提交的 codex/file-attachment-preview 分支，已有附件实现属于同一任务。原两份审计报告保留不动。只改 filePreview.js/css、对应行为测试与离线原生验收，以及 DESIGN、能力文档、CHANGELOG。主进程读取、权限、官网运输与原有文字编辑保持原 owner；不新增分页引擎、Word 大纲、拖拽平移或外部网络。

dev-orient 已核对 editorWorkspace 接口、已有文件菜单、共用 ui-button/ui-icon 和 DESIGN。dev-split: no split；呈现继续归现有 filePreview owner，入口不积累 UI。百分比用原生 select，更多用原生 details/summary，复用主题与焦点约定，避免另建通用菜单模块。图片默认适应窗口，PDF/Word 默认适应宽度；窗口模式按图片/页面尺寸计算，Word 采用首个渲染页尺寸，不能据此声明真实 Word 页数。

## 步骤与验证

1. [done] 检查当前分支、预览调用方、UI 契约和现有回归入口。
2. [done] 实现紧凑单行底栏及菜单；13 项渲染行为测试通过，涵盖适应模式、固定比例、合并重绘、错误打开、更多关闭与焦点、文档切换后状态。ResizeObserver 合并到下一动画帧重绘，消除原生布局循环警告。聚焦比例菜单时保留选项，失焦恢复实际百分比；PDF 重绘保持比例菜单可用，保证连续键盘选择。
3. [done] 原生 Electron 离线验收 39 项通过，HTTP 请求与渲染错误均为 0。图片/PDF/Word 底栏、380/240px 单行、更多菜单及比例焦点通过；Word 宽/380/240px 捕获白纸、正文和嵌图像素，宽及 240px 截图人工复核通过。截图位于 C:/WINDOWS/TEMP/mini-file-preview-probe-802NQV/。离线隐藏窗口用合成 change、键盘和 focus 事件验证处理，不声称完成操作系统级输入测试。
4. [done] typecheck、build 通过，完整测试 838/838、无跳过，git diff --check 通过。DESIGN、能力文档、CHANGELOG 已同步；独立只读评审指出的比例选项重置和 PDF 重绘焦点问题已修复，13 项渲染行为测试通过。文档校验仍为原有 5 个历史归档错误及 3 个警告，本次文档无新增诊断。实现已归档，未提交。

## 验收与收尾

缩放控件始终在右下角；底栏不遮正文、不换成多行。窄列仍可通过百分比菜单缩放；错误不隐藏系统打开能力。PDF 翻页正常；异步取消、文件切换与只读边界回归通过。菜单可键盘使用，Escape/外部点击关闭更多，切文档不残留打开菜单。静态资源不联网。design_system_impact: update，记录已确认底栏规则；ADR gate: 沿用现有本地沙箱与 owner，无新增架构决策。提交合并仍等待用户显式批准，绝不 push。

Design system gate: update/check 通过，沿用共用按钮、主题及焦点规则，底栏局部紧凑尺寸与窄列规则已写 DESIGN。Changelog gate: 已合并到本次未发布附件功能条目。Distill gate: 当前行为归能力文档，可执行交互约束归测试；不新增术语或 ADR。Check gate: 本次差异通过，完整文档校验保留历史失败事实。

Independent review gate: review_file_preview 只读评审通过，无未解决阻断项；独立复跑 13 项渲染测试，并复核最终窄列截图与完整验证证据。
