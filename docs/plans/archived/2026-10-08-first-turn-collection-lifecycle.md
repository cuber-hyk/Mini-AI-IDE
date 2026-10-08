---
artifact_type: plan
status: archived
created: 2026-10-08
updated: 2026-10-08
owner: 胡运宽
source_audit: docs/audits/2026-10-08-first-turn-auto-collection-audit.md
covered_findings: [FTA-01, FTA-02, FTA-03]
deferred_findings: [FTA-04]
design_system_impact: none
---

# 首轮采集与历史基线交接修复

## 目标与范围

官网真实点击/回车和本地需求在首页创建首个会话时，地址先于回复挂载且生成态不可识别，首条完整工具回复仍执行一次；从旧会话连续新建也成立。真正打开历史、重复批次、未知或中断回复不执行。

用户已要求修复上一轮分析确认的故障。本次不调整界面摘要优先级（FTA-04），不修改发送器、协议、权限、网络或指纹，不提交、合并、push 或发布安装包。

## 决策与事实来源

- 修复入口覆盖官网与本地发送；短期提交记录只用于同文档首页地址交接的连续性判断，不授予工具执行资格。
- 将既有 localSubmitAt 替换为共享提交记录：本地标记和已识别的可信官网发送/回车写入同一状态。其他真实动作取消旧交接且不能被新节点兜底复活，新的已识别发送可重新建立记录；超时、导航消费和监听重建后不继承。
- 已确认的首页首轮交接清除 AutoCollector 历史等待和 baseline，保留 last 去重及真实 observedGenerating 状态；不得伪造生成证据。
- 没有真实动作取消交接时仍可使用已有回复节点/真实生成连续性；没有这些依据的历史导航继续建立历史基线。
- 工程放置：replyChangeWatcher.ts 拥有 DOM/动作/导航记录；autoCollector.ts 拥有基线交接。无需新模块或改变公开 IPC。
- ADR gate：沿用输出驱动采集边界，更新现有 ADR 对导航连续性证据的说明；不新增采集授权或改变权限政策。
- Git：在 147689e 创建独立 worktree 和 codex/first-turn-collection 分支；主目录用户文档修改保持原样，仅复制相关审计作为输入。
- 来源：上述审计、src/main/tools/{replyChangeWatcher,autoCollector,integration,replyObservation}.ts、相关单测、tools/verify-web-result-sender.cjs。

## 步骤与验证

1. done：补当前实现下失败的官网 click/Enter 首轮、旧会话中新建首轮回归，以及记录失效/历史不执行反例。验证：修复前定向测试失败于首条执行断言。
2. done：统一首轮提交记录并修正采集器交接。验证：第一步用例通过，已有监听/自动采集/集成测试通过；unknown/idle 不因标记被执行。
3. done：原生离线 Electron 夹具使用现场完成控件结构，显式分离地址事件和延迟回复；覆盖冷/热首页及首次执行次数、第二次新建与历史反例。验证：原生夹具通过；可信事件分支由 VM 测试，原生合成事件不冒充可信点击。
4. done：运行相关测试、类型检查、构建和必要全量回归；更新 CHANGELOG、能力事实和 ADR 描述，回填审计并归档本计划。验证：dev-check 与独立只读评审，检查最终 diff，仅包含本任务修改。

## 验收与限制

- 接受依据是首条实际工具执行一次，不是 preserve=true 或发送回执。
- 首页首发交接后的空/unknown/中断/idle 不执行，complete 才执行；真生成后的既有规则保持。
- 历史加载、多次导航、失效标记和重复通知不得重放。
- 真实官网端到端仍需用户现场复测，离线夹具不代替官网验证。
- 计划完成后归档；审计保留 active，因为 FTA-04 未在本任务处理且官网验证仍需现场证据。

## 实施与验证记录

- 生产修改限 replyChangeWatcher.ts 与 autoCollector.ts：共享一次提交记录；非发送真实动作取消整次交接，禁止后挂历史节点复活；首轮交接清除遗留历史等待，保留正文去重与真实生成证据。
- 初次新增回归在修复前 6 失败、2 通过；独立评审补“点击历史后正文先于导航检查挂载”的反例，修正前失败，修正后冷/热首页都不执行历史。
- 最终 npm test：677/677 通过，0 失败、0 跳过；定向测试 72/72 通过。
- npm run build：通过（含 strict TypeScript 编译）；渲染脚本未绑定标识符 0，工具另报告 105 条非阻断语义诊断，未在本任务清理。
- node tools/verify-web-result-sender.cjs：28/28 通过，使用现场完成控件结构，连续两次新建首批各执行一次，历史及重复通知不执行。
- dev-flow validate-docs：No issues found；git diff --check 通过。
- 已更新 CHANGELOG、能力文档与现有 ADR 的交接说明，不新增架构授权。FTA-04 界面摘要问题仍 open，不影响本次采集执行修复；真实官网仍需现场复测。
- 独立只读评审模式 subagent；最终评审结果补于审计修复记录。工作区保留未提交修改，不合并或 push。