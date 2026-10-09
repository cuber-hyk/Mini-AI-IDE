---
artifact_type: adr
status: accepted
created: 2026-10-09
updated: 2026-10-09
owner: 胡运宽
source_of_truth: [src/shared/toolProtocol.ts, src/main/tools/attachments.ts, src/main/tools/resultReturn.ts, src/main/tools/integration.ts, src/main/webComposerSender.ts, test/toolAttachmentIntegration.test.ts, test/toolAttachments.test.ts, test/toolResultReturn.test.ts]
---

# 当前工具批次的附件回传

用户确认 IDE 需要将技能产生的图片、PDF、Word 等受支持文件回传给网页 AI，沿用现有工具权限及 automatic；关闭自动继续时提供手动入口。

采用唯一 `attach_file({path})` 工具。它是明确的官网上传请求，ask 模式对项目内外文件都审批，rules/full 遵循现有策略。审批说明标明上传到当前 DeepSeek 会话，精确规则绑定真实目标及文件身份；文件变化后不能复用旧批准。技能和命令输出不自动授予附件权限，也不从日志猜测文件路径。

`ToolAttachments` 只暂存当前选择的已授权文件，复用主进程文件类型、数量和大小校验；工具 done 仅表示暂存，返回 id/name/size/mediaType。真实路径及字节仅在主进程持有，执行账本不保存附件或正文。发送前及流式读取复核文件身份，变化、取消、新批、项目/会话切换使旧附件失效。

`AutoContinuation` 继续拥有完成事件与计时；`ToolResultReturn` 统一拥有自动/手动的当前真实批次资格与一次运输。整批真正完成且有实际执行才允许；拒绝、取消、未知、历史和无执行不发送。发送前核验官网最新完整回复仍为原正式批次，再解析自有附件。手动窄 IPC 不接受路径、正文或附件 ID，只能发送主进程持有的当前批。关闭 automatic 优先取消待发送，不中断本地工具；一次发送开始后失败或未知均明确暂停，不重试该批上传。

运输继续只由 `WebComposerSender` 在隔离世界 1005 完成：官方 DeepSeek origin、当前会话、唯一可见 textarea 和发送控件、无用户草稿/既有附件；文件通过官方 input 控件上传，确认全部文档及图片预览和进度结束后才提交结果正文一次。所有 AI 业务网络仍由 Chromium 发出；无 Node HTTP 上传、任意 URL、磁盘桥或额外 DOM 写 owner。

PDF 读取不是在本任务中实现本地解析。AI 可请求上传原 PDF，由官网能力读取；论文局部截图由技能通过已授权 run_command 使用环境中实际可用工具生成，再请求 attach_file。平台支持的格式及页面结构仍影响实际可用性，原生离线夹具不替代真实官网登录态验收。
