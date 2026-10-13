---
artifact_type: capability
status: current
updated: 2026-10-13
owner: 胡运宽
source_of_truth: [src/main/composerDraftBackup.ts, test/composerDraftBackup.test.ts, src/main/firstPromptSession.ts, src/main/tools/replyChangeWatcher.ts, test/chatgptReply.test.ts, test/replyChangeWatcher.test.ts, src/main/tools/replySource.ts, test/replySource.test.ts, src/shared/webPlatform.ts, src/main/webPlatformController.ts, src/main/webPlatformView.ts, src/main/index.ts, src/main/tools/integration.ts, src/main/localPromptController.ts, src/main/workspaceLayoutController.ts, src/renderer/webbar.js, src/renderer/promptComposer.js, src/renderer/toolHarness.js, test/webPlatformController.test.ts, test/toolPlatformActivity.test.ts, test/webPlatformUi.test.ts, src/main/chatgptPage.ts, src/shared/webConversation.ts, src/main/webComposerSender.ts, test/chatgptToolIntegration.test.ts, tools/verify-chatgpt-composer.cjs, tools/verify-chatgpt-tools.cjs, tools/verify-web-platform.cjs, docs/adr/2026-10-11-web-platform-switching.md]
---

# 官网平台

两平台官网视图均采用原生后台调度，窗口遮挡、隐藏与最小化不会因默认后台节流停止必要计时器和画面帧；资源影响见 `app-shell.md`。两平台自动采集共用 `replySource.ts` 的回复顺序、历史指纹与快照封存规则，回看不会授予新轮资格；来源无法核实时保留手动采集。平台关闭工具能力的门禁仍独立生效。

顶栏具名选择框在 DeepSeek / ChatGPT 间直接切换，每次启动默认 DeepSeek。仅活动平台运行采集、权限执行和限定发送；两平台共用工具协议、权限、执行、复制及 automatic 单开关。ChatGPT 接入普通首页与 `/c/<id>` 会话的纯文本需求和工具结果，不接入 GPTs、项目专属路径或特殊编辑界面；未知地址或 DOM 状态暂停，不猜测控件。

ChatGPT 本地需求携带附件时明确拒绝并保留暂存文件；工具 `attach_file` 请求返回明确失败，不读取或上传文件。图片、PDF、Word 等仍可由用户通过官网原生入口操作。程序纯文本发送遇到官网已有附件也暂停，避免夹带文件。DeepSeek 原有程序附件运输保持独立。
平台复用各自原生视图，分别使用 persist:postcheck 与 persist:postcheck-02 固定分区，首次进入 ChatGPT 才创建。切换不重载已创建的网页、不清除登录态；登录资料不与用户浏览器或独立验证工具共享。正式应用首次需自行登录。无 iframe、网页 preload、Node、本地桥、凭据读取或指纹伪造。

工具执行、存活后台进程及需求/结果发送期间拒绝切换；自动回传倒计时可先撤回再切换。已完成结果和需求草稿保留，可继续复制，旧批次和附件不补发；automatic 配置保留，活动网页重新绑定到同一工具流程时，先释放旧监听与运输，建立新历史基线；上一批展示结果仅保留复制资格，切回任何平台均不补发。跨异步回执以平台修订和活动守卫防止旧动作继续执行。

`webPlatformSwitchBlock` 从真实 busy、hasRunningProcesses、本地需求 isSending 和结果发送阶段判定切换原因；主进程执行锁与 `WebPlatformState.switchBlockedReason` 同源。工具状态及需求准备/运输的开始、结束触发 `WebPlatformController.refreshSwitchAvailability`，仅原因变化时通知顶栏，避免重绘本地需求区的平台提示。顶栏原生选择框即时禁用，外层标题与可访问描述提供简短原因；倒计时、等待 AI、暂停和空闲不构成锁。状态查询按每次广播的修订保护，迟到查询不能覆盖更新状态；采集回执只按平台及切换状态变化核验，忙原因变化不作废当前平台采集回执。IPC 竞态拒绝仍由主进程保护，界面恢复权威平台并显示约 3 秒短提示，技术错误进入日志；提示结束不擦除后续采集反馈。

只读监听的安装和撤销共享主进程单调注册序号，隔离世界保留最新撤销或安装的序号；迟到的旧安装不能替换新监听，也不能在关闭自动采集后复活。此门禁仅管理监听生命周期，不授予历史或未知来源输出执行资格。

ChatGPT 首页首发可经过 `/c/local-chatgpt%3A<UUID>` 编码占位地址，再分配正式会话。占位地址不属于普通会话白名单，不提供采集、执行或输入写入资格；只允许已有监听在未取消的短期本地提交标记下等待正式地址，保持原首页来源基线。运输只在首页实际点击之后等待同一占位地址，再确认一次正式会话；未分配完成、换占位标识或点击前导航均暂停，工具结果不享有例外。正式地址仍独立核验回复完成和新增来源；其他导航建立历史基线，返回支持的会话后恢复监听且不补执行当前历史。

创建或本地切换失败恢复原平台；网络加载失败显示脱敏提示，可立即切回。官网登录弹窗使用同分区与沙箱，仅允许明确的官方和登录提供商地址，主窗口关闭时释放。布局由 WorkspaceLayoutController 管理，文件区全屏隐藏活动官网，退出后恢复。

验证入口：`pnpm run build`、`pnpm exec electron tools/verify-web-platform.cjs`（仅离线本地夹具，拦截公网请求）、相关 test 与应用 self-test。真实官网登录、对话和重启保持由用户手动验证，不能凭页面 loaded 事件推断。完整 IDE 隔离验收可运行 `pnpm exec electron tools/chatgpt-ide-preview.cjs`，其固定独立 userData 不共享安装版登录资料。

ChatGPT 只读规则由 `chatgptPage.ts` 提供：在最新 `data-talvt-turn-state` 轮次内取最后一个未被排除的 assistant 角色标记，其 owner 必须属于本轮且内部角色唯一；正式正文必须唯一、具有 data-dil-message-id、属于该 owner 的 markdown 区域且最近消息 owner 一致。同轮有较早角色时，仅接纳各自属于不同、非嵌套 owner 且具唯一内部页脚的已知连续消息结构。多消息时最后 owner 不能带自己的局部页脚；最后角色的 owner 或正文尚未挂载时等待，不回退采同轮较早消息。完成仍要求本轮 complete 及所有消息 owner 之外的唯一轮末复制页脚，用户、思考、正文和其他消息内操作栏不计入；多份答案各自带内部页脚时暂停，即使另有全局页脚也不能自动选择答案；其他未知比较结构不纳入支持范围。后续用户轮、生成、中断及歧义均不能回退采历史。CodeSurface 中的唯一 CodeContent 保留原始文本，语言仅取对应 StickyActionBar 的明确局部标签。变化监听涵盖这些轮次、角色、正文及页脚节点与状态属性。

`webComposerSender.ts` 仍是唯一网页 DOM 写入 owner，分别验证平台官方 origin、普通会话、唯一可编辑 composer 和局部发送控件；ChatGPT 统一以最近且不含回复的 FORM 关联 ProseMirror 与唯一 type=submit/发送控件，空 composer 的语音控件只用于确认输入区，填入后等待真正发送控件出现。发送只接纳用户主动需求或当前批真实结果；当前工具结果/诊断可将已有纯文本草稿先保存到本项目隐藏目录，重新核验后替换回传。主动需求的已有草稿、已有附件、生成中、未知控件及不确定回执仍暂停，点击后不重试。

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
