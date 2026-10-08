---
artifact_type: plan
status: archived
created: 2026-10-08
updated: 2026-10-08
owner: 胡运宽
design_system_impact: none
---

# 本地新会话首发的自动采集衔接

用户确认在新会话首次本地发送后自动采集失效，要求修复。目标是官方首页首发的一次同文档地址分配保留新轮，发送未确认不执行、首页正文不作为工具会话；真正切会话/项目、关闭开关、失败/未知发送继续取消。无新网页能力或重试，不改 isTrusted 检测。

1. 复核 sender、watcher、integration 和 controller 的三层作用域取消，保持现有已有会话切换拒绝回归。
2. sender 仅实际点击后的首页→官方 /a/chat/id 一次分配可返回目标回执；watcher 为本地主动提交保存独立短期标记，真实用户动作、消费与取消清理标记；integration 仍以回执闸门控制执行。
3. 覆盖网址先到/回执先到/最快正文先到，以及开关/项目/二次导航取消；原生离线官方 origin 夹具通过本地 protocol handler 提供 HTML，阻止外网，不连接官网。
4. 类型、影响测试、构建、自检和独立复查；同步当前能力/ADR/CHANGELOG。不提交合并发布。独立复查已指出不得放宽通用会话校验；沿用技能/本地需求 ADR，仅补首发状态衔接。


实施结果：新增纯地址判断 `firstPromptSession.ts`；sender 仅点击后交接一次首页地址；watcher 保存并消费只读首发标记；integration 在地址交接后等待发送回执，容纳 DOM 已确认而 IPC 尚未送达的原首页回执。导航元数据不等待采集，避免与发送 gate 循环等待；自动继续只取消 results。LocalPromptController 保留选项/项目/忙状态校验，会话合法性交由受控 integration/sender 核验。

验证：完整测试 658 通过、0 失败/跳过；构建通过（裸标识符未绑定 0，其他语义诊断 105 条由原检查工具报告为非阻断）；Electron 自检 PASS、无失败项，日志仍报告 Monaco worker CSP 限制并回落主线程，未扩展本次修复范围。22 项原生离线 DOM 夹具通过，包括真实 sender/watcher/integration 的“地址先到”和“完整正文先同步挂载再分配地址”，均只执行首轮一次；另覆盖点击前迁移、工具结果禁止例外、二次迁移与交接不等采集。最后补充 automatic 关闭/项目 reset 的集成回归 12 项全部通过。

独立只读复查确认地址回执竞态、交接等待死锁与取消来源问题已关闭，无新增阻断。当前能力、ADR、CHANGELOG 同步；未连接真实官网，不声称真实官网端到端验证；未提交、合并或发布。
