---
artifact_type: plan
status: archived
created: 2026-10-15
updated: 2026-10-15
owner: agent
plan_readiness: ready
source_audit: docs/audits/2026-10-13-performance-exploratory-audit.md
covered_findings: [PERF-07]
deferred_findings: [PERF-03, PERF-08, PERF-09]
---

# 工具账本事务性能

## Goal And Scope

测量并减少工具账本事务随历史增长的主进程复制和无效写盘开销，保持所有去重记录、原子持久化与执行前确认。仅修改store.ts、针对性测试、测量夹具和相关文档；不换存储格式、不加数据库/日志双轨、不延后真实状态落盘、不淘汰记录、不改工具执行或官网。用户已验收首屏优化并授权继续性能优化，未授权Git提交/合并。

## Assumptions And Decisions

- 先测100/1000/10000批、每批10请求，区分加载、真实状态变更、重复/冲突、相同状态与配置；记录耗时和复制/写盘次数，不预设提速比例。
- 工程路线：同一串行事务中按变化路径创建下一快照，只复制被改请求、条目或配置；持久化成功后才发布内存。真正无变化返回现有已持久快照，不写盘。仍采用原version 1 JSON与临时文件原子重命名，保留10000上限及坏文件失败关闭。
- 不确定性：真实更新仍需全量JSON序列化和写入；本轮不声称消除随文件规模增长的所有成本。若测量表明需要改持久化架构，停止该扩展并单独确认设计。
- dev-split: local cleanup / no split。store.ts是唯一事务状态owner，保持公开入口/导出稳定；不在harness/integration添加缓存或第二账本。测量归tools/measure-tool-store.ts，回归归test/toolStore.test.ts。
- ADR/Design system gate: not needed，格式、状态语义、权限、界面与owner不变。
- 复用当前独立性能分支，保留已验收首屏改动及两个既有未跟踪路径，所有变更待后续统一展示及批准，不自动提交或切换master。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| TS-1 | done | 建立真实磁盘基线 | 100/1000/10000批各3样本，真实磁盘及克隆/写盘计数；仅临时合成元数据 |
| TS-2 | done | 按变化路径复制及跳过无变化事务 | 17项针对性回归通过，新增意图测试在改动前2项失败、改动后通过；原子失败、在途快照及队列无丢失通过 |
| TS-3 | done | 回归与同口径复测 | 前后18真实磁盘样本校验通过；类型/构建通过；全套并发4条件1167/1167、0跳过，默认并发超时记录保留 |
| TS-4 | done | 文档与独立评审 | 能力/CHANGELOG/审计及本计划已更新，validate-docs无问题，独立生产及测量评审通过；待用户验收 |

## Acceptance Criteria

重复批次、冲突、相同状态不克隆全账本或写盘；实际变更不深拷贝无关历史；落盘失败不改变任何既有内存/磁盘记录、后续队列可恢复。不同项目/会话及手动来源保持现有判定；不改变历史长度、记录内容或读取快照隔离。测量不写性能断言到普通单测，不将合成数据等同现场体感。

## Artifact Routing And Closeout

能力文档tool-harness.md，原审计PERF-07，CHANGELOG与本计划；不新建重复性能清单。验证后保留active待验收，验收后归档。Git提交、合并、清分支及推送均不在本次授权内。

## Verification Record

- 前后真实磁盘各9样本（3规模×3），共18样本重启/去重核对通过。报告`C:/WINDOWS/TEMP/mini-tool-store-before.json`与`C:/WINDOWS/TEMP/mini-tool-store-after.json`，保留源码摘要和原始记录，不覆盖重写。before源码7398c7d1，after源码aa84633e。
- 10000批×10请求，约8.30MB；真实状态更新中位130.362→34.931ms，全账本structuredClone 1→0、写盘仍1次。相同状态147.821→0.014ms、重复333.708→0.103ms、冲突291.930→0.013ms、相同配置293.373→0.020ms，写盘均1→0；重复仅保留单entry的clone，其他无变化操作clone为0。真正配置变化仍写1次，中位326.501→33.218ms。
- 100批真实状态中位4.340→4.227ms；1000批17.447→10.697ms。加载中位100批21.046→19.529、1000批26.599→23.139、10000批80.650→76.173ms；加载未改动，按波动看待。旧版后两次大样本负载升高，不能据此宣称现场倍数/百分比。
- 测量目标为首条记录；仍保留线性查找，不宣称末尾查找最坏情况或任意规模恒定耗时。未隔离磁盘缓存和运行时预热，不测真实用户账本/GUI/官网，也不宣称解决自动回传中断。真实更新完整JSON序列化与写盘仍存在，PERF-07按局部优化记录，不当作增量存储已完成。
- 类型检查、构建及renderer作用域检查通过；测量工具不在主tsconfig内，另以相同strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes独立检查通过。独立生产及测量代码评审通过，未发现阻断项。

- 完整回归记录：首次与构建并行的默认`pnpm test`为1166/1167，40请求自动协作测试等待超时；无构建并行再次默认运行1165/1167，同一协作等待和进程清理10秒耗时限制失败，报告均保留，不能称默认命令通过。自动协作单文件21/21通过；随后以`pnpm exec tsx --test --test-concurrency=4 "test/**/*.test.ts"`执行相同全部测试，1167/1167、0失败/取消/跳过、exit0（约72秒）。没有修改测试、配置或耗时阈值；验证结论限定该并发条件，不对默认高并发稳定性作保证。日志分别为C:/WINDOWS/TEMP/mini-tool-store-tests.log、mini-tool-store-tests-final.log、mini-tool-store-auto-recheck.log与mini-tool-store-tests-concurrency4.log。
- 独立评审模式subagent；计划、审计覆盖、相关性、Changelog/Distill/Check通过。验证按完整并发4结果通过，默认并发失败如实记录。没有重跑与本轮无关的官网/完整GUI布局；上一项用户已知的缩放5/10限制仍保留。
- 本轮实现结束，活跃计划保留待用户验收；PERF-07为部分实施，不关闭完整JSON持久化随规模增长的剩余发现。没有提交、合并、删除分支或推送。

用户验收（2026-10-15）：用户在本轮测量、并发4条件及保留完整JSON成本说明后回复“ok, 继续完成后续任务”；本轮局部优化按既有证据验收，计划归档。PERF-07仍保留完整JSON随规模增长的剩余成本，未授权提交、合并或推送。
