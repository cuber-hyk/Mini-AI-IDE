---
artifact_type: plan
status: active
created: 2026-10-11
updated: 2026-10-11
owner: Codex
---

# ChatGPT 官网手动接入与顶栏平台切换

## 已确认目标与边界

顶栏直接切换 DeepSeek / ChatGPT，每次启动默认 DeepSeek，两平台分别保存登录状态。用户已实际确认独立 Electron 验证窗口登录、对话、重启登录保持均成功；正式 IDE 分区不迁移验证 profile，需要用户首次登录。

本轮 ChatGPT 仅官网手动登录/对话；不接入输出采集、本地需求代发送、工具执行、自动继续或程序附件上传。最终自动执行/自动继续目标保留，后续讨论。本地编辑、文件预览和用户原生拖拽保持可用。既有 DeepSeek 发送 owner 和分区保留。

用户确认：工具执行、后台进程或需求/结果发送期间阻止平台切换；仅自动回传倒计时时可取消待发送后切换，已完成结果可复制。切换恢复后不补发取消的旧批次；原 automatic 配置保留，但仅活动 DeepSeek 生效。

## 实现路线

- 两个固定独立原生视图，ChatGPT 首次选择时创建；隐藏 DeepSeek 停止其变化采集、批次执行和运输，返回建立历史基线。
- DeepSeek 保留 persist:postcheck；ChatGPT 使用固定中性 persist:postcheck-02。无随机分区、profile 迁移、Node AI HTTP、CDP、合成输入或指纹改写。两网页均无 preload/Node/文件桥；ChatGPT 允许官方登录弹窗及常见身份提供商的原生窗口。
- 新 owner src/main/webPlatformController.ts 管理平台生命周期及窄 IPC；共享平台状态 src/shared/webPlatform.ts，顶栏选择器仅接收两个平台 ID，不接收任意 URL。
- WorkspaceLayoutController 单一几何计算，仅新增替换活动网页视图入口；index.ts 只负责接线。tools/integration.ts 新增活动门禁和暂停取消，LocalPromptController 保留唯一发送入口并提供活动门禁/发送忙判据。编辑器与顶栏消费状态，ChatGPT 禁用未适配控件并说明原因。
- dev-split: local owner，主进程大入口仅接线，不新建通用 helper、不重构无关模块。复用现有 UI token 与具名 select。

## 步骤与验证

1. [done] 读取主进程、布局、工具 integration、需求 controller 和顶栏调用关系；明确切换忙判据和独立分区；用户确认切换入口及执行/发送阻止切换。
2. [done] 实现平台 owner/契约/IPC 与原生视图布局接线；7 项 owner 行为测试通过，覆盖默认平台、隔离、并发/忙拒绝、错误恢复和主 frame/参数限制。
3. [done] 工具与需求活动门禁完成；65 项聚焦回归通过，倒计时撤回不补发、隐藏平台不执行/运输、完成结果可复制，跨异步授权/采集/运输守卫核验。
4. [todo] UI 与离线原生验收均通过：59 项 UI、13 项原生平台检查，类型检查/构建通过，全仓 874 测试通过 0 跳过，启动 self-test 159 项 PASS。用户已确认完整 IDE 来回切换正常、新验证 profile 仅首次要登录；用户随后推迟登录保持验收，该项保留未验收，不再反复重开。
5. [todo] 更新当前能力、设计规则、CHANGELOG Unreleased、必要 ADR/context-map；独立只读评审，归档计划；用户未批准提交/合并/push，不执行这些操作。

## 风险与验收限制

页面 loaded 不等于认证成功。真实登录、对话与正式分区重启保持需用户确认，程序不读取凭据、Cookie 值或 ChatGPT 回复。原有诊断模式仍诊断 DeepSeek，不把它用于 ChatGPT 认证判定。既有全仓文档校验存在 5 错误/3 警告，避免无关修复并明确报告增量。

ADR gate: needed，正式平台分区与活动暂停是跨模块生命周期契约。Changelog/Design/Distill gates: needed，新增可见平台入口及当前能力边界。原两份未跟踪审计不纳入任务；先前登录验证工具/归档记录作为相关证据保留。

## 验证记录

- 全仓测试 874/874 通过、0 skipped；随后仅补充加载恢复断言与错误清理行为，7 项 owner 测试再次通过。类型检查与构建通过，脚本作用域未绑定标识符为 0。
- 离线原生平台夹具 13/13，通过真实本地顶栏/原生视图核验默认选择、忙拒绝、失败切回、分区、无 Node/preload/本地桥、UA 和布局。夹具主动拒绝官网公网请求，ERR_BLOCKED_BY_CLIENT 和忙拒绝日志是负向验收预期，不是官网连接实测。
- `electron . --self-test` 159 项 PASS，failures=[]。开发模式另有既有 Monaco CSP worker 被阻止并回退主线程的日志；本轮未改 Monaco/CSP，不将这些日志隐藏为无错误启动。
- dev-check 本轮文档无新增错误，整体仍为基线 5 errors / 3 warnings；无关归档元数据和审计未修改，整体校验不能称为通过，不进入提交/合并门。
- 独立只读评审发现加载恢复后旧提示未清，已加 did-finish-load 清理并回归。两名 reviewer 对互不属于自身实现的 scope 只读评审通过，独立复跑 50 项、16 项均通过 0 跳过；无已证实代码阻断，完整 IDE 登录持久化人工验收仍 pending，不归档。
- 用户报告完整 IDE 重启后 DeepSeek/ChatGPT 仍需登录，因此不得宣称正式 IDE 重启保持已通过。按用户要求再次正常关闭/重开，确认相同固定 probes/ide-01 目录；只读 SQLite 聚合元数据确认 postcheck-02 有 chatgpt.com 持久 Cookie 记录，但未读取名称/值，记录存在不能证明认证有效。用户已明确推迟登录保持验收，本轮不再要求登录或执行受控重启。DeepSeek 本次隔离目录未确认完成过登录，不预期继承安装版数据。
- 评审期间新增无关 `tools/audit-background-history.cjs`，未触碰，不纳入本任务提交范围。

- 用户明确推迟完整 IDE 登录保持验收，不再反复重启或要求登录；本计划保留 active 跟踪该未验收项。用户随后确认开始 ChatGPT 纯文本自动执行/自动继续，后续实现与验证归 `docs/plans/archived/2026-10-11-chatgpt-text-automation.md`，上述“本轮不接入自动化”是本阶段范围记录，不代表当前能力。
