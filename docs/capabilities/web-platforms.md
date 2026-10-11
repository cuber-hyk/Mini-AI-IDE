---
artifact_type: capability
status: current
updated: 2026-10-12
owner: 胡运宽
source_of_truth: [src/main/firstPromptSession.ts, src/main/tools/replyChangeWatcher.ts, test/chatgptReply.test.ts, test/replyChangeWatcher.test.ts, src/main/tools/replySource.ts, test/replySource.test.ts, src/shared/webPlatform.ts, src/main/webPlatformController.ts, src/main/webPlatformView.ts, src/main/index.ts, src/main/tools/integration.ts, src/main/localPromptController.ts, src/main/workspaceLayoutController.ts, src/renderer/webbar.js, src/renderer/promptComposer.js, src/renderer/toolHarness.js, test/webPlatformController.test.ts, test/toolPlatformActivity.test.ts, test/webPlatformUi.test.ts, src/main/chatgptPage.ts, src/shared/webConversation.ts, src/main/webComposerSender.ts, test/chatgptToolIntegration.test.ts, tools/verify-chatgpt-composer.cjs, tools/verify-chatgpt-tools.cjs, tools/verify-web-platform.cjs, docs/adr/2026-10-11-web-platform-switching.md]
---

# 官网平台

两平台官网视图均采用原生后台调度，窗口遮挡、隐藏与最小化不会因默认后台节流停止必要计时器和画面帧；资源影响见 `app-shell.md`。两平台自动采集共用 `replySource.ts` 的回复顺序、历史指纹与快照封存规则，回看不会授予新轮资格；来源无法核实时保留手动采集。平台关闭工具能力的门禁仍独立生效。

顶栏具名选择框在 DeepSeek / ChatGPT 间直接切换，每次启动默认 DeepSeek。仅活动平台运行采集、权限执行和限定发送；两平台共用工具协议、权限、执行、复制及 automatic 单开关。ChatGPT 接入普通首页与 `/c/<id>` 会话的纯文本需求和工具结果，不接入 GPTs、项目专属路径或特殊编辑界面；未知地址或 DOM 状态暂停，不猜测控件。

ChatGPT 本地需求携带附件时明确拒绝并保留暂存文件；工具 `attach_file` 请求返回明确失败，不读取或上传文件。图片、PDF、Word 等仍可由用户通过官网原生入口操作。程序纯文本发送遇到官网已有附件也暂停，避免夹带文件。DeepSeek 原有程序附件运输保持独立。
平台复用各自原生视图，分别使用 persist:postcheck 与 persist:postcheck-02 固定分区，首次进入 ChatGPT 才创建。切换不重载已创建的网页、不清除登录态；登录资料不与用户浏览器或独立验证工具共享。正式应用首次需自行登录。无 iframe、网页 preload、Node、本地桥、凭据读取或指纹伪造。

工具执行、存活后台进程及需求/结果发送期间拒绝切换；自动回传倒计时可先撤回再切换。已完成结果和需求草稿保留，可继续复制，旧批次和附件不补发；automatic 配置保留，活动网页重新绑定到同一工具流程时，先释放旧监听与运输，建立新历史基线；上一批展示结果仅保留复制资格，切回任何平台均不补发。跨异步回执以平台修订和活动守卫防止旧动作继续执行。

只读监听的安装和撤销共享主进程单调注册序号，隔离世界保留最新撤销或安装的序号；迟到的旧安装不能替换新监听，也不能在关闭自动采集后复活。此门禁仅管理监听生命周期，不授予历史或未知来源输出执行资格。

ChatGPT 首页首发可经过 `/c/local-chatgpt%3A<UUID>` 编码占位地址，再分配正式会话。占位地址不属于普通会话白名单，不提供采集、执行或输入写入资格；只允许已有监听在未取消的短期本地提交标记下等待正式地址，保持原首页来源基线。运输只在首页实际点击之后等待同一占位地址，再确认一次正式会话；未分配完成、换占位标识或点击前导航均暂停，工具结果不享有例外。正式地址仍独立核验回复完成和新增来源；其他导航建立历史基线，返回支持的会话后恢复监听且不补执行当前历史。

创建或本地切换失败恢复原平台；网络加载失败显示脱敏提示，可立即切回。官网登录弹窗使用同分区与沙箱，仅允许明确的官方和登录提供商地址，主窗口关闭时释放。布局由 WorkspaceLayoutController 管理，文件区全屏隐藏活动官网，退出后恢复。

验证入口：`pnpm run build`、`pnpm exec electron tools/verify-web-platform.cjs`（仅离线本地夹具，拦截公网请求）、相关 test 与应用 self-test。真实官网登录、对话和重启保持由用户手动验证，不能凭页面 loaded 事件推断。完整 IDE 隔离验收可运行 `pnpm exec electron tools/chatgpt-ide-preview.cjs`，其固定独立 userData 不共享安装版登录资料。

ChatGPT 只读规则由 `chatgptPage.ts` 提供：以最新 `data-talvt-turn-state` 轮次及明确 assistant 角色标记定位唯一正式 DilResponseRoot，要求该轮状态为 complete 且正文外有本轮唯一复制页脚；用户消息容器内的操作栏不能计入完成证据，后续用户轮、思考、生成、中断及歧义均不能回退采历史。CodeSurface 中的唯一 CodeContent 保留原始文本，语言仅取对应 StickyActionBar 的明确局部标签。变化监听涵盖这些轮次、角色、正文及页脚节点与状态属性。

`webComposerSender.ts` 仍是唯一网页 DOM 写入 owner，分别验证平台官方 origin、普通会话、唯一可编辑 composer 和局部发送控件；ChatGPT 统一以最近且不含回复的 FORM 关联 ProseMirror 与唯一 type=submit/发送控件，空 composer 的语音控件只用于确认输入区，填入后等待真正发送控件出现。发送只接纳用户主动需求或当前批真实结果，已有草稿/附件、生成中、未知控件、不确定回执均暂停，点击后不重试。

真实 ChatGPT 页面只读结构核验与离线夹具是不同证据。原生结构诊断已核验 ProseMirror/FORM、submit/发送、DilResponseRoot、轮次完成标记、局部复制页脚及代码语言标题；官网输入事件接收和连续闭环以真实对话验收为准，离线测试不能替代该证据，也不能证明重启登录保持。登录保持由用户推迟验证。预览模式可开启 MINI_CHATGPT_STRUCTURE_TRACE，按 `tools/chatgpt-page-structure.cjs` 输出不含正文、草稿、凭据或会话 ID 的结构快照；不向官网提供桥。网页能力依赖平台当前 DOM，技术实现也不代表平台授权程序化提取输出。
