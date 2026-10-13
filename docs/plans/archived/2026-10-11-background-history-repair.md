---
artifact_type: plan
status: archived
created: 2026-10-11
updated: 2026-10-11
owner: Codex
source_audit: docs/audits/archived/2026-10-11-background-history-replay-audit.md
covered_findings: [BH-1, BH-2, BH-3]
deferred_findings: []
---

# 后台运行与历史误采集修复

## Goal And Scope

修复窗口被遮挡时网页后台节流，以及回看历史导致工具执行或解析诊断重复回传；保持 DeepSeek/ChatGPT 当前普通会话的新完成输出自动采集、权限、持久去重和一次发送边界。用户已明确“开始修复”。不改变协议、长度上限、命令权限、发送重试规则或官网网络出口。

## Assumptions And Decisions

- 当前未提交的 ChatGPT 接入是需要保留的开发基线；在独立工作树 codex/background-history-repair 使用当前工作区快照，最终按本轮差异同步，不提交或合并任何分支。
- 使用只读 DOM 顺序连续性和已见回复指纹区分新输出/历史；整个尾部被卸载或替换、无法证明新增时自动暂停，保留手动采集。正常在已有尾部之后追加的瞬时完成回复不要求发送回执或生成态。
- 使用 Electron 原生 backgroundThrottling:false 支持官网后台调度，不伪造 document.visibilityState，不改变 UA 或指纹。此配置影响 Page Visibility 和后台资源消耗，写入当前能力文档。
- dev-split: no split。回复来源跟踪使用具名 replySource owner，由只读 watcher 保存状态、observation 读取，autoCollector 只拥有执行调度；不把历史识别放进 integration/harness 或新增通用工具模块。index.ts 只增视图配置，禁止增加调度行为。
- 网站是否在用户滚动时卸载消息尚未现场核验；通过真实离线 DOM 重挂载回归阻止已确认路径，不声称完成官网现场验证。

## Steps

1. done：确认审计复现、调用关系和当前并行开发基线。验证：历史未入账命令/旧诊断/遮挡节流的审计证据。
2. done：在只读 owner 加来源连续性、已见历史防护，并阻断自动执行/自动诊断回传。验证：历史重挂载/前插/尾部卸载/节点复用/idle 与异步封存竞争/普通回复往返/快速新增/续写/导航回归通过。
3. done：两个官网视图采用原生后台调度配置。验证：真实遮挡、隐藏、最小化的定时器/画面帧/发送和命令四场景通过，0 跳过。
4. done：相关类型检查与构建通过；合并最新 ChatGPT 页面适配后的全量 920 项通过，0 失败、0 跳过。DeepSeek 原生发送/附件夹具 39 项与 ChatGPT 两轮真实离线闭环通过；官网现场未知未纳入通过声明。
5. done：变更记录、能力与审计更新，独立只读评审无剩余阻断；同步前复核并保留原工作区并行 ChatGPT 改动。无提交/合并/push。

## Closeout

实施与离线验收结束，计划归档。审计保持 active，仅保留官网虚拟化、用户原命令与 payload 归因的现场未知；已确认实现路径 findings 标记 verified。不可辨识的顺序追加历史边界保留在现行 ADR 与能力文档，未采用官网 API 或发送/生成资格屏障。

## Acceptance And Risks

- 自动继续开启时，已见历史、未入账历史、旧解析错误回看均不启动命令、不触发新发送；正常新完成输出仍执行一次。
- 权限和持久账本不重置；手动采集仍由用户明确选择。
- 官网视图被完全遮挡、隐藏或最小化时不因默认后台节流停止必要网页调度；系统休眠/官网网络失败不在保证范围内。
- 丢失消息顺序连续性可能需要手动采集；不通过猜测生成、模拟用户输入、自动重试或读取 API 补偿。
- Artifact routing：CHANGELOG、tool-harness/human-machine-boundary/app-shell/web-platforms 能力、context-map、相关测试；审计闭环仅针对已证实实现路径，现场 payload 原因保留未知。设计系统无变化。
