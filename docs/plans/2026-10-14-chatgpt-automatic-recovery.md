---
artifact_type: plan
status: active
created: 2026-10-14
updated: 2026-10-14
owner: agent
plan_readiness: ready
source_audit: docs/audits/2026-10-14-chatgpt-automatic-recovery-audit.md
covered_findings: [CGA-01, CGA-02, CGA-03, CGA-04, CGA-05, CGA-06, CGA-07]
deferred_findings: []
---

# 计划：修复 ChatGPT 自动流程停滞与有限恢复

## Goal

在不重放历史、不重复执行工具、不重发未知提交的前提下，使暂时监听故障和未进入运输的预检故障有界恢复，修复来源封存窗口，并准确展示阻断原因。

## Scope

- In scope：采集来源连续性、完成快照封存、同会话监听有限恢复、独立采集健康状态、预检阶段复核、发送超时阶段/取消证据、JSON 草稿提示与默认说明、离线长链故障注入和知识回填。
- Out of scope：更换 JSON 正式协议、盲补错误 JSON、历史全量未执行命令搜索、自动点击继续生成、改变权限、任意网页写入、AI API/网络代理、安装依赖、提交/合并/推送。

## Plan Readiness

- Goal clear：已确认至少三条可复现源码缺口；截图确认来源未知与运输超时两个阻断环节。
- Scope clear：用户在审计和方案说明后要求开始修复，采用此前建议的保留进度有限恢复。
- Source of truth known：审计中的 owner、对应测试及已接受采集/回传 ADR。
- Critical decisions confirmed：恢复仅限可证明连续的来源和无运输副作用的阶段；未知与人工接管保持阻断，不改变正式协议。
- Validation path known：针对性回归、类型检查、构建、长链故障注入、独立只读评审；官网现场另由用户确认。

## Assumptions And Decisions

- 使用当前 master 已有四项本地提交作为基线，不覆盖其他任务分支；既有未跟踪临时目录/UI 原型不处理。审计属于本任务。
- 截图不能还原完整时序，不承诺已证明所有真实中断的唯一根因；实现验证以可复现缺口和既有安全契约为准。
- 监听修复与导航重启分开：保留同文档来源状态及自动采集进度；状态丢失时保守建立历史，不从未执行记录推断授权。
- 新增资格仅来自连续追加/绑定生成证据。若使用官网 DOM 消息 ID 修复重挂载尾部，必须限定同文档/会话、ID 唯一及已确认正文；仅同文本不得授予资格。
- 轻量探测不能提前封存未接纳正文；实际接纳时按同一 sourceKey 进行封存及守卫复核。已接纳内容后续改写仍不能继承执行资格。
- 自动恢复限次退避，关闭/取消/导航/销毁及时撤销。长时间没有回复不是监听故障。
- 未开始运输且具备明确临时原因的预检允许有界复核；开始网页运输或附件读取后仍保留一次尝试。点击未知、取消清理不明、用户中断与历史不补发。
- JSON 继续使用唯一严格协议；有有效草稿时给唯一补丁指导，无草稿才完整重发。默认提示词提前介绍 repair_draft。
- UI 复用原有工具摘要/顶栏和反馈优先级，不新增控件、布局或视觉体系。

## Confirmed Choices

| Decision | Chosen route | Confirmed by | ADR gate |
|---|---|---|---|
| 恢复策略 | 按阶段保留进度、限次恢复，未知仍停 | 用户授权开始此前建议方案；工程参数由测试约束 | needed |
| 执行协议 | 保留 JSON 和既有草稿补丁 | 本次最小修复范围 | not needed |
| 模块结构 | no split；局部 owner 修复 | dev-split 职责审查 | not needed |

dev-split 约束：replySource 拥有来源状态；replyChangeWatcher 拥有只读订阅与恢复；autoCollector 拥有采集调度；resultReturn/autoContinuation 拥有资格与有界预检调度；webComposerSender 拥有唯一网页运输；integration 仅接线。Do not add to: src/main/index.ts（除必要接线外不放恢复策略）。不创建 utils/helpers 或第二条执行/发送链路。测试随 owner；长链测试放已有 integration/原生夹具入口。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 核对故障与安全边界，建立审计及可复现路径 | 已有内存复现、截图与针对性测试；本计划文档校验 |
| PLAN-2 | done | 修复来源封存、连续性与同会话监听恢复 | 轻量探测不封存、实际接纳/导航守卫、缺 key 零执行、稳定 ID 重挂载及同步/异步历史回归通过 |
| PLAN-3 | done | 修复预检暂失与超时阶段诊断 | 1/3/5秒三次预检；超时有界取消与附件清理竞争回归通过；未知运输不重试 |
| PLAN-4 | done | 接入采集健康状态及准确 UI，统一 JSON 草稿说明 | 集成/顶栏/工具面板/协议提示回归通过，采集暂停覆盖旧等待状态 |
| PLAN-5 | done | 长链故障注入、构建与独立评审 | 全量1126/1126、0跳过；类型/构建通过；30轮60请求原生闭环；独立评审阻断已修 |
| PLAN-6 | done | 更新 ADR、能力、变更记录和审计处置 | 恢复ADR、能力、AGENTS/路由及CHANGELOG已回填；文档/差异门禁记录下方 |
| PLAN-7 | todo | 用户在实际 ChatGPT 官网连续协作验收 | 启动本分支构建后连续30轮以上，含历史切换/后台及真实草稿，确认暂停有原因且无重复执行；由用户反馈现场结果 |

## Acceptance Criteria

- 同会话临时监听故障恢复后不清空已接纳/执行/回传状态；失败到上限明确显示原因。
- 轻量完成探测到实际接纳之间正文补全不会仅因探测提前封存而丢失资格；已执行正文变化与历史仍被阻断。
- 确认同消息身份的重挂载不执行旧命令，后续新回复仍可推进；无法确认身份时不猜测。
- 未进入运输的暂时预检失败可有界复核；不会重复执行命令、突破连续错误额度或重发未知提交。
- 采集暂停/恢复的状态不被“等待 AI 回复”、复制/音效等反馈覆盖。
- 默认提示词介绍 JSON 草稿修复；回执不再同时禁止与推荐补丁。
- 多轮故障注入与相关安全回归通过；记录官网人工验收尚未完成，不宣称彻底解决所有网站变化。

## Artifact Routing

- Capability updates：tool-harness、human-machine-boundary、return-path-and-format-contract。
- Audit output：更新原审计状态/证据，不把发现写入能力文档。
- Source audit：frontmatter 所列路径。
- Covered findings：CGA-01 至 CGA-07。
- Deferred findings：无实现发现预先忽略；真实官网验收单独记录边界。
- ADR gate：needed；修订采集来源、同会话恢复及未运输预检策略。
- Tests：既有来源、监听、ChatGPT 快照、自动继续、运输、协议、UI 与集成入口。
- design_system_impact：none；遵循 DESIGN.md 既有错误优先反馈，新增状态沿用现有区域。

## Verification Record

- 全量：`node node_modules/tsx/dist/cli.mjs --test --test-concurrency=4 --test-reporter=tap "test/**/*.test.ts"`，1126/1126通过，0失败/取消/跳过。此前默认高并发运行有一次原有进程树超时测试超过10秒断言；未改该测试或进程实现，限制测试并发后完整通过。
- 类型检查与构建退出0；构建裸标识符未绑定0处，116条既有参考语义诊断不作为失败。
- 原生离线：ChatGPT工具30轮/60项实际创建与读取，2次监听恢复、2次同消息重挂载、同步/异步历史隔离，执行/复制/运输各一次；ChatGPT composer 57项、通用运输39项、工具面板235项通过。均独立临时profile，不连接官网。
- 独立评审先发现附件超时重复清理及主动取消正文抢先结束两处P2，均补回归修复。复审运输66项、监听/集成106项通过，未发现新的确定阻断。另一来源审查的139项与上述测试有重叠，不累计为全量数量。
- 最终门禁：mode=subagent；plan compliance、audit coverage、related changes only、verification evidence、changelog、distill、check 均pass。设计检查复用现有状态区域/主题/焦点，UI235项及提示优先回归通过；文档校验无问题，git差异检查通过。代码经用户批准纳入本次提交，现场验收单独保留PLAN-7。
- 采集缺 key 的生产路径按失败关闭，4个网页测试替身改为明确来源与accepted，不引入测试专属生产fallback。
- 视觉/交互复用现有状态区域、主题与焦点规则；UI布局未变。原运输夹具末尾仍按已移除的正文文字按钮判位置，现改为检查实际摘要图标按钮，与当前DESIGN一致。
- 当前官网场景、真实模型输出错误率及安装版未验；不关闭真实中断/未知提交保护，不承诺所有未来DOM变化均自动恢复。

## Git Visibility

- 本计划和来源审计属于本任务；使用 codex/20261014-chatgpt-automatic-recovery 分支；用户已批准提交、合并及清理已完成分支，不推送。
- 写入后检查 git 状态和 validate-docs。

## Closeout

保持 active，唯一待执行步骤为 PLAN-7 真实官网验收，CGA-06 的现场部分由本计划承接。实现及离线门禁已完成，能力与决策已由 dev-distill 回填；用户现场确认后再归档计划和审计。用户已显式批准提交、合并及清理已完成分支；不推送远端。
