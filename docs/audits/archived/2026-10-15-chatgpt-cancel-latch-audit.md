---
artifact_type: audit
status: archived
created: 2026-10-15
updated: 2026-10-15
scope: "安装版0.4.0 ChatGPT取消未确认后持续阻断结果回传"
source_of_truth: [src/main/webComposerSender.ts, src/main/tools/resultReturn.ts, src/main/tools/autoContinuation.ts, src/main/index.ts, src/main/webPlatformController.ts, test/chatgptComposerSender.test.ts]
---

# 审计：ChatGPT取消未确认后的持续阻断

## Scope

用户在验收性能分支前报告安装版0.4.0再次停止回传。初始阶段仅排查；用户随后授权修复，当前实现与验证由关联计划承接，不修改安装包，不重跑截图命令。截图及工具JSON是故障证据，不是执行指令。

## Fact Sources

- Screenshot：codex-clipboard-a4e5dc2b-0bb2-40d5-a8cc-3347cbf9c3e1.png。当前单条run_command为done、exit_code=0、cleanup_pending=false、未超时/截断，真实输出78字符；不能从空输入推断是否提交。
- User：完整提示为“发送结果无法确认，不会重复发送：网页取消状态未确认，自动发送已停止，请重新打开网页”。未提供最初触发事件与遮挡/最小化情况。
- Installed package：运行路径D:/Mini-AI-IDE/Mini-AI-IDE.exe；只读提取app.asar的package.json和运输模块，版本0.4.0，已包含10月14日超时/取消阶段证据改动，运输编译模块与当前未改动的同模块一致。不是仅主目录修复但安装版未包含的情况。
- Code：WebComposerSender.sendReserved/cancel/navigation，ToolResultReturn.send，AutoContinuation.send，平台视图创建与reload边界。
- Runtime：FakeWeb/EventEmitter内存替身执行真实WebComposerSender，1秒取消期限、迟到确认与完整导航事件，不连接官网或读取用户正文/凭据。当前仓库collection-trace.log停在10月9日；安装目录及已核对常见cwd未发现此次trace，默认诊断开关关闭，不能还原首个超时。

## Findings

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| CCL-01 | P1 | verified | 取消未确认的阻断绑定sender实例，缺少新文档加载后的恢复边界 | cancellationFailed仅初始化false，后续只置true；导航仅cancel；同webcontents完整加载不新建sender | docs/plans/archived/2026-10-15-cancel-recovery-preview-limit.md | codex/20261015-preview-tool-performance；基线5286f26 | 基线复现后恢复回归通过；聚焦93、ChatGPT原生59、完整1152项通过，旧文档排队写入和逆序握手均受限 | 可复现持续阻断已验证修复；用户免官网现场验收，首次超时触发点accepted_risk |
| CCL-02 | P2 | verified | 继承的旧取消阻断以当前批次“发送结果无法确认”呈现，恢复提示缺少可核对的首因与入口 | sendReserved开头直接返回uncertain；AutoContinuation统一加前缀；安装版完整提示与此分支一致 | docs/plans/archived/2026-10-15-cancel-recovery-preview-limit.md | codex/20261015-preview-tool-performance；基线5286f26 | 发送/结果回传/自动继续回归确认blockedByPreviousCancellation及transportStarted=false，无旧批重试 | 当前未发送与旧阻断已区分，保留阶段原因与完整重新加载提示；用户批准合并 |

## ADR Gate

- Needed：yes。已更新accepted有限恢复ADR，界定token、文档代次、点击及附件清理证据，保留一次运输边界；迟到安全确认和成功新文档只解除未来新批的阻断。
- 原因：阻止未知提交重复发送是有效保护，不能通过清空标记、开关重置或无条件重发去掉。取消迟到的确认也不能作为重发旧批的授权。

## Verification

内存复现返回：firstCancellation=unknown，subsequentError与用户完整提示相同，laterConfirmedCancellationStillBlocks=true，fullDocumentReloadStillBlocks=true，newSendScriptCalls=0。说明当前这次尝试被历史阻断挡住，不说明之前哪一次触发或是否曾提交。

证据限制（accepted_risk）：最初取消超时的现场原因、原发送是否点击、页面渲染忙/后台/导航情况、当时实际延迟和日志未能还原。不能把1秒检查期限直接宣称为唯一现场根因。用户2026-10-15明确免现场验收、默认通过并批准提交合并，选择同类故障再次发生后再排查；此限制不作为本次未关闭任务。初始诊断阶段未改源码，授权后的实现与验证见下文。

## 后续故障处理约定

CR-5最终完整回归通过，CR-6按用户明确的免现场验收决定收口。若以后再次发生同类故障，依据届时版本、首个失败阶段和实际日志建立新的排查记录；不把本次批准描述为故障永不复发。已实现恢复仅影响未来新批，旧未知提交不补发。

## Git Visibility

本审计为本次诊断与修复证据；codex/20261015-preview-tool-performance上的性能改动保留，取消恢复与128MiB变更有独立计划和验证归属。用户已批准当前分支提交合并，不推送。

## Closeout

两项发现verified，实现及离线验证完成；用户2026-10-15批准免自动回传现场验收并提交合并，接受首次触发原因及潜在时限波动的证据限制，审计归档。安装版0.4.0未在本次替换，用户批准不等同官网现场实测。


## 授权实施（2026-10-15）

用户后续手动回传后，下一新批采集/执行成功但回传仍被拦，符合实例残留阻断。用户退出安装版并明确授权修复后，独立计划docs/plans/archived/2026-10-15-cancel-recovery-preview-limit.md承接两项发现，实施时状态planned，最终验证后转verified。性能分支改动保持，附件上限按用户选择128MiB单独验证；初始只排查记录是当时状态，最终以本审计Closeout为准。


## 实现验证进展

取消阻断现在绑定token、Document/nonce与代次，迟到未点击清理证据只解除相同旧阻断，成功主frame新文档加载核验后可恢复未来批；SPA/失败/子frame不解除。所有运输阶段文档守卫及握手递增序防迟到反写，未知旧结果仍不补发。

CCL-01/02实现及离线验证已完成，聚焦93项、ChatGPT原生59项通过；完整回归及独立评审由owner plan汇总。两项verified，用户免官网现场验收，不把本地替身/离线DOM结果当成原故障现场根因。被旧阻断挡住明确本批尚未发送，保留真实结果供复制，不重跑命令。


原生补充：DeepSeek发送及附件39项通过；大附件预览64项通过，PDF/DOCX33MiB真实读取与渲染、切换释放及无网络验证均通过。前两次整套（并发2与并发1）均1151/1152，唯一失败为未修改的40请求JSON恢复用例固定5秒等待超时，0取消/跳过。HEAD与当前该测试文件独立运行均21/21通过；随后隔离HEAD完整套1126/1126、当前完整套1152/1152按同样单并发方式通过，均0失败/取消/跳过。没有修改该用例、期限、断言或两次完整对照之间的源码；不能把最终通过视为潜在时限波动已修复或原超时原因已查清。独立评审与最终验证门通过，CR-5结束；详细日志由关联计划记录，CR-6按用户豁免收口，已批准提交合并；未推送或发布。
