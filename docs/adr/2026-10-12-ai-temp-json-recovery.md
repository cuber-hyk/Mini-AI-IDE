---
artifact_type: adr
status: accepted
created: 2026-10-12
updated: 2026-10-12
owner: 胡运宽
source_of_truth: [src/main/tools/aiTempDirectory.ts, src/main/tools/jsonDraft.ts, src/shared/toolProtocol.ts, src/main/tools/harness.ts, src/main/tools/integration.ts, src/main/tools/resultReturn.ts, src/main/tools/autoContinuation.ts, test/aiTempDirectory.test.ts, test/aiTempIntegration.test.ts, test/jsonDraft.test.ts, test/toolAutoContinueIntegration.test.ts]
---

# ADR：按项目隔离的 AI 临时目录及未执行 JSON 草稿局部恢复

## Context

AI 处理工具任务时需要稳定的临时目录，避免把生成的中间脚本与正式文件混放；临时目录必须以当前打开项目为作用域，不能覆盖、认领或自动清理未知数据。另一方面，规范工具 JSON 因语法截断等原因无法解析时，原有解析诊断不会执行工具，模型只能完整重发长批次。允许局部修复必须保证不会绕开原协议、权限、去重与官网一次发送边界。

## Decision

1. 由主进程具名 `AiTempDirectory` owner 实现 `get_ai_temp_dir({task_id})`，路径固定为当前项目真实根下的 `.mini-ai-ide/ai-temp/<task_id>/`。task_id 严格限定为以英小写字母开头的 3–64 位小写字母、数字和连字符。创建及复用检查目录真实路径、祖先与目标是否为链接或 Windows junction，并核验专用归属标记。已有未知目录或标记冲突拒绝使用，不静默认领、覆盖、迁移或自动删除文件；局部 Git 忽略不代表保密、沙箱或安全删除。工具仍通过原始预选权限、授权指纹、批次执行和持久去重流程，不改变其他命令 cwd，也不开放网页文件桥。
2. 只有单个、完整、顶层正式 `mini-ai-tools` 围栏中 JSON.parse 失败，才在主进程内存建立一个未执行草稿。语法正常但协议不合法、多围栏、旧文件协议和损坏的 `repair_draft` 均不能借此建立新草稿。诊断回传草稿 ID 和修订版本，不生成工具完成事件或执行账本。
3. 后续正式完整回复允许唯一 `repair_draft` 对当前修订稿按 old_string 唯一匹配执行一次内存替换；核对 draft_id、version、当前项目、会话、平台及采集代次。成功替换递增版本，若仍为 JSON.parse 错误则报告下一版本；若已成为合法 JSON 但协议校验失败，草稿失效，需重新提交完整合法批次。原始官网回复及历史正文从不改写；过期、错误、重复、歧义补丁不执行工具。
4. 修复为完整合法批次后，只通过既有 ToolHarness、ToolStore、权限和文件安全 owner 执行，不增加第二条工具入口。恢复来源关联原始回复、修订稿及补丁的摘要、版本、完整解析批次的摘要与当前作用域。ToolResultReturn 在自动发送前重新只读获取官网最新已完成回复，核验仍是该补丁、该版本和该执行批次；任何失配均暂停旧结果发送，绝不重放或猜测最新正文。
5. 取消、新无关回复、项目、会话、平台及生命周期代次变化使草稿或已恢复结果的发送资格失效。保留既有连续最多 5 次解析或批次校验错误回传规则，第 6 次暂停；正式工具运行失败仍返回真实结果，不把它伪装成 JSON 修复过程。唯一官网写入仍归 WebComposerSender，采集仍只读。

## Alternatives Considered

- 在网页编辑历史消息或自动补齐 JSON：无法证明来源与实际用户看到的回复一致，拒绝。
- 将任意格式错误、非法参数和旧工具协议都纳入草稿：容易产生不明确的执行意图与无限嵌套修复，拒绝。
- 独立执行修订稿并绕过 ToolHarness：绕过审批、静态整批校验或重启去重，拒绝。
- 使用系统全局临时目录或自动清理任务目录：无法维持项目关联且可能误删，拒绝。

## Consequences and Verification Boundary

局部修复能够减少重新输出整个长 JSON 批次，但 AI 仍必须生成正确且唯一的原文替换，不能保证每个模型回复可恢复。目录操作存在没有跨进程文件锁的 TOCTOU 风险；绝不声称提供针对敌对并发文件系统的完整沙箱。临时文件的容量、保密和删除由项目持有人负责。

2026-10-12 接手修复后全量测试 958 通过、0 失败/取消/跳过；构建和类型检查退出码 0，构建另报告 115 条非阻断参考诊断。回归含拒绝不创建、批准后创建、持久去重、40 请求长正文恢复、错误额度、关开自动继续、作用域失效及畸形补丁保留草稿。原生本地 DOM/composer 11 项通过，实际创建临时目录与文件并核验恢复来源回传；独立评审确认 ATR-005 / ATR-006 修复。用户随后明确确认 DeepSeek 和 ChatGPT 普通新会话均完成常规闭环验收，错误诊断、恢复结果及后续工具结果全程自动采集回传。Codex 另核对任务归属标记及 recovery-ok.txt 实际内容。两平台现场结论来源为用户确认，取消、历史和竞态边界证据来自离线回归；不扩展为所有官网页面均已验证。原有设计路线经确认并完成实施、评审和验收，ADR accepted；提交、合并及发布仍需用户单独批准。
