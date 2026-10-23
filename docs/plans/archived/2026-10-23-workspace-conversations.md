---
artifact_type: plan
status: archived
created: 2026-10-23
updated: 2026-10-23
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 项目网页会话绑定与双向同步

## Goal

用户显式收藏官网普通会话到本地项目，以“项目 → 平台·账号 → 会话”展示，双向切换与选中同步且不扩大网页权限。

## Scope

- 包含：本地绑定持久化、解除绑定、分组列表、账号/平台联动导航、官网导航同步、网页触发跨项目静默保存、失败隔离。
- 不包含：历史镜像、自动绑定、新建官网会话、修改归属、网页删除/改名、每会话常驻视图或后台并行任务。

## Assumptions And Decisions

- 用户已确认：仅显式绑定，同一平台/账号/会话唯一项目归属，无归属迁移入口；点击项目只切本地，点击会话才导航官网。
- 用户已确认：官网切到其他项目的已绑定会话，静默保存当前全部脏文件，不询问或提示正常保存；失败保留项目和草稿，显示原因并阻断不匹配自动工具。
- 本地点击会话跨项目继续使用现有未保存保护；正常点击项目与关闭/退出保存策略不变。
- 官网身份取正式白名单地址和本地账号编号；绑定标题取原生网页标题，未知时使用会话 ID 占位，不读取正文、认证或官网存储。
- 无绑定会话仍沿用当前本地项目与工具行为；列表只收藏已绑定会话，不把导航当作绑定授权。
- 持久化以主进程独立元数据文件为唯一事实源，不写入 Chromium 分区或项目正文。

## Structural Guidance

- 分类：no split。现有 index.ts 与 tools/integration.ts 只增加接线/门禁，不迁移无关逻辑；selfTest.ts 不增加业务实现。
- 新 owner：shared/workspaceSessions.ts 身份与契约；main/workspaceSessionStore.ts 元数据；main/workspaceSessions.ts 导航/项目协调与窄 IPC；renderer/workspaceNavigation.js 本地导航展示。
- 静默保存复用 EditorSession 保存回执与 WorkspaceController 串行目录切换；不新增文件写盘通道。
- Do not add to: src/main/index.ts 会话持久化、导航竞态或同步状态机；不创建通用 helpers/utils。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 核对现有项目、账号、导航与保存 owner，隔离任务分支 | 源码与 capability 对照；原工作区未跟踪文件保留 |
| PLAN-2 | done | 严格会话身份与原子持久化，仅显式绑定 | 身份白名单、重启、重复跨项目绑定、损坏与写入失败测试 |
| PLAN-3 | done | 接入双向导航、选中与工具活动门禁，新增静默保存方式 | 同/跨项目、失败、连续导航、后台账号/子 frame、旧回传不复活、IPC来源测试 |
| PLAN-4 | done | 项目/平台账号/会话列表与显式绑定/解绑交互 | 界面行为测试、键盘与纯文本、旧状态回执、离线原生渲染验收 |
| PLAN-5 | done | 回归、文档/ADR/设计与变更记录、独立评审 | 类型检查、构建、完整测试、离线原生夹具、validate-docs、只读评审 |

## Acceptance Criteria

- 无导航、启动、首发或标题事件会创建绑定；IPC仅接受本地编辑器主frame，参数为已注册项目索引/已有绑定ID。
- 平台/账号与正式会话身份唯一；只导航白名单官方普通会话，不提供任意URL、分区、正文或文件接口。
- 选中由实际活动网页与项目核验，迟到导航/保存/平台回执不覆盖当前意图；失败和未绑定状态明确。
- 官网触发跨项目先静默保存所有脏标签；失败无草稿丢失、无错误项目工具执行，不拦截/回退官网导航。
- 真实切换撤回旧待发送、历史只建立基线；不会因切回会话恢复旧回传资格。
- 解除绑定仅影响本地列表，官网内容不变；其他项目切换与退出保护保持现有规则。

## Artifact Routing

- 新 capabilities/workspace-sessions.md、accepted ADR、更新 AGENTS/CONTEXT/context-map、相关能力文档与 DESIGN.md、CHANGELOG.md。
- design_system_impact: update；复用共用token、项目按钮、树缩进与原生保存回执。
- 测试按身份/存储、协调、保存、UI owner放置；原生离线验证不代表真实官网登录/草稿恢复验收。

## Closeout

- 分支 `codex/20261023-workspace-conversations` 在独立托管工作目录实施，原目录未跟踪内容未改动。
- `pnpm run typecheck`、`pnpm run build` 通过；最终全仓 1308 测试通过，失败/取消/跳过均为 0。
- 完整应用 `--self-test` 159/159 PASS，正常退出码 0；新增 workspace 通道纳入自检前缀扫描。活动网页销毁时不再经平台状态读取失效原生对象，退出回归已用真实应用及专属单测验证。
- `node tools/verify-workspace-sessions.cjs` 14/14 通过，实际双文档保存与保存失败保护、340/200px 原生渲染通过，0 弹窗、0 网络请求；截图已人工检查。
- `validate-docs` 无问题；DESIGN、CHANGELOG、能力文档、上下文路由与 accepted ADR 已同步。
- 独立只读 subagent 评审已修正并核验准备期旧平台广播、中断遗留等待、后台慢加载占用操作、旧失败覆盖新准备锁四类问题；追加销毁回调问题经只读复现核验与主代理回归检查通过。最终人工 diff 复核的计划符合性、相关范围、验证证据及文档/设计门禁均通过，无剩余已知阻断。
- 真实官网登录、网页草稿保持和人工切换体验为用户现场验收边界；离线夹具不冒充该证据。计划验收使用的本地路径与状态规则均已验证。
- 不提交、合并、删除分支或推送；保留工作目录供用户审阅。
