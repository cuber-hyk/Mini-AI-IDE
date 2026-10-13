---
artifact_type: plan
status: archived
created: 2026-10-13
updated: 2026-10-13
owner: 胡运宽
source_audit: docs/audits/archived/2026-10-12-chatgpt-first-result-return-audit.md
covered_findings: [CGR-011]
---

# ChatGPT 同轮多消息采集修复

## Goal And Scope

修复普通对话同一 complete turn 中包含较早 assistant 区域与最新正式 assistant 区域时，自动及手动采集均为空、额外消息页脚使完成判定未知的问题。仅调整 chatgptPage.ts 的只读消息选择及完成页脚归属，共用现有采集、监听、生成与回传入口。

不强制滚动、不读取或修改用户草稿、不改官网运输、权限、工具去重或历史来源规则；不接入双答案比较，未确认选择的比较结构继续暂停。不提交、合并、删除分支或推送。

## Assumptions And Decisions

用户确认当前故障页是普通对话，并提供三次只读结构快照。结构随渲染补齐：最新 turn 最终有两个 assistant 标题、两个 owner/正文，较早消息的页脚位于它自己的 owner 中，轮末页脚在消息 owner 之外。当前生产实现要求整轮唯一标题和唯一页脚，复现该结构即拒绝。按同轮消息的 DOM 顺序取最后角色标记，不允许在最后标记缺失 owner/正文时向前回退；选中 owner 内仍必须只有一个有效角色和正文，正文不能属于嵌套的其他 owner。多消息只接纳已核实的较早消息自带页脚、最后消息无内部页脚、由轮末唯一外部页脚结束的结构，未知/并列比较继续暂停。

分支 codex/chatgpt-multi-message-collection，基线 master 5895bd2；既有未提交差异仅本次诊断追加，随分支保留。实现单一 owner 仍为 chatgptPage.ts；脚本和回归夹具集中且紧耦合，不另拆新模块。Design system gate 不需要：无本地 UI 改动。ADR gate 不需要：现有最新正式消息、结束核验和只读边界的局部纠错，没有新增权限或架构。

## Fact Sources

- docs/capabilities/web-platforms.md、AGENTS.md、CONTEXT.md。
- src/main/chatgptPage.ts、replyCollector.ts、tools/replyObservation.ts、tools/replyChangeWatcher.ts、tools/replySource.ts。
- test/chatgptReply.test.ts 与 tools/verify-chatgpt-tools.cjs；来源/监听/接线相关测试。
- 用户当前失败页结构及普通对话确认；旧 collection-trace.log 不是本次证据。

## Steps And Verification

| Step | Status | Work | Verification |
|---|---|---|---|
| MMC-1 | done | 核对现场与生产守卫，分类工作区，建立分支 | 用户结构证明双标题及页脚归属；既有92项聚焦测试通过，0失败/跳过 |
| MMC-2 | done | 加入多消息采集/完成正例与不回退、歧义、其他消息页脚反例，先证实旧代码失败 | 两项新正例在旧代码失败；修正后104项聚焦及原生11项通过，0失败/跳过 |
| MMC-3 | done | 最小调整最新消息及外部完成页脚规则，验证监听/来源复用 | 最终104项聚焦、981项全量均全部通过；类型/构建通过、原生11项正常退出0；并行超时及单独复跑记录在source_audit |
| MMC-4 | done | 更新能力/变更/审计，独立只读评审，提供原故障会话验收 | docs check及diff check通过；2026-10-13用户确认原故障会话自动两轮及手动采集均成功 |

## Risks And Acceptance

渲染补齐时 owner 或正文仍可能短暂缺失，必须等待，不回退执行前一条。两份待选择答案的未知结构不得因按最后标记选择而自动执行；多消息模式必须具备已确认的内外页脚关系。历史回复、重复批次、真实中断或当前消息正文歧义必须继续拒绝。用户官网验收与离线测试分别记录，不能互相代替。

## Artifact Routing And Closeout

本计划及现有active审计记录CGR-011；CGR-005其他未知旧现场继续保留。更新web-platforms当前事实及CHANGELOG，代码入口未变无需改context-map。已复现并实现，最终全量981项、原生11项、构建/类型、独立93项、文档及差异检查通过，用户确认官网自动两轮及手动采集均成功，本计划归档。未提交或合并。


## Verification Checkpoint

独立subagent只读review：plan compliance、audit coverage、related changes、验证、changelog/distill/check均通过；latest owner内部页脚+全局页脚误选风险已加反例并修复。原生验证runner遇到run.error时退出1，最后差异独立复核通过。未知真实比较页继续不纳入支持范围。首次并行最终组合曾出现单项长JSON恢复超时及原生runner超时，未计为通过；分别复跑相关19项、原生11项、全量981项均通过。主目录生产构建已完成，未自行关闭用户窗口或清理登录数据。

2026-10-13 用户按验收步骤反馈“自动两轮和手动采集均成功”，原故障普通会话自动及手动入口验收通过；MMC-4结束，计划归档。修复不证明所有未知比较界面或旧取消现场均已解决；这些不属于本计划。代码仍未提交/合并/推送。

归档后的仓库文档复核：本次任务文档在性能审计出现前的正式检查通过；最后全仓检查发现另一任务新生成的docs/audits/2026-10-13-performance-exploratory-audit.md缺少YAML frontmatter（1错误），并有1项ADR门禁提醒。该未跟踪文档保持原状，本次未修正或纳入变更；不把全仓文档门禁报告为通过。任务差异检查通过，当前未执行Git提交/合并。
