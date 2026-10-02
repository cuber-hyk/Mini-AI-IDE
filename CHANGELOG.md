# Changelog

本文件记录面向人与运维的可见变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
版本号策略：脚手架阶段不做发布，首次可用版本再定版本号。

## [Unreleased]

### Added

- 建立 Dev Flow 仓储记忆骨架：`AGENTS.md`、`CONTEXT.md`、`CHANGELOG.md`、`docs/ai/context-map.md`、`docs/{plans,audits,adr,capabilities}/`。
- 新增 Mini-AI-IDE PoC 计划 `docs/plans/2026-10-02-mini-ai-ide-poc.md`，以及四份架构决策记录（ADR-0001 ~ ADR-0004）。
- 新增回程通道能力契约 `docs/capabilities/return-path-and-format-contract.md`：定义输出格式契约、只读回程采集、diff 预览与一键应用规则；计划新增步骤 P3R。
- 新增 ADR-0004（回程契约与信任边界）：确认默认动作为 **diff 预览后应用**，网页层永不获得写本地能力，不做自动回注循环。
- 计划 P0 拆分为 **P0a（离线 JS 表面 diff）** 与 **P0b（真实可达性与登录实测）**，并调整为先测量差异、再决定 patch 范围。
- 网页嵌入方式定选 **`WebContentsView`**（弃用 `<iframe>` 与 `<webview>` 标签），写入 ADR-0002 与 `app-shell` 能力文档。
- ADR-0001 补充推论：**UA 保持诚实即可、不追求最新版**（待 P0 验证），rebase 从"必须紧跟"降为"择机跟进"；并把"本机 Chrome 直启"记为战略备选。
- **方向修正**：目标从"模拟真实 Chrome"改为"如实 Electron 身份 + 只消除自动化特征"。ADR-0001 重写并更名为 `2026-10-02-honest-electron-identity.md`；ADR-0003 验收判据从"与 Chrome 一致"改为"无自动化特征"三级清单；计划目标/决策/风险/验收标准同步更新；AGENTS.md 允许禁止清单重写并补边界判定。
- **职责收敛（第一轮）**：程序定位为纯搬运工，提示词与发送归用户。删除指令头／格式约定注入、剪贴板通道与其降级策略；术语"文本载荷"改为"注入内容"。
- **零注入（第二轮，结构性简化）**：确认出程连"搬运代码"都不需要程序代劳（用户已选中代码，自行复制粘贴更快），**出程整体移除**。ADR-0003 重写并更名为 `2026-10-02-zero-injection-and-automation-trace-baseline.md`；`text-injection` 能力文档替换为 `human-machine-boundary.md`；计划删除注入步骤（原 P3）并把 P3R 收为 P3、风险表改为只列封号风险；AGENTS.md 与 CONTEXT.md 同步改写。
- **风险结论**：封号风险收敛为**唯一一条未知**——平台是否对"Electron 客户端访问网页"整体持负面态度（由 P0b 实测判定）；页面改版、模型不守格式等移入"非封号项"。
- **P0a 完成**：新增自动化特征核验台 `tools/trace-verifier/`（Electron 44.5.1 + 本地 HTTP 探针，全程 `127.0.0.1`，零平台暴露、不使用 CDP、不写入页面）。核验结果：**A 级自动化特征 8/8 通过、C 级内部矛盾 0 项**，两次运行结论一致。证据与发现项见 `docs/audits/2026-10-02-p0a-trace-verification-audit.md`；计划步骤 P0a 标记为 `done`。新增 `.gitignore`（并明确保留 Dev Flow 路径被跟踪）。
- **P0b 工具就绪**：新增 `tools/reachability-probe/`（只读采集：导航/加载失败/渲染崩溃事件、验证与风控关键词命中、HTTP 4xx-5xx、第三方域、会话事实；URL 去 query、Cookie 只记名与长度），配套 `tools/run-p0b-reachability.ps1`（含 `-SelfTest` 不联网自检）与操作手册。`tools/` 提升为 pnpm workspace，两个工具共享一份 Electron 二进制；新增 `tools/install-electron.ps1` 处理镜像源与 `ELECTRON_RUN_AS_NODE` 陷阱。
- **P0b 基线实测完成（提示级警告，非拦截）**：真实访问 `chat.deepseek.com`，全人工操作。**登录成功、会话保持、对话正常**（0 个 4xx/5xx、无验证码挑战）；但登录页出现明确警告「使用环境异常…建议您使用我们的官方产品」，环境内实际运行了风控云验证码与设备指纹服务，网关侧为华为云 WAF。发现项 P0B-1 ~ P0B-5，其中 **P0B-3（警告触发点未定位）为 `open`**。证据见 `docs/audits/2026-10-02-p0b-reachability-audit.md`。
- **受控实验工具就绪**：`tools/reachability-probe` 新增 `--variant noident`（**仅**移除 UA 中的 `Electron/<ver>` 与应用名标记；不做任何 JS 注入、不改其他任何属性）与 `--profile`（实验分区隔离），用于定位 P0B-3。
