---
artifact_type: adr
status: accepted
created: 2026-10-13
updated: 2026-10-13
source_of_truth: [src/main/sharedSessionInstance.ts, src/main/index.ts, test/sharedSessionInstance.test.ts, tools/verify-shared-session-instance.cjs]
---

# 共享登录目录的单实例保护

## Context

安装版和开发版在同一Windows账户下固定使用mini-ai-ide应用名与同一userData，两平台官网分区亦固定。用户选择保持共享登录，阻止不同版本或重复点击同时占用目录。本次现场读到三个安装主进程与一个开发主进程共用目录，并有QuotaDatabase打开/重置失败；不从该错误单独推断登录令牌损坏。

## Decision

在app.setName和隔离探针目录配置后，app.whenReady、SettingsStore与session.fromPartition之前获取Electron原生requestSingleInstanceLock。Windows对应Electron44.5.1实现将同一程序名和userData传给ProcessSingleton，不按项目目录或启动器分别建立保护。

失败实例立即退出，不创建新配置、工具服务、窗口或平台官网视图。first实例收到second-instance只恢复/显示/聚焦已有主窗口，忽略其路径与参数，不发送、导航或重启官网。窗口尚未创建则记录激活请求。不能在窗口关闭、退出请求或后台命令清理开始时releaseSingleInstanceLock，保持到进程真实退出。

SELF_TEST/UI_PROBE先配置独立TEMP userData，锁与正式应用隔离；diagnose继续使用正式数据并受相同门禁保护，锁失败明确拒绝诊断。保持现有登录目录、分区、UA与持久化规则，不读取/复制/清理认证数据，不结束用户进程。

## Consequences And Verification

同名、同数据目录的新版安装/开发实例互斥，切换使用版本仍复用原存储。旧二进制没有新增保护，必须正常关闭旧实例，并让安装版与开发版都包含此修复；不能声称新开发代码已保护仍运行的旧安装程序。网站自行注销或过期、已损坏存储不由实例锁恢复。

验证失败启动零初始化、早到事件、最小化/销毁窗口、锁直到退出；TEMP多进程隔离fixture覆盖不同入口、拒绝第二实例、second事件、正常/异常退出后再启动、不同目录并行与synthetic数据顺序持久。真实登录保持与用户现场验收分开。


## 现场验证（2026-10-13）

用户已确认新版打包程序与开发版互相重复启动只激活原窗口，以及正常关闭/交替启动保留DeepSeek登录。原生夹具的跨程序与认证验证限制已由此现场反馈补齐；未声称ChatGPT已验收。旧安装版尚未替换，发布/安装仍独立进行。
