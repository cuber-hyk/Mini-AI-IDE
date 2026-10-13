---
artifact_type: audit
status: active
created: 2026-10-12
updated: 2026-10-13
scope: "ChatGPT 首批回传状态复核暂停，以及用户无操作时自有输入检查暂停"
source_of_truth: [src/main/tools/integration.ts, src/main/tools/resultReturn.ts, src/main/webComposerSender.ts, src/main/chatgptPage.ts, src/main/tools/replyObservation.ts, src/main/tools/replySource.ts, src/main/tools/replyChangeWatcher.ts, test/chatgptReply.test.ts, test/replySource.test.ts, tools/verify-chatgpt-composer.cjs, tools/verify-chatgpt-tools.cjs]
---

# ChatGPT 采集与回传误暂停诊断

## 原始核查范围（历史阶段）

只读核验两张用户截图所示暂停阶段和自有输入比对。读取生产规则，并在内存执行已序列化的 ownedText 函数，不操作实际网页。不修改发送规则，不重启当前应用，不重发当前或历史结果；官网本次具体触发结构尚未取得。

## Fact Sources

- Code: integration.ts 的 resultReturn.verify；resultReturn.ts 的一次尝试与 paused 终态；chatgptPage.ts 的完成判断；replyObservation.ts 的同步快照与地址复核。
- Tests: 现有回传/平台/ChatGPT 测试可验证保护语义，本轮未以离线夹具代替当前官网现场。
- Docs: CONTEXT.md、docs/ai/context-map.md、docs/capabilities/web-platforms.md、AGENTS.md。
- Runtime checks: 用户截图显示 ChatGPT 两项工具 done 与“网页回复状态或会话已变化”；用户称手动回传后后续自动恢复。当前前台为 electron .，现有临时诊断日志来自已结束的旧验证窗口，未读取为本次证据；未取得当前发送前快照。

## Findings

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| CGR-001 | P2 | resolved | 发送前复核混称会话变化与未完成状态，无法从提示确定暂停原因 | 旧 integration.ts:299 合并守卫；当前分别返回会话/生成/中断/未知结束 | docs/plans/archived/2026-10-12-chatgpt-collection-composer-pause.md | codex/chatgpt-auto-collection-pause / 未提交 | 三种完成复核反例均拒发送并返回准确原因；旧结果不重发 | fixed：区分诊断；原截图具体触发结构不冒称已取得 |
| CGR-002 | P2 | resolved | ChatGPT 同文编辑器整理触发自有输入失效 | 旧 ownedText 拒 span/末尾 BR；新限 P/文本/span/明确 trailingBreak，原文逐字比对 | docs/plans/archived/2026-10-12-chatgpt-collection-composer-pause.md | codex/chatgpt-auto-collection-pause / 未提交 | 原生同文整理发送与取消通过；真改文、未知节点、接管反例仍暂停不清草稿 | fixed：已修复确定机制；官网实际变形仍由用户验收核对 |

## ADR Gate

- Needed: maybe（若修改自有文本与用户接管判据，须复核原受控发送契约）。
- Reason: 仍保持活动平台、当前批次、正式会话与完成状态复核；不能用取消校验或重试旧批次恢复流程。

## Verification

- Commands run: git status/log；读取相关 owner 与文档；检查前台进程和现有诊断日志来源。
- 内存验证：发送器的 WebContents 被 mock，仅捕获序列化脚本，世界 1005 不注入实际页面；执行其中 ownedText 函数。三组正文同为 unchanged text；plain ownershipAccepted=true，inline-span/trailing-break=false。复现脚本存临时目录 mini-chatgpt-owned-text-probe.cjs，不加入产品构建。
- Not verified: 当前暂停时的 URL 是否一致、具体 completion、生成/复制页脚控件；第二次官网实际 DOM 和程序填入前后正文是否字节相等。不能断言本次实际发生了 span/BR 整理，不能用仅 trim/任意 innerText 比对替换草稿保护。

## Git Visibility

- 当前新增审计文件应显示为 untracked；未提交、合并或 push。

## Closeout

当前结论见下文：确定机制已修复并有离线证据；CGR-005 与新版官网验收继续保留 active，不把截图猜测写成已取得的现场根因。

## 当前修复核查（2026-10-12）

用户新提供六张截图并明确授权修复。已区分：等待结束、未知新增来源、手动采集为空、发送前复核、输入归属和点击后/取消未知；未把所有失败归为推荐词未出现。旧 collection-trace.log 最后更新为 2026-10-09，不能作为本次故障证据。

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| CGR-003 | P2 | resolved | 全页 busy 把推荐区/侧栏加载误认为 AI 生成，影响完成/监听/发送和点击后确认 | 旧生产脚本中给完整回复外加 aria-busy 推荐区域即 complete→generating | docs/plans/archived/2026-10-12-chatgpt-collection-composer-pause.md | codex/chatgpt-auto-collection-pause / 未提交 | 新生成范围反例及原生发送反例通过 | fixed：统一当前正式回复生成见证；官网实际是否用该 busy 属性待确认 |
| CGR-004 | P2 | resolved | seal 后代码复制按钮文案变化污染整个 textContent 指纹，正式工具文本不变却 new→unknown | 现有 fixture 中复制→copy，采集文本不变，旧来源失效 | docs/plans/archived/2026-10-12-chatgpt-collection-composer-pause.md | codex/chatgpt-auto-collection-pause / 未提交 | 接线和来源回归证明控件改文案 key 稳定；真实正文变化、旧历史和未知重挂载仍拒绝 | fixed：ChatGPT 来源只读正文 reader；不开放任意 sealed 节点变化 |
| CGR-005 | P2 | open | 手动采集为空、实际回复节点重挂载及取消未确认的具体现场仍未定位 | 截图“未采集到回复”、无操作却暂停；缺该瞬间 DOM/时序 | docs/plans/archived/2026-10-12-chatgpt-collection-composer-pause.md | codex/chatgpt-auto-collection-pause / 未提交 | 不以 busy 修复解释 collect 脚本返回空；节点重挂载守卫保持 | 待新版真实官网验收与失败时结构证据，不放宽唯一最新回复或点击后不重试 |

CGR-001 的复核错误已区分会话变化、generating、interrupted 和未知结束；CGR-002 的同文 span/明确末尾占位 BR 已修复，未知结构保留，真实编辑优先停止。当前不宣称六张截图所有现场均已修复，审计因 CGR-005 和官网验收继续 active。

## 最终验证与限制

主目录组合972单测通过，0失败/取消/跳过；构建通过。独立评审92聚焦通过，已修正角色控件包装导致指纹与采集范围不一致的复现风险。ChatGPT composer原生31项及DeepSeek原生39项通过。组合ChatGPT工具原生检查第一次首页首发超时，未认作通过；单独诊断业务11项通过后出现profile锁清理失败，已修正fixture父进程清理和退出码，最终11项通过且正常退出。该复跑不证明第一次间歇超时或六张截图所有现场根因消失。

完成状态仍要求最新唯一正式 assistant/complete turn/复制页脚；推荐提示词加载不作为完成依据。新版三轮官网验收待用户反馈，手动采集为空、实际编辑器节点变形/重挂载、取消未确认等现场保持 CGR-005 open，未放宽历史隔离或点击后不重试。

## 官网验收反馈（2026-10-12）

用户按新版开发 IDE 三轮只读验收反馈“三轮全程自动成功”，没有手动采集或回传；本次修复闭环已通过官网验证。CGR-001/002/003/004 的确定机制有离线回归、独立审查与新版功能验收；CGR-005 保留原现场归因未知，不因正常三轮成功声称所有间歇故障永不发生。相关实施计划已归档，本报告因 CGR-005 继续 active。

## 已有会话的实际结构故障（2026-10-12）

用户保留故障页面，在官网Console提供三份只读结构快照：普通路径成立、5轮均有assistant及data-dil-message-id，最新turn complete；heading未排除且owner包含正文与markdown，正文未排除，但带DilResponseRoot-类名条件的正文根命中0。CodeContent与CodeSurface各1，mini-ai-tools语言标签存在。由此确认自动/手动采集均为空的具体阻断点，不将反馈卡片或推荐词作为原因。

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| CGR-006 | P1 | resolved | 已有会话正式正文不满足DilResponseRoot-样式类约束，采集根为空 | 用户现场matchingReplyRoots=0，但唯一正文ID、角色、归属、markdown和代码框均满足 | docs/plans/archived/2026-10-12-chatgpt-existing-conversation-collection.md | codex/chatgpt-auto-collection-pause / 未提交 | 旧代码class改变/缺失正例失败；新根按稳定语义属性限定，独立94聚焦通过；主目录全量975及原生11通过 | fixed：原会话两轮及同一HTML自动闭环成功；用户确认接受本次验收并归档计划，不伪称单独手动采集已实测 |

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| CGR-007 | P2 | resolved | 首发需求尚在确认时当前新工具已完成，结果立即运输触发已有内容正在发送 | 更名正文原生首页闭环多次复现，完整拒绝原因为运输互斥；对齐backgroundThrottling=false后仍复现 | docs/plans/archived/2026-10-12-chatgpt-existing-conversation-collection.md | codex/chatgpt-auto-collection-pause / 未提交 | 延迟需求确认反例旧code失败；新verify等待再复核，25接线、39独立评审聚焦和原生11全部通过；取消不补发 | fixed：运输等待及当前批次/不重试保护已验证；用户确认本次官网自动闭环验收通过 |

CGR-005所包含的手动采集为空现场，本次已取得结构证据并单独归因至CGR-006；未知节点重挂载或取消未确认的其他瞬间仍未取得现场，不因本次修复自动关闭。审计保持active。

## 续聊发送控件变化（2026-10-12）

用户在原故障会话反馈两轮自动采集/回传均成功，随后续原任务，read_file真实完成且正文已填入，暂停提示“网页发送控件已变化”。用户明确未手动操作/发送；其后截图输入为空、只显示语音按钮，静态快照inputCount=1/sendCount=0/唯一FORM/无其他编辑器。空输入下sendCount=0正常，该快照不能还原失败瞬间的原/当前节点身份，不能据此断言推荐词或某种重挂载是现场原因。

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| CGR-008 | P2 | resolved | 已知发送按钮被官网重绘时仍按节点身份拒绝；聚合控件变化提示无法区分真实输入替换与按钮重绘 | 原生同一原输入/FORM、旧button断开及唯一已知新button正例在旧代码失败；官网具体触发分支尚未取得 | docs/plans/archived/2026-10-12-chatgpt-existing-conversation-collection.md | codex/chatgpt-auto-collection-pause / 未提交 | 仅受控未点击阶段选择唯一已知新按钮，再核验原文/接管/会话/生成/附件；细分提示及不含正文的布尔诊断 | fixed：已知按钮重绘及反例验证通过，用户接受新版续聊验收；不冒称原截图瞬时节点身份已取得 |

原生反例及生产函数只读内存核对证明：纯按钮替换而原输入逐字自有时原代码会清空；原输入断开或未知正文结构可能保留结果。细分控件错误及可选collection trace仅记录连接、身份、归属布尔值，不记录正文或草稿。CGR-006已有原会话两轮全自动成功反馈；关闭automatic后的手动采集验收尚未反馈，且当前发送问题由CGR-008独立跟踪。

CGR-008验证：构建/类型检查通过，8运输单测全部通过、0失败/取消/跳过；主目录原生35项通过、退出0，含组合守卫和点击后unknown不重试。独立只读代码审查无阻断，独立原生33项通过；追加组合反例在主目录最终35项覆盖。文档校验无问题、差异检查通过。官网续聊验收仍待反馈，审计与实施计划继续active；无Git提交、合并或推送。

## 官网FORM拒绝条件核实（2026-10-13）

用户新版再次暂停于“无法唯一确认输入框与发送按钮”。首次检查误在本地file页面，只取得“需求”textarea，用户随后明确确认并重取https://chatgpt.com快照，前者不作为官网证据。官网结果为唯一ProseMirror编辑器、唯一已知submit/发送按钮且enabled、sameForm=true、excluded=false，但formHasReply=true。这直接命中controls的FORM内回复排除条件，说明此刻并非缺失发送按钮或编辑器歧义。命中的具体selector及节点位置尚待只读核查；不把预提示词时序、按钮重绘或模糊markdown类名误判提前写成已证实的现场根因。

用户后续结构快照明确只有[class*="markdown"]命中，节点为输入框内P→SPAN→SPAN.inline-markdown，无data属性；.ds-message与全部正式角色/轮次/正文标记均无匹配。现已确认模糊样式类检查把正常编辑器装饰误当回复区，不需要再猜测推荐词渲染时序。

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| CGR-009 | P1 | verified | ChatGPT输入内inline-markdown装饰被FORM回复检查误判，填入后暂停回传 | 真实官网唯一输入/发送/FORM正常，仅输入内span.inline-markdown触发回复排除 | docs/plans/archived/2026-10-12-chatgpt-existing-conversation-collection.md | codex/chatgpt-auto-collection-pause / 未提交 | 现场嵌套span正例旧代码失败；修复后原生38项、相关14单测通过，构建与独立审查通过 | fixed：原输入范围判据及保护不变；2026-10-13同一故障会话含颜色和URL的HTML读取自动采集/回传验收通过 |

CGR-009验证检查点：主目录原生38项全部通过、退出0；14相关单测通过、0失败/取消/跳过，生产构建通过。独立只读审查无阻断发现，独立8发送器单测与类型检查通过。组合fixture覆盖长JSON、空行和末尾空格、busy推荐区、取消、原输入inline装饰下五种真实编辑接管，以及9项消息标记/未知语义/改文/外部markdown反例。主目录文档校验无问题，差异检查通过；最终官网复验待用户反馈，不归档计划或关闭其他未知现场，不提交、合并或推送。

## 颜色色块与自动链接装饰（2026-10-13）

新版用户续原任务，工具采集及read_file完成，官网输入已有结果而提示“网页输入已被修改”。只读结构核查显示24个段落、50050正文字符、无BR，共43个旧正文判据拒绝节点。完整补充结构确认：23个空SPAN色块均含data-hex-color-swatch、aria-hidden=true、contenteditable=false及已知属性；4个自动链接SPAN包含原文字及空data-inline-url-icon装饰，每组额外有容器SPAN、svg、path，共20个节点。这覆盖全部43个拒绝节点；预提示词并非本次正文校验失败的证据。

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| CGR-010 | P1 | verified | 官网颜色预览和自动链接排版被自有正文节点白名单拒绝，误报输入修改 | 用户真实官网三次只读结构检查，23+4×5=43个拒绝节点全部定位 | docs/plans/archived/2026-10-12-chatgpt-existing-conversation-collection.md | codex/chatgpt-auto-collection-pause / 未提交 | 旧代码新增五万字颜色结果正例false!==true复现；实现后初轮44原生检查通过，组合含颜色、链接及busy推荐区 | fixed：主目录44原生/14单测、构建与独立审查通过；2026-10-13用户确认原会话同一HTML自动采集/回传成功 |

范围限发送owner的正文判据：仅允许明确自动链接span的属性白名单；仅忽略无文字且受限结构的明确颜色/链接装饰。不放宽任意不可编辑节点或SVG、不跟随链接、不改正文、不新增重试。原文逐字、用户接管、附件、原输入/FORM、会话及点击后不重试仍独立核验。Design system gate: not needed，本轮无布局、样式或交互控件变化。ADR gate: not needed，既有运输授权及所有权边界不变。计划/审计继续active，待用户复验，不进行Git操作。


CGR-010最终检查点：主目录组合状态原生44项通过（含五种真实编辑接管分别覆盖inline排版及色块/自动链接排版），14相关单测通过，均0失败/取消/跳过；生产构建通过。独立只读审查mode=subagent，plan compliance/audit coverage/related changes/verification/changelog/distill均pass，无代码阻断，独立8发送单测及类型检查通过。任务worktree正式文档校验有5项既有错误、3项警告，来自未修改旧归档；最终主目录正式文档校验No issues found，差异检查通过。两目录代码及原生夹具逐字一致，主目录既有AI临时目录变更和登录验收记录保留。官网仍须原故障会话重新读取同一HTML并全自动回传，不用旧批补发，未提交/合并/推送。

## 当前官网验收结论（2026-10-13）

用户对同一故障ChatGPT会话、同一份含颜色值和URL的HTML复验，明确反馈“自动采集并回传成功”，测试要求不手动采集或发送结果。因此CGR-009/010标记verified；这覆盖此次确定的输入装饰误判，不代表所有未知时序永不发生。审计仍因CGR-005的未知重挂载/取消未确认现场保持active；独立关闭automatic后的手动采集未取得新验收反馈，保留在CGR-006所属活跃计划，不将自动链路成功冒充独立手动验收。既有待验收段落为历史阶段记录，当前结论以本节为准。本轮只更新文档，不更改代码、不重跑已通过测试、不进行提交/合并/推送。

## 用户确认与收尾（2026-10-13）

用户在真实官网自动闭环成功后明确确认本次验收通过，要求收尾归档、提交合并。本计划EC-1至EC-4全部结束，单独关闭automatic后的手动采集未另行实测，不伪称该项已实测通过；用户接受现有验收作为本次收尾依据。本文早期等待验收记录保留为历史证据，不再作为未决门禁。未知旧现场仅由仍active的首批回传审计CGR-005留存，不由本计划继续实施。不推送远端，不纳入AI临时目录/JSON恢复及无关文档整理改动。

提交前最终复核：独立ChatGPT任务分支全量测试952项通过，0失败/取消/跳过（不含主目录另行未提交的AI临时目录/JSON恢复测试）；生产构建通过。最后一次原生44项与主目录相关14单测通过，真实官网同一故障会话验收通过。独立收尾review pass，无新增阻断；主目录正式文档检查及差异检查通过。独立任务树的5项既有归档错误、3项警告未扩入本次修复范围，保持明确记录。按用户明确授权提交并在独立工作树快进合并到master，不push，不删除分支，主目录其他未提交工作保留。
