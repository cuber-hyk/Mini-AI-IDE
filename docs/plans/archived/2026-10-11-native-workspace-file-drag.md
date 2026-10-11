---
artifact_type: plan
status: archived
created: 2026-10-11
updated: 2026-10-11
owner: Codex
---

# 目录树原生文件拖拽

用户已确认系统原生拖拽方案，并补充普通文本文件。目标：目录树单个真实文件可拖到官网附件输入区或本地需求框；只添加附件，由用户自行发送。包含图片、PDF、Word、TXT/Markdown 等普通文件，格式/大小接受由接收方决定。不拖文件夹、不转换文件、不拖编辑器未保存草稿、不新增预览区拖拽、多选或代上传入口。

事实：fileExplorer 当前 dragstart 仅设置内部 MIME，官网无法把它识别为 File。本地 localPrompt 已有 Files→stagePromptAttachments 入口；stageWorkspacePromptAttachments 仍供右键附件操作使用。新实现替换内部 MIME 拖拽为 editor 主 frame 窄 IPC，经主进程校验当前 root/真实路径/文件身份后 startDrag，官网接收操作系统原生 drop，不注入页面、不模拟发送、无文件桥。

继续当前 codex/file-attachment-preview 同一功能分支，两份已有审计报告不变。dev-orient 已检查 FileService/FileManagement 路径守卫、FileExplorer 调用与 LocalPrompt 接收方；dev-split：原生拖拽拥有明确 IPC/文件身份责任，独立 workspaceFileDrag owner，index 只接线；无需拆分现有渲染模块。

1. [done] 确认内部 MIME 缺失真实附件语义及 native startDrag 官方方案；核查双方接收入口和现有根目录守卫。
2. [done] 添加 editor-only 原生拖拽 owner/契约，文件树仅可信用户 dragstart 发起；删除内部 MIME drop 分支，保留统一 Files 接收和右键附件入口。空系统图标明确拒绝，避免 Electron 静默返回后误报启动。
3. [done] 33 项相关行为测试通过；原生 Electron 25 项离线 IPC/参数检查通过，实际 preload/owner 与系统图标、原文件字节及非法来源拒绝验证，HTTP/rendererErrors 均为 0。仅 fixture 替换 startDrag 参数捕获，不模拟系统拖拽、不操作官网。目录 C:/WINDOWS/TEMP/mini-workspace-file-drag-probe-gOrXYC/。
4. [done] typecheck/build/full test/self-test 与文档同步已完成；review_file_preview 独立只读评审通过，无未解决阻断项，独立复跑 33 项相关测试。实现归档，物理拖放/官网接收保留手动验收限制，未提交或 push。

验收：不向官网新增 bridge、不写网页 DOM、不读系统剪贴板；拖拽采用磁盘文件，普通文本字节保持。错误显示在本地，startDrag 返回不宣称上传成功。Windows 物理跨 WebContents 拖放与 DeepSeek 实际接收需手动验证，自动验证不得冒充。Design system impact: update，树文件拖拽统一真实 Files；ADR gate: 用户批准的原生拖拽作为手动附件入口写入 accepted ADR，区别于 WebComposerSender 程序代上传。

验证结果：完整测试 845/845、无跳过，typecheck/build 与 Electron self-test PASS。git diff --check 通过；文档校验仍为既有 5 个历史归档错误、3 个警告，本轮无新增。Design system gate: update/check 通过，复用文件行/Files 暂存和本地错误反馈。Changelog gate: 已记录用户可见原生拖拽；Distill/ADR gate: 原生手动交付写入 accepted ADR 并同步 AGENTS、已有附件 ADR、当前能力与路由。
