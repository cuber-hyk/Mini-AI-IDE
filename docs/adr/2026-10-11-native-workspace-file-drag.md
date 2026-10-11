---
artifact_type: adr
status: accepted
created: 2026-10-11
updated: 2026-10-11
owner: 胡运宽
source_of_truth: [src/main/workspaceFileDrag.ts, src/main/preload.ts, src/shared/contract.ts, src/renderer/fileExplorer.js, src/renderer/localPrompt.js, test/workspaceFileDrag.test.ts, test/fileExplorer.test.ts, test/localPrompt.test.ts, tools/verify-workspace-file-drag.cjs]
---

# 用户主动原生文件拖拽

用户确认目录树文件可直接拖到官网附件输入区，并要求支持普通文本文件。采用 Electron `webContents.startDrag` 系统原生拖拽，取代内部 MIME 拖拽。文件目录树只接受可信用户 dragstart；编辑器主 frame 窄 IPC 只接收当前项目根与单个相对文件路径。主进程校验真实路径、普通文件、非文件链接及项目代次，取得系统图标后复核文件身份，再交给操作系统。空图标、过时项目/文件或原生错误明确反馈，不声称附件上传成功。

拖拽的是磁盘原文件，包含图片、PDF、Word、TXT、Markdown 和代码等普通文件，不转换类型或字节，不导出编辑器未保存草稿。目录及链接不拖出。最终目标由用户松手位置决定，原生拖拽可以到官网、本地需求框或系统其他接收方；格式、大小与上传状态由接收方处理。官网自行处理原生 drop 后的附件，不自动发送正文；本地需求框复用 Files→主进程附件暂存入口，仍受本地原有附件格式/大小限制并随用户提交发送。

这是用户主动操作的文件交付，不属于程序 DOM 写入运输。官网没有新增 preload、路径查询、文件系统桥或任意文件 IPC；文件路径只在主进程与系统原生拖放载荷间使用。不得在网页添加合成 drop/input、模拟按键或自动上传/发送。程序代上传本地需求或工具结果仍仅由 WebComposerSender 经既有官方控件运输，与本入口不混用。

Windows 原生拖放需要真实鼠标动作；异步文件/图标校验期间用户释放按键时，原生拖放可能直接结束。操作系统接手后按原路径读取，不冻结文件快照或跟踪远端上传，也不重试取消/未知拖放。离线 IPC/参数验收不替代跨 WebContents 与官网接收的物理验收。
