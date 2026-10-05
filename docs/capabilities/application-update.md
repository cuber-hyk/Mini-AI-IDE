---
artifact_type: capability
status: current
updated: 2026-10-05
owner: 胡运宽
source_of_truth: [src/main/updateService.ts, src/main/appUpdater.ts, src/main/updateInstaller.ts, src/main/index.ts, test/updateService.test.ts, test/updateInstaller.test.ts, electron-builder.config.cjs, scripts/prepare-release.mjs]
---

# 能力：安装版软件更新

## 范围与入口

Windows x64 NSIS 安装版从公开 GitHub 仓库 `cuber-hyk/Mini-AI-IDE` 的正式 Release 检查更新。每次正常启动检查一次；“帮助”菜单显示当前版本，并提供检查、下载与重启安装操作。只接受更新库判定的新稳定版本，不降级、不安装预发布版本。

主入口 `createApplicationUpdater()` 将原生菜单和应用生命周期接到 `UpdateService`。`appUpdater.ts` 负责 electron-updater、原生对话框和任务栏进度；`updateService.ts` 负责用户确认与更新状态；`updateInstaller.ts` 仅启动已校验的 NSIS 安装包，等待进程启动事件成功再允许退出。没有渲染进程更新 IPC，也没有 URL 或更新源输入。

## 更新流程

- 启动检查没有新版本或网络失败时保持安静；手动检查显示当前版本或错误。发现新版本提示版本与纯文本说明，用户选择下载或稍后。
- 明确下载前不获取安装包；任务栏与帮助菜单显示整数百分比。下载失败清除进度并允许重试。
- 下载成功后选择重启安装或稍后；稍后仍可从帮助菜单安装。普通关闭软件不安装更新。
- 安装前经 `WorkspaceController.run()` 和 `EditorSession.canLeave()` 处理所有未保存文件。取消、保存失败或窗口已销毁时不调用安装器；安装中复用该批准，不重复询问放弃的草稿。
- 安装包启动成功后才退出应用；启动失败则明确报错并保留窗口，用户从帮助菜单重新检查、下载和安装。等待启动期间仍走普通退出保护，不通过更新库预先排程退出，也不在失败后回落到 shell 打开或自动提权。
- 窗口关闭后取消在途下载，晚到的事件不更新菜单、不弹新对话框、不安装。

## 支持判定与数据

仅 `app.isPackaged`、Windows、非 Portable、非自检/诊断/探针且 exe 同目录存在 `Uninstall Mini-AI-IDE.exe` 时启用。该卸载器是当前 electron-builder 26 NSIS 的安装标识；开发和 `win-unpacked` 不启用，Portable 不进行原地替换。

保留 appId、productName、userData、固定会话分区和 `deleteAppDataOnUninstall: false`。升级不主动清理设置和网页登录数据；真实 Windows 升级后的保留结果仍须发布验收。

## 网络与发布边界

主进程软件更新网络例外见 ADR-0005。客户端不读取或内嵌发布凭据，不访问 AI 平台业务、不上传工作区内容。编辑器仍无网络能力，网页只读边界不变。

构建生成 `app-update.yml`（随安装版）及 `latest.yml`（Release 附件）。发布必须将同版本 NSIS 安装包、`.blockmap`、`latest.yml` 一并提供，Portable 作为独立下载项。`pnpm run prepare:release` 检查清单版本、文件名、大小、SHA-512 和 blockmap 覆盖大小，命令不上传文件。

Windows 产物目前未签名；下载内容的散列与更新清单一致不等于发布者认证。GitHub 可达性、真实安装升级与数据保留是发布验收项。

## 验证

业务测试 `test/updateService.test.ts` 验证确认前不下载、取消/保存失败不安装、并发互斥、安装错误恢复与销毁后无副作用；`test/updateInstaller.test.ts` 验证真实进程启动边界、失败不退出及不执行 shell。发布产物测试 `test/releaseArtifacts.test.ts` 验证错误版本、Portable 混入、损坏包和错误 blockmap 被拒绝。完整升级必须另在 Windows 桌面用两个版本验证，不能以模拟 backend 测试替代。
