---
artifact_type: plan
status: archived
created: 2026-10-18
updated: 2026-10-18
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# DeepSeek 独立登录账号切换

## Goal

用户在每个独立账号会话首次登录后，可从本地顶栏切换 DeepSeek 账号，无需退出其他账号；有效登录跨应用重启保留，旧批工具结果不能跨账号运输。

## Scope And Decisions

- 用户已确认独立持久会话方案并授权实施；当前默认账号沿用 persist:postcheck，ChatGPT 仍用 persist:postcheck-02。
- 首版提供本地备注名、添加与选择账号；不提取真实账号身份、不读写认证值、不迁移浏览器/历史退出账号、不提供删除资料或自动登录。登录失效由用户在官网处理。
- 应用启动仍进入默认 DeepSeek 账号；新增账号分区创建一次并长期按账号 ID 固定复用，不随启动变化。备注与编号放应用资料目录，认证仅由 Chromium 在独立分区中保存。
- 只允许本地顶栏主 frame 添加和切换。执行、后台进程、发送期间拒绝；倒计时先撤回。准备完成后二次核验忙门禁；同平台账号切换也递增活动代次、重绑运输/采集、重建历史基线，不补发旧结果/附件。
- 账号首次使用才创建原生视图，切换复用；隐藏账号不运行采集和发送。失败恢复原活动视图；加载、错误与重载按视图隔离。
- 当前与 master 同一提交84a902f。原有三个未跟踪文件保持不动且不包含于任务差异；不提交、合并或推送。

## Fact Sources / Split Guidance

- src/shared/webPlatform.ts、src/main/webPlatformController.ts、webPlatformView.ts、index.ts、tools/integration.ts、webbarPreload.ts 及 renderer/webbar.*；能力见 web-platforms.md、session-persistence.md，UI 沿用 DESIGN.md 与 ui.css。
- no split：不拆现有模块。新增 deepseekAccounts.ts 管理稳定账号元数据及分区映射；新增 deepseekAccountViews.ts 管理账号视图缓存；index.ts 仅接线，不承载账号状态或解析逻辑。平台 controller 保持唯一切换锁与加载生命周期 owner；工具 integration 保持唯一结果和采集 owner。
- design_system_impact: update；复用具名原生选择框、共用图标按钮与主题 token，添加时使用顶栏内具名备注输入，不覆盖官网。
- ADR gate: needed；固定分区从每平台一个扩展至每账号一个，需要记录状态隔离与既有默认资料保留。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| ACC-1 | done | 核对合并、现有切换与工具绑定，确定单一状态归属 | master与HEAD一致，默认分区及busy/绑定调用链已读 |
| ACC-2 | done | 账号元数据、稳定分区与延迟视图缓存 | 7项元数据测试及原生两进程存储验收通过，损坏/写入失败保留原文件 |
| ACC-3 | done | 账号切换及权限接线，逐视图加载状态 | 13项组合切换测试及工具真实写盘/账本回归通过；同URL来源选择已独立释放 |
| ACC-4 | done | 顶栏选择与添加交互 | 36项UI/原顶栏相关回归通过；原生中文输入/错误和窄栏几何通过 |
| ACC-5 | done | 原生隔离夹具、回归与知识收尾 | 全量1259/1259，build、文档校验、原生账号33/33、原平台24/24通过；独立复审无阻断 |

## Acceptance And Routing

更新 web-platforms/session-persistence 当前能力、DESIGN、CHANGELOG、context-map与必要AGENTS固定分区规则，新增账号ADR。测试覆盖账号/视图/controller/UI及工具绑定回归；原生夹具仅使用临时资料，不连接官网、不读取用户认证。验证后归档本计划，明确实际官网登录与重启验收边界。

## Verification Record / Closeout

- 2026-10-18 最终完整测试1259/1259通过，31 suites，0失败/取消/跳过，39.45秒。首轮全量1256/1257：旧后台策略AST断言只允许原有两个官网工厂，按新增账号工厂更新有限配置断言后全量通过，没有放宽全局后台开关约束。
- 同URL、同batch的真实写盘测试先复现旧工具选择不释放问题，新增harness.resetSource并为附加账号账本加入稳定ID作用域后，harness与toolPlatformActivity 52/52通过。默认账号账本不迁移，切回防重放，上一账号结果可复制但不能发送。
- 最终build通过（包含严格TypeScript编译）；renderer裸标识符未绑定0，其余153条语义参考诊断不作为通过的功能断言。未新增依赖。
- 最终原生两进程账号夹具33/33通过，报告 `C:/WINDOWS/TEMP/mini-deepseek-accounts-probe-hhIRRu/report.json`：同origin synthetic localStorage与持久cookie隔离及重开复用、真实控件/IPC/沙箱/UA、IME、重名和控制字符提示均通过。320/380/440px无溢出，添加输入宽74/92/92px。5张截图成功并检查320px添加；320px选择截图UnknownVizError明确记录，相关DOM几何断言通过。
- 原有原生平台夹具24/24通过，报告 `C:/WINDOWS/TEMP/mini-platform-probe-CO9GOu/report.json`。两类夹具的主动busy拒绝日志为预期断言；未接官网。首次误用Node运行Electron专用脚本已纠正为Electron进程，未改产品适配测试。
- 独立只读评审识别重复备注误报临时切换失败，修复为基于权威列表的明确校验后，原复现显示正确原因且IPC调用0；独立复审28/28、文档校验和diff检查通过，无剩余阻断。最终窄栏样式仅改添加态，后续增量build及33项原生验证通过。
- 按dev-changelog/distill/design-system更新当前能力、账号ADR、规则与路由；dev-check校验无问题。本计划按开发与离线验收收尾归档。真实官网多账号登录、过期及跨重启是否仍认可登录由用户现场确认；不将合成存储验收称为官网登录验收。
- 日志 `TEMP/mini-accounts-full-final.log`、`mini-accounts-build-final.log`、`mini-accounts-native-final.log`、`mini-accounts-platform-native.log`。未提交、合并、删除分支或推送；原有三个未跟踪文件保持原样。
