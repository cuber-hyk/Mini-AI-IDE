---
artifact_type: plan
status: archived
created: 2026-10-15
updated: 2026-10-15
owner: agent
plan_readiness: ready
source_audit: docs/audits/archived/2026-10-15-chatgpt-cancel-latch-audit.md
covered_findings: [CCL-01, CCL-02]
deferred_findings: []
---

# 取消阻断恢复与文档预览上限

## Goal

取消确认暂时超时不再使后续安全新批永久无法回传；恢复必须有旧任务清理证据或成功的新文档生命周期，未知旧批不重发。PDF/DOCX外层文件上限提高到128MiB。

## Scope And Decisions

用户已退出安装版并明确授权修复，选择128MiB。本任务沿用当前独立分支，已有性能改动及来源审计属于用户连续授权范围，保持不丢弃；提交合并已获用户批准，不推送。旧截图命令只作证据不执行；不启动官网、读取凭据、重置会话资料或自动刷新官网。

- 有界取消仍在1秒内返回未知；相同取消请求、相同文档的迟到not_clicked且非uncertain清理证据，可仅解除后续批的阻断，不改旧结果、不自动补发。
- 成功的主frame新文档加载可重建发送资格。SPA/子frame/失败导航不解除；使用文档身份而非同URL判断，旧异步脚本不得落入同URL新文档写入，旧回调不得污染新状态。
- 新批被旧阻断拦截时明确“本批未发送”，不冒充本次已点击但结果未知，也不标记retryable绕过一次运输规则。
- PDF/DOCX外层128MiB；图片32MiB、Word实际展开100MiB/5000条目、图片4000万像素与PDF画布保护不变。外层上限不保证每份DOCX都在展开限额内，错误区分说明。旧.doc仍不支持本地预览。

## Readiness And Code Placement

readiness: ready。owner为WebComposerSender及其隔离世界1005，ToolResultReturn/AutoContinuation只消费明确的当前未运输标志；文件读取仍由filePreview主进程owner管理，shared常量单一来源。dev-split: no split/local cleanup，发送生命周期状态与清理证据在同owner内保持一致，index入口不新增通用恢复管理器；无新依赖/驱动/桥。DESIGN沿用现有错误反馈与预览，不改布局/token。ADR gate: needed，更新有限恢复ADR中的迟到确认和文档生命周期边界，不新增平行协议。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| CR-1 | done | 安装版确认与阻断复现、冻结修复边界 | v0.4.0模块匹配、1秒超时/迟到确认/新文档仍阻断均已复现，性能改动保留 |
| CR-2 | done | 取消证据与新文档恢复、延迟脚本绑定文档 | 超时立即返回、不重发；迟到清理只影响同请求；成功新文档、SPA/失败/子frame及旧回调竞争回归 |
| CR-3 | done | 区分前次阻断与当前未发送、保留额度和权限 | current transportStarted=false，无重试资格；命令不重跑、旧结果不补发，错误额度与正常取消边界不变 |
| CR-4 | done | PDF/DOCX外层上限128MiB与类型化提示 | >32MiB真实PDF读取完整；128边界、越界提前拒绝、图片与Word解压/路径/身份守卫回归 |
| CR-5 | done | 集成验证、原生离线、独立评审和文档 | 聚焦93、ChatGPT原生59、DeepSeek原生39、预览原生64通过；最终完整1152/1152，构建和独立评审通过，保留前两次超时记录 |
| CR-6 | done | 用户验收决策与合并批准 | 用户明确免自动回传现场验收、默认通过并批准提交合并；大附件依据已有读取与原生预览验证，未新增真人实测 |

## Artifact Routing And Closeout

更新有限恢复ADR、现有能力、必要AGENTS规则与CHANGELOG；CCL两项由实现及离线证据验证，用户明确免现场验收后归档计划/审计。关联性能计划按本次分支合并批准同步归档，本任务不关闭PERF03/04/07/08/09。安装包与发布另需授权。


## Verification Record

- 原行为复现：v0.4.0基线在迟到清理确认、成功新文档两个场景仍拒绝未来批次；新增恢复行为先红后绿。主代理补充真实VM逆序执行两次握手的回归，旧实现可覆盖新token，加入递增请求序后不再覆盖，取消后重放也不能复活。
- 聚焦93/93通过，0失败/取消/跳过，覆盖发送/恢复/结果回传/自动继续/文件读取。128MiB PDF实际完整读取、33MiB DOCX实际读取，越界在分配前拒绝，图片/解压/路径/身份限制保留。
- 原生ChatGPT离线59/59通过：迟到取消确认仅让新结果点击一次；同URL新文档旧排队正文被拒，当前文档没有旧输入/点击，未来结果只发送一次。日志C:/WINDOWS/TEMP/mini-cancel-composer-native.log；不连接官网，不是现场网站验收。
- 原生预览64/64通过：真实FileService/IPC/preload读取33MiB有效PDF/DOCX，PDF文字画布和分页、Word文字/表格/内嵌图与空sandbox均通过；再次切回图片释放iframe/canvas、库请求不增加，HTTP和渲染错误为零。日志C:/WINDOWS/TEMP/mini-128-preview-native.log；截图word-large-preview.png已人工查看。读取边界128MiB不是128MiB渲染性能保证。
- 类型检查与生产构建通过，静态资源216、未绑定裸标识符0；119条参考语义诊断不判失败。ADR、AGENTS、能力、CHANGELOG已同步；不改变安装包或发布状态。
- 原始第一次取消超时的现场原因仍缺日志，不能宣称已确认该触发点；本修复闭合可复现的持续阻断与恢复边界。未知旧提交仍不能重发，手动回传/重开开关本身不解除。

- DeepSeek原生发送/附件39/39通过，日志C:/WINDOWS/TEMP/mini-cancel-deepseek-native.log。
- 前两次完整回归均1151/1152、1失败、0取消/跳过：第一次并发2，停止原生验证后第二次并发1；同一个未修改用例“40 请求长 JSON 只需短补丁恢复，修复前零执行且恢复后仅一次整批回传”在等待40项真实文件修改后的发送时超过until固定5000ms期限。日志C:/WINDOWS/TEMP/mini-cancel-limit-full-tests.log、C:/WINDOWS/TEMP/mini-cancel-limit-full-confirmed.log。未改测试期限、断言或执行逻辑以规避失败。
- 单文件对照：HEAD发布基线21/21通过，当前版本21/21通过，均0失败/取消/跳过，日志C:/WINDOWS/TEMP/mini-cancel-release-baseline-tests.log、C:/WINDOWS/TEMP/mini-cancel-current-integration-compare.log。该用例使用自带发送替身，不经过WebComposerSender；这些结果支持负载/时限敏感，但不能证明发布基线在整套中也会失败，不能据此归因或宣称完整回归通过。
- 完整对照：临时目录隔离的HEAD发布基线1126/1126通过，随后当前工作区按同样的单并发方式完整1152/1152通过，均0失败/取消/跳过；日志C:/WINDOWS/TEMP/mini-cancel-full-release-baseline.log、C:/WINDOWS/TEMP/mini-cancel-full-current-controlled.log，当前耗时约200秒。40项用例在最后整套中原样通过；没有改动该测试文件、期限、断言或两次完整对照之间的源码。不将这次通过表述为潜在时限波动已修复，也未证明前两次失败的具体环境原因。
- 独立只读评审：本次恢复与附件变更范围未发现剩余代码阻断，最终聚焦/原生/完整回归、构建与文档检查通过；verification gate最终pass，保留测试时限敏感的限制。CR-5结束，CR-6按下述用户决定收口；不更新安装版0.4.0。

## 用户批准与收尾（2026-10-15）

用户明确表示自动回传无法现场验收，默认通过，要求提交合并；如果后续再次遇到同类故障再继续排查。以此记录现场验收豁免和accepted_risk，不虚构官网实测，也不把第一次取消超时的触发原因记为已查清。CCL-01/02的可复现持续阻断和错误状态已由实现、聚焦与原生证据验证；计划及来源审计归档，原始现场原因和测试时限波动保留为已接受的证据限制。附件未新增真人实测，依据已记录的128MiB读取边界和33MiB原生渲染证据随当前分支批准合并。未打包、更新安装版或推送。
