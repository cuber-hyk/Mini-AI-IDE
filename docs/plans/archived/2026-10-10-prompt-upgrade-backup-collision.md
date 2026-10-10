---
artifact_type: plan
status: archived
created: 2026-10-10
updated: 2026-10-10
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 提示词迁移备份冲突修复

## 目标与范围

已有旧提示词备份与当前设置不同也能安全升级并启动；当前生效自定义、当前设置和所有历史备份均有保留。仅修改 SettingsStore 的迁移备份命名和对应验证，不改变提示词选择规则、会话分区、工具权限或更新运输。既有面板折叠修复留在原分支，不混入本分支。

## 已确认事实与实现约束

- 本机配置与旧备份均为有效 JSON，只在 workspaceLayout 和 formatSpecVariant 不同，自定义字段一致；固定备份路径的逐字相等检查导致启动中止。
- 保留现有固定备份；遇到不同内容时，以当前原始设置的 SHA-256 为后缀另存备份。相同原文复用相同备份，任何备份写入失败或同名内容校验失败仍保留原设置并明确报错。
- dev-split: no split。备份和原子落盘归 src/main/settings.ts；不在启动入口追加迁移或兼容分支，不修改已安装应用二进制。
- 事实来源：src/main/settings.ts、src/main/index.ts 的设置初始化、test/promptSettingsMigration.test.ts、docs/capabilities/skills-and-local-prompt.md。
- ADR gate: not needed；局部迁移修复，无新架构或权限。design_system_impact: none。

## 步骤与验证

1. done：只读核对本机配置和调用链，独立工作树建立修复分支；确认既有配置和备份均未修改。
2. done：三个新增回归场景在原实现失败；迁移测试覆盖历史备份保护、保存失败后配置变化、重试幂等及损坏同名备份保护。
3. done：修复备份命名；迁移及设置消费者 31 项测试全部通过，零失败、零跳过；构建与作用域检查通过。真实配置副本迁移和重启幂等验证通过，旧备份未变、当前原文另存。
4. done：确认应用未运行、原配置及旧备份与已验证副本完全一致后，由 SettingsStore 迁移本机配置；旧备份原文未变，当前原文已保存为独立备份。重复读取及原版 0.2.5 包内 SettingsStore 读取验证通过。能力和变更记录已更新；本轮不提交或发布。

## 产物与风险

测试表达备份不可覆盖、当前生效内容选择及原子失败保护；能力文档只记录当前备份规则，CHANGELOG 记录启动修复。计划完成后归档。旧备份无法读取、目录不可写、落盘失败继续明确报错，不能用默认值覆盖用户内容。

## 验证证据

- 日志：`C:/WINDOWS/TEMP/mini-prompt-collision-before.log`（原逻辑三个回归失败）、`mini-prompt-collision-tests.log`（31 项通过）、`mini-prompt-collision-build.log`（构建通过）。
- 独立只读评审：迁移测试 11 项通过、零跳过，无数据丢失或代码阻断项；未读取或修改真实 APPDATA。
- 真实配置副本及修复前快照：`C:/WINDOWS/TEMP/mini-prompt-upgrade-recovery-EZm05D`。恢复脚本核对源文件 SHA-256 后才迁移，保留旧固定备份和当前原文的独立备份；未修改安装版二进制或会话分区。
- 原版 0.2.5 验证读取的是此前发布包内旧 SettingsStore，不以修复后实现冒充安装版验证；仅验证配置加载，未启动官网或代用户发送消息。
- 文档门禁仍有已知的五项历史错误和三项警告，不把门禁记为通过；本次不修改这些无关历史文档。归档记录已完成的修复和本机恢复，提交与发布另行由用户批准。
