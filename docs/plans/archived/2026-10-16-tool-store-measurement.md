---
artifact_type: plan
status: archived
created: 2026-10-16
updated: 2026-10-16
owner: agent
plan_readiness: ready
source_audit: docs/audits/2026-10-13-performance-exploratory-audit.md
covered_findings: [PERF-07]
deferred_findings: [PERF-03, PERF-09]
---

# 工具历史存储剩余成本测量

## Goal And Scope

量化当前完整JSON写盘在100/1000/10000批、每批1/10/50请求下的成本，比较首条/末条目标，并区分序列化、真实磁盘写入与其余耗时，据此判断是否值得另立存储优化任务。只测临时合成元数据，不读取用户账本、命令或输出，不运行协议工具，不改变产品存储格式、去重上限、权限或持久化顺序。

用户授权先收尾布局验收修正，再独立测量存储；前任务已以d7b8439提交合并至master。本轮分支codex/20261016-tool-store-measurement，不自动提交/合并/push。两个既有未跟踪用户路径保持原状。

## Assumptions And Decisions

- 既有优化已去除全量clone与无变化写盘；剩余真实变更仍完整JSON原子保存。本轮先测量，不预先选择数据库、日志或分段格式。
- dev-split: no split。ToolStore与其调用方只读，测量扩展唯一入口tools/measure-tool-store.ts，重用已有真实磁盘夹具/计数/重启核验，不创建通用性能框架，不向生产添加钩子。
- 序列化与文件I/O分项只在独立CLI进程、指定临时目录和合成StoreData上统计；原函数仍执行，计时包装有开销。报告中位数/范围和原始样本，不凭少量样本宣称稳定P95、安装版卡顿或GUI帧率。
- 每个组合至少5样本；未隔离系统缓存与进程预热，不据此判断冷盘或现场体感。首尾目标的无变化操作用于观察查找成本，不能把总耗时都归为写盘。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| SM-1 | done | 阅读当前store、调用方及旧测量边界 | 生产store保持不变；确认reserve/updateResult先持久后继续，原测量只覆盖首条×10请求 |
| SM-2 | done | 扩展现有测量维度及分项计数 | 每样本重启/去重/冲突/未变历史一致；无变化0写盘、真实变化完整写盘；工具独立strict检查通过 |
| SM-3 | done | 运行受控测量并解释结果 | 系统Node与应用Electron运行时各90样本，18组合×5；保留原始数据/hash，分项不重复计数 |
| SM-4 | done | 独立评审及文档收尾 | 独立重算中位值及数据校验通过，原审计PERF-07保持open；文档/diff检查，计划active待验收 |

## Acceptance And Closeout

输出可复核的测量数据和下一步建议；不把“测量完成”描述为存储优化完成。若证据显示大账本同步序列化/全量写入值得改进，另行列出需要确认的持久化/迁移方案，不在本轮直接实现。更新原审计及本计划，测量工具使用方式变化时更新tool-harness能力文档；不新增用户版本变更记录。完成后待验收归档，不自动提交。

## Measurement And Results

生产ToolStore源码SHA256仍为aa84633ebdde08c5c932a0b42a0d5a2f5f0f250ff0dbe35a3dd3e9301ffa1b7f；测量脚本最终SHA256为da361e99285dd338f93ab2614152e5a86eb18da4c2adfee40d6063bfa98d4b94。产品代码及磁盘格式未改。

系统Node22.19首轮：C:/WINDOWS/TEMP/mini-store-remaining-20261016.json；应用自带Electron44.5.1、Node24.21.0、V8 15.2.124.28-electron.0复测：C:/WINDOWS/TEMP/mini-store-remaining-electron-20261016.json。各90样本，3批次数×3请求数×2目标位置×5次；共180样本重启、去重、冲突和未变化历史核验通过。Electron复测只在独立CLI子进程设置ELECTRON_RUN_AS_NODE=1，并由tsx装载同一工具，无窗口或真实用户资料；它缩小引擎差异，但仍不是实际GUI场景。

主要依据采用Electron复测，各数字为首/末两个目标各5样本的中位数范围，不是P95或最大延迟：

| 历史规模 | 单份JSON | 单次真实状态更新 | JSON序列化分项 | 相同状态的末尾更新 |
|---|---|---|---|---|
| 100批×10请求 | 0.08 MiB | 6.39–6.58 ms | 0.10–0.11 ms | 0.016 ms |
| 1000批×10请求 | 0.79 MiB | 9.23–11.11 ms | 1.52–1.88 ms | 0.067 ms |
| 10000批×10请求 | 7.92 MiB | 52.37–54.27 ms | 19.10–19.42 ms | 0.625 ms |
| 10000批×50请求 | 31.95 MiB | 163.50–215.28 ms | 86.44–113.53 ms | 0.601 ms |

10000×50加载中位327.03–335.98ms；首条真实更新原始范围197.15–332.71ms，末条160.19–186.84ms，说明噪声/GC/次序效应显著，不能声称首尾真实更新严格随查找位置增大。系统Node22轮相同大组合约301–323ms，不能把两运行时差值当成代码优化收益。

判断：小账本没有立即重构的证据；大量请求历史下，全量JSON序列化与保存值得独立优化。末尾无变化查找不足1ms，与真实变更百毫秒形成明确差距，优先减少每次实际更新需序列化/落盘的数据量。不能简单延迟保存、淘汰去重或放宽失败关闭来换速度；若继续实施，需另行确认持久化方案、旧记录迁移及损坏/中断恢复边界，当前未选择数据库/追加日志/分段格式。

## Verification And Gates

- 每个样本7操作，无变化写盘/StoreData序列化均0，真实状态/配置变化各1次；实际完整写字节与最终文件精确核对。首尾每样本轮换先后；合成请求仅有read_file描述，不执行任何工具，权限规则夹具为空，不代表所有ID长度和规则上限的最坏字节数。
- 分项只包本夹具路径和StoreData；原始样本中clone/stringify/write/rename分项和不超过总耗时。各分项中位数不可相加解释总中位数；剩余耗时含mkdir/rm、UTF8统计、事务/查找与计时开销。缓存/预热未隔离、不测真实主进程响应、GUI帧率、冷盘或fsync耐久性。
- 测量工具通过独立TypeScript strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes检查；ToolStore单元17/17，无失败/跳过，日志C:/WINDOWS/TEMP/mini-store-remaining-tests.log。未修改产品代码，不重复无关完整测试/GUI。
- PowerShell带逗号参数需引号；首次未引用的命令在夹具创建前因参数拆分被拒绝，失败日志mini-store-remaining-20261016.log保留。有效系统测量日志mini-store-remaining-20261016-run.log，Electron日志mini-store-remaining-electron-20261016.log；所有报告在C:/WINDOWS/TEMP，输出wx不覆盖已有报告。
- mode=subagent独立只读评审：两轮90样本各18组合、全部重启/字节/分项校验及各630项中位重算一致；两轮生产源码hash一致，Electron复测脚本hash与当前文件一致。系统Node首轮报告没有脚本hash字段，其后只补充运行时/脚本元数据，不将该字段虚构为首轮核验。无阻断。Changelog/Design/ADR gate不需：纯内部测量无产品行为/界面/架构变化；Distill更新工具用法和原审计，PERF-07仍open。计划active待本轮验收，测量分支未提交/合并/push。

## 最终验收与归档

2026-10-16，用户明确本轮“只做验证记录，可以提交收尾合并”。本轮仅提交测量工具、原始合成数据报告及相关文档，未修改生产ToolStore、持久化格式或任何权限/去重逻辑；计划归档。PERF-07仍open，后续优化需另行立项，PERF-03/09保持原状。本次不推送远程，既有未跟踪用户文件不纳入提交。

两份原始报告原样归档至`docs/audits/evidence/2026-10-16-tool-store-node.json`和`docs/audits/evidence/2026-10-16-tool-store-electron.json`，避免临时目录清理后丢失180样本；以Electron复测作为主要结论，运行时差值不当作优化收益。
