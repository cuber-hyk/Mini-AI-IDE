---
artifact_type: plan
status: archived
created: 2026-10-13
updated: 2026-10-13
owner: agent
plan_readiness: ready
---

# 共享登录资料与跨版本单实例

## Goal And Scope

用户选择安装版与开发版共用当前登录资料，并只允许一个IDE实例使用该资料目录。当前发现三安装主进程与一开发主进程共用APPDATA/mini-ai-ide，并伴随QuotaDatabase打开/重置失败。保留应用名、userData和两persist分区，不读取认证值、迁移/清除数据或终止用户实例。

JSON手动执行仍在主目录codex/manual-tool-json待验收；此修复独立工作树codex/shared-session-instance基于master3b210aa，实现和评审独立，必要代码同步到主目录开发构建时保留全部JSON改动。未授权提交、合并、推送或发布。

## Decisions And Owners

- 使用Electron44.5.1原生requestSingleInstanceLock，应用名固定mini-ai-ide，在probe目录配置后、app.whenReady及所有配置/session创建前获取锁。失败实例退出，不读取生产配置/创建网页。锁只随进程真实退出释放，不在窗口关闭/退出请求开始时提前释放。
- second-instance只激活已有主窗口（最小化恢复、显示、聚焦），不处理第二实例的路径/参数、不导航官网或发送需求。首次窗口尚未创建时记住激活请求，创建后处理。
- 自检/UI探针用独立临时userData与独立锁，不能影响生产会话。diagnose仍用正式目录，受同一实例门禁保护。
- 旧安装版本没有新锁，不能由新版代码使旧程序遵守；两种版本均须包含本修复，升级/验收前用户正常关闭全部旧实例及后台命令。恢复只观察正常顺序启动，不承诺平台令牌永不过期或恢复已丢失的资料。
- dev-split：不拆index，具名sharedSessionInstance owner管理锁/激活，index只接线，复用BaseWindow；新测试与隔离原生多进程夹具验证跨启动路径和退出重启，不另造文件锁/端口/凭据桥。
- 更新session-persistence能力与ADR、CHANGELOG，独立只读评审；原现场冲突只写元数据与用户反馈，不运行官方认证诊断或读存储值。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| SI-1 | done | 核对争用和原生机制 | 当前真实主进程和user-data-dir相同，无单实例；官方对应版本实现按应用名+userData构建ProcessSingleton |
| SI-2 | done | 添加启动门禁与激活 | 锁失败零配置/session/window创建、最小化激活、早到事件、销毁窗口、锁不提前释放；DIAG与探针正确范围 |
| SI-3 | done | 原生隔离验证 | 两启动路径共用TEMP userData，第二退出/首实例收到事件；正常与异常退出后再启动；不同目录可并行；只用synthetic数据，无官网或真实登录 |
| SI-4 | done | 文档、回归、评审及现场验收 | 全量/类型/构建/自检/文档/差异检查，独立复核；用户关闭旧实例后重复启动只出现一个，正常重启登录保持 |

## Acceptance

开发版重复启动激活原窗口，不新增主进程，不产生共享数据库争用。安装版也需新版构建，双方轮流正常关闭/启动时复用原登录资料。JSON验收与该登录修复分开记录，不凭登录测试宣称JSON通过。


## 验证记录（2026-10-13）

- 独立任务树全量1033通过，主目录与待验收JSON功能组合全量1063通过，均0失败/取消/跳过；类型检查、构建、差异和Dev Flow文档检查通过。
- 4项单元测试与7项真实Electron隔离互斥夹具通过：不同脚本入口同name/userData第二实例拒绝，首实例收到事件并调用激活日志stub；不同目录并行；正常退出及仅自有异常退出后可重启；synthetic.json文件计数1→2→3。报告C:/WINDOWS/TEMP/mini-instance-probe-TyY9Vm/report.json。
- 独立只读审核通过，没有阻断项。原生测试使用同一Electron exe不同入口，不声称已验证不同发行版exe互锁；文件计数也不是浏览器认证存储或官网登录测试。
- 主目录保留JSON全部差异同步此锁修复并完成构建。生成本地未发布打包目录C:/WINDOWS/TEMP/mini-shared-instance-package-aea9f562d87f42d4b48fe17dd12de2d5/win-unpacked；该打包程序 --self-test 在独立TEMP资料下PASS（ExitCode0），不替换安装程序/用户数据。版本仍0.3.0，本地验收构建不是正式发布。
- 待用户正常关闭全部无锁旧实例与后台命令，核验新版打包程序与开发版重复启动只一个窗口、轮流使用和正常重启的真实登录保持。旧安装版D:/Mini-AI-IDE没有新保护，不能据此宣称已修复运行中的旧二进制。
- JSON手动入口的真实验收尚未完成，本登录验证不能代替。两任务均未提交、合并或推送；独立计划保持active。


## 用户现场验收与结案

2026-10-13用户确认“全部通过”：新版打包程序运行时启动开发版只激活原窗口；正常关闭后开发版保留DeepSeek登录；开发版运行时启动新版打包程序仍只有一个窗口。至此补齐不同发行程序互斥及真实DeepSeek登录保持的现场证据，不扩大为ChatGPT登录验收。旧D:/Mini-AI-IDE安装程序未更新、未参与验收。

SI-1至SI-4完成，计划归档。JSON手动执行仍待独立验收，相关计划保持active；当前没有提交、合并或发布授权，不修改旧安装目录或登录数据。
