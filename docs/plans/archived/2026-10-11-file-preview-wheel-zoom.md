---
artifact_type: plan
status: archived
created: 2026-10-11
updated: 2026-10-11
owner: Codex
---

# 附件预览 Ctrl＋滚轮缩放

目标：图片、PDF、Word 预览正文内 Ctrl＋向上滚轮放大、向下缩小，同步底栏比例，复用原有 10%–400% 手动缩放入口。

事实：filePreview 当前仅按钮与比例菜单驱动缩放；Word 为无脚本、无同源 sandbox iframe，其内部 wheel 不向父文档冒泡。Electron 44.5.1 原生 zoom-changed 通知滚轮缩放方向，ContentsZoomChange 仅发通知。采用编辑器专用原生通知→主 frame 单向 IPC→预览 owner 命中正文后缩放，保留 Word 无脚本/无文件桥边界，无 DOM wheel 第二入口。

范围：继续 codex/file-attachment-preview 当前任务分支。主进程原生输入接线归 filePreviewZoom，入口只接线；preload/contract/selfTest 同步窄通知。renderer 复用 setZoom；不修改官网、文件读写权限、普通滚动或新增光标锚定策略。两份已有审计不变。dev-split：新原生输入责任独立 owner，避免扩大 index.ts。

1. [done] 核查现有缩放、调用方、Electron 类型与官方实现，确认缺失与 iframe 事件边界。
2. [done] 实现 editor 主 frame 单向通知及 elementFromPoint 正文命中，复用原 setZoom；15 项相关测试通过，含负屏幕坐标、窗口移动/UI 比例换算、方向/上下限、加载/隐藏/非正文排除、Word iframe 和 PDF 重绘。
3. [done] 原生离线 52 项通过，真实 preload/IPC 通路验证图片/PDF/Word 双向缩放和底栏同步、全局比例不变、错误/隐藏/菜单排除；Word sandbox 不变，宽/380/240px 真实画面像素通过，截图 C:/WINDOWS/TEMP/mini-file-preview-probe-nbUS7J/。HTTP 请求与渲染错误均为 0。typecheck/build 通过，完整测试 840/840、无跳过，Electron self-test PASS、无失败。
4. [done] DESIGN/能力/CHANGELOG 与单向契约同步，差异检查无新增问题；review_file_preview 独立只读评审通过，无阻断项，独立运行 15/15 相关测试。计划归档，未提交合并。

验收不使用 sendInputEvent/CDP/自动化驱动；原生离线测试直接触发 zoom-changed 通知，明确不等同操作系统级物理滚轮验收。Design system impact: update，快捷交互归现有预览模式；ADR gate: 保持原隔离契约，仅增加 editor 单向通知，无新权限或文件桥。

实现依据：Electron 44.5.1 ContentsZoomChange 仅 Emit；对应 Chromium 152.0.7977.130 未消费的轮事件 ACK 经 WebContentsDelegate 的 kPageZoom 路径调用该事件，包含子 frame。不增加 manual 全局缩放模式、不加 DOM wheel 第二实现。坐标采样于原生通知时，快速移出正文可能忽略该次请求。

版本源码：[Electron ContentsZoomChange](https://github.com/electron/electron/blob/v44.5.1/shell/browser/api/electron_api_web_contents.cc#L1604)、[Chromium ACK](https://github.com/chromium/chromium/blob/152.0.7977.130/content/browser/renderer_host/render_widget_host_impl.cc#L3496)、[Chromium 页面缩放请求](https://github.com/chromium/chromium/blob/152.0.7977.130/content/browser/web_contents/web_contents_impl.cc#L4301)。

Design system gate: update/check，通过既有缩放控件入口和只读边界；Changelog gate: 已记录 Ctrl＋滚轮用户行为；Distill gate: 能力文档已写单向契约与 owner，并补可执行测试，无新术语/ADR；Check gate: git diff --check 通过，文档校验仍为既有 5 个历史归档错误及 3 个警告，本次无新增诊断。
