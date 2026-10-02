---
artifact_type: capability
status: current
updated: 2026-10-02
owner: 胡运宽
source_of_truth:
  - docs/adr/2026-10-02-honest-electron-identity.md
  - docs/adr/2026-10-02-filesystem-permission-model.md
  - docs/plans/2026-10-02-mini-ai-ide-poc.md
---

# 能力：应用外壳与进程架构

> 状态说明：**本能力尚未实现**（脚手架阶段）。以下为已确认的契约，实现完成前不得据此认为功能存在。实现后本文件改为记录当前事实。

## 职责

主进程负责窗口与进程编排，是唯一持有本地能力（文件系统读取、会话分区配置、回程只读采集）的层。

## 进程契约

| 进程 | 职责 | 硬性约束 |
|---|---|---|
| **main** | 窗口管理、IPC 路由、本地文件读取、回程只读采集调度、会话分区配置 | 绝不发起或代理大模型相关网络请求；**绝不向网页写入任何内容** |
| **editor renderer** | Monaco 渲染、选区捕获、向 main 请求文本 | `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`；无文件系统能力；无业务网络请求 |
| **webview renderer** | 加载 DeepSeek 网页、维护独立 Cookie | 必须是顶级独立视图，**不得用 `<iframe>`**；无任何本地能力通道 |

## 网页嵌入方式选型（Electron 三种方式对比）

| 方式 | 进程关系 | 结论 |
|---|---|---|
| `<iframe>` | 同渲染进程，依赖目标站点 CSP 允许 | **排除**。共享父页面环境，痕迹脏 |
| `<webview>` 标签 | 跨进程 iframe（OOPIF），需开 `webviewTag` | **排除**。Electron 官方明确不推荐（"undergoes dramatic architectural changes"），WebView API 不保证长期可用 |
| **`WebContentsView`** | 由主进程创建与控制，不在 DOM 内 | **采用**。`BaseWindow` + `contentView.addChildView`；天然独立进程与独立 session，符合 ADR-0002 的进程隔离要求 |

注：`BrowserView` 已标记 Deprecated，迁移目标即 `WebContentsView`。参考 Electron 官方 [Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)。

**可行性已获旁证**：Obsidian 的核心插件 Web viewer 基于 Chromium webview 标签，实测可正常加载 `chat.deepseek.com`——说明该站点**未通过 `X-Frame-Options` / CSP `frame-ancestors` 禁止嵌入**。但这只证明"能嵌进去"，**不证明"不会被识别"**；识别风险仍由 P0 Gate 判定。

## 关键规则

1. 编辑器与网页视图必须在**不同渲染进程**。
2. **程序不向网页写入任何内容**：主进程不调度任何注入，对网页的接触只有回程**只读**采集（见 `human-machine-boundary`）。
3. IPC 只暴露窄接口（声明式参数），不接受任意表达式或任意路径。
4. **无自动化特征**（A 级判据，必须为零）：不暴露 CDP 调试端口；不引入 Selenium / Puppeteer / Playwright；不设置 `navigator.webdriver`；不注入任何"伪装浏览器身份"的脚本。
5. **UA 规则（硬性）**：
   - **移除**自我声明标记：`Electron/<ver>` 与 `<appName>/<ver>`；
   - **保留**真实信息：`Chrome/<真实内核版本>`、平台段、`AppleWebKit/537.36`、`Safari/537.36`；
   - **禁止**把版本号改成"最新 Chrome"、禁止伪造平台；
   - **实现要点**：必须在创建 `WebContentsView` 时通过 `webPreferences.userAgent` 显式传入。**仅调用 `session.setUserAgent()` 不生效**（实测教训）。
6. **不自报但不伪造**：只允许移除"我方主动声明的标识"；**禁止**为"看起来更像浏览器"而补齐 `window.chrome`、改 `userAgentData`、伪造 TLS/Canvas/字体。
7. 启动时自检"UA 声明的内核版本 == 实际内核版本"，不一致即告警。

## 已知边界

- 仅 Windows 10/11 x64。
- 单窗口、单网页视图；多标签不在范围内。
- **不 patch Chromium 构建**；不追求与官方 Chrome 指纹一致——与 Chrome 的差异（TLS、Canvas/WebGL、字体列表、`window.chrome` 成员、`userAgentData` 的 `Google Chrome` 条目等）**只作为知情记录留档，不是修补目标**。
  - 实测依据：P0b 受控实验显示，`window.chrome` 与 `userAgentData` 的差异**存在却没有**触发平台告警；触发告警的只有 UA 中的自报标记。
- **UA 与会话分区正交**：UA 规则见上方第 5 条；会话分区见 `session-persistence` 能力文档（`persist:postcheck`）。

## 代码入口

- 待建：`src/main/`、`src/editor/`、`src/webview/`
