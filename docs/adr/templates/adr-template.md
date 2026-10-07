---
artifact_type: adr-template
is_template: true
status: proposed
created: 2026-10-02
updated: 2026-10-07
owner: 胡运宽
source_of_truth: [AGENTS.md]
---

# ADR 模板

> **本文件是模板，不是 ADR。** `is_template: true` 用于把本文件与真实的 ADR 区分开：真实 ADR 的 `status` 只用 `proposed` / `accepted` / `archived`，且由 `docs/adr/` 直接持有（不在 `templates/` 下）。

复制本文件到 `docs/adr/YYYY-MM-DD-short-title.md` 后填写。文件名用小写英文与连字符。

```markdown
---
artifact_type: adr
status: proposed
created: YYYY-MM-DD
updated: YYYY-MM-DD
owner: <姓名>
source_of_truth: [<实现或测试路径>]
---

# ADR-NNNN：<一句话决策>

## 状态

<proposed / accepted / archived；若已接受，注明由谁在何时确认。>

## 背景

<是什么约束逼出了这个决策？列出代码事实、文档事实、外部限制。不要写方案。>

## 决策

<唯一路线。写成可执行的断言，避免 Option A / Option B 分支。>

## 备选方案

| 方案 | 为什么未采用 |
|---|---|
| <方案> | <理由> |

## 后果

**正面**：<收益>

**负面 / 代价**：<成本、限制、后续负担>

**已知风险**：<什么情况下本决策会被推翻>

## 关联

- 能力文档：<路径>
- 计划：<路径>
```

## 准入条件（ADR Gate）

四项全满足才值得写 ADR：决策**难以逆转**、未来的维护者会问"为什么这么做"、**存在真实的备选与取舍**、影响架构/数据归属/业务规则/工作流策略或多模块。

普通 bug 修复、局部重构、临时计划笔记**不写 ADR**。
