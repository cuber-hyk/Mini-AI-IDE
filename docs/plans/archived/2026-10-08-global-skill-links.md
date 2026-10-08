---
artifact_type: plan
status: archived
created: 2026-10-08
updated: 2026-10-08
owner: 胡运宽
design_system_impact: none
---

# 全局共享技能目录链接修复

目标：全局目录内登记的技能目录符号链接与 Windows junction 可发现/加载；项目同名优先不变，项目越界链接仍拒绝，SKILL.md 不越出所属真实技能目录。用户要求无可用技能时仅空列表，不显示原因。不改变工具权限或自动执行资源，不提交或发布。

验证问题：真实 ~/.agents/skills 的 14 个技能均为链接，原扫描返回 0 个技能与 14 条越界错误。

实施：SkillService 按来源限定目录链接边界；localPrompt 目录结果为空或读取失败时保持空列表并恢复输入可用状态。原分支 codex/20261008-skills-local-prompt 原地修复，不处理其他未提交改动。

验证：34 项影响回归通过，0 失败/跳过，包含共享目录 junction/符号链接、项目覆盖、项目越界、正文文件链接越界、空列表无提示及输入不锁死。构建通过；真实全局扫描恢复 14 个技能、0 错误。人工复核共享目录只授予 SKILL.md 读取，编辑器桥与资源执行入口未扩大。ADR/能力/CHANGELOG 已同步。
