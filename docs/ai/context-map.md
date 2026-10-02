# Context Map — 上下文路由

给代理用的路由表：做哪类任务时，**先读什么、别读什么**。默认上下文不得指向计划、审计或归档目录。

## 默认上下文（任何任务先读）

| 顺序 | 文件 | 用途 |
|---|---|---|
| 1 | `AGENTS.md` | 仓库级硬性约束、允许/禁止清单 |
| 2 | `CONTEXT.md` | 稳定词汇表，避免同名异义 |
| 3 | `docs/capabilities/` 下相关能力文档 | 模块当前事实与边界 |

## 按任务类型路由

| 任务类型 | 读这些 | 不要读 |
|---|---|---|
| 外壳 / 进程架构 / IPC | `docs/capabilities/app-shell.md`、`docs/adr/` 下架构类决策 | 历史计划、审计归档 |
| 本地文件读取 / 编码 / 大小控制 | `docs/capabilities/local-file-access.md` | 无关能力文档 |
| 人机边界 / 出程（什么由人做） | `docs/capabilities/human-machine-boundary.md`、`docs/adr/2026-10-02-zero-injection-and-automation-trace-baseline.md`（ADR-0003） | 回程解析细节 |
| 回程解析 / 一键应用 / 输出格式 | `docs/capabilities/return-path-and-format-contract.md`、`docs/adr/2026-10-02-return-path-contract-and-trust-boundary.md` | 指纹与网络层细节 |
| 指纹与环境特征 | `docs/adr/2026-10-02-honest-electron-identity.md`（ADR-0001）、`docs/adr/2026-10-02-zero-injection-and-automation-trace-baseline.md`（ADR-0003） | 实现细节代码（尚未存在） |
| 会话 / 登录持久化 | `docs/capabilities/session-persistence.md`（会话分区命名 ADR 为**候选未建项**，暂由该能力文档承载） | 计划文档 |
| UI / 设计规则 | `DESIGN.md` + `design-tokens.json`（**尚未创建**，由计划步骤 P5 产出） | — |

## 过程证据（非默认上下文）

- `docs/plans/` — 任务计划。只读当前任务的活跃计划。
- `docs/audits/` — 审计与发现。只读直接驱动本次任务的活跃审计。
- `docs/plans/archived/`、`docs/audits/archived/`、`docs/adr/archived/` — 历史归档，默认不读。

## 当前入口点

| 领域 | 入口 |
|---|---|
| 需求来源（初步想法，非最终裁决） | `IDE接入网页版AI.md` |
| 活跃计划 | `docs/plans/2026-10-02-mini-ai-ide-poc.md` |
| 决策记录 | `docs/adr/` |
| 回程机制（一键同步） | `docs/capabilities/return-path-and-format-contract.md` |
| 实现代码 | `src/`（尚未创建） |

## 维护规则

- 新增能力、ADR 或关键入口后必须更新本文件。
- 本文件**不得**把默认上下文指向 `docs/plans/`、`docs/audits/` 或任何 `archived/` 目录。
- 引用的路径必须真实存在。
- 脚手架阶段的例外：能力文档的 `source_of_truth` 目前**同时列出活跃计划**，因为尚无实现代码，当前契约由计划承载。**实现落地后必须移除计划项**，改以代码/测试为事实来源（该清理由 `/dev-distill` 在 P1 Gate 后执行）。
