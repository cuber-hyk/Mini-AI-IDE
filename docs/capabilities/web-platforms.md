---
artifact_type: capability
status: current
updated: 2026-10-18
owner: 胡运宽
source_of_truth: [src/shared/deepseekAccounts.ts, src/main/deepseekAccounts.ts, src/main/deepseekAccountViews.ts, test/deepseekAccounts.test.ts, test/deepseekAccountSwitch.test.ts, tools/run-deepseek-accounts-probe.cjs, tools/verify-deepseek-accounts.cjs, src/main/webLoadingView.ts, src/renderer/webLoading.html, src/renderer/webLoading.css, tools/verify-web-loading.cjs, tools/verify-deepseek-startup.cjs, src/main/composerDraftBackup.ts, test/composerDraftBackup.test.ts, src/main/firstPromptSession.ts, src/main/tools/replyChangeWatcher.ts, test/chatgptReply.test.ts, test/replyChangeWatcher.test.ts, src/main/tools/replySource.ts, test/replySource.test.ts, src/shared/webPlatform.ts, src/main/webPlatformController.ts, src/main/webPlatformView.ts, src/main/index.ts, src/main/tools/integration.ts, src/main/localPromptController.ts, src/main/workspaceLayoutController.ts, src/renderer/webbar.js, src/renderer/promptComposer.js, src/renderer/toolHarness.js, test/webPlatformController.test.ts, test/toolPlatformActivity.test.ts, test/webPlatformUi.test.ts, src/main/chatgptPage.ts, src/shared/webConversation.ts, src/main/webComposerSender.ts, test/chatgptToolIntegration.test.ts, tools/verify-chatgpt-composer.cjs, tools/verify-chatgpt-tools.cjs, tools/verify-web-platform.cjs, docs/adr/2026-10-11-web-platform-switching.md]
---

# 官网平台

两平台官网视图均采用原生后台调度，窗口遮挡、隐藏与最小化不会因默认后台节流停止必要计时器和画面帧；资源影响见 `app-shell.md`。两平台自动采集共用 `replySource.ts` 的回复顺序、历史指纹与快照封存规则，回看不会授予新轮资格；来源无法核实时保留手动采集。平台关闭工具能力的门禁仍独立生效。

顶栏具名选择框在 DeepSeek / ChatGPT 间直接切换，每次启动默认 DeepSeek。仅活动平台运行采集、权限执行和限定发送；两平台共用工具协议、权限、执行、复制及 automatic 单开关。ChatGPT 接入普通首页与 `/c/<id>` 会话的需求、工具结果及其授权附件，不接入 GPTs、项目专属路径或特殊编辑界面；未知地址或 DOM 状态暂停，不猜测控件。

ChatGPT 支持本地需求中用户选择、拖入及粘贴的附件，以及当前官网工具批经权限批准的 `attach_file` 附件；手动 JSON 来源仍禁止上传。主进程复用暂存、文件身份校验和分块读取，网页只获得本次字节，不获得文件路径或磁盘桥。两平台均最多 50 个、单文件最多 100 MiB，官网实际格式和额度另有限制。程序发送遇到官网已有附件仍暂停，避免夹带文件；附件批要求空输入，不使用纯文本工具结果的草稿备份替换。
DeepSeek 默认账号沿用 persist:postcheck，顶栏可通过本地备注添加/选择账号；附加账号固定使用 persist:postcheck-ds-N，首次选择才创建原生视图。ChatGPT 固定 persist:postcheck-02，首次进入才创建。切换复用视图、不重载网页、不清除登录态；启动进入默认 DeepSeek 账号。登录资料不与用户浏览器或验证工具共享，新账号首次手动登录，失效或官网验证仍需用户处理。无 iframe、网页 preload、Node、本地桥、凭据读取或指纹伪造。

账号元数据 owner 为 `deepseekAccounts.ts`，稳定编号/分区合同为 `shared/deepseekAccounts.ts`，原生缓存为 `deepseekAccountViews.ts`，顶栏 owner 为 `renderer/deepseekAccounts.js`。账号仅为本地标签，应用不读取真实身份，不提供删除、改名或自动登录。`ui:set-deepseek-account` 与 `ui:add-deepseek-account` 仅本地顶栏主 frame 可用；已有账号 ID/备注之外不接受其他控制参数。资料损坏不清空，新增视图打开失败保留已保存条目并恢复原账号，可重新选择。

同平台账号切换复用以下忙门禁和撤回流程，准备前后均复核忙状态。`bindWeb` 清除上一网页选择，账号与平台共用活动修订；错误/加载/重载按原生视图隔离，后台账号事件不污染当前界面。附加账号的工具执行账本按稳定账号 ID 隔离；默认账号原有去重记录保留。历史与旧结果不会因切换复活发送资格。

工具执行、存活后台进程及需求/结果发送期间拒绝切换；自动回传倒计时可先撤回再切换。已完成结果和需求草稿保留，可继续复制，旧批次和附件不补发；automatic 配置保留，活动网页重新绑定到同一工具流程时，先释放旧监听与运输，建立新历史基线；上一批展示结果仅保留复制资格，切回任何平台均不补发。跨异步回执以平台修订和活动守卫防止旧动作继续执行。

`webPlatformSwitchBlock` 从真实 busy、hasRunningProcesses、本地需求 isSending 和结果发送阶段判定切换原因；主进程执行锁与 `WebPlatformState.switchBlockedReason` 同源。工具状态及需求准备/运输的开始、结束触发 `WebPlatformController.refreshSwitchAvailability`，仅原因变化时通知顶栏，避免重绘本地需求区的平台提示。顶栏原生选择框即时禁用，外层标题与可访问描述提供简短原因；倒计时、等待 AI、暂停和空闲不构成锁。状态查询按每次广播的修订保护，迟到查询不能覆盖更新状态；采集回执只按平台及切换状态变化核验，忙原因变化不作废当前平台采集回执。IPC 竞态拒绝仍由主进程保护，界面恢复权威平台并显示约 3 秒短提示，技术错误进入日志；提示结束不擦除后续采集反馈。

只读监听的安装和撤销共享主进程单调注册序号，隔离世界保留最新撤销或安装的序号；迟到的旧安装不能替换新监听，也不能在关闭自动采集后复活。此门禁仅管理监听生命周期，不授予历史或未知来源输出执行资格。

ChatGPT 首页首发可经过 `/c/local-chatgpt%3A<UUID>` 编码占位地址，再分配正式会话。占位地址不属于普通会话白名单，不提供采集、执行或输入写入资格；只允许已有监听在未取消的短期本地提交标记下等待正式地址，保持原首页来源基线。运输只在首页实际点击之后等待同一占位地址，再确认一次正式会话；未分配完成、换占位标识或点击前导航均暂停，工具结果不享有例外。正式地址仍独立核验回复完成和新增来源；其他导航建立历史基线，返回支持的会话后恢复监听且不补执行当前历史。

创建或本地切换失败恢复原平台。WebPlatformController统一监听两平台主frame导航、失败、完成及停止，加载失败保留固定平台名和有界错误码；本轮失败后的错误页did-finish-load不能清错，新的主frame导航成功后才恢复。子frame失败不改变平台状态，取消不替换已知网络错误；隐藏平台的失败仅在切回后显示，不污染当前平台。

正常启动经 `WebPlatformController.loadInitialDeepSeek` 加载首页。本次启动首个官方 DeepSeek 首页主 frame 同时返回 `-100` 与 `ERR_CONNECTION_CLOSED` 时，约 1 秒后在原视图原分区中自动重载一次，复用原重载准备和工具/发送忙门禁。等待与重载期间保留真实错误、`reloading` 状态及本地加载提示，采集和本地发送不可用；成功后恢复，二次失败保留真实诊断与手动入口，不第三次请求。额度不授予后续导航、登录页重定向、手动重载、ChatGPT、证书、取消或未知错误。平台切换、任意新主 frame 导航（含同文档）、关闭和忙状态取消待恢复；异步准备后再核对导航修订及原官方首页，不刷新已变更的页面。启动自检/诊断/自定义目标不通过该默认首页恢复条件。

顶栏仅失败时显示“重新加载”，零参数reloadWebPlatform入口只接受webbar主frame且复用工具/发送忙门禁；取消旧待回传与来源后浏览器reload当前视图，不接地址、不创建视图、不改登录资料。准备期有切换锁，网络等待释放切换锁且拒绝重复重载。恢复成功清提示；继续失败保留真实原因。失败/重载期间采集及本地主动发送禁用，需求草稿保留；正常平台切换不刷新。官网登录弹窗使用同分区与沙箱，仅允许明确的官方和登录提供商地址，主窗口关闭时释放。布局由WorkspaceLayoutController管理，文件区全屏隐藏活动官网，退出后恢复。

加载失败、切换和重载提示只在顶栏 `collect-status` 显示一处，左侧工具摘要不重复平台原因；恢复后显示最新真实工具摘要。恢复中显示“正在重新加载官网…”，原错误保留在平台悬停诊断，终止恢复后显示真实失败。窄栏保留该提示和手动入口；切换、重载调用和状态读取错误仍按原优先级显示。

验证入口：`pnpm run build`、`pnpm exec electron tools/verify-web-platform.cjs`（仅离线本地夹具，拦截公网请求）、相关 test 与应用 self-test。真实官网登录、对话和重启保持由用户手动验证，不能凭页面 loaded 事件推断。完整 IDE 隔离验收可运行 `pnpm exec electron tools/chatgpt-ide-preview.cjs`，其固定独立 userData 不共享安装版登录资料。

ChatGPT 只读规则由 `chatgptPage.ts` 提供：在最新 `data-talvt-turn-state` 轮次内取最后一个未被排除的 assistant 角色标记，其 owner 必须属于本轮且内部角色唯一；正式正文必须唯一、具有 data-dil-message-id、属于该 owner 的 markdown 区域且最近消息 owner 一致。同轮有较早角色时，仅接纳各自属于不同、非嵌套 owner 且具唯一内部页脚的已知连续消息结构。多消息时最后 owner 不能带自己的局部页脚；最后角色的 owner 或正文尚未挂载时等待，不回退采同轮较早消息。完成仍要求本轮 complete 及所有消息 owner 之外的唯一轮末复制页脚，用户、思考、正文和其他消息内操作栏不计入；多份答案各自带内部页脚时暂停，即使另有全局页脚也不能自动选择答案；其他未知比较结构不纳入支持范围。后续用户轮、生成、中断及歧义均不能回退采历史。CodeSurface 中的唯一 CodeContent 保留原始文本，语言仅取对应 StickyActionBar 的明确局部标签。变化监听涵盖这些轮次、角色、正文及页脚节点与状态属性。

`webComposerSender.ts` 仍是唯一网页 DOM 写入 owner，分别验证平台官方 origin、普通会话、唯一可编辑 composer 和局部发送控件；ChatGPT 统一以最近且不含回复的 FORM 关联 ProseMirror 与唯一 type=submit/发送控件，空 composer 的语音控件只用于确认输入区，填入后等待真正发送控件出现。发送只接纳用户主动需求或当前批真实结果；当前纯文本工具结果/诊断可将已有纯文本草稿先保存到本项目隐藏目录，重新核验后替换回传。主动需求及附件批的已有草稿、已有附件、生成中、未知控件及不确定回执仍暂停，点击后不重试。

ChatGPT 附件只选择同一 `form[data-chatgpt-composer]` 内唯一 multiple 且无 accept 限制的通用文件 input。`chatgptPage.ts` 的 `CHATGPT_ATTACHMENT_READER` 只读核验图片卡和文档卡，逐一确认全部本次附件；图片须可解码，文档卡若有缩略图须就绪，上传进度消失及唯一发送控件就绪后才发送正文。选择后 input.files 被官网清空不能作为完成依据。可信输入和附件操作接管即暂停；点击前仅通过已知官方移除控件清理可明确归属本批的卡片，并有界异步复核，未知仍停。所有运输阶段保留 Document、nonce 和活动 token 守卫，点击后不确定不重试或清理可能提交的文件。

文档匹配接纳完整原名，以及官网在相同扩展名前追加数字编号的完整名称；编号名称须同时出现在移除控件标签和卡内文本。`CHATGPT_DOCUMENTS_MATCH` 对本批文件和文档卡作双向唯一核对；名称可对应多个文件或卡片时，发送与清理均暂停，不使用前缀包含或任意改名匹配。

2026-10-15，用户确认新版IDE中ChatGPT本地需求TXT及PDF＋图片实际发送验收通过。工具附件的权限和批次入口、图片/PDF/DOCX/混合运输及取消边界由回归覆盖，未将其写成另行取得的人工连续闭环证据。

真实 ChatGPT 页面只读结构核验与离线夹具是不同证据。原生结构诊断已核验 ProseMirror/FORM、submit/发送、DilResponseRoot、轮次完成标记、局部复制页脚及代码语言标题；官网输入事件接收和连续闭环以真实对话验收为准，离线测试不能替代该证据，也不能证明重启登录保持。2026-10-12 用户补充确认完整 IDE 跨重启登录保持验收通过；该结论来自用户实际验收反馈。预览模式可开启 MINI_CHATGPT_STRUCTURE_TRACE，按 `tools/chatgpt-page-structure.cjs` 输出不含正文、草稿、凭据或会话 ID 的结构快照；不向官网提供桥。网页能力依赖平台当前 DOM，技术实现也不代表平台授权程序化提取输出。

ChatGPT 的生成见证由 chatgptPage 的 CHATGPT_GENERATING_SCRIPT 单一提供给完成核验、变化监听和发送运输：仅识别当前正式回复/代码/思考及已知停止控件，忽略推荐区、侧栏、附件和旧轮次的 busy；推荐提示词不是完成条件，仍要求本轮 complete 与唯一正式复制页脚。来源指纹使用 CHATGPT_SOURCE_TEXT_READER 保留语言标签和正文，排除按钮等非正文显示；历史、未知节点重挂载及封存后正文改变仍无自动执行资格。

自有 ChatGPT 输入允许段落中原文逐字相同的文本/span，以及空段落或带 ProseMirror-trailingBreak 的末尾占位 BR。带明确自动链接标记的span须通过属性白名单并递归读取原文字，不读取或跟随链接地址；已知颜色色块须为空SPAN且aria-hidden=true、contenteditable=false，已知自动链接图标须属于自动链接span、具同样隐藏/不可编辑标记且子树仅含无文字的受限SPAN/svg/path，才可作为零正文装饰忽略。未知属性、任意原子节点或SVG、非空装饰、未知换行和正文变化仍拒绝，不trim或使用任意innerText。真实 beforeinput/input/paste/drop/compositionstart 接管使本次正文失去发送和取消清理资格，即使当时字节未变；合成事件不冒充用户接管。未获备份资格或无法完成备份的已有草稿、附件、会话或控件变化及点击后未知运输仍暂停，不重试。

2026-10-12 用户在新版开发 IDE 的 ChatGPT 普通新会话完成三轮只读工具全程自动采集、执行与回传验收，无手动恢复；该实际闭环反馈与离线 DOM 夹具结果分别记录。

ChatGPT 正文根以 div[data-dil-message-id] 的消息语义属性定位，不依赖 DilResponseRoot 样式类；仍须属于最新轮次的唯一 assistant owner/markdown 区域，并排除用户和思考内容。多个候选、缺角色或归属不明确时拒绝采集；类名变化不使既有会话失去能力，也不授予初始化历史自动执行资格。

本地主动需求的运输确认尚未结束时，新完成工具输出仍可独立采集并执行。integration 的结果发送前复核先等待该需求运输释放，再重新检查活动平台、取消状态、会话、最新回复和当前批次；等待不代表前需求已成功，不重试发送，取消后重新开启 automatic 也不补发旧批。

ChatGPT 点击前发送按钮重绘时，仅在旧按钮已断开、原输入框及原FORM不变、当前按钮为唯一已知发送控件时重新选择。点击前仍逐字核验自有结果、编辑接管、会话、生成和附件；原输入重挂载、未知或歧义按钮继续暂停，点击后不重新选择或重试。控件变化提示区分唯一性、输入框、FORM与按钮身份，开启collection trace时补充不含正文的布尔结构诊断。

ChatGPT控件和附件区域核验共用FORM回复判据：原输入框内的inline-markdown等文本span样式不作为回复混入，正文仍须满足原有允许节点和逐字一致检查；真实角色、轮次及正式正文标记无论位置均拒绝，输入框外的markdown样式区域同样拒绝。官网整理自有输入的样式不会单独撤回发送资格，真实编辑接管继续优先。


ChatGPT网页草稿备份owner为`composerDraftBackup.ts`，由index和工具integration注入当前项目；具体受控读取/替换运输仍由`webComposerSender.ts`在世界1005管理。发送前存在草稿时先冻结输入及原文并监听真实接管，保存成功后以一次token恢复；异步保存期间的编辑、节点/FORM替换、附件、生成、取消及会话/批次变化不覆盖。备份保留于`.mini-ai-ide/composer-drafts/`，专用归属/.gitignore与真实路径核验，UTF-8 TXT独占保存并sync，保存失败或超1MiB暂停。工具结果状态显示备份路径；不存原会话ID、不改剪贴板、不自动清理。参见`../adr/2026-10-13-chatgpt-composer-draft-backup.md`与对应落盘/发送测试。


已核验的ChatGPT粘贴原文包装SPAN[data-prompt-literal-paste]仅允许该标记与class属性，无属性STRONG允许递归读取内部纯文本；段落换行及节点外空白逐字保留。备份和运输后自有结果共用同一reader；未知属性、可编辑/原子节点、隐藏结构或正文变化仍拒绝，不以任意innerText替代。页面隐藏编辑器不计入唯一可见输入判定，也不作为备份来源，多个可见输入仍暂停。

## 官网加载反馈

首次启动、平台首次创建及主 frame 实际导航期间，独立本地沙箱视图按当前主题展示平台名和“正在加载…”。无 preload、IPC 或官网 DOM 写入；布局与显隐仍由 WorkspaceLayoutController 管理，只覆盖官网区域，文件全屏时隐藏。正常已加载平台切换复用原页面，不刷新。

WebPlatformController 在文档完成后用只读隔离世界核验是否已有可见内容；SPA 空壳继续显示，最长观察 10 秒后撤下提示，避免未知结构长期遮挡官网。未进入首次自动恢复的加载失败或取消撤下提示，失败继续走顶栏错误及具名重新加载入口。后台平台事件不覆盖前台提示，导航修订使旧检测失效，关闭清理计时器。这仅管理加载提示，不代表 AI 回复完成或授予工具执行/发送资格。

首次连接关闭的一次恢复等待也保持加载提示；其他失败和恢复终止撤下提示。离线原生验收为 `node tools/verify-deepseek-startup.cjs`（先构建），隔离资料目录、HTTPS 本地响应与失效本机代理确保不连接公网；覆盖真实连接关闭事件、一次重载、失败上限与取消。该验收证明恢复流程，不确定用户现场连接关闭的具体网络根因或成功率。
