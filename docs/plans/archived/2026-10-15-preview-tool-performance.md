---
artifact_type: plan
status: archived
created: 2026-10-15
updated: 2026-10-15
owner: agent
plan_readiness: ready
source_audit: docs/audits/2026-10-13-performance-exploratory-audit.md
covered_findings: [PERF-05, PERF-06]
deferred_findings: [PERF-03, PERF-04, PERF-07, PERF-08, PERF-09]
---

# 预览资源与工具结果性能优化

## Goal

普通编辑不解析PDF/Word专用大脚本，工具结果进度更新保留未变条目与展开状态，仅展开时生成详情；增加离线启动里程碑计时供后续PERF-04测量，不调整启动顺序。

## Scope And Decisions

用户同意上一轮推荐路线。保持显示样式、结果数据、复制与发送入口、取消语义、离线预览及CSP/消毒边界；不改ledger、路径校验、官网采集、源码启动脚本，不引入依赖。提交合并已获用户批准，不推送。前轮未提交性能审计更新属于本任务来源；既有AI临时目录与UI原型不纳入。

## Plan Readiness And Split Guidance

事实来源：filePreview.js/index.html、toolHarness.js/toolExecutionClock.js、index.ts/workspaceProbe.ts及直接调用和测试；DESIGN沿用现有details/summary、图标与焦点规则。dev-split分类local cleanup/no split：加载Promise及Word的现有Monaco AMD依赖由filePreview owner管理，结果节点由toolHarness owner管理；保持唯一入口，不拆大文件或增建通用utils。index.ts只接线启动计时，详细采样复用workspaceProbe，禁止改变业务启动时序。若须变更权限/协议/存储或用户交互再停下确认。ADR gate不需要：当前推荐行为的内部加载/渲染调度，未改变事实源和不可逆策略。design_system_impact: none。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PT-1 | done | 核对基线、代码owner、建立任务分支与计划 | v0.4.0基线；两热点静态证据与前轮53项回归；来源审计可见 |
| PT-2 | done | PDF/Word依赖首次使用加载并复用，失败可再打开重试 | 普通编辑不加载；分类型/并发/失败/迟到取消；离线PDF与DOCX安全回归 |
| PT-3 | done | 按批次/请求复用结果节点，详情按展开生成 | 未变节点身份/焦点/展开保留；停止最新进程；大结果计数/内容/安全和旧批移除 |
| PT-4 | done | 增加离线启动里程碑计时 | 临时独立profile，不连接官网；明确窗口/编辑器就绪定义与证据限制 |
| PT-5 | done | 整合验证、独立评审与知识回填 | 针对性及全量回归、类型/构建、原生离线、次数对比、设计/文档/差异门禁 |
| PT-6 | done | 验收决策与合并批准 | 用户批准当前分支提交合并；依据已有原生与自动化证据收口，未补充真人现场测试，不将批准描述为现场实测 |

## Artifact Routing And Closeout

更新local-file-access、tool-harness及app-shell能力与CHANGELOG；PERF-05/06实现及原生验证闭合、用户批准当前分支合并后标记verified，计划归档；整体性能审计其余发现保持active。启动计时只提供PERF-04基线，不标记已优化。独立评审按dev-branch的subagent门禁执行，所有工作代理禁止Git写操作和无关改动。


## Verification Record

- 工具结果：42项UI回归与原生240项通过，HTTP请求为零；20条各128KiB结果的HEAD（5286f26）对照，50次同值克隆的整批序列化50→0，20次其他行进度的节点创建3200→0、结果行替换400→0、详情序列化400→0。打开行真实焦点/选区/正文保留；改变已展开行只生成该行详情一次，停止使用最新进程身份。
- 启动：临时空profile离线9项通过。单次主进程bootstrap到编辑器loaded约14064ms，渲染器自身导航到Monaco初始化约1971ms；运行同时有其他验证负载，不能作为安装版指标、优化收益或稳定中位数。阶段日志保存在C:/WINDOWS/TEMP/mini-startup-perf-20261015.log，辅助视图先后等待仍存在，PERF-04未关闭。
- 初次全量1136/1136、0失败/取消/跳过，类型检查与构建通过；独立评审发现真实Monaco AMD接管UMD预览组件，初次离线夹具未覆盖此组合，已将Word统一为现有AMD模块入口，成功导出由owner持有，失败重开只为失败库换专用模块ID；禁止改写全局define或reset。补真实AMD故障及Monaco共存回归后重新验证，不把此前通过当最终门禁。
- Design check：沿用details/summary、现有图标与可访问名称、主题和焦点规则，未新增布局或token；原生240px Word截图已人工检查，底栏可达且无溢出。工具面板原生覆盖240/460/900px与焦点/选区，不据此声称真实人工键盘验收。
- 生命周期：PERF-05/06按实现及原生验证闭合，整体审计其余发现保持原状态；最终验收与Git授权见本计划收尾记录。


### AMD修复后的验证

预览renderer21项、缩放1项通过。真实Monaco AMD原生58项全部通过：普通首屏/图片不加载专用库，PDF本地字体/翻页/缩放正常；实际阻断净化库本地请求一次，Word显示错误且不建立未净化iframe，随后Monaco editor.main正常加载，再次打开Word恢复。成功模块JSZip和DOCX各请求1次，净化库2次（故障+成功），此后重开不增加；HTTP及非预期渲染错误为零。日志C:/WINDOWS/TEMP/mini-ai-ide-preview-performance-amd-native-retry-20261015.log，root已核对日志与新240px Word截图。

首次真实AMD探针在图片截图阶段发生UnknownVizError，保留失败日志，未改业务代码绕过，原样重跑通过。加载器失败模块ID记录保留到窗口关闭；不做全局reset。安装文件损坏或模块求值错误不承诺能靠重开修复。

AMD后首次全量1135/1136，未改动的40请求草稿恢复测试等待超时，当时同时运行构建/原生验证；未改变逻辑或断言，单独重跑该集成文件21/21通过，最终低并发完整回归另记。构建通过：216静态资源、作用域未绑定0，119条参考语义信息不判失败。


### 最终门禁

- 最终完整回归：`node node_modules/tsx/dist/cli.mjs --test --test-concurrency=2 --test-reporter=tap "test/**/*.test.ts"`，1137/1137通过，0失败/取消/跳过，约116秒。日志C:/WINDOWS/TEMP/mini-perf-full-tests-confirmed-20261015.log；此前负载超时未通过修改原测试规避。
- 构建/类型检查通过，最终渲染器产物与源码字节一致；原生预览58/58、工具面板240/240、离线启动9/9，未连接官网。基准固定5286f26628e03e71d08c1bdcba8d62ecf3011c48，避免提交后对照点漂移。
- 独立评审mode=subagent：plan compliance、audit coverage、related changes only、verification evidence、design、changelog、distill、check均pass，无剩余代码阻断；root核对全量/原生日志、最终差异和截图。文档校验及差异检查通过。
- PT-1至PT-5结束；PT-6按下述用户批准收口，计划归档，整体性能审计因其余发现继续active。启动PERF-04仍未优化，安装版未打包/发布。

## 用户批准与收尾（2026-10-15）

用户在知悉最终1152项回归及原生验证通过、安装版未更新后，明确要求“自动回传我也没法验收，就默认通过，提交合并吧”，并选择出现同类故障后再排查。当前分支包括本性能计划和取消恢复/128MiB计划，按批准提交合并；自动回传免现场验收，其他未补充真人实测，保留已有证据的范围与限制。PERF-05/06按实现与原生验证标记verified，不将批准换算为安装版启动收益或全面性能验收。PERF-03/04/07/08/09保持open，不随本计划归档关闭。最终取消恢复及大附件验证见docs/plans/archived/2026-10-15-cancel-recovery-preview-limit.md；未推送或发布。
