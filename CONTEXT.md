# CONTEXT — 稳定词汇表

本文件只收录**跨模块复用**的术语。一次性命名放在代码或对应能力文档里。

| 术语 | 含义 |
|---|---|
| **外壳层 / 主进程（Main）** | Electron 主进程。负责窗口与进程管理、IPC 路由、本地文件读取、回程只读采集调度。**绝不代理大模型流量，也不向网页写入任何内容。** |
| **编辑层（Editor Renderer）** | 承载 Monaco 的渲染进程。沙箱化，无 Node、无网络，只能通过 IPC 请求文件内容。 |
| **网页层（WebView Renderer）** | 承载目标大模型官网的独立渲染进程（`WebContentsView`）。对外表现为一个"纯净的 Chromium 标签页"，程序对它**只读不写**。 |
| **网页只读（Read-only Webpage）** | 不注入键盘事件、不改 DOM、不派发合成事件、不代写剪贴板、不模拟发送；允许隔离上下文中的只读 DOM 变化监听和真实用户发送动作识别，不读取输入内容，状态仅供新轮关联/通知/清理，不向网页主世界暴露本地能力。 |
| **人机边界（Human-Machine Boundary）** | AI 生成规范请求，IDE 只读采集、按预选权限执行并整理；当前工具批次执行结束可按预选设置自动复制，其余由用户点击复制，粘贴发送始终手动。需要批准时由 IDE 发起询问。 |
| **工具批次（Tool Batch）** | 一条回复唯一正式 mini-ai-tools JSON 围栏；请求带批次与请求 ID，IDE 校验、去重、执行并返回真实结果。 |
| **格式约定（Format Convention）** | AI 实际读取、修改和命令统一输出 mini-ai-tools JSON；局部修改用唯一 old_string/new_string，新建和覆盖用完整 content；讨论与澄清用自然语言。 |
| **预览基线（Preview Baseline）** | 主进程在预览时冻结的完整原文与目录版本，写入前复核；仅 IDE 成功应用或撤销可推进已知原文，外部变化要求重新采集。 |
| **回程通道（Return Path）** | 模型回复回到 IDE 的**只读**链路；正式工具经校验和预选权限执行，旧文件操作文本不能写盘，不授予网页层本地能力。 |
| **不伪造、不自报、内部自洽（No Fabrication, No Self-Declaration）** | 项目的基本姿态（术语曾用"如实 Electron 身份"，**已修正**）：UA 如实反映真实内核版本、**但不主动声明 Electron 构建**；不伪造任何能力或指纹；UA/内核/可观测表面保持自洽。依据：P0b 受控实验证明"自报 Electron"会直接触发平台警告，而 `window.chrome`、`userAgentData`、TLS 等差异存在却未据此报警。 |
| **自报（Self-Declaration）** | 我方主动提供的、平台据此可直接下判断的标识（如 UA 中的 `Electron/<ver>`、`<appName>/<ver>`）。与"平台自己推断出的差异"是两件事；本项目只消除前者。 |
| **自动化特征（Automation Traces）** | 唯一需要主动消除的一类信号：`navigator.webdriver`、CDP 调试端口、Playwright/Puppeteer/Selenium 痕迹、无头模式特征、伪装脚本造成的内部矛盾。与"指纹差异"是两件事。 |
| **指纹差异（Fingerprint Divergence）** | 与真实 Chrome 之间的差异（TLS 握手、Canvas/WebGL 串、字体与插件列表等）。在本项目中**只作为知情记录**，不作为修补目标。 |
| **内部矛盾（Internal Contradiction）** | 伪装带来的自相矛盾（如 UA 声称 Chrome 而实为 Electron）。风险权重高于"差异"，属于 C 级阻断项。 |
| **无自动化特征核验（Trace Verification）** | 在真 Chrome 与内嵌视图中核验 A 级自动化特征清单、并如实记录 B 级差异的可重复流程。项目第一交付物（替代早期的"指纹评测台"）。 |
| **Gate** | "A 级自动化特征是否为零 + 平台是否针对性拦截"的决策门。不通过则停止投入后续步骤。 |
| **会话分区（Session Partition）** | 固定且中性的 `persist:` 分区，用于隔离并持久化登录态。分区名不得随机生成。 |
