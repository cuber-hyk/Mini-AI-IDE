---
artifact_type: adr
status: accepted
created: 2026-10-14
updated: 2026-10-14
owner: 胡运宽
source_of_truth: [src/main/tools/replySource.ts, src/main/tools/replyChangeWatcher.ts, src/main/tools/replyObservation.ts, src/main/chatgptPage.ts, src/main/tools/autoCollector.ts, src/main/tools/integration.ts, src/main/tools/autoContinuation.ts, src/main/tools/resultReturn.ts, src/main/webComposerSender.ts, src/shared/toolProtocol.ts, src/main/toolWorkspaceStatus.ts, src/renderer/toolHarness.js, test/replySource.test.ts, test/replyChangeWatcher.test.ts, test/chatgptReply.test.ts, test/toolAutoCollector.test.ts, test/toolAutoContinueIntegration.test.ts, test/autoContinuation.test.ts, test/toolResultReturn.test.ts, test/webResultSender.test.ts, tools/verify-chatgpt-tools.cjs]
---

# ADR：保留来源进度的有限自动恢复

## Context

ChatGPT 连续协作中，用户已开启 automatic，监听暂时失效、来源封存过早或回传只读预检暂缺完成证据，都可能造成流程不再前进。用户授权在既有来源、权限与一次运输边界内修复并恢复自动流程。重新建立全部历史基线会漏掉暂停期间的新回复；仅查找历史中未执行的批次不能证明它获得了当前执行授权。发送超时又可能发生在提交之后，不能把所有失败统一重试。

## Decision

1. automatic 表示用户意愿；主进程另投影 collection 的 off/watching/recovering/paused、原因及恢复次数。工具面板和官网顶栏优先呈现采集阻断或恢复，旧的等待回复、复制与完成反馈不能掩盖它。顶栏只输出固定简短原因，不带网页正文、路径或原始异常。
2. 轻量及完整只读完成探测不封存正文。实际接纳前按快照 sourceKey 重新检查当前最新节点、正文指纹、新来源及非生成状态；ChatGPT 还复核完整完成证据，之后才封存。自动接纳必须具备来源标识；手动入口沿用用户明确采集与完成确认。采集快照的会话、项目和导航版本在异步检查前冻结，迟到或导航往返的旧回执不能在新作用域执行或改变新状态。
3. 同文档、同会话的尾部节点重挂载，仅在已保存的唯一稳定消息 ID 与已确认正文同时匹配时恢复顺序锚。旧消息保持历史，后续真正追加可形成新来源。缺失/重复 ID、正文改变、不同作用域及任意同文历史均不获得新增资格。已接纳正文后续改写仍须新的绑定生成证据。
4. 监听明确失败后按 250/1000/3000 ms 最多恢复三次。隔离世界仍持有同 token、同文档/会话的 sources 时，只修复订阅、撤销遗留 waiter，保留来源、生成见证、用户动作及采集/执行/结果状态，主动复核当前回复。正常通知后恢复额度归零。状态丢失时重建安全历史并明确提示已有回复需手动采集，不能凭执行账本补跑历史。关闭、导航、销毁撤销旧恢复。仅缺少 DOM 变化不判故障，不增加后台历史全文轮询。
5. 回复读取抛错仅在只读读取阶段按同样三次间隔复核，保留当前基线；工具执行或接纳失败不作为读取重试。历史加载维持 500 ms 相关 DOM 安静窗口，且不把安静当作回复完成证据。导航时已经替换为目标历史节点的完整 DOM 立即安排一次仅更新历史基线的通知；仍是旧节点或空加载帧时继续等待迟到历史。
6. ToolResultReturn 仅对明确标为 retryable、stage=preflight、transportStarted=false 且非 uncertain 的临时生成/完成未知预检失败释放预检资格。AutoContinuation 保留同一完成事件、正文和守卫，按 1/3/5 秒最多额外复核三次。真实中断、来源/项目/会话变化、用户接管和取消不复活旧回传。工具不重新执行；附件读取或 sender 开始后保持一次尝试。解析/整批错误额度只计真正进入运输或无法排除运输的尝试，纯预检不占额；迟到预检不得倒扣新 scope 或成功结果清零后的额度。
7. 网页纯文本运输仍有整体 7.5 秒期限，附件沿现有大小上限期限。整体超时先有界收敛取消，再保留 preparing/draft_backup/waiting_button/clicked/confirmed 等阶段与 not_clicked/clicked/unknown 结论。只有当前 token 的取消与清理确认才能报告未点击；取消最多等待 1 秒，未确认则阻断后续运输。取消已完成附件清理时不重复等待清理。即使确认未点击，本批开始运输后仍不重试；已点击或未知提交绝不重发。

## Alternatives Considered

- 全部暂停都关闭再开启：会重建历史基线、丢失待处理结果，不能证明执行或提交阶段。
- 扫描所有未执行历史命令：未执行不是当前授权，不采用。
- 将未知来源直接改为新来源或依赖文本稳定时间：无法隔离历史及节点复用，不采用。
- 所有运输失败自动重试或仅延长超时：不能解决未知提交，保留一次运输与阶段证据。
- 引入另一条网页/工具入口：扩大能力与重复状态，不采用；继续使用原 Harness 和唯一 WebComposerSender。

## Consequences And Verification Boundary

暂时性只读故障及明确未运输的预检可有限恢复，未知来源、真实用户中断和未知提交保持人工处理。状态丢失或网站缺乏连续性证据时，系统可能保守漏采，不能通过猜测执行补偿。

回归包括实际接纳前正文变化、已封存正文替换、稳定 ID 重挂载、导航迟到回执、监听恢复与上限、预检额度和取消。原生离线夹具运行 30 轮、60 项真实文件工具，注入监听失效、重挂载及同步/异步历史切换，并核对每批执行与运输一次、复制同源。离线测试不连接官网，当前官网连续使用验收单独记录，不能宣称任意未来 DOM 变化都可恢复。网页采集保持只读，写入仍仅由世界 1005 的 WebComposerSender 运输，无新增网络、身份或权限能力。
