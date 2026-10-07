---
artifact_type: adr
status: accepted
created: 2026-10-02
updated: 2026-10-07
owner: 胡运宽
source_of_truth: [src/shared/toolProtocol.ts, src/shared/formatSpec.ts, src/main/replyCollector.ts, src/main/tools/harness.ts, src/main/tools/changes.ts, src/main/returnPathService.ts, src/main/fileService.ts, test/toolProtocol.test.ts, test/toolChanges.test.ts, test/returnPathService.test.ts]
---

# ADR-0004：只读回程解析与本地工具信任边界

## Context

官方网页回复是外部文本。模型可以生成文件修改和命令请求，但文本格式不能授予本地能力。IDE 必须在本地主进程校验正式请求、预选权限、原文与目录身份，网页自身不能持有文件桥。交互回传边界见自动结果回传 ADR，身份与驱动核验见 ADR-0003。

## Decision

- 网页回复的读取与解析保持只读。正式调用只能来自唯一 `mini-ai-tools` JSON 批次，普通解释和代码示例不产生操作；批次整体先校验，不能从正文猜测工具、路径或授权。
- 权限由用户预选，IDE 决定自动执行或发起授权请求。拒绝返回真实拒绝状态，不由模型宣布获批。网页没有 IPC、文件系统或任意工具入口。
- 文件修改统一经 `apply_changes`，内部使用 `ReturnPathService` 计算精确 old_string/new_string 替换、冻结基线和撤销。准备本请求全部变更、处理目标草稿后逐项直接写盘，实际失败保留已完成事实；右侧只查看执行快照，不产生第二条应用链路。
- 路径校验与权限属于主进程 owner；编辑器文件桥限用户打开的项目，授权的项目外工具目标采用隔离 owner，不扩大编辑器根目录。
- 写入前复核原文、文件身份及目录版本；唯一匹配不等同于代码正确。失败不模糊匹配、不重建已消失目标、不静默覆盖外部修改。
- 当前工具结果可按设置自动复制。开启自动继续时，可由限定发送 owner 将同源真实整批结果填入并发送至当前官方网页；首条需求与自由对话仍由用户输入。回传必须符合 `docs/adr/2026-10-07-automatic-result-return-boundary.md`，不能扩展成任意网页自动化或 AI HTTP 代理。

## Alternatives Considered

| 方案 | 原因 |
|---|---|
| 网页直接持有本地文件／工具桥 | 外部页面取得本地能力，破坏进程与授权边界 |
| 普通代码框或模型口头说明直接执行 | 缺少可信参数与确定性规则，不能获得授权 |
| 变更查看另外提供人工应用链路 | 形成两套写入口，重复写盘与状态分歧 |

## Consequences

模型负责生成规范请求，IDE 负责权限与实际执行，结果真实可审查。工具修改、原文复核与撤销有明确 owner；查看快照不随人工后续编辑变化。逐文件写入不提供跨文件事务或跨进程锁，系统错误可能导致部分成功，必须显示真实结果。

## Related

- `docs/capabilities/return-path-and-format-contract.md`
- `docs/capabilities/tool-harness.md`
- `docs/adr/2026-10-06-native-tool-harness-boundary.md`
- `docs/adr/2026-10-07-automatic-result-return-boundary.md`
