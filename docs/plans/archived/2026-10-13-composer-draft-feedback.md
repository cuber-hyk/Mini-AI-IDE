---
artifact_type: plan
status: archived
created: 2026-10-13
updated: 2026-10-13
owner: 胡运宽
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 草稿备份成功后自动展示

## Goal And Scope

用户已同意：当前ChatGPT工具回传保存草稿后，右侧默认打开实际备份TXT，显示明确保存提示，每份只打开一次，不抢键盘焦点，自动回传继续。仅本轮新产生的备份通知触发，不从启动或历史状态重放；不改变草稿保存、权限、网页运输、剪贴板和保留策略，不实现JSON粘贴执行。

## Decisions And Code Placement

- 沿用codex/chatgpt-draft-backup任务工作树，前轮已验收的备份实现是直接前置依赖；主目录多消息采集修复及性能审计保留。无暂存、提交、合并或推送。
- 保存成功且当前运输资格核对通过后，WebComposerSender一次同步回调通知主进程；只向编辑器推送当前项目root和备份相对路径，不含草稿正文，不新增invoke或官网桥。通知失败独立于发送，不使当前运输重试。
- 新composerDraftFeedback.js负责项目核验、一次打开及提示；renderer只适配既有文件入口。编辑器owner增加明确focus选项，文件区owner复用布局入口恢复右侧正文，保留其他缓冲。打开/读取失败仍显示已保存路径，不改变回传状态。
- dev-split：no split，发送器仅增加窄通知，稳定的新显示owner承接界面逻辑；不拆现有大型入口或添加泛化工具模块。
- Design gate：复用文件标签、状态提示和布局；更新DESIGN的已确认自动展示例外。现有accepted草稿备份ADR增加通知边界，不创建重复ADR。

## Steps And Verification

| Step | Status | Work | Verification |
|---|---|---|---|
| DF-1 | done | 核对批准交互及前置差异 | 原代码快照保留、主目录相关源文件与任务树一致 |
| DF-2 | done | 保存后单向通知及无焦点展示 | 通知在保存后覆盖前一次发生；失败/失效无通知，通知异常不阻断发送；项目/重复/打开失败反例通过 |
| DF-3 | done | 回归、构建及UI契约 | 原缓冲保留、focus=false、文件区恢复；原生57、主目录全量1000、type/build、文档与差异检查通过 |
| DF-4 | done | 独立评审、安全同步、官网验收 | 同步保留前轮差异；用户确认备份自动打开、内容完整、提示、焦点及两轮回传均符合预期 |

## Closeout

CHANGELOG、能力、context-map、DESIGN及现有ADR已更新；独立只读评审结论记录于本文。用户已完成真实官网验收，本计划归档。

## Verification And Review

UI聚焦25项及sender9项通过；独立只读34项相关测试全部通过，0失败/取消/跳过。原生57项通过、0失败、退出0，覆盖通知在保存成功后发出及通知失败仍只发送一次；主目录组合全量1000项通过，0失败/取消/跳过。主目录与任务树build/type通过，renderer未绑定标识符0、115既有信息诊断不判失败；正式docs检查及diff检查通过。

独立评审确认sender→index→专用单向通知→preload→renderer→实际文件入口接通；项目/版本/路径、去重、迟到与打开失败保护通过。focus:false最终传至Monaco且原buffer保留，恢复文件区只走现有layout owner。Design gate复用标签和状态提示、更新已确认交互契约；changelog/distill/check gate已完成。无新的持久架构owner或磁盘行为，accepted备份ADR记录单向通知边界。

按修改前快照逐字核对后同步16个源文件/测试/计划路径，保留主目录先前多消息采集修复、备份功能和用户性能审计。主目录已构建，新功能未暂存、提交、合并或推送。DF-4的独立评审、安全同步及官网验收完成，本计划归档。

## 官网验收与结案（2026-10-13）

用户对包含“自动打开实际备份TXT、内容完整、保存提示可见、两轮自动回传继续、不抢键盘焦点、原编辑缓冲保留”的验收问题明确反馈：“没问题, 符合预期”。本次已获得真实官网验收；DF-1至DF-4全部结束。沿用最终全量1000项、原生57项、独立34项及构建/文档/差异检查通过证据，本轮仅更新验收记录，不重复运行无新增代码的测试。

代码仍为未提交任务差异，两个任务分支保留；Git提交、合并、删除分支及推送仍须用户明确授权。其他未知暂停、用户性能审计与JSON粘贴执行讨论不属于本次结案范围。
