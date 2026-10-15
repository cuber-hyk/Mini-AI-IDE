---
artifact_type: adr
status: accepted
created: 2026-10-08
updated: 2026-10-15
owner: 胡运宽
source_of_truth: [src/main/chatgptPage.ts, test/chatgptComposerSender.test.ts, tools/verify-chatgpt-composer.cjs, src/main/localPromptAttachments.ts, src/main/localPromptController.ts, src/main/webComposerSender.ts, src/main/preload.ts, docs/capabilities/skills-and-local-prompt.md, docs/capabilities/human-machine-boundary.md]
---

# 用户主动本地需求附件

用户可以在本地需求区选择工作区文件、拖入外部或工作区文件/图片，或粘贴剪贴板图片，并随明确提交的本地需求发送给当前活动的 DeepSeek 或 ChatGPT 普通会话。

本地附件暂存 owner 仅接受用户本次选择/拖入的文件路径，或编辑器明确粘贴的受支持图片字节；检查真实路径、扩展名、数量（最多 50）和单文件大小（最多 100 MiB），并以不透明 ID 管理。该上传暂存上限独立于 PDF／DOCX 本地预览的 128 MiB 上限，官网另有实际格式和额度约束。磁盘文件由主进程分块读取；剪贴板图片经窄 IPC 进入主进程并受相同大小限制。网页不接收路径查询、文件系统桥或一般文件 IPC。程序代上传附件只能通过唯一 `WebComposerSender` 在当前平台官方 origin 下提交到经约束识别的文件输入控件；当前工具结果附件边界另由 `2026-10-09-tool-attachment-return.md` 定义。用户直接从目录树原生拖入官网的手动交付入口由 `2026-10-11-native-workspace-file-drag.md` 定义，不暂存在本地需求列表，不代用户发送。

发送前要求官网 composer 为空、无既有附件、无生成状态，且文件控件可唯一识别。ChatGPT 要求唯一 ProseMirror 所属的 `form[data-chatgpt-composer]` 内仅有一个 multiple 且无 accept 限制的通用文件输入；附件批不适用纯文本工具结果的草稿备份替换。文件选择后必须逐一确认本次图片、文档及混合附件，等待进度消失和发送控件就绪；图片须可解码，文档卡若有缩略图也须就绪，不能以图片数量或已清空的 input.files 代替文档确认。上传期间的可信输入和附件操作视为用户接管。超时或无法确认时不发送正文，保留本地待发项；点击前仅清理可明确归属本批且具有已知官方移除控件的附件，并异步有界复核，未知归属或清理不确定仍暂停。发送点击后不确定时不重试，也不擅自清理可能已被官网接收的文件。官网控件结构和实际接收行为可能变化；离线夹具不能证明真实官网兼容，需在真实站点验收。

该设计允许网页获得用户明确选择的文件字节，但不扩大为网页任意磁盘访问、文件路径可见或 API 上传能力。

ChatGPT 文档除完整原名外，接纳官网在原扩展名前追加数字编号的完整名称；该名称必须同时与卡内文本及移除控件标签相符。发送和点击前清理共用双向唯一匹配，存在多文件或多卡片解释时均暂停，不通过放宽前缀包含来绕过身份核对。
