---
artifact_type: adr
status: accepted
created: 2026-10-08
updated: 2026-10-09
owner: 胡运宽
source_of_truth: [src/main/localPromptAttachments.ts, src/main/localPromptController.ts, src/main/webComposerSender.ts, src/main/preload.ts, docs/capabilities/skills-and-local-prompt.md, docs/capabilities/human-machine-boundary.md]
---

# 用户主动本地需求附件

用户可以在本地需求区选择工作区文件、拖入外部或工作区文件/图片，或粘贴剪贴板图片，并随明确提交的本地需求发送给 DeepSeek。

本地附件暂存 owner 仅接受用户本次选择/拖入的文件路径，或编辑器明确粘贴的受支持图片字节；检查真实路径、扩展名、数量（最多 50）和单文件大小（最多 100 MiB），并以不透明 ID 管理。磁盘文件由主进程分块读取；剪贴板图片经窄 IPC 进入主进程并受相同大小限制。网页不接收路径、文件系统桥或一般文件 IPC。附件只能通过唯一 `WebComposerSender` 在官方 DeepSeek origin 下提交到经约束识别的文件输入控件；当前工具结果附件边界另由 `2026-10-09-tool-attachment-return.md` 定义。

发送前要求官网 composer 为空、无既有附件、无生成状态，且文件控件可唯一识别。文件选择后，等待 composer 中出现本次附件的文件名或图片预览，并确认上传进度标记结束，再发送正文；超时或无法确认时不发送正文，保留本地附件供用户重试。遇到不确定状态停止并清理本次尚未提交附件；发送点击后不确定时不重试，也不擅自清理可能已被官网接收的文件。官网控件结构和实际接收行为可能变化；离线夹具不能证明真实官网兼容，需在真实站点验收。

该设计允许网页获得用户明确选择的文件字节，但不扩大为网页任意磁盘访问、文件路径可见或 API 上传能力。
