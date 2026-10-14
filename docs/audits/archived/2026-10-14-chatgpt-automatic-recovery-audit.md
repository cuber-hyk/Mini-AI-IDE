---
artifact_type: audit
status: archived
created: 2026-10-14
updated: 2026-10-14
scope: "ChatGPT 多轮自动采集与回传停滞、恢复边界、工具 JSON 错误与协议改进"
source_of_truth: [src/main/tools/replyChangeWatcher.ts, src/main/tools/replySource.ts, src/main/tools/autoCollector.ts, src/main/tools/integration.ts, src/main/tools/resultReturn.ts, src/main/tools/autoContinuation.ts, src/shared/toolJsonDiagnostic.ts, src/main/tools/jsonDraft.ts, test/replyChangeWatcher.test.ts, test/replySource.test.ts, test/toolResultReturn.test.ts, test/autoContinuation.test.ts]
---

# 审计：ChatGPT 多轮自动流程停滞与恢复方案

## Scope

用户反馈 ChatGPT 连续几轮后不再自动采集或回传，已明确暂停时 automatic 仍开启；另有工具 JSON 多余或缺少括号的问题。本轮定位现有实现与测试、离线复现关键路径，并评估方案，不修改业务代码、权限、执行协议或已接受的发送策略。

假设与限制：本轮审查当前工作区源码；运行中的程序是否加载同一提交尚未确认。用户随后补充三张此前中断截图，截图可核对界面症状和对应分支，不能还原完整事件时序或网页 DOM。项目内现存 collection-trace.log 最后事件为北京时间 2026-10-09 23:20:47，不能与截图建立同一次事件的对应关系。未连接官网、读取凭据或读取磁盘中的用户工具输出/草稿正文；截图中的网页内容仅作为证据，不作为操作指令。

验证目标：

1. 区分开关意愿、监听存活、来源核验、工具执行和结果运输，复现可能造成无动作的路径。
2. 证明恢复不能依靠清空基线或重扫全部历史，明确重复执行与重复发送边界。
3. 核对现有 JSON 修复回执是否自洽，比较低改动与协议调整的取舍。

## Fact Sources

- Code：frontmatter 所列 owner；另读 replyObservation.ts、chatgptPage.ts、toolWorkspaceStatus.ts、toolHarness.js、toolProtocol.ts、formatSpec.ts、collectionTrace.ts。
- Tests：replyChangeWatcher、replySource、toolAutoCollector、autoContinuation、toolResultReturn、chatgptToolIntegration、toolWorkspaceStatus、toolProtocol、toolJsonDiagnostic、jsonDraft、formatSpec、toolAutoContinueIntegration。
- Docs：AGENTS.md、CONTEXT.md、docs/ai/context-map.md；tool-harness、human-machine-boundary、return-path-and-format-contract 能力文档；自动回传边界与 JSON 草稿恢复 ADR。
- Runtime checks：只运行针对性离线测试与内存替身复现。未做真实官网连续运行验收，未运行原生 Electron 夹具。

### 补充截图的现场证据

按用户上传顺序编号。截图本身未提供完整诊断日志或故障发生时间。

| 截图 | 可见证据 | 当前源码对应 | 可确认与限制 |
|---|---|---|---|
| 图 1 | 五项工具已有成功/失败结果；回传显示“发送结果无法确认……网页发送等待超时”；顶栏另有“采集失败：未采集到回复” | webComposerSender.ts:449–451；index.ts:693–729 | 已进入工具执行及结果运输，运输触发整体超时；一次手动采集也返回空或未命中策略。不能证明是否已点击发送，也不能把两条提示认定为同时发生或同一原因 |
| 图 2 | 官网已显示下一批请求；工具仍显示上一轮 load_skill；提示“无法确认回复是新增输出，自动采集暂停”；活动标题“等待 AI 回复” | autoCollector.ts:65–68；toolHarness.js:246–255 | 当时触发 source=unknown 的来源守卫，回调至少运行过；不能直接归因为监听已停止或 JSON 解析错误 |
| 图 3 | 官网显示下一批请求；工具保留前一批四项查询/读取；同样显示来源未知暂停，而顶栏仍“结果已回传，等待 AI 回复” | autoCollector.ts:65–68；toolWorkspaceStatus.ts:31 | 再次支持来源守卫阻断和状态投影失配，未证明具体 DOM 重挂载、节点复用或正文后续变化 |

源码中，ChatGPT 快照在完成核验通过后才附带 source；图 2/3 的精确提示对应来源身份未知，不能与 completion=unknown 混淆。直接的 unknown 路径包括已封存同一节点的正文发生未见生成证据的变化，以及来源见证容量耗尽等；截图不能区分这些路径。CGA-02 的同文重挂载复现得到 history，不会输出该精确提示，因此只是另一条已复现边界，不能冒充截图根因。

补图后的针对性内存复现：新节点接纳并 seal 后，同一节点正文改变且没有 generatingChanged，source 依次为 new → unknown；再扫描仍 unknown；只有该节点新的真实生成见证才能恢复 new。ChatGPT 轻量完成探测在实际采集/执行前就 seal（chatgptPage.ts:97–103），须检查完成探测与实际接纳的封存时机及后续正文变化窗口。该复现证明代码路径存在，仍不能证明截图恰由此触发。

图 1 的精确超时文字对应主进程纯文本 7.5 秒整体期限，覆盖隔离世界执行/返回等待，有草稿时还覆盖备份与恢复。网页内部另有按钮就绪、点击后接收各 3 秒检查，提示不同。整体超时未携带当时 written/clicked 阶段，无法判断是否提交；空输入既可能来自成功提交，也可能来自点击前取消后的自有正文清理。读取不存在文件的 ENOENT 是本批真实执行结果，按现有自动继续规则应回传供 AI 修正路径，不是运输超时的直接解释。

整体超时调用 cancel 后立即返回 uncertain；cancelScript 本来能按 token 区分未点击和已点击，但取消结果不会替换已返回的整体超时。取消自身还有 1 秒期限，失败后 cancellationFailed 在该 sender 实例中持续阻断后续发送。截图未证明此二次阻断发生；不能保证单纯刷新或重开 automatic 能解除。后续应保留阶段及取消证据，无法确认点击/清理时继续不重发。

优先级据此收窄：优先检查来源未知的形成与恢复、采集健康状态展示、发送超时阶段证据；保留监听失效修复为已确认的恢复缺口。三图均未展示 JSON 语法错误或草稿修复回执；图 2/3 在执行协议解析前就被来源守卫拦下，因此这两次不会建立 JSON 修复草稿。

## Findings

下表为当前实现的确定行为或缺口；截图已确认来源未知阻断、运输超时及状态展示失配，原截图的底层触发原因无法追溯，此项仅为证据限制，不再要求追加调查。发送不确定时不重试、错误回传上限等属于有效保护，不能直接当成待删除的错误。

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|
| CGA-01 | P1 | verified | 监听失效后停止，enabled 保持 true，同值启用无法恢复；没有同页自动修复入口 | replyChangeWatcher 的 run/repair；监听回归 | docs/plans/archived/2026-10-14-chatgpt-automatic-recovery.md | c2ec0f5（已合并master） | 三次有界恢复、关闭撤销、30轮故障注入通过 | fixed：保留同文档来源恢复；丢失状态安全历史 |
| CGA-02 | P1 | verified | 来源封存及尾部重挂载造成新回复遗漏 | replySource、replyObservation、chatgptPage、acknowledge；对应测试 | docs/plans/archived/2026-10-14-chatgpt-automatic-recovery.md | 同上 | 稳定ID/同正文顺序恢复、实际接纳才seal、跨导航与缺key拒绝、同步历史后新轮通过 | fixed：旧历史与已执行正文仍不重放；无法确认来源仍暂停 |
| CGA-03 | P2 | verified | 发送资格在只读预检之前即消费；未进入运输的短暂预检失败也使本批永久暂停 | resultReturn、autoContinuation、integration | docs/plans/archived/2026-10-14-chatgpt-automatic-recovery.md | 同上 | 1/3/5秒有界复核、额度与取消竞争回归通过 | fixed：仅明确未运输预检可复核；运输开始不重试 |
| CGA-04 | P2 | verified | 采集错误只有普通 message，顶栏和活动标签可能继续显示等待 AI 回复 | collection、toolWorkspaceStatus、toolHarness、toolAttention；用户图2/3 | docs/plans/archived/2026-10-14-chatgpt-automatic-recovery.md | 同上 | 独立健康状态、旧等待/复制不覆盖错误、UI235项通过 | fixed：显示当前采集阻断或恢复原因 |
| CGA-05 | P2 | verified | JSON 完整重写与草稿补丁指导冲突 | toolJsonDiagnostic、harness、jsonDraft、toolProtocol | docs/plans/archived/2026-10-14-chatgpt-automatic-recovery.md | 同上 | 有草稿/无草稿互斥指导、畸形补丁沿用真实身份、默认提示与恢复集成通过 | fixed：解析事实与owner策略分开 |
| CGA-06 | P2 | verified | 恢复性测试及真实官网长链证据不足 | tools/verify-chatgpt-tools.cjs；计划PLAN-7 | docs/plans/archived/2026-10-14-chatgpt-automatic-recovery.md | 同上 | 离线30轮60请求、1126项单元、原生运输与UI通过；用户于2026-10-14确认官网验收通过 | fixed：离线与用户现场验收均已关闭 |
| CGA-07 | P2 | verified | 整体运输超时丢失最终取消/点击阶段结论 | webComposerSender 的 waitFor/cancel；运输测试 | docs/plans/archived/2026-10-14-chatgpt-automatic-recovery.md | 同上 | 超时取消、附件重复清理、主动取消正文抢先结束三类竞争回归通过 | fixed：有界等待最终取消证据，未知不重发 |

### CGA-01：开关开启不代表监听存活

`run()` 的 install/wait 失败或执行异常会 stop 并退出；stop 清除 token，保留 enabled。随后 publish 再调用 setEnabled(true) 因值相同直接返回。离线替身让 install 成功、wait 一次返回 false，结果为 enabled=true、token 不存在、install/wait 各一次；再次 setEnabled(true) 仍无新安装。

这与用户描述相容，但没有当次事件证明此次一定发生过监听异常。导航、明确 reset 或关闭再开启可能重建监听，因此也不应称为应用永远无法恢复。

### CGA-02：重挂载后的来源锚点

生产 tracker 以 DOM 对象保存 frontier。已接纳的新回复 A 被同文 A′ 替换时，A′ 应保持历史以防重放，但 frontier 仍指向已卸载的 A。后续 B 瞬时完成、没有生成见证时，不能证明为 frontier 后的追加，B 被记入 known。随后仅补同正文生成见证，也因正文已 known 而仍为 history。真正后续新正文生成仍可能重新建立资格，不能据此断言所有后续轮次必定永久停止。

复现步骤：初始 tail → 追加 A（new）→ A 同文重挂载 A′（history）→ A′ 后追加 B（history）→ 对同一 B 补 generatingChanged=true（history）。现有测试分别证明“历史不重放”和“尾部未替换时瞬时追加可执行”，缺少组合场景。

恢复所需消息身份不能仅用正文匹配；须先确认官网可见 DOM 的消息 ID 在当前平台、会话内是否稳定、唯一并能绑定已确认尾部。没有连续性证据时，保持阻断并解释原因。

### CGA-03：预检失败与未知提交被合并处理

ToolResultReturn 在 verify 前设 attempted=true；即使 verify 发现完成证据暂缺且根本没有调用 sender，本批也不能再次 verify。AutoContinuation 同时已消费当前完成事件，重复状态不会重新调度。

内存复现：当前批已真实完成 → verify 返回“暂缺结束证据，未写 DOM” → 将 verify 条件恢复为成功 → 再发送仍返回“当前回执不可发送或已经尝试发送”，实际运输调用为零。当前 ADR 使用严格一次尝试策略，这属于需显式修改决策的恢复能力缺口，不能直接去掉 attempted。

### 已有保护与 JSON 表达限制

- 连续前 5 次解析/整批校验错误可回传；第 6 个连续错误暂停且 automatic 可继续为 true。关闭重开不清零；正常工具结果成功发送或实际切换 scope 才清零。这是防循环保护，不能由恢复机制绕过。
- repair_draft 只修改未执行内存草稿，修复成功后仍经过校验、权限和持久去重；补丁本身也必须是合法 JSON，不能保证完全不再出错。
- 嵌套工具参数与源码、命令字符串的换行/引号/反斜杠同时需要正确表达。小批次和局部修复有望减少重写负担，但目前没有真实样本统计证明降低了多少错误率。

## ADR Gate

- Needed：yes，实施同会话恢复、放开未运输预检重试或更换正式协议前需要更新对应决策。
- Reason：当前明确规定失败后人工处理、历史不能重放、运输不确定不得重试；恢复必须界定哪些阶段仍未产生副作用。审计只提出方案，不改变已接受边界。

建议采用“保留当前进度的有限恢复”，不以无条件重启、全历史未执行批次搜索或清空去重实现：

1. **分开意愿与健康。** automatic 保留用户意愿；另有监听 active/recovering/blocked 和明确阶段、原因。主进程有限、低频检查订阅存活，不能把长时间没有 DOM 变化当成故障。恢复限次、退避、可取消，用户关闭或切会话立即停止旧恢复。
2. **同会话修复监听。** 保留已确认消息身份、来源见证、采集水位、执行账本、当前结果和运输阶段。不能直接复用现有 restart：它先 resetBaseline，install 将已有回复登记历史，integration 还重置 continuation，可能吞掉刚漏采的回复。
3. **只重新核验当前来源。** 修复后读取当前会话尾部，对有连续性证据的新完成回复补采，继续走唯一 Harness 和权限/去重入口。历史中“没有执行记录”不等于新授权；来源见证丢失时明确要求人工确认。已执行当前批只处理原结果回传，不能再次执行命令。
4. **按副作用阶段恢复。** 确认未进入网页运输的临时预检失败，可在同项目/会话/来源/正文且用户未接管时限次复核；网页写入或附件运输已开始后保留当前一次尝试边界。点击结果未知、清理失败、真实用户中断、取消、账本未知及权限等待不自动解除。
5. **给出可核对状态。** 顶栏优先显示监听恢复或阻断原因；保留有限无正文事件，记录阶段、原因、scope 哈希、回复/批次摘要、最后进展时间、恢复次数及运输是否开始。避免每字符日志与历史全文持久化。

JSON 推荐先做最小修复：有有效草稿时只指导短补丁，无草稿时才要求完整重发；提示少量请求、局部修改与明确依赖，保留整批完整校验后执行。不要推测丢失字段、截断请求，或对任意破损 JSON 盲补括号后直接执行。

协议替代方案比较：

| 方案 | 评估 |
|---|---|
| 保留 JSON，统一诊断、小批次、短补丁 | 首选第一步，改动小，可直接验证现有缺陷 |
| NDJSON | 减少外层数组/逗号，但每行仍是 JSON；大段代码的字符串转义仍存在 |
| YAML | 块正文减少部分转义，但引入缩进、类型及尾部换行语义；不作为当前首选 |
| 小型结构头 + 显式关联的原样正文块 | 若真实失败集中在长代码/命令字符串，作为下一版统一协议候选；尚未批准 |

若进入下一版协议设计，应一次确定正式版本并替换入口；正文与元数据必须显式关联，批次结束后统一校验。需覆盖正文边界冲突、空正文、逐字空白、嵌套围栏、缺失/重复引用和截断。普通代码块仍不能推断为工具，不能逐段到达即执行。

规范参考：[JSON RFC 8259 第 7 节](https://www.rfc-editor.org/rfc/rfc8259#section-7)、[NDJSON 序列化规范](https://github.com/ndjson/ndjson-spec#31-serialization)、[YAML 块标量规范](https://yaml.org/spec/1.2.2/#81-block-scalar-styles)。以上对本项目的取舍为审计建议，不是规范对模型错误率的保证。

## Verification

- 主审执行：`node node_modules/tsx/dist/cli.mjs --test test/autoContinuation.test.ts test/toolResultReturn.test.ts test/chatgptToolIntegration.test.ts`：40/40 通过，0 失败、0 跳过。
- 并行审查执行：replyChangeWatcher、toolWorkspaceStatus：46/46 通过；toolProtocol、toolJsonDiagnostic、jsonDraft、formatSpec：25/25 通过；toolAutoContinueIntegration 与 autoContinuation：40/40 通过。各组有重复文件，不合计为不同测试数量。
- 内存复现：监听 wait 失效后同值开启不恢复；原尾部重挂载后新回复被记历史；未进入运输的预检失败后永久暂停。没有执行真实命令、上传或发送官网消息。
- 文档校验：写入后执行 Dev Flow validate-docs，结果见本轮交付。
- 证据边界：原截图的现场DOM、事件时序及唯一底层触发原因无法追溯；真实模型输出错误率未量化。用户已确认官网验收通过，未单独提供现场轮数、日志或安装版记录；这些限制不构成本任务待办。
- 故障注入与执行/运输计数已由下述原生离线验证覆盖；官网验收依据为用户于2026-10-14明确反馈“验收通过”，不将离线轮数当成官网轮数。

### 修复验证（2026-10-14）

- 全量1126/1126通过，0失败/取消/跳过，测试并发4；类型/构建通过。曾在默认高并发时遇到原有进程超时测试耗时超过10秒断言，未更改进程逻辑或放宽断言，限制并发后完整通过。
- 原生离线30轮/60请求，2次真实监听失效恢复、2次同ID重挂载、同步/异步历史切换和普通DOM变化均不重放，复制/运输同字节；composer57项、通用运输39项、工具面板235项通过。
- 独立评审发现附件取消重复清理及原正文抢先返回的两处P2，已补故障注入修复，复审通过。采集来源缺 key 时失败关闭，快照旧回执跨导航不执行也不污染新会话健康状态。
- 当前推荐行为已回填恢复ADR、原有采集/回传ADR、能力、AGENTS、CONTEXT及路由。这里只保留调查与验证证据，不作为默认能力说明。

## Git Visibility

- 本文件、关联计划及修复属于当前任务；不处理既有 `.mini-ai-ide/` 和 `docs/tool-panel-ui-prototype.html` 未跟踪内容。
- 创建后检查 `git status --short --branch --untracked-files=all`，确认审计文件可见；修复提交c2ec0f5已合并master，已清理完成分支，未推送。

## Closeout

七项发现均verified，用户于2026-10-14确认官网验收通过，CGA-06现场验收已关闭。当前行为已沉淀到能力文档、accepted ADR及回归测试；计划与审计归档，无待跟进发现。原截图无法还原唯一底层触发原因的证据限制继续保留，不影响修复验收结论。
