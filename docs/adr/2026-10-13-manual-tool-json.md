---
artifact_type: adr
status: accepted
created: 2026-10-13
updated: 2026-10-14
source_of_truth: [src/main/tools/manualToolJson.ts, src/main/tools/integration.ts, src/main/tools/harness.ts, src/main/tools/store.ts, src/main/tools/autoContinuation.ts, src/main/tools/resultReturn.ts, src/renderer/toolJsonPanel.js]
---

# 手动工具JSON执行与官网来源隔离

## Context

官网结构变化可能使自动/手动采集都失败。用户已确认将复制的完整工具JSON粘贴到本地工具面板，单次点击执行，命令校验和真实执行仍由工具层处理，错误与结果交给AI判断。粘贴本身不能证明该请求来自当前官网最新回复，不能复用官网来源的自动回传资格。

## Decision

只允许编辑器主frame具名executeToolJson原文入口，UI只保留执行与关闭。完整原始JSON或唯一mini-ai-tools围栏仍使用正式协议校验，原始JSON仅增加围栏，不修补内容、不解释正文嵌套示例；最多200000个UTF-16字符。同步完成入口守卫与解析，复用工具层项目/会话/平台修订守卫，忙状态阻断。入口拒绝保留输入，不覆盖活动结果；已接纳的协议错误生成manual诊断和统一batch_error回执，不伪造执行完成。

复用工具harness、权限和持久去重，不创建第二执行器。手动来源随选择与去重记录保留，结果仅查看/复制，不能进入自动继续、批次诊断回传或具名附件回传。automatic配置保持原值；后续新的官网批次继续正常流程。重复或恢复的手动记录也不获得回传资格。手动入口不接受repair_draft；attach_file请求明确失败，不读取/暂存/上传。

用户通过官网手动复制和粘贴命令，程序不读取剪贴板，不写网页。手动解析诊断与本次终态回执遵循autoCopyResults，每个事件最多自动复制一次；关闭设置、取消、未知、历史恢复或状态查询不复制，后台命令等待真实退出与清理。手动结果格式与正常工具结果同源，用户可自行复制给AI。暂停/失效不重试，输入正文不额外保存磁盘或日志。

## Consequences And Verification

采集失败时可直接补上请求入口，同时保留权限、去重及官网发送边界。代价是用户自行将真实结果复制给AI，手动入口无法恢复官网补丁草稿或上传附件。必须验证错误零执行、重复/冲突去重、权限拒绝、作用域变化、持久记录来源、自动开关切换、复制设置与后台结束，以及下一官网新批正常回传；UI错误必须安全纯文本，迟到回执不能关闭已变化的上下文。


## Validation

执行入口ok表示请求已接纳处理，单项结果以工具列表真实状态为准；去重范围为项目+会话。验收由manualToolJson、manualToolJsonIntegration、toolJsonPanel及复制/回传关联测试覆盖，离线原生工具面板夹具验证单次原文提交和窄宽布局。
