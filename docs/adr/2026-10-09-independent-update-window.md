---
artifact_type: adr
status: accepted
created: 2026-10-09
updated: 2026-10-09
owner: 胡运宽
source_of_truth: [src/main/applicationUpdateWindow.ts, src/main/applicationUpdateIpc.ts, src/main/updatePreload.ts, src/renderer/applicationUpdate.js, src/renderer/updateDialog.js, src/renderer/update.html]
---

# 更新 UI 使用独立本地窗口

用户确认更新内容可以使用居中的独立弹窗，不依赖侧栏浮层。官网是原生 WebContentsView，其层级高于本地编辑器 DOM；侧栏浮层跨出本地区域时被遮挡，限宽后又影响说明阅读。

更新 UI 使用与主 BaseWindow 关联的唯一非模态 BrowserWindow。首次和重复打开居中、聚焦并复用该窗口；宽约 460px，按是否有发布说明调整高度，受显示器可用区域约束。窗口不阻塞本地编辑；关闭和 Escape 隐藏窗口，下载与更新状态继续由现有应用级 UpdateService 持有，主窗口退出才销毁。安装批准期间临时隐藏，避免遮住未保存文件确认。

编辑器只查询更新状态和打开窗口；检查、下载、安装和关闭操作由更新窗口主 frame 发起。IPC 核对具体 WebContents 身份、主 frame 和零参数。窗口使用 contextIsolation、sandbox、nodeIntegration=false 与专用 updatePreload，只有窄更新接口，没有文件、工具、官网桥或 URL 输入；导航和新窗口请求拒绝，发布说明继续作为纯文本渲染。

更新网络例外、确认前不下载、普通退出不安装、未保存文件确认及真实安装器启动边界沿用现有 owner。主界面保留版本与更新图标，移除原侧栏面板及对应控制路径，不保留双轨展示。
