---
artifact_type: capability
status: current
updated: 2026-10-16
owner: 胡运宽
source_of_truth: [test/toolTextBodies.test.ts, test/toolTextDraft.test.ts, tools/verify-chatgpt-tools.cjs, src/shared/toolTextBodies.ts, src/main/chatgptPage.ts, test/chatgptComposerSender.test.ts, tools/verify-chatgpt-composer.cjs, src/main/tools/manualToolJson.ts, src/shared/manualToolJson.ts, src/renderer/toolJsonPanel.js, test/manualToolJson.test.ts, test/manualToolJsonIntegration.test.ts, test/toolJsonPanel.test.ts, src/main/tools/replySource.ts, test/replySource.test.ts, src/main/toolWorkspaceStatus.ts, src/renderer/toolAttention.js, src/renderer/fileWorkspace.js, src/renderer/editorTabs.js, test/toolWorkspaceStatus.test.ts, test/toolAttention.test.ts, test/fileWorkspace.test.ts, src/main/toolSettingsWindow.ts, src/main/toolSettingsIpc.ts, src/main/toolSettingsPreload.ts, src/shared/toolSettings.ts, src/renderer/toolSettings.html, src/renderer/toolSettings.js, src/renderer/toolSettings.css, src/renderer/toolCompletionSound.js, test/toolSettingsWindow.test.ts, test/toolSettingsIpc.test.ts, test/toolSettingsUi.test.ts, src/main/workspaceProbe.ts, docs/adr/2026-10-09-batch-error-auto-return.md, docs/adr/2026-10-09-tool-attachment-return.md, src/main/tools/attachments.ts, src/main/tools/resultReturn.ts, test/toolAttachmentIntegration.test.ts, test/toolAttachments.test.ts, test/toolResultReturn.test.ts, docs/capabilities/skills-and-local-prompt.md, src/main/localPromptController.ts, src/main/skills.ts, src/main/webComposerSender.ts, src/renderer/workspaceLayout.js, src/main/workspaceLayoutController.ts, src/main/tools/autoContinuation.ts, src/main/tools/webResultSender.ts, test/autoContinuation.test.ts, test/webResultSender.test.ts, tools/verify-web-result-sender.cjs, src/shared/toolJsonDiagnostic.ts, src/main/tools/resultClipboard.ts, src/renderer/toolExecutionClock.js, test/toolJsonDiagnostic.test.ts, test/toolResultClipboard.test.ts, test/toolExecutionClock.test.ts, test/toolExecutionIntegration.test.ts, src/shared/toolProtocol.ts, src/main/tools/harness.ts, src/main/tools/store.ts, src/main/tools/files.ts, src/main/tools/processes.ts, src/main/tools/changes.ts, src/main/tools/autoCollector.ts, src/main/tools/replyObservation.ts, src/main/tools/replyContinuation.ts, src/main/tools/replyChangeWatcher.ts, src/main/tools/integration.ts, src/renderer/toolHarness.js, src/renderer/toolHarness.css, src/renderer/toolPanelLayout.js, src/renderer/toolResultPresentation.js, test/toolProtocol.test.ts, test/toolHarness.test.ts, test/toolIntegration.test.ts, test/toolAutoCollector.test.ts, test/replyObservation.test.ts, test/replyChangeWatcher.test.ts, test/toolHarnessUi.test.ts, test/toolPanelLayout.test.ts, test/toolResultPresentation.test.ts, test/deepseekReplyState.test.ts, test/toolChanges.test.ts, test/toolProcesses.test.ts, src/main/tools/aiTempDirectory.ts, src/main/tools/jsonDraft.ts, test/aiTempDirectory.test.ts, test/jsonDraft.test.ts, test/toolAutoContinueIntegration.test.ts, test/toolStore.test.ts, tools/measure-tool-store.ts]
---

# 能力：通用本地工具

## 回复来源与历史隔离

`replySource.ts` 在只读隔离世界 1004 保存所有已挂载历史的正文指纹与当前消息尾部；`replyChangeWatcher` 拥有该状态，`replyObservation` 在同一快照读取来源与结束证据。只有保留尾部的顺序新增或绑定到该回复节点的真实生成正文变化，才能形成新输出；不依赖发送回执。回看、旧内容重挂载和整段尾部替换不授予执行资格。同会话唯一稳定消息 ID 与已确认正文同时匹配时可恢复重挂载尾部的顺序锚，旧消息保持历史，下一真正新增回复可继续。轻量与完整完成探测保持只读且不封存；实际接纳时按 sourceKey 复核当前来源、正文与完成状态再封存。缺少来源标识、正文被换成历史、异步导航或项目变化都不能执行旧快照。流式来源检查随 150ms 合并通知或完成快照运行，不对每次字符变化重扫历史全文。

监听明确失效与只读读取异常按 250/1000/3000 ms 最多恢复三次。订阅修复保留同文档来源、采集水位与工具/回传状态；来源状态丢失则将已有回复保留为历史并提示手动采集。关闭、导航或销毁撤销旧恢复，未知来源与用户中断不自动解除。同步挂载的目标历史安排仅更新基线的通知；旧 DOM 和空加载帧仍等待迟到历史。主进程 collection 独立报告监听/读取健康及原因，顶栏和工具摘要不再用旧等待状态掩盖采集暂停。规则见 `../adr/2026-10-14-automatic-recovery.md`。

AutoCollector 按会话记住基线和已接纳完整正文的 SHA-256，已见错误经过普通回复后重现也不再产生自动诊断回传。来源与内容见证最多保存 10,000 项，到达上限不淘汰旧记录，而是停止自动处理；持久执行账本仍由 ToolStore 独立拥有。手动采集保持用户明确选择的既有入口，权限不变。已有会话的初始空 DOM 等待迟到历史；官网空首页仍可采集首轮。若官网将从未挂载的历史后段按与新输出完全相同的顺序追加，DOM 本身仍可能无法区分；不读取或逆向官网 API 补偿，现场需核实。

验证：`test/replySource.test.ts`、`test/replyChangeWatcher.test.ts`、`test/toolAutoCollector.test.ts`，以及 `tools/audit-background-history.cjs` 的真实离线 DOM/命令/诊断回归。

权限与执行边界依据 `docs/adr/2026-10-06-native-tool-harness-boundary.md`；限定网页结果回传依据 `docs/adr/2026-10-07-automatic-result-return-boundary.md`，均已接受。

AI 输出规范请求，IDE 只读采集、校验、按权限执行并显示真实结果。开启 automatic 后，在当前整批工具真实结束时按间隔回传官网，覆盖读取、搜索、修改与命令；关闭或暂停时保留用户手动复制发送。路由、权限、计时、状态与截断由确定性代码完成。

## 协议与工具

只接受顶层完整 mini-ai-tools 围栏内版本 1 清单：protocol_version、batch_id、requests，清单后可跟具名原文块。请求含唯一 id/tool/args，可通过 depends_on 引用前面请求。至多 50 项；额外参数、重复 ID、非法依赖、多正式批次、与旧文件操作块混用均拒绝。同文件修改集中到一条 apply_changes，多个非重叠替换放同一 edits；真实路径别名不能绕过唯一目标。参数来源为 validateToolArgs 与 TOOL_PROTOCOL_PROMPT。

多行及复杂正文推荐通过 `{ "text_ref": "块名" }` 引用同围栏内 `@@body 块名` 与 `@@end 块名` 之间的原文；仅 run_command.command、文件修改 content、old_string/new_string 和草稿替换 content 可引用，路径等控制字段不引用或插值。每块唯一引用，无缺失、闲置或歧义边界；块名为 `[A-Za-z0-9][A-Za-z0-9_.-]{0,99}`，manifest 保留；最多100块，带块的容器正文不超过200000字符。运输换行统一LF，其他字符不trim；标记相邻单个换行属于边界，额外空行仍保留。正文中的独立@@body或@@end标记词行（标记词后接空白或行尾，含缩进歧义行）拒绝，外层围栏须长于正文内同类围栏。无块的短JSON仍为同一协议；解析成字符串后继续复用原内部ToolBatch、权限与执行owner，不引入第二执行路径。详细合同及迁移见 return-path-and-format-contract.md 和 `../adr/2026-10-16-tool-text-bodies.md`。

读取、修改和命令只有这一种执行协议。手动采集也拒绝旧文件头及操作文本，不能从普通代码推测写盘或运行。自然语言、普通代码示例和围栏内引用资料不执行；反例及正常测试原文见 docs/工具调用测试样例.md。

| 工具 | 内容 |
|---|---|
| attach_file | 明确请求上传受支持的真实文件；工具权限批准后暂存当前批附件，done 不表示官网已接收 |
| get_project_info | 真实根目录、平台、目录概况 |
| get_ai_temp_dir | 按需创建或验证当前项目内、具备归属标记的 AI 任务临时目录，返回真实路径和稳定 task_id |
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

## AI 临时目录与 JSON 草稿恢复

`get_ai_temp_dir({task_id})` 由 `aiTempDirectory.ts` 管理当前项目真实根目录下的 `.mini-ai-ide/ai-temp/<task_id>/`。首次选择稳定的 task_id，后续同任务复用。创建及复用时检查目录归属标记、真实路径、符号链接与 Windows junction；未知或冲突目录直接拒绝，不迁移、不覆盖、不自动删除已有文件。专用 `.gitignore` 只忽略临时运行文件，不修改项目原有 `.gitignore`，也不改变命令默认 cwd。临时脚本、日志和敏感数据由用户自行管理；Git 忽略不代表安全删除。

`jsonDraft.ts` 仅为一个完整、边界无歧义的顶层正式容器内清单 JSON.parse 错误维护内存草稿。诊断返回 draft_id 和从 1 开始的修订版本；下一次完整官网回复可发送单个 `repair_draft`，包含 draft_id、version、body_id 与 content。body_id 为 manifest 时替换清单，为当前块名时替换该正文并保留其他块；content 可为短字符串或补丁自身原文块引用，不需复述旧长正文。仍支持非空且唯一匹配的 old_string/new_string 短补丁，默认优先重发短清单。原始官网回复不变，补丁只修改未执行的内存修订稿。修复后仍存在 JSON 语法错误时可以继续按新版本修补；JSON 已合法但工具协议或参数错误时终止草稿，要求重新提交完整合法批次。错误标识、过期版本、重复、歧义边界或失效补丁均不得执行工具。

默认强制提示词提前介绍草稿修复，模型必须等待 IDE 返回真实 ID 与版本，不能自行编造。有有效草稿的诊断给当前身份的清单/块替换指导；无法建立草稿或已失效时要求完整重发。解析原因由 toolJsonDiagnostic 单独提供，不混入相反的修复策略。旧会话由用户重新附带新版格式要求，不静默改写历史；内联长脚本推荐在真实临时目录创建脚本后用短命令运行。

恢复后的合法批次继续经过原有 ToolHarness 静态校验、权限审批、ToolStore 持久去重和结果回传。来源绑定草稿、原文与修订稿摘要、补丁原文及摘要、恢复批次摘要、项目、官网平台、会话及采集代次。ToolResultReturn 发送前必须重新读取官网最新已完成回复，确认仍是关联的有效补丁；来源变更、取消及作用域失效均阻断旧结果发送。解析及批次校验错误仍受连续最多 5 次自动回传限制，第 6 次暂停。命令启动或运行失败仍返回真实工具结果，不属于 JSON 语法草稿修复。

既有临时目录和JSON短补丁闭环已有单元、集成及原生本地DOM验证。具名原文块与整块替换的确定性解析、来源及执行边界由对应测试验证；不能将既有官网验收外推为新协议的真实官网连续使用或模型降错比例。新协议的官网接纳与人工使用需单独验收。

## 权限与状态

底部预选权限，初始请求批准、自动继续关闭、草稿策略询问，设置持久保存。请求批准时项目内五类只读工具自动，其余由 IDE 询问；规则模式精确匹配允许/询问/拒绝规则，未覆盖询问；完全访问在当前账户内执行项目内外请求。权限不关闭参数、基线与草稿校验。

批准可仅一次或记住本项目精确请求；工作目录到项目根的配置与直接引用脚本变化使规则失效。字面路径支持引号、空格和中文；展开、拼接、嵌套 shell 或无法确定的引用仅支持当次批准。外部脚本不读取正文建立授权指纹，只支持当次批准。设置可清除本项目规则。规则不是命令沙箱，不保证约束间接脚本和联网。

批次顺序执行，前置失败返回 skipped_dependency。结果含 batch_id/request_id/tool/status/data/error；非零退出和超时如实返回。成功查询或停止进程时，进程的失败状态作为 data 保留，工具本身完成，只有调用异常才失败。等待批准、运行、完成、失败、拒绝、取消与重启未知可见。每条运行命令旁的中断停止对应进程树，并立即撤回本批自动回传；不影响其他命令或后续无依赖请求，真实结果与复制保留；显式依赖被中断前台命令的请求跳过，保留已执行事实。

去重仅存配置、散列、请求状态，先落盘再执行。最多 10,000 批，达到上限明确停止，不淘汰引入重放。输出正文仅保留最近采集的一轮，界面和复制使用同一结果；新轮开始或解析失败清空旧正文，旧轮迟到输出不混入。重启不自动展示历史；重新采集该批只恢复状态元数据，不恢复原输出或运行 unknown 请求。

`ToolStore`在同一串行事务中依据当前已提交快照判断变化；实际更新仅复制变化路径，原version 1 JSON完整原子保存成功后才发布内存和返回，保存失败不影响旧快照及后续事务。普通重复、内容冲突、相同请求状态、未变化配置和无规则可清除时不写盘；重复批次首次提升为手动来源仍必须保存，启动恢复running/pending_permission为unknown仍必须保存。读取配置、规则、预留结果及历史返回隔离快照，不能从外部修改内部记录。真实变更仍完整序列化/写入文件，不是增量磁盘格式；规模化测量入口为`pnpm exec tsx tools/measure-tool-store.ts --samples=5 '--requests=1,10,50' '--targets=first,last' --output=报告路径`，使用临时合成元数据和真实文件系统，不执行工具，输出不会覆盖已有报告。PowerShell逗号参数需引号；默认仍为每批10请求、首条目标、每组合3样本，可用参数扩展。报告保留原始样本、Node/V8/Electron及生产/脚本hash，区分完整JSON序列化、writeFile和rename耗时；各分项中位数不能相加或据少量样本推导P95。应用运行时复测仅在测量CLI子进程设置ELECTRON_RUN_AS_NODE=1，不改变正常IDE环境；结果仍不代表实际GUI卡顿或冷盘表现。

工具记录读取、格式校验或启动恢复失败时，应用继续启动，工具状态以 `storageError` 显示原因并展开现有结果区。工具执行、自动采集、自动继续与工具设置停用；错误不被取消、项目切换或普通反馈覆盖。`ToolStore.ready()` 仍拒绝，配置、规则及执行记录写入仍受该门槛保护，不重置权限、不删改损坏或不兼容记录、不使用空账本执行新请求。使用匹配版本或恢复有效记录后重启；正常文件编辑和官网访问保留。

复制只包含当前项目与会话最近采集的本批结果；切换项目或会话、尚未采集时不把历史结果送入剪贴板。重启历史只有状态元数据，重新采集已执行批次只返回记录而不重放。

解析失败时 Harness 保存主进程内的诊断 ID、项目/会话和采集原文；同一当前原文重复采集不创建新 ID，取消后仍失效，不产生工具 completion 或执行账本。开启自动继续时由 `ToolResultReturn` 核验当前诊断、空结果和官网最新已完成原文后，回传与复制字节一致的错误正文，不读取附件。最多连续 5 次，第 6 次暂停；正常结果成功发送或实际切项目/会话后归零。见 `../adr/2026-10-09-batch-error-auto-return.md`，验证为 `test/toolHarness.test.ts`、`test/toolResultReturn.test.ts`、`test/autoContinuation.test.ts` 和 `test/toolAttachmentIntegration.test.ts`。

## 修改与采集

头部反馈统一比较实际状态与提示：当前操作失败、记录不可用及授权/运行/运输状态优先于成功复制、完成与音效等次要反馈，明确回传或复制错误仍按错误优先级显示；提示消失后恢复当前状态，完整原因与同时存在的反馈保留在悬停提示中。

离线布局验证入口为 `node tools/verify-tool-panel.cjs`（先构建），使用真实本地标记与样式，在固定宽窗口中独立调整工具容器宽度，覆盖长目标、异常、JSON与菜单交互；使用内存桥替身，不连接官网或执行真实工具。

右侧“工具”标签中的结果面板默认展开，摘要固定单行 38px：折叠入口、标题、数量、当前执行/发送状态、JSON 入口与具名操作同排；短暂完成提示出现或消失不会改变摘要高度。长反馈单行省略，显示优先级最高反馈，悬停提示聚合完整反馈。结果状态同时使用图形和文字：完成 ✓、执行中圆环、等待授权 ⏱、已停止 ■、依赖跳过 ⊘、失败/权限拒绝/未知 ✕，圆环在减少动态效果设置下不旋转。未知和依赖跳过显示短称，悬停保留完整提示；运行命令直接显示方块图标中断按钮，保留悬停说明和可访问名称；中断过程中显示圆环、aria-busy 并禁用按钮，仍只中断该命令及其子进程。

`toolHarness.css` 通过 `.tool-dock` 的 `tool-panel` 命名容器按工具区实际宽度排布，不以整个窗口宽度判断。宽列结果单行，按动作、目标、耗时、结果摘要、执行状态排列；状态之后只保留中断与展开操作，耗时独立于状态文字仍由原执行时钟刷新；不超过 619px 时结果摘要另排一行；不超过 380px 时动作、状态与中断在首行，目标独占下一行，普通成功摘要仅在展开的原始 JSON 中查看，`describeToolResult.detailImportant` 标记的失败、错误、截断、跳过、后台、清理中、非零退出和附件待发送等重要反馈另行显示。不超过 280px 时耗时仅在原始 JSON 中查看，其余宽度以秒显示。目标使用实际回传路径、技能名、附件名或进程 ID，长目标保留完整提示；参数未回传时不猜测命令或文件目标。工具结果按batch_id/request_id复用节点，按JSON字段比较确认内容变化后只更新对应行；克隆同值广播不重新序列化整批正文或重建列表。详细纯文本JSON在条目展开时生成，内容变化时更新，收起时释放；未变节点保留焦点与展开状态，新批次移除旧节点。中断按钮始终使用该行当前进程身份，复制数据仍直接来自主进程完整结果，不经过摘要或详情DOM。正文仅面板滚动，避免多层纵向滚动条。

不超过 380px 时头部简写“工具”并保留数量，JSON 与复制/发送始终直接可用；“查看改动”收进既有更多菜单，复用原按钮入口。窄列有结果时即使没有撤销项也保留菜单；宽列独立显示查看改动，仅有撤销项或正在撤销时显示菜单。布局 owner 在入口失效时关闭浮层，宽度变化隐藏已聚焦菜单项时转移到可见项。头部复制/发送按钮仍沿用既有规则：没有可手动回传附件或 automatic 开启时只复制本批结果；automatic 关闭且当前真实批次含可发送附件时，复制结果并经既有零参数入口发送当前批结果及附件。复制失败不阻断回传，官网回传失败保留剪贴板副本，附件上传不复制二进制。“工具完成后自动复制”开关位于设置的完成反馈分组。

工具标签与文件、改动标签共用右侧正文，工具正文占据可用高度并独立滚动，不提供纵向拖高入口。关闭工具标签只隐藏展示，保留执行、结果与阅读位置；通过官网顶栏“查看工具”重新打开。真实新批次开始由 harness 广播仅用于界面展示的递增 `batchStart.id`；仅右侧文件区已展开且工具页未显示才打开工具标签；右侧已折叠则保持折叠，工具页已显示时不重复打开或滚动。同批普通进度与成功完成不切换标签；新批准请求、执行失败或回传暂停自动恢复文件区、切换工具并展开相关内容，同一事件仅一次，新事件可再次打开。自动继续与运输 owner 先后进入暂停视为同一暂停过程，直到两者均退出暂停才可触发下一次；用户主动开始新需求使旧运输 `invalidated`，不作为暂停自动打开工具。初始化、历史恢复及重复状态不触发，也不主动聚焦批准按钮或重建 Monaco 模型。

官网顶栏显示主进程投影的精简工具状态，数量、倒计时与“查看工具”入口不暴露路径或结果正文；摘要与结果详情位于右侧工具标签；“查看改动”按需打开右侧可关闭的本批改动标签，同批普通进度不自动切离当前文件；权限与自动继续位于可折叠的本地需求操作栏，同一个 automatic 开关包含采集、权限执行与结果回传，无轮数参数。详细设置使用关联主窗口的独立非模态原生窗口，靠齿轮向上展开并钳制至主窗口及显示器可见范围，正常窗口完整展示设置，仅可用高度不足时内部滚动；打开和关闭不改变 dockHeight、官网或文件区高度。按执行与回传、完成反馈和权限规则分组，标签左对齐、控件右对齐；包含发送间隔（0–300 整数秒，默认 3）、未保存策略、完成音效、自动复制与规则清理；提示词编辑统一使用应用设置入口。关闭和 Escape 恢复齿轮焦点；失焦、主窗口移动/缩放/最小化或切项目收起且不抢焦点，主窗口退出销毁。工具更多菜单由布局 owner 钳制在右侧工具正文可见范围内；窄列和长输入仍保留常用操作。摘要显示倒计时、发送、等待回复/用户及暂停原因。工具面板不参与中间 dock 高度测量，空态与长结果都不压缩官网。权限以手掌、盾牌和橙色盾牌分别表示请求批准、按规则自动和完全访问，始终保留文字。

设置专用 preload 只传声明式设置、busy、hasProject 与 storageError，不传工具结果、路径或正文。编辑器主 frame 仅可提交当前视口内的齿轮锚点打开浮层；四项设置保存及当前项目规则清理仅浮层主 frame 可调用，权限与 automatic 不能由该窗口修改。窗口关闭或切项目后修改入口失效，忙碌/无项目/记录未加载时禁止清理规则；配置持久化及广播仍由原工具 owner 负责。

修改先准备本请求全部变更，检查所有真实目标别名的未保存内容，再逐项直接写入。继续替换 B 为 C，停止保留 A/B；成功落盘后更新编辑器。右文件区的 Diff 模式仅查看本批实际 before/after、差异与逐项执行状态，与编辑模式共用正文且不覆盖最右目录树，不提供再次应用或编辑器内联预览；后续人工编辑不污染执行快照，失败与部分成功如实显示。快照仅存当前轮内存，不进入复制结果或执行账本。撤销使用唯一源身份，复用原工具入口并同步变更状态，不能误撤销其后的人工修改。保留同项目／会话内最近 20 项工具撤销，项目或会话切换清空；迟到完成的旧会话修改不能进入新撤销栈。改名／删除仅移除相关路径撤销记录。

自动采集同步观察生成/完成控件和正文，不以文字静止判结束；启用或导航建立历史基线。结构未知时提示手动采集；手动未知状态需用户确认并再次核对正文，生成中不执行。采集不点击、输入或修改网页。

DeepSeek 主回复使用当前回复页脚的原生复制、可用重新生成图标及朗读标签，并结合输入区已知发送箭头确认结束。同框回复数量按 `ds-assistant-message-main-content` 正式答案节点判断，深度思考的独立 markdown 区不算另一条回复；两条正式答案同框仍返回未知。无标签图标依据现场 SVG 路径前缀识别，不依赖随机类名；代码框和扩展按钮不作为结束证据。任一标志缺失、重新生成不可用或输入图标未知时返回未知，不以先前生成状态推断完成。网页更换这些图标或结构后需重新适配；现场控件与深度思考结构回归见 test/deepseekReplyState.test.ts。

启用后在独立隔离上下文注册只读 MutationObserver，相关回复/控件变动以 150 毫秒一次合并通知；没有变化时不安排计时器、读取摘要或运行采集。启用时已有未知回复也保持历史基线，直到可读取完成正文；导航后等待旧回复根替换并在历史加载阶段持续更新基线，相关DOM安静500毫秒后退出加载阶段。该窗口不用于判断AI生成结束；历史分批间隔超出窗口时仅靠DOM无法完全区分。通知后检查生成/完成状态，生成中或结束未知时不散列或解析全文；摘要和状态不变时复用主进程缓存。导航历史等待期间已观察到的新生成状态单独保留到合并通知；即使生成在150毫秒通知前结束，也不把首轮完整输出重置为历史。关闭或再次导航清除该观察证据。变化通知不能证明生成结束，执行仍读取正文与结束标志的同一完整快照。监听不写 DOM、主世界变量或暴露本地桥；关闭/导航/销毁清理，失败明确提示手动采集，不退回轮询。工具处理期间变动合并为一个待通知，完成后继续读取；手动成功同步调度基线，不重复执行。

本次新批结果就绪产生一次当前轮完成事件；本地摘要显示短暂成功/错误动画，成功完成不展开工具或抢焦点；执行失败沿用关注事件自动打开工具，尊重减少动态效果。工具设置中的完成音效默认关闭、持久保存，用户由关闭切换为开启且保存成功后预听一次，与批次完成使用同一短音；保存失败或准备结束前已关闭不播放。此后每批最多一次本地短音；播放失败独立提示，不覆盖工具事实。刷新、重复批和重启历史状态不触发，切项目或会话清空事件，ID 在主进程生命周期内递增。

自动采集由新完成回复驱动，独立于发送动作识别、发送回执和会话绑定。开启后已有正文只建立历史基线；真正切会话时等待目标历史DOM，不把旧DOM残留或迟到历史作为新输出。首页分配真实 `/a/chat/s/ID` 地址时，连续回复节点、生成状态或有效的一次提交记录用于确认地址交接；路径谓词与发送器共享。官网可信发送点击/回车与本地发送共用8秒提交记录，其他真实动作取消旧交接（不能再由先挂载的历史节点恢复），导航消费后不继承；新的已识别发送可重新建立记录。确认首页交接同时结束遗留历史等待，保留正文去重和真实生成证据；记录不是回复完成证据或执行授权。真实用户动作另用于取消旧待发送结果。生成/中断/未知仍等待，完整新回复经正式协议、权限和持久批次去重后执行。

输入区外可见、可用的原生“继续生成／Continue generating”按钮表示回复中断，优先于普通完成页脚；正在生成标志仍优先。中断等待时不读取正文摘要或自动采集半成品，工具栏显示“等待续写”。标签须精确匹配，允许最新唯一回复的正文外页脚和独立原生控件，历史回复、正文及代码卡不作为续写控件。真实点击继续后，页面变化恢复检查；再次中断继续等待，最终结束才重新采集整条原回复。早期格式错误不写执行账本，不占用批次 ID；补全后仍校验完整协议，已执行失败、重复或未知批次不自动重放。手动采集在明确中断状态及确认期间再次中断时也不执行。

自动入口复核内容观察版本及来源项目/会话；手动入口复核采集时的项目、会话、重置版本与销毁状态。切换、关闭或销毁作废旧读取，不把旧回复交给新上下文执行。

确认新回复结束后将正式批次交给执行器。普通讨论不执行，界面明确显示没有工具请求；旧文件操作格式明确拒绝。单一完整内置提示词的全部示例遵循同一协议；自定义原文保留，但有效复制始终附强制协议，不能改为另一种执行格式。状态显示就绪、等候生成结束、无法确认结束或执行结果，避免没有请求时静默略过。

命令默认 120 秒、最大 600 秒，返回 stdout/stderr/退出码/超时/进程状态。后台最多保留 1,000,000 字符，分页明示截断；停止失败保留可能仍在运行的事实。Bash 缺失明确失败，不换另一 shell。

退出先处理未保存内容；取消退出保持工具与自动采集可用。批准退出后关闭编辑窗口，主进程等待所属命令清理完成再退出。

## 执行反馈、诊断与复制

任务真实开始时记录 started_at，终态记录 finished_at；等待授权或重启恢复不虚构时长。命令 data 提供真实主进程时间戳与 duration_ms，后台启动回执不表示进程结束，后续真实退出事件刷新当前批次输出；发布启动回执前复核快照，避免退出早于记录写入时卡住。列表状态只显示一次，执行秒数仅刷新文字，结束、切换或关闭释放本地计时器。

前台和后台命令在真实 spawn 后即发布进程身份，每行中断按当前项目、会话、批次、请求与 process_id 核验，只终止对应 IDE 所属进程树。旧进程的迟到中断响应不能禁用同 ID 的新命令或污染其状态。停止失败保留真实输出、错误、归属身份及重试入口，cleanup_pending 表示仍有树清理工作；主 shell 已退出时长保持真实退出值。超时报告失败，用户中断报告取消。退出清理仍取消剩余请求并停止全部所属命令，路径校验阶段的未启动命令不能迟到启动。后台所有命令及树清理结束后才生成本批完成事件，按实际退出状态判断反馈，不把启动成功当作执行成功。

工具 JSON 错误整批不执行、不预约批次；多个请求中一项校验失败也不部分执行。工具结果列表显示一个展开的“批次校验”失败卡片，包含原生 SyntaxError；有位置时给 JSON 正文行列、UTF-16 偏移与短片段，没有位置时不推测。不能解析的批次不伪造工具名或请求 ID，复制本批结果返回 {protocol_version:1,tool_results:[],batch_error:{status:"failed",error:诊断正文}}。不另铺全局长诊断，正文只保留最近轮内存，切换项目/会话清除，不联网或直接自动修复 JSON；只在上述严格范围内接纳下一轮明确的局部修复指令。

网页来源当前新批次全部工具真正结束且至少一个工具实际执行后自动复制完整 tool_results 一次，覆盖读取、搜索、修改、进程查询和命令，默认开启，在设置浮层的“完成反馈”可关闭并保存；工具执行失败输出也复制。已结束、清理完成的超时或用户停止命令视为实际执行终态，真实部分输出可复制；权限拒绝但没有任何实际执行的批次不自动复制。后台启动、全部未执行、整批取消、未知、历史恢复及界面状态查询/设置不会写剪贴板；切换项目/会话作废旧轮。手动复制按钮保留，复制失败独立提示，automatic 开启时成功复制不误提示用户必须再粘贴。批次完成事件主进程单调编号，状态广播、界面初始化或重绘不重复复制，失败不暗中重试。

## 自动继续与结果发送

`autoContinuation.ts` 独立拥有完成事件去重、等待、倒计时和一次发送状态。发送只消费当前项目/会话/批次的新完成事件；真实 started_at 的 done/failed 结果、以及真实开始和结束、`data.status: 'stopped'` 且清理已完成的单条命令结果均可回传，后者保留 cancelled/failed 事实与部分输出。用户手动中断在停止进程前为当前批次设置独立 `userInterrupted` 标记，立即暂停本批自动回传正文及附件；停止失败、清理完成、自然退出或重开 automatic 均不恢复，下一新批次不继承，复制仍按真实执行结果处理。完整批次仅含 permission_denied 与 skipped_dependency 且至少有一项权限拒绝时，可回传拒绝回执；不执行被拒绝工具、不上传附件。整批取消、普通 cancelled、unknown、后台启动与 cleanup_pending 继续阻断或等待；普通无执行失败仍等待用户。执行前整批校验失败由 harness 在全部失败回执保存成功后标记当前 completion.validation_failed，整批均 failed 且没有执行时间或数据时可自动回传完整请求回执；不执行工具，不读取或上传附件。该标记不持久化，历史恢复没有发送资格。与解析层 batchError 共用连续 5 次额度，第 6 次暂停；校验错误回传成功不清零，正常执行结果成功发送或实际切项目/会话后清零。历史恢复与重复广播不启动发送。

限定发送与输出采集独立；后续只读 DOM 变化触发完整结束快照核验，合成 click 不冒充真实用户事件。

`webResultSender.ts` 是工具发送门面，唯一网页写运输 owner 为 `webComposerSender.ts`，仅官方活动平台普通会话，隔离世界 1005；DeepSeek 验证唯一 textarea/已知发送 SVG，ChatGPT 验证唯一 ProseMirror/有界 FORM 内已知发送按钮。采集与运输职责分离，ChatGPT 快照与可信停止见证共用只读隔离世界 1004。页面空闲才提交同源结果正文，不读取剪贴板；DeepSeek 要求空输入，ChatGPT 当前有效纯文本工具结果遇纯文本草稿时先在本项目备份并复核后替换，见草稿备份 ADR。两平台均支持当前官网批次经权限批准的 attach_file；附件批必须空输入且无既有附件，不适用草稿备份替换。未知控件、备份失败或用户接管暂停；点击前取消仅清理自有文本及明确本批附件并有界复核，点击后不确定、超时或异常不重试或清理可能已提交附件。网页始终无 IPC/文件桥，AI HTTP 仍由 Chromium 发起。

`attach_file({path})` 经工具权限暂存当前选择的真实文件，支持现有图片、PDF/Word、表格、幻灯片及文本附件，单文件最多 100 MiB、每批最多 50 个，独立于本地预览的 128 MiB 上限；官网实际格式和额度约束仍生效。ask 模式对项目内附件也审批，批准明确包含上传到实际活动的 DeepSeek 或 ChatGPT；rules/full 继续使用现有规则。授权指纹包含真实路径和文件身份；暂存及运输复核文件变化。done 仅表示暂存，data 只有 id/name/size/mediaType，不包含路径能力或文件字节。`ToolAttachments` 拥有内存 ID 与当前选择，历史恢复不重建附件，切项目/会话/批次及取消使旧附件失效。

当前完整真实批次由 `ToolResultReturn` 统一发送：automatic 开启时沿用完成事件与间隔；关闭时当前批有附件且资格有效时，工具栏自适应按钮复制结果并手动发送当前批。手动 IPC 零参数，仅编辑器主 frame，可用资格仍须整批实际结束并核对官网最新正式批次。整批取消、普通取消、未知、历史及普通未执行失败仍不发送；权限拒绝可回传真实拒绝信息，但被拒绝附件不上传。唯一 sender 通过官方文件控件上传全部附件，等待预览和进度结束后提交整批正文一次；ChatGPT 通过原 composer FORM 内唯一 multiple 且无 accept 的通用 input 上传，逐一匹配图片与文档卡、核验图片和文档已有缩略图就绪及发送控件就绪，混合附件不能遗漏文档，不以 input.files 清空作为完成。可信输入和附件操作接管即暂停。首次尝试后失败/未知暂停，不重复上传。工具摘要只显示已暂存，独立发送状态才显示官网回执。

`read_file` 继续只读文本；PDF/Word 可经 attach_file 上传原文件。技能需要 PDF 页或局部图时，通过已授权 run_command 使用真实可用的本地工具提取，再请求 attach_file。不会扫描命令日志猜测附件，也不把二进制编码进工具 JSON。新工具的完整提示词示例由 formatSpec 生成，补充格式上限 15,000 字以容纳完整内置模板。

规则验收入口为 `test/autoContinuation.test.ts`、`test/webResultSender.test.ts`、`test/toolIntegration.test.ts`；原生 sender 验收为 `tools/verify-web-result-sender.cjs` 的本地 Electron 夹具。用户已确认两平台本任务常规闭环的实际自动回传，现场结果与夹具证据分开记录。

自动采集与受控发送独立：实际新完成工具输出无需等待本地发送或结果回传回执，发送失败和 unknown 不屏蔽真实输出。执行与结果回传仍使用来源项目/会话/批次校验，回传不重试未知提交，切换上下文作废旧待发送结果。

## 用户手动粘贴工具 JSON

工具面板正文的 JSON 输入区只有“执行”和“关闭”。用户主动粘贴完整原始JSON或唯一mini-ai-tools正式围栏后，executeToolJson原子提交原文。主进程ManualToolJson只接受最多200000个UTF-16字符，仍使用parseToolBatch做完整协议、参数和依赖校验；不修补语法，不接纳repair_draft、结果回执、普通说明或多个围栏。格式错误形成manual批次诊断，使用统一formatToolResults生成含batch_error及空tool_results的回执，不猜测请求ID、不预约或执行工具。

工具、后台命令、本地需求准备/运输、自动倒计时或发送忙时阻止提交；无项目、平台切换、系统工具禁用或工具存储故障等入口拒绝保留输入且不覆盖正在执行的结果。提交后复用harness的项目/会话/修订守卫，审批期间上下文失效按取消处理。接纳确认ok不代表各工具成功，以工具层真实结果为准。此入口不依赖官网DOM采集成功，不自动重试。

执行仍归harness、原有权限和持久去重。同ID同内容不重复执行，同ID不同内容拒绝。选择、诊断与ledger保留manual来源；手动或后来采集/恢复的同批结果只能查看/复制，automatic开关及发送间隔变化不能使其回传，附件手动回传入口也拒绝。手动attach_file请求明确失败且不读取/暂存/上传，不改变其他本地工具权限。新官网批次仍走原采集与回传流程。输入不从剪贴板自动读取，也不写入官网；本次手动格式诊断、权限拒绝、执行前失败与执行结果按autoCopyResults设置各复制一次，后台命令等待真实结束与清理，历史恢复和状态查询不重放。用户也可使用统一手动复制入口粘贴给AI；网页来源的复制资格保持原规则。


取消未确认的发送阻断绑定具体token与文档。相同取消的迟到未点击且清理完成证据，或成功主frame新文档加载并核验新nonce后，仅允许后续合法新批继续；旧批结果不补发、工具不重跑。SPA、失败加载、未知或已点击的同文档取消不自动恢复。隔离世界所有运输阶段核对Document/nonce/活动token，旧排队脚本和逆序握手不能落入新批。当前纯文本被旧阻断挡住时显示“本批未发送”，不报告当前提交未知、不自动重试；真实未知状态仍等待用户处理。规则见 `../adr/2026-10-14-automatic-recovery.md`。
