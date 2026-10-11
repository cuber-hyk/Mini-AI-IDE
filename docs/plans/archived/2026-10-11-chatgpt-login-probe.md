---
artifact_type: plan
status: archived
created: 2026-10-11
updated: 2026-10-11
owner: Codex
---

# ChatGPT 网页登录与内核适配验证

用户最终目标仍包括自动执行/自动继续，本轮仅批准先验证网页登录及 IDE 环境兼容，自动化范围后续讨论。使用现有 Electron 44.5.1 / Chromium 152 与共享真实 UA 规则的原生 WebContentsView；不接回复采集、工具执行、需求发送或文件桥。

1. [done] dev-orient 核查 IDE 主进程、已有诊断/可达性工具和共享 UA；现有诊断依赖 DeepSeek 且可能读回复，因此不直接用改 URL 的方式试 ChatGPT。当前生产 IDE 正在运行，原有两份未跟踪审计报告原样保留，不提交。
2. [done] 独立 codex/chatgpt-login-probe 分支添加 tools/chatgpt-login-probe.cjs：固定隔离验证 userData 与 persist 分区，手动窗口，无 preload/Node/官网 DOM 注入，仅脱敏加载/网络错误报告。node --check 与离线 --self-test 通过，验证无 Node/文件桥且实际 UA 等于清理后的真实 Chromium UA。实测 webPreferences.userAgent 单独无效，沿用主进程现有 session 与 webContents.setUserAgent 方式，仅移除自报标记。
3. [done] 已启动真实 chatgpt.com 登录验证窗口；用户确认“登录并对话成功”。正常关闭验证窗口后，用同一固定 userData 与分区重开，用户再次确认“登录状态保留，可以直接对话”。认证与对话结论来自用户实际操作确认，程序仅记录加载 origin，不读取账号/密码/Cookie/会话内容。
4. [done] 独立只读 subagent review 通过，无代码阻断问题；事实与验证说明归档。正式平台切换和后续自动闭环属于后续适配范围，本轮未提交合并或发布。

验证数据位置固定在生产 userData 下的独立 probes/login-01 子目录，仅试验程序访问，不共享 DeepSeek 分区；不能把该 profile 跨应用搬入正式环境或保证正式切换无需再次登录。公网加载不绕过证书错误、验证、网站保护，不伪造 UA/指纹，不使用 CDP/浏览器驱动/合成输入。出现认证阻碍由用户手动处理，程序不自动重试。日志仅记录 origin、错误码/网络类型和生命周期，不采集正文、表单、凭据或 Cookie。

dev-split: no split，单个可删除的验证工具有明确责任，不改 IDE 多平台架构。Design system gate: not needed，使用原生临时验证窗口，无正式产品 UI 规则。Changelog gate: 本轮为验证工具，无生产功能发布条目。ADR gate: 正式平台与分区决策后续讨论，本轮沿用现有隔离/真实身份契约，不作永久平台架构决策。

## 当前验证记录

- 2026-10-11：Electron 44.5.1 / Chromium 152.0.7977.130；离线窗口 noNode=true、noBridge=true、uaMatches=true，退出码 0。
- 真实窗口首次加载：ready、loaded=https://chatgpt.com；报告为 `%APPDATA%/mini-ai-ide/probes/login-01/login-report.json`。仅记 origin 与错误类型，不记录官网正文或登录信息。
- 用户实际确认首次登录/对话及重启后的登录保持均成功。首次日志另有 cdn.openai.com 字体 ERR_CACHE_MISS、认证跳转和关闭时的 xhr ERR_ABORTED；没有阻止用户成功登录对话，未将单个网络错误误判为认证失败。
- 本轮范围为独立内核验证窗口，尚未加入正式 IDE 平台切换、ChatGPT 回复采集、工具执行或结果回传。
- 独立评审确认无官网采集/发送/文件桥，分区隔离及真实 UA 符合边界。正式 IDE 的登录兼容仍需在集成后验证；独立验证成功不代表自动执行/自动继续已支持。
- 文档校验：本轮计划未被报告错误；仓库整体校验仍返回既有 5 个错误、3 个警告，涉及 2026-10-09-brand-font、2026-10-09-file-tree-icons 的元数据和既有归档审计，不在本任务范围。本轮不申请提交/合并。
