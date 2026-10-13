---
artifact_type: plan
status: archived
created: 2026-10-12
updated: 2026-10-12
owner: Codex
plan_readiness: ready
source_audit: docs/audits/2026-10-12-chatgpt-first-result-return-audit.md
covered_findings: [CGR-001, CGR-002, CGR-003, CGR-004, CGR-005]
---

# ChatGPT 采集与自有输入误暂停

## Goal And Scope

修复用户截图中可由生产代码复现的完成状态误判与未修改正文的自有输入误判，核查新增来源资格及推荐提示词挂载的关系。用户已授权分析、审查并修复。保持只读采集世界 1004、唯一发送运输世界 1005、普通会话/平台/当前批次/权限/历史去重守卫；真实输入、正文变化、未知结构、取消、点击后不确定仍暂停，不重发旧批。

不把推荐提示词出现或固定安静时长作为完成判据。截图不能证明实际 DOM 属性或草稿结构；现场证据与离线机制分开记录。无需重启当前窗口或读取凭据。

## Route And Owners

- 独立干净工作树：codex/chatgpt-auto-collection-pause，从 073756a 建立；主目录既有 JSON 恢复、临时目录及 docs 整理保持原样。
- chatgptPage 统一提供 ChatGPT 回复生成见证，供只读完成核验、watcher 和 sender 使用；页面无关区域 busy 不能授权或阻断工具轮次。
- WebComposerSender 仍唯一写入 owner，限定无语义变化的 P/文本/span/编辑器末尾占位 BR 读取；正文逐字一致才能发送或取消清理。真实 beforeinput/paste/drop/composition 接管立即作废自有文本资格。
- 来源身份仅在复现明确缺陷后调整，历史/节点复用反例必须保留；不以执行过命令或手动采集成功推断自动资格。
- dev-split: local cleanup，复用具名 owner，不拆入口或新增通用 helpers。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| CP-1 | done | 核对截图、当前代码、历史审计与诊断日志来源 | 已区分完成、来源、回传复核、输入接管、点击后未知；旧日志不作为新现场证据 |
| CP-2 | done | 编写反例并修复生成见证和编辑器同文归属 | 推荐区域 busy/有无提示词、真实生成、历史、同文 span/末尾 BR、正文更改/用户接管/取消反例 |
| CP-3 | done | 核验来源与延迟 DOM 变化，执行聚焦/全量及原生离线检查 | 不放宽历史或未知来源；原生 composer 一次点击，DeepSeek 回归，类型/构建 |
| CP-4 | done | 更新审计/当前事实/CHANGELOG，独立审查和用户官网验收 | 记录已证实机制及未验证现场，不声称离线结果代替官网；未提交合并推送 |

## Gates

ADR gate: update existing，修复受控自有文本识别实现，授权边界保持原契约，明确真实编辑优先保护。Design gate: not needed，无 UI 布局/设计规则变更。Changelog gate: needed，用户可见自动继续可靠性。Distill/check gates: needed，同步现有能力与审计证据。Review: independent read-only subagent；只在实现完成后评审。

## 验证检查点

独立工作树全量948测试通过、0失败/取消/跳过；构建/类型检查通过，渲染脚本未绑定标识符0，115项既有信息诊断不作本轮故障。原生ChatGPT composer31项、ChatGPT工具闭环7项、DeepSeek sender39项通过，均为离线本地夹具；不替代官网。独立代码审查正在核对正文指纹与采集输出边界。

## 最终实现检查点

- 独立只读评审发现 role=button 子树可能漏掉 collector 实际读取正文，已对齐 CodeContent 整体字节及段落短路读取范围；新增生产 watcher 封存后真正 JSON 变化反例通过。最新独立聚焦92项通过，无失败/取消/跳过，代码无剩余阻断。
- 任务补丁已定点应用主目录；integration 仅替换完成复核拒绝原因，原 JSON 恢复接线及此前测试保留。主目录组合构建通过，全量972项通过、0失败/取消/跳过。
- 原生组合检查首次首页两轮超时，没有计入通过；单独诊断复跑11项业务通过，但暴露 Windows 活动 profile 清理失败。fixture 改由 Node 父进程待 Electron 退出后清理自有目录，窗口销毁不抢先以0掩盖异常；修复后 node tools/verify-chatgpt-tools.cjs 11项通过、退出0且无未处理清理错误。首次间歇超时尚未独立归因，不宣称所有官网暂停已消除。
- 文档校验在主目录整理后的组合状态执行：No issues found；diff检查通过。工作树旧历史文档基线不纳入本任务改动。当前未提交、未合并、未推送。
- 用户已收到三轮只读官网验收提示词。CP-4 仅剩用户新版真实官网结果和失败时现场结构核查；不因离线成功归档活动计划或 CGR-005 审计。

## 用户官网验收与收尾

2026-10-12 用户按新版开发 IDE 普通 ChatGPT 新会话三轮只读提示词操作，明确反馈“三轮全程自动成功”，没有手动采集或回传。CP-4 官网闭环验收通过；本次已证实机制修复及验收完成，计划归档，未提交合并推送。

原截图“手动采集为空”、节点重挂载或取消未确认的具体现场仍未捕获，不声明其根因已经证明或永不再现；相关剩余证据缺口由活动审计 CGR-005 保留，若复现另立范围明确的修复计划，不扩大本次授权或放宽历史/未知状态守卫。
