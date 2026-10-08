---
artifact_type: capability
status: current
updated: 2026-10-08
owner: 胡运宽
source_of_truth: [docs/capabilities/skills-and-local-prompt.md, src/main/localPromptController.ts, src/main/skills.ts, src/main/webComposerSender.ts, src/renderer/workspaceLayout.js, src/main/workspaceLayoutController.ts, src/main/tools/autoContinuation.ts, src/main/tools/webResultSender.ts, test/autoContinuation.test.ts, test/webResultSender.test.ts, tools/verify-web-result-sender.cjs, src/shared/toolJsonDiagnostic.ts, src/main/tools/resultClipboard.ts, src/renderer/toolExecutionClock.js, test/toolJsonDiagnostic.test.ts, test/toolResultClipboard.test.ts, test/toolExecutionClock.test.ts, test/toolExecutionIntegration.test.ts, src/shared/toolProtocol.ts, src/main/tools/harness.ts, src/main/tools/store.ts, src/main/tools/files.ts, src/main/tools/processes.ts, src/main/tools/changes.ts, src/main/tools/autoCollector.ts, src/main/tools/replyObservation.ts, src/main/tools/replyContinuation.ts, src/main/tools/replyChangeWatcher.ts, src/main/tools/integration.ts, src/renderer/toolHarness.js, src/renderer/toolHarness.css, src/renderer/toolPanelLayout.js, src/renderer/toolResultPresentation.js, test/toolProtocol.test.ts, test/toolHarness.test.ts, test/toolIntegration.test.ts, test/toolAutoCollector.test.ts, test/replyObservation.test.ts, test/replyChangeWatcher.test.ts, test/toolHarnessUi.test.ts, test/toolPanelLayout.test.ts, test/toolResultPresentation.test.ts, test/deepseekReplyState.test.ts, test/toolChanges.test.ts, test/toolProcesses.test.ts]
---

# 能力：通用本地工具

权限与执行边界依据 `docs/adr/2026-10-06-native-tool-harness-boundary.md`；限定网页结果回传依据 `docs/adr/2026-10-07-automatic-result-return-boundary.md`，均已接受。

AI 输出规范请求，IDE 只读采集、校验、按权限执行并显示真实结果。开启 automatic 后，在当前整批工具真实结束时按间隔回传官网，覆盖读取、搜索、修改与命令；关闭或暂停时保留用户手动复制发送。路由、权限、计时、状态与截断由确定性代码完成。

## 协议与工具

只接受顶层完整 mini-ai-tools 围栏内版本 1 JSON：protocol_version、batch_id、requests。请求含唯一 id/tool/args，可通过 depends_on 引用前面请求。至多 50 项；额外参数、重复 ID、非法依赖、多正式批次、与文件块混用均拒绝。同文件修改集中到一条 apply_changes，多个非重叠替换放同一 edits；真实路径别名不能绕过唯一目标。参数来源为 validateToolArgs 与 TOOL_PROTOCOL_PROMPT。

读取、修改和命令只有这一种执行协议。手动采集也拒绝旧文件头及操作文本，不能从普通代码推测写盘或运行。自然语言、普通代码示例和围栏内引用资料不执行；反例及正常测试原文见 docs/工具调用测试样例.md。

| 工具 | 内容 |
|---|---|
| get_project_info | 真实根目录、平台、目录概况 |
| load_skill | 固定项目/全局技能目录按名称加载完整 SKILL.md，项目同名优先，不执行资源 |
| list_directory | 目录、深度、条目上限 |
| search_files | glob 路径匹配 |
| read_file | 编码探测、行范围、截断信息 |
| search_text | 字面文本、位置、上下文、上限 |
| apply_changes | 新建、覆盖、唯一 old_string/new_string，复用基线与撤销 |
| run_command | PowerShell/Bash、cwd、前台/后台、超时 |
| get_process_output | IDE 进程 ID、字符游标与分页 |
| stop_process | 只停止 IDE 创建并持有的进程 |

读取使用磁盘内容；用户既有复制上下文可含草稿。目录搜索跳过依赖/构建目录及链接，返回跳过理由；拒绝二进制，不假称截断内容完整。

## 权限与状态

底部预选权限，初始请求批准、自动继续关闭、草稿策略询问，设置持久保存。请求批准时项目内五类只读工具自动，其余由 IDE 询问；规则模式精确匹配允许/询问/拒绝规则，未覆盖询问；完全访问在当前账户内执行项目内外请求。权限不关闭参数、基线与草稿校验。

批准可仅一次或记住本项目精确请求；工作目录到项目根的配置与直接引用脚本变化使规则失效。字面路径支持引号、空格和中文；展开、拼接、嵌套 shell 或无法确定的引用仅支持当次批准。外部脚本不读取正文建立授权指纹，只支持当次批准。设置可清除本项目规则。规则不是命令沙箱，不保证约束间接脚本和联网。

批次顺序执行，前置失败返回 skipped_dependency。结果含 batch_id/request_id/tool/status/data/error；非零退出和超时如实返回。成功查询或停止进程时，进程的失败状态作为 data 保留，工具本身完成，只有调用异常才失败。等待批准、运行、完成、失败、拒绝、取消与重启未知可见。每条运行命令旁的中断只停止对应进程树，不影响其他命令或后续无依赖请求；显式依赖被中断前台命令的请求跳过，保留已执行事实。

去重仅存配置、散列、请求状态，先落盘再执行。最多 10,000 批，达到上限明确停止，不淘汰引入重放。输出正文仅保留最近采集的一轮，界面和复制使用同一结果；新轮开始或解析失败清空旧正文，旧轮迟到输出不混入。重启不自动展示历史；重新采集该批只恢复状态元数据，不恢复原输出或运行 unknown 请求。

复制只包含当前项目与会话最近采集的本批结果；切换项目或会话、尚未采集时不把历史结果送入剪贴板。重启历史只有状态元数据，重新采集已执行批次只返回记录而不重放。

## 修改与采集

本地面板默认收起，头部直接复制本批结果，每条运行命令直接显示独立中断按钮。头部“⋯”始终可见，提供“工具完成后自动复制”开关和可用时的撤销。列表显示中文工具动作、真实路径或进程 ID 及简短结果；参数未回传时不猜测命令或文件目标。异常、后台状态与截断如实保留，展开条目查看完整纯文本 JSON，复制数据不经过摘要转换。正文仅面板滚动，避免多层纵向滚动条。

展开面板可拖动顶部横向分隔条，方向键每次调整 24px，Home／End 调至当前最小／最大高度，双击恢复 160px 请求高度。实际高度随窗口、输入区与摘要高度钳制，保留至少 120px 编辑空间；拖动在取消、失去捕获、失焦或收起时结束，不跨次保留活动指针。

工具摘要与结果详情位于中间官网下方的本地协作 dock；“查看改动”按需打开右侧可关闭的本批改动标签，执行工具不自动切离当前文件；权限与自动继续常驻本地操作栏，同一个 automatic 开关包含采集、权限执行与结果回传，无轮数参数。详细设置在本地浮层，包含发送间隔（0–300 整数秒，默认 3）、未保存策略、完成音效、规则清理与原提示词设置入口；浮层不参与工作区宽度计算。Escape 关闭并恢复按钮焦点，外点、焦点离开或失焦关闭；窄列和长输入仍保留常用操作。摘要显示倒计时、发送、等待回复/用户及暂停原因。

修改先准备本请求全部变更，检查所有真实目标别名的未保存内容，再逐项直接写入。继续替换 B 为 C，停止保留 A/B；成功落盘后更新编辑器。右文件区的 Diff 模式仅查看本批实际 before/after、差异与逐项执行状态，与编辑模式共用正文且不覆盖最右目录树，不提供再次应用或编辑器内联预览；后续人工编辑不污染执行快照，失败与部分成功如实显示。快照仅存当前轮内存，不进入复制结果或执行账本。撤销使用唯一源身份，复用原工具入口并同步变更状态，不能误撤销其后的人工修改。保留同项目／会话内最近 20 项工具撤销，项目或会话切换清空；迟到完成的旧会话修改不能进入新撤销栈。改名／删除仅移除相关路径撤销记录。

自动采集同步观察生成/完成控件和正文，不以文字静止判结束；启用或导航建立历史基线。结构未知时提示手动采集；手动未知状态需用户确认并再次核对正文，生成中不执行。采集不点击、输入或修改网页。

DeepSeek 主回复使用当前回复页脚的原生复制、可用重新生成图标及朗读标签，并结合输入区已知发送箭头确认结束。无标签图标依据现场 SVG 路径前缀识别，不依赖随机类名；代码框和扩展按钮不作为结束证据。任一标志缺失、重新生成不可用、输入图标未知或容器混有多条回复时返回未知，不以先前生成状态推断完成。网页更换这些图标或结构后需重新适配；现场控件回归见 test/deepseekReplyState.test.ts。

启用后在独立隔离上下文注册只读 MutationObserver，相关回复/控件变动以 150 毫秒一次合并通知；没有变化时不安排计时器、读取摘要或运行采集。启用时已有未知回复也保持历史基线，直到可读取完成正文；导航后等待旧回复根替换并在历史加载阶段持续更新基线，相关DOM安静500毫秒后退出加载阶段。该窗口不用于判断AI生成结束；历史分批间隔超出窗口时仅靠DOM无法完全区分。通知后检查生成/完成状态，生成中或结束未知时不散列或解析全文；摘要和状态不变时复用主进程缓存。导航历史等待期间已观察到的新生成状态单独保留到合并通知；即使生成在150毫秒通知前结束，也不把首轮完整输出重置为历史。关闭或再次导航清除该观察证据。变化通知不能证明生成结束，执行仍读取正文与结束标志的同一完整快照。监听不写 DOM、主世界变量或暴露本地桥；关闭/导航/销毁清理，失败明确提示手动采集，不退回轮询。工具处理期间变动合并为一个待通知，完成后继续读取；手动成功同步调度基线，不重复执行。

本次新批结果就绪产生一次当前轮完成事件；本地摘要显示短暂成功/错误动画，不展开面板或抢焦点，尊重减少动态效果。工具设置中的完成音效默认关闭、持久保存，用户由关闭切换为开启且保存成功后预听一次，与批次完成使用同一短音；保存失败或准备结束前已关闭不播放。此后每批最多一次本地短音；播放失败独立提示，不覆盖工具事实。刷新、重复批和重启历史状态不触发，切项目或会话清空事件，ID 在主进程生命周期内递增。

自动采集由新完成回复驱动，独立于发送动作识别、发送回执和会话绑定。开启后已有正文只建立历史基线；真正切会话时等待目标历史DOM，不把旧DOM残留或迟到历史作为新输出。首页分配真实 `/a/chat/s/ID` 地址时，连续回复节点、生成状态或有效的一次提交记录用于确认地址交接；路径谓词与发送器共享。官网可信发送点击/回车与本地发送共用8秒提交记录，其他真实动作取消旧交接（不能再由先挂载的历史节点恢复），导航消费后不继承；新的已识别发送可重新建立记录。确认首页交接同时结束遗留历史等待，保留正文去重和真实生成证据；记录不是回复完成证据或执行授权。真实用户动作另用于取消旧待发送结果。生成/中断/未知仍等待，完整新回复经正式协议、权限和持久批次去重后执行。

输入区外可见、可用的原生“继续生成／Continue generating”按钮表示回复中断，优先于普通完成页脚；正在生成标志仍优先。中断等待时不读取正文摘要或自动采集半成品，工具栏显示“等待续写”。标签须精确匹配，允许最新唯一回复的正文外页脚和独立原生控件，历史回复、正文及代码卡不作为续写控件。真实点击继续后，页面变化恢复检查；再次中断继续等待，最终结束才重新采集整条原回复。早期格式错误不写执行账本，不占用批次 ID；补全后仍校验完整协议，已执行失败、重复或未知批次不自动重放。手动采集在明确中断状态及确认期间再次中断时也不执行。

自动入口复核内容观察版本及来源项目/会话；手动入口复核采集时的项目、会话、重置版本与销毁状态。切换、关闭或销毁作废旧读取，不把旧回复交给新上下文执行。

确认新回复结束后将正式批次交给执行器。普通讨论不执行，界面明确显示没有工具请求；旧文件操作格式明确拒绝。默认简洁版 6 例、完整版 13 例全部遵循同一协议；自定义原文保留，但有效复制始终附强制协议，不能改为另一种执行格式。状态显示就绪、等候生成结束、无法确认结束或执行结果，避免没有请求时静默略过。

命令默认 120 秒、最大 600 秒，返回 stdout/stderr/退出码/超时/进程状态。后台最多保留 1,000,000 字符，分页明示截断；停止失败保留可能仍在运行的事实。Bash 缺失明确失败，不换另一 shell。

退出先处理未保存内容；取消退出保持工具与自动采集可用。批准退出后关闭编辑窗口，主进程等待所属命令清理完成再退出。

## 执行反馈、诊断与复制

任务真实开始时记录 started_at，终态记录 finished_at；等待授权或重启恢复不虚构时长。命令 data 提供真实主进程时间戳与 duration_ms，后台启动回执不表示进程结束，后续真实退出事件刷新当前批次输出；发布启动回执前复核快照，避免退出早于记录写入时卡住。列表状态只显示一次，执行秒数仅刷新文字，结束、切换或关闭释放本地计时器。

前台和后台命令在真实 spawn 后即发布进程身份，每行中断按当前项目、会话、批次、请求与 process_id 核验，只终止对应 IDE 所属进程树。旧进程的迟到中断响应不能禁用同 ID 的新命令或污染其状态。停止失败保留真实输出、错误、归属身份及重试入口，cleanup_pending 表示仍有树清理工作；主 shell 已退出时长保持真实退出值。超时报告失败，用户中断报告取消。退出清理仍取消剩余请求并停止全部所属命令，路径校验阶段的未启动命令不能迟到启动。后台所有命令及树清理结束后才生成本批完成事件，按实际退出状态判断反馈，不把启动成功当作执行成功。

工具 JSON 错误整批不执行、不预约批次；多个请求中一项校验失败也不部分执行。工具结果列表显示一个展开的“批次校验”失败卡片，包含原生 SyntaxError；有位置时给 JSON 正文行列、UTF-16 偏移与短片段，没有位置时不推测。不能解析的批次不伪造工具名或请求 ID，复制本批结果返回 {protocol_version:1,tool_results:[],batch_error:{status:"failed",error:诊断正文}}。不另铺全局长诊断，正文只保留最近轮内存，切换项目/会话清除，不联网或自动修复 JSON。

当前新批次全部工具真正结束且至少一个工具实际执行后自动复制完整 tool_results 一次，覆盖读取、搜索、修改、进程查询和命令，默认开启，在工具结果栏“⋯”可关闭并保存；工具执行失败输出也复制。后台启动、全部未执行、取消、未知、历史恢复及界面状态查询/设置不会写剪贴板；切换项目/会话作废旧轮。手动复制按钮保留，复制失败独立提示，automatic 开启时成功复制不误提示用户必须再粘贴。批次完成事件主进程单调编号，状态广播、界面初始化或重绘不重复复制，失败不暗中重试。

## 自动继续与结果发送

`autoContinuation.ts` 独立拥有完成事件去重、等待、倒计时和一次发送状态。发送只消费当前项目/会话/批次的新完成事件，且至少一项 done/failed 结果具有真实 started_at；实际执行失败可回传用于修复。后台启动及 cleanup_pending 继续等待。任何拒绝、取消/中断、unknown，或无执行、批次格式错误、纯对话时暂停/等待用户；历史恢复与重复状态不启动发送。

限定发送与输出采集独立；后续只读 DOM 变化触发完整结束快照核验，合成 click 不冒充真实用户事件。

`webResultSender.ts` 是唯一网页写 owner，仅官方 DeepSeek 当前会话、唯一可见 textarea 与已知发送 SVG 的局部关联，隔离世界 1005；采集/监听仍只读世界 1004。输入为空且页面空闲才以原生 value setter、input 和 click 填入并提交同源纯文本结果，不读取剪贴板、不写 HTML、不保存用户草稿。未知控件、已有草稿或用户改写暂停；点击前取消只清理自有文本，点击后不确定、超时或异常不重试。网页始终无 IPC/文件桥，AI HTTP 仍由 Chromium 发起。

规则验收入口为 `test/autoContinuation.test.ts`、`test/webResultSender.test.ts`、`test/toolIntegration.test.ts`；原生 sender 验收为 `tools/verify-web-result-sender.cjs` 的本地 Electron 夹具。真实官网尚未验收，不能据夹具断言平台接受合成发送。

自动采集与受控发送独立：实际新完成工具输出无需等待本地发送或结果回传回执，发送失败和 unknown 不屏蔽真实输出。执行与结果回传仍使用来源项目/会话/批次校验，回传不重试未知提交，切换上下文作废旧待发送结果。
