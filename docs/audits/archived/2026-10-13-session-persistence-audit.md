---
artifact_type: audit
status: archived
created: 2026-10-13
updated: 2026-10-13
scope: "升级后反复登录：安装身份、固定分区与多进程存储争用"
source_of_truth: [src/main/index.ts, src/shared/webPlatform.ts, src/main/webPlatformView.ts, electron-builder.config.cjs, docs/capabilities/session-persistence.md]
---

# 升级后登录保持排查

## Scope

用户反馈更新后反复需要登录。本轮只读排查版本差异、启动身份、存储目录元数据，并在独立临时目录执行人工测试数据持久化实验；不读取认证值、不迁移或清除用户会话、不关闭用户 IDE。

用户已补充确认：只测试 DeepSeek，使用 Setup 安装版，每次普通关闭再打开都会要求登录，不是仅升级后的首次启动。

## Fact Sources

- v0.2.7 与 v0.3.0 对比：应用名 mini-ai-ide、appId、productName、DeepSeek persist:postcheck 与 deleteAppDataOnUninstall:false 未改变；未新增 clearStorageData 或 clearCache。
- ChatGPT 分区固定为 persist:postcheck-02，切换复用视图。
- 排查时存在两个真实主进程：主目录 node_modules 中 electron.exe（开发版），及 D:\Mini-AI-IDE\Mini-AI-IDE.exe（安装版，文件版本 0.3.0）。两者代码默认共用 APPDATA/mini-ai-ide。
- 进一步核对两者实际子进程的 --user-data-dir 参数，两者均为 C:\Users\胡运宽\AppData\Roaming\mini-ai-ide；共享目录不仅是根据代码推测。
- 只读目录元数据显示正式 postcheck 存储自 2026-10-02 存在、postcheck-02 自 2026-10-12 存在，不能据此认定升级清空了资料，也不能据此证明当前认证仍有效。

## Findings

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| LOGIN-1 | P2 | verified | 窗口关闭后残留的开发版进程与安装版共用登录数据，产生本次反复登录现象 | 两实例实际 user-data-dir 相同；开发版 PID 47492 已无主窗口但仍存活；用户确认后台命令未结束，结束后恢复 | 不新增代码计划 | master 37fdd47 / v0.3.0 | 并行存储实验复现，顺序控制组通过；用户实测恢复；最终进程检查仅安装版 PID 40764 | fixed（运行环境）：结束残留后台命令；没有修改登录代码，也没有新增单实例保护 |

## ADR Gate

- not needed：本次通过结束残留后台命令恢复，用户要求恢复排查前状态；不更换目录、分区或实例策略。

## Verification

- 并行原生实验：TEMP/mini-session-contention-5MT8lf/report.json。完全隔离 userData，固定测试分区，https 由 Electron 自有本地协议处理，只写 synthetic-sentinel，不连接官网。
- 第一实例写 first，第二实例 before=null、after=second；后续实例 before=first。第一实例等待退出未结束，最终仅终止包含本次精确临时目录标识的探针进程；未终止用户开发版或安装版。该实验不声称验证正常退出全部路径。
- 正常顺序启动控制：TEMP/mini-session-sequential-RKUUMF/report.json；两个进程均退出 0，写 control 后再次读取为 control。
- 补充完整 IDE 离线正常关闭检查：独立 userData、无工具命令的普通启动，以及本地页面带 beforeunload 的启动，两次均经过 will-quit/quit，退出码 0。日志为 TEMP/mini-full-ide-exit-probe.log 与 mini-full-ide-unload-probe.log；这些结果只覆盖夹具状态，不推断所有工具退出路径。
- 用户最终确认：“开发版本虽然关闭但是后台命令没有结束，我刚刚结束了，没问题了，可以恢复修改”。随后只读进程检查仅余安装版主进程。
- 验证范围限定为运行环境冲突及用户恢复反馈，不读取官网令牌，也不把夹具实验当作官网认证载体的完整验证。
- 未运行真实官网诊断模式，避免与仍运行的正式实例再次争用同一数据目录。

## Git Visibility

报告保持未提交；前一项更新面板 CSS/文档变更和无关性能审计、临时目录文件保持原样。

## Closeout

用户结束残留后台命令后确认恢复，本次排查结案归档。排查全程未修改登录相关实现，不需要回退代码；不新增单实例保护、退出策略或存储迁移。保留先前更新面板滚动优化，未提交、合并或发布。开发版/安装版共享数据及避免并发使用的当前规则已收录 session-persistence 能力文档。
