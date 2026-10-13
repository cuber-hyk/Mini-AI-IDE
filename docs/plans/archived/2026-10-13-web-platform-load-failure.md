---
artifact_type: plan
status: archived
created: 2026-10-13
updated: 2026-10-13
owner: 胡运宽
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 官网加载失败提示与手动重载

## Goal And Scope

用户现场确认启动DeepSeek曾正常、切回显示白页；只读诊断为chrome-error协议、body为空。日志明确ERR_CONNECTION_CLOSED(-100)及SSL连接关闭，之后仍打印“已加载”。不据此归因平台切换或Monaco CSP，也不能确定连接被网络、代理还是服务端关闭。

用户已选择：仅加载失败时在顶栏显示“重新加载”按钮，点击重载当前官网；正常切换保留原视图、会话和登录，不自动刷新。修复两平台错误追踪、误导完成提示及此恢复入口；不修改TLS/指纹、网络代理、CSP、用户登录数据或执行/发送权限。

## Implementation Decisions

- WebPlatformController统一监听两平台主frame失败和导航生命周期，保存固定平台名及有界错误码，不在UI/log输出会话URL；ERR_ABORTED不当新网络故障，但不能把失败页完成当作成功。
- 错误页did-finish-load不得清除本轮失败；真正新导航完成后才恢复状态。隐藏平台的错误保留到切回，不污染活动平台；关闭撤销监听。
- 手动重载仅webbar主frame零参数入口，只针对当前失败平台并复用现有忙门禁。当前页面须保持该平台官方origin且无凭据；准备前后核验，页面已恢复时不再重载。取消待回传/旧来源后浏览器reload，不接URL、不新建视图；网络等待不占切换锁，重复点击拒绝。编辑器及官网无此写入口。
- UI复用现有紧凑状态区、共用按钮和禁用原因；失败/恢复期间本地发送与采集不可用，平台仍可切换。正常页面无重载按钮。外部连接继续失败时保留真实提示，不声称网络已修好。
- dev-split为no split：生命周期仍归WebPlatformController，index仅接线与删除误导日志；不拆大型入口，不加通用helper。现有平台ADR/能力/Design同步限定恢复动作。
- 基线master68f1632，复用干净managed工作树建立codex/deepseek-load-failure；主目录无关性能审计及AI临时文件不纳入。不提交、合并、删分支或推送。

## Steps And Verification

| Step | Status | Work | Verification |
|---|---|---|---|
| WL-1 | done | 核对现场与切换/加载owner | chrome-error、ERR_CONNECTION_CLOSED及假完成证据；原离线16项通过但无失败页生命周期覆盖 |
| WL-2 | done | 统一错误生命周期与当前失败页重载 | 失败→完成不清错、隐藏错误、成功恢复、取消/旧事件、scope/权限/忙/重复重载及非官网/恢复竞争反例通过 |
| WL-3 | done | 失败按钮、可用性和状态反馈 | 仅失败可见、加载禁用、错误码可见、正常切换不刷新；聚焦40项通过，最终type/build及native见验证记录 |
| WL-4 | done | 文档、评审、安全同步、现场验收 | 手动评审及安全同步完成；全量1014、原生21、type/build/docs/diff通过，自检仅既有F3d失败；用户确认页面可显示且验收通过 |

## Closeout

CHANGELOG、DESIGN、平台能力、context-map及已有ADR已更新；评审模式及结果记录本文。用户确认官网页面恢复显示、验收通过，本计划归档。外部网络原因及未单独实测的失败按钮行为不冒充已现场查明。

## Verification Checkpoint

先添加DeepSeek主frame失败→错误页完成的回归，旧代码断言失败（平台无error）；修复后两平台生命周期统一。初轮38项聚焦和原生21项通过，含真实Chromium ERR_BLOCKED_BY_CLIENT失败页、错误不清、切换隔离及用户点击同一视图reload恢复。补充当前官方origin、准备后地址变化/已成功恢复守卫，有界ERR名称/数字码；最终聚焦40项通过、0失败/取消/跳过。UI worker最小35项通过，不与聚焦40累加计数。

独立评审代理因账户额度限制未能执行，不记为评审通过；按dev-branch改用manual模式。主代理检查协议/授权、生命周期、失败/恢复事件顺序、旧来源撤销、官网origin及准备竞态、真实按钮到零参数主frame入口与重复点击/迟到回执，并为新增风险补回归。Design gate复用现有共用按钮与状态区；changelog/distill已更新现行能力和accepted ADR。最终全量、构建、自检/原生、文档与主目录同步待记录。

## Final Offline Verification And Review

- 主目录全量1014项通过，0失败/取消/跳过；聚焦40项通过、0跳过。原生21项通过、0失败、退出0，包括两平台真实Chromium错误页完成、隐藏错误隔离、顶栏点击reload同一view恢复；使用隔离userData/本地协议，不接公网或用户登录。
- 主目录构建/type通过，scope未绑定0，115既有信息诊断不判失败（新增按钮类型已明确标注，无新增该类诊断）。正式文档与Git差异检查通过。
- 应用完整self-test退出1，仅F3d失败：fullExamples.valid=true、examples=16，但旧断言要求15。selfTest.ts、formatSpec.ts、toolProtocol.ts、returnPath.ts及formatSpec.test.ts均与基线68f1632逐字一致；既有formatSpec测试明确要求16。未把自检报成通过，也未修改此无关旧规则。IPC注册、preload一致性、按钮链路等其余自检通过。该基线自检差异留作单独后续，不以其推断本轮网络功能失败或声称全仓门禁全绿。
- Review mode=manual（subagent额度失败，不存在独立通过结论）；plan compliance=pass，audit coverage=not applicable（现场证据在本计划），related changes=pass，task verification=pass但self-test有上述既有失败，Design/changelog/distill/check=pass，无本轮已确认阻断。检查并补充了仅官方origin、准备后busy/导航/已恢复守卫，日志仅有界错误码不含会话URL。
- 主目录19个相关路径经68f1632基线逐字核验后同步，既有未跟踪性能审计与AI临时目录保留。主目录master上为未提交验证差异，任务工作树分支codex/deepseek-load-failure；未暂存、提交、合并、删分支或推送。之前任务的提交批准不用于本轮。
- 官网反馈已收到：“通过了,可以显示了”。据此记录页面恢复显示及用户验收通过；未明确反馈失败后点击重载，不把失败入口原生离线验证冒充官网实测。外部ERR_CONNECTION_CLOSED原因仍可能是网络、代理或服务端，不自动改TLS/CSP或清除会话。

## 验收与结案（2026-10-13）

用户确认页面恢复显示并通过本轮验收，WL-1至WL-4结束。保留原生失败/重载覆盖和官网显示恢复的不同证据范围；完整self-test的既有F3d失败仍独立记录，不声称所有全仓门禁通过。本轮仅更新验收文档，无新增代码，不重复自动化验证。

验收阶段未执行 Git 发布操作；之后用户明确授权“提交合并，发布最新版本，可以push”。本任务提交为 3021900，随 v0.3.0 快进合并 master 并推送。发布阶段单独修正既有 F3d 数量断言，开发版与打包程序各 159 项自检全部通过；先前失败保留在上述检查点作为历史证据。发布产物及远端验证见[0.3.0 发布记录](2026-10-13-release-0.3.0.md)。无关用户文件和已有分支保留。
