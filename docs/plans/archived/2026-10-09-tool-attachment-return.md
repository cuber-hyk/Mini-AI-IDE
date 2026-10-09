---
artifact_type: plan
status: archived
created: 2026-10-09
updated: 2026-10-09
owner: tool-integration
---

# 工具附件回传

## Goal / Scope

AI 明确请求 `attach_file({path})` 后，IDE 按工具权限暂存真实文件，当前批结束后将结果正文与附件经官方 DeepSeek 上传控件一起发送。支持现有图片、PDF、Word、表格、幻灯片及文本类型，单文件 100 MiB、每批最多 50 个。

不实现 PDF 解析/OCR/截图工具，不扫描命令输出寻找文件，不新增网络代理或网页文件桥。技能可用现有 run_command 生成截图片后再请求 attach_file。

## Assumptions And Decisions

- 用户已确认支持图片及现有上传通道接受的文件，并沿用工具权限与 automatic：开启自动发送，关闭提供当前批手动发送。
- attach_file 是明确的上传请求，不归类为自动放行的项目文本读取；ask 模式需批准，rules/full 按既有规则。权限说明明确文件将上传到当前官网会话。
- 原文件字节走现有 WebComposerSender；不编码成 JSON/base64 正文。JSON 仅留真实文件描述及暂存状态，暂存不声称已上传。
- 附件及发送资格仅保留当前选择内存；历史恢复、新批、项目/会话切换及取消不复用；同批一旦开始运输不重试，未知状态交给用户。
- ADR gate: needed；用户授权扩展现有工具结果仅文本的网页边界。
- 真实官网新入口需人工验收；原生离线夹具验证运输且不能代替真实官网验收。

## Source Of Truth / Placement

事实源为 toolProtocol/harness/store/autoContinuation/integration、localPromptAttachments、webComposerSender；界面遵循 DESIGN，共用工具栏按钮与状态文字。

| Module | Owner responsibility | May depend on | Must not own |
|---|---|---|---|
| main/tools/attachments.ts | 当前选择已授权附件暂存与解析 | localPromptAttachments、files、harness 类型 | 网页写入、权限决策 |
| main/tools/resultReturn.ts | 当前批发送资格、一次运输与状态 | toolProtocol、resultClipboard、窄回调 | DOM、磁盘、工具执行 |
| main/tools/integration.ts | 工具 owner 接线和官网最新回复核对 | 各 owner | 附件存储、重复发送算法 |
| renderer/toolHarness.js | 手动发送按钮与状态呈现 | editorBridge | 本地文件访问、授权 |

Do not add to: src/main/index.ts（只接线）、src/main/tools/integration.ts（不放附件算法）。无需重构既有模块。

## Steps / Verification

- [done] PLAN-1 确认产品范围，提交合并旧附件分支并创建独立 codex/tool-attachment-return。验证：旧功能用户验收、697 全量测试及新增竞态 14 focused、build、独立复审；commit 1201fd4。
- [done] PLAN-2 新增 attach_file 协议及当前批附件 owner；复用文件类型和大小校验。验证：协议非法参数、类型、文件变化、跨选择失效、附件描述真实且无路径/字节桥。
- [done] PLAN-3 自动/手动共用一次结果发送 owner 与窄 IPC，发送前核对最新网页正式批次。验证：审批拒绝、取消/历史/未执行、会话/项目变化、后台进程等待、重复/未知不重试。
- [done] PLAN-4 本地工具栏手动发送入口、状态文字与附件动作摘要。验证：UI 请求不带路径或正文、忙/已发送/自动开启禁用、错误显示、键盘名称、共用控件与窄宽度。
- [done] PLAN-5 扩展原生离线运输夹具为工具图片、文档、混合附件，运行针对回归、build、全量测试。验证：bytes经官方input，正文在上传就绪后点击一次、失效守卫拒绝。
- [done] PLAN-6 更新 AGENTS/能力/ADR/路由/CHANGELOG/DESIGN，文档检查及独立评审，记录自动化验收边界。归档实施计划；用户已确认通过并批准提交、合并。

## Artifact Routing

Capability: tool-harness、human-machine-boundary；ADR: 2026-10-09-tool-attachment-return；context-map 更新 owner 路由；Changelog: Unreleased；design_system_impact: update（手动附件回传状态规则）。Audit: none。

## Closeout

已实现全部步骤并归档。验证：全量 722 项通过、0 失败/跳过；构建通过（renderer 无未绑定标识符，112 条既有非门禁诊断）；原生离线 39 项通过，包括工具图片/PDF/Word/混合上传及 240/360/620px 本地动作行布局；独立评审 62 项相关测试通过，无代码阻塞；文档检查无问题，diff 检查通过。

首次全量验证发现完整模板缺少新工具示例且长度超过原补充格式上限，已增加示例并将上限调整为 10,000，回归通过。测试夹具的切根调用与变化监听 mock 已按实际 API 修正；未跳过失败测试。

自动化测试未连接真实官网，离线成功不代表官网全部状态兼容。用户于 2026-10-09 确认本次功能通过并批准提交、合并；现有用户主动图片/文档需求亦已有用户实测。用户诊断文件保留本地，不包含在提交中。旧任务 commit 1201fd4 已 fast-forward 合并到 master；本次实现分支为 codex/tool-attachment-return，按批准提交并合并到 master，不推送。
