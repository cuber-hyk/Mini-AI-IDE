---
artifact_type: capability
status: current
updated: 2026-10-09
owner: 胡运宽
source_of_truth: [src/shared/applicationUpdate.ts, src/main/updateService.ts, src/main/appUpdater.ts, src/main/applicationUpdateIpc.ts, src/main/updateInstaller.ts, src/renderer/applicationUpdate.js, src/renderer/applicationUpdate.css, src/main/applicationUpdateWindow.ts, src/main/updatePreload.ts, src/renderer/update.html, src/renderer/updateDialog.js, docs/adr/2026-10-09-independent-update-window.md, test/updateService.test.ts, test/applicationUpdate.test.ts, test/applicationUpdateIpc.test.ts, test/updateInstaller.test.ts, electron-builder.config.cjs, scripts/prepare-release.mjs]
---

# 能力：安装版软件更新

## 范围与入口

Windows x64 NSIS 安装版从公开 GitHub 仓库 `cuber-hyk/Mini-AI-IDE` 的正式 Release 检查更新。每次正常启动检查一次；左侧工作区标题栏显示当前版本并提供更新图标，点击或“帮助 → 软件更新…”打开同一独立本地窗口，查看当前版本、检查、下载与重启安装。只接受更新库判定的新稳定版本，不降级、不安装预发布版本。

ApplicationUpdateWindow 持有与主 BaseWindow 关联的非模态 BrowserWindow。首次和重复打开都复用唯一窗口并在主窗口中心显示；宽 460px，无发布说明时高 360px、有说明时高 540px，按当前显示器 workArea 钳制。关闭与 Escape 只隐藏窗口，下载由应用级 UpdateService 持有；失焦不关闭，重新打开保留进度与说明展开状态。应用主窗口真正关闭时销毁该窗口。安装前暂时隐藏更新窗口，完成未保存文件确认后恢复，避免遮挡确认对话框。

更新窗口正文用状态头（图标 + 标题 + 副标题）表达当前阶段：成功态绿色勾、警告态橙色、更新/下载中蓝色；版本以卡片块展示当前版本与目标版本，右侧标注语义（当前版本 / 可更新至 / 待安装）；主按钮按动作分权——无更新时为普通按钮，可下载/可安装时才用强调色，底部提示位于按钮上方。窗口只保留单层边框，面板铺满窗口。图标经 `createElementNS` 构建，远程说明仍为纯文本，均不进入 `innerHTML`。

主入口 `createApplicationUpdater()` 将独立更新窗口、帮助菜单和应用生命周期接到 `UpdateService`。`appUpdater.ts` 负责 electron-updater 和任务栏进度；`updateService.ts` 负责显式动作与唯一状态；`updateInstaller.ts` 仅启动已校验的 NSIS 安装包，等待进程启动事件成功再允许退出。`applicationUpdateIpc.ts` 按主 frame 和具体 WebContents 身份限定入口：编辑器只查询状态与打开窗口；专用更新窗口可查询、检查、下载、安装及关闭。所有请求零参数，不接纳 URL、更新源或安装器路径。updatePreload 只暴露这些窄更新接口与状态订阅，不暴露文件、工具或官网能力；编辑器 preload 不再提供更新执行动作。revision递增，渲染层忽略迟到的旧快照。

## 更新流程

- 启动检查仅更新左侧工作区标题栏的图标状态，不自动打开浮层。点击查看版本、普通文本说明与错误；完整说明默认折叠，远程内容不作为HTML或资源执行。
- 明确点击下载前不获取安装包；任务栏与窗口显示整数百分比。下载失败清除进度并允许重试。关闭窗口不中断下载，不改变更新状态。
- 下载成功后保留“重启并安装”按钮，直到用户明确点击；关闭窗口可以稍后安装，普通关闭软件不安装更新。
- 安装前经 `WorkspaceController.run()` 和 `EditorSession.canLeave()` 处理所有未保存文件。取消、保存失败或窗口已销毁时不调用安装器；安装中复用该批准，不重复询问放弃的草稿。
- 安装包启动成功后才退出应用；启动参数由 Node 在 Windows 上负责转义，避免含空格的安装目录被 NSIS 拆分。退出排在安装器进程收到 `spawn` 后的下一事件循环，给 NSIS 初始化和接管当前安装目录留出机会。启动失败则在窗口报错并保留窗口，用户重新检查、下载和安装。等待启动期间仍走普通退出保护，不通过更新库预先排程退出，也不在失败后回落到 shell 打开或自动提权。
- 窗口关闭后取消在途下载，晚到的事件不广播新状态、不安装。

## 支持判定与数据

仅 `app.isPackaged`、Windows、非 Portable、非自检/诊断/探针且 exe 同目录存在 `Uninstall Mini-AI-IDE.exe` 时启用。该卸载器是当前 electron-builder 26 NSIS 的安装标识；开发和 `win-unpacked` 不启用，Portable 不进行原地替换。

保留 appId、productName、userData、固定会话分区和 `deleteAppDataOnUninstall: false`。升级不主动清理设置和网页登录数据；真实 Windows 升级后的保留结果仍须发布验收。

## 网络与发布边界

主进程软件更新网络例外见 ADR-0005。客户端不读取或内嵌发布凭据，不访问 AI 平台业务、不上传工作区内容。编辑器仍无网络能力，网页只读边界不变。

构建生成 `app-update.yml`（随安装版）及 `latest.yml`（Release 附件）。发布必须将同版本 NSIS 安装包、`.blockmap`、`latest.yml` 一并提供，Portable 作为独立下载项。`pnpm run prepare:release` 检查清单版本、文件名、大小、SHA-512 和 blockmap 覆盖大小，命令不上传文件。

Windows 产物目前未签名；下载内容的散列与更新清单一致不等于发布者认证。GitHub 可达性、真实安装升级与数据保留是发布验收项。

## 验证

业务测试 `test/updateService.test.ts` 验证确认前不下载、取消/保存失败不安装、并发互斥、安装错误恢复与销毁后无副作用；`test/updateInstaller.test.ts` 验证真实进程启动边界、失败不退出及不执行 shell。发布产物测试 `test/releaseArtifacts.test.ts` 验证错误版本、Portable 混入、损坏包和错误 blockmap 被拒绝。完整升级必须另在 Windows 桌面用两个版本验证，不能以模拟 backend 测试替代。

`test/applicationUpdate.test.ts` 验证图标与独立窗口只在用户点击时执行动作、当前版本显示、关闭继续下载、纯文本说明、Escape焦点恢复和旧快照被忽略；`test/applicationUpdateIpc.test.ts` 验证编辑器与更新窗口按各自主 frame 的接口权限调用，拒绝额外参数与其他视图。
