---
artifact_type: adr
status: accepted
created: 2026-10-08
updated: 2026-10-08
owner: 胡运宽
source_of_truth: [src/main/skills.ts, src/main/localPromptController.ts, src/main/webComposerSender.ts, src/main/tools/integration.ts]
---

# 固定技能目录与可选本地需求发送

用户明确授权本地输入技能选择与可选需求发送，并选择手动决定是否附带初始化提示词。

采用全局 `~/.agents/skills` 与项目 `.mini-ide/skills`，项目同名优先。用户全局目录可登记指向共享仓库的技能目录链接，读取边界为链接解析后的技能目录；项目技能不允许越出项目技能根，SKILL.md 不允许越出所属技能目录。主进程固定入口服务读取 SKILL.md，完整技能通过显式选择或 load_skill 获取；不授予网页磁盘权限，不自动执行技能资源。

持久化两个独立选项：初始化默认附带，回车发送默认关闭。初始化不依赖会话记录；复制和发送共用受控组装。本地发送是用户主动提交需求，工具 automatic 仍只负责真正结束的当前批结果。

限定网页写入扩展为两个明确调用来源：本地需求 owner 与工具结果 owner，共用单一 WebComposerSender。共享运输同步预留发送资格，取消按来源区分，不允许互相清理正文。保留官方 origin、当前会话、空输入、已知局部控件、一次点击及不确定不重试限制；不改变真实动作 trusted 检测，不引入 API/CDP/模拟按键或剪贴板代送。

本地主动首页首发的发送器仍验证实际点击及一次同文档地址分配。采集独立于发送结果，不保存本地主动首发资格，不等待回执；新回复由输出驱动采集 ADR 管理。

代价是控件变化或发送产生未知会话迁移时暂停，由用户检查；不通过放宽来源、猜测会话或自动重试掩盖这些情况。该决策扩展原工具结果回传 ADR 的需求输入边界，其余回传安全与进程原则继续适用。
