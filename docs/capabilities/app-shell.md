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

> 状态说明：**P2 骨架已实现并通过启动自检（28/28）**。本节记录当前事实。
> 自检命令：`npm run self-test`（构建 + `electron . --self-test`，不联网）。

## 当前技术栈（已落地）

| 项 | 值 |
|---|---|
| 运行时 | Electron **44.5.1**（Chromium 152.0.7977.130 / Node 24.21.0） |
| 语言 | TypeScript 5.9.3（strict，含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`） |
| 包管理 | pnpm（**依赖 postinstall 的二进制需单独安装**，见下） |
| 编辑器 | Monaco Editor 0.57.0（AMD 发行版，从 `node_modules` 复制到 `dist`） |
| 测试 | Node 内置测试运行器 + tsx（53 项单测，`npm test`） |
| 打包器 | **无**（`tsc` + 静态复制脚本） |

## 进程契约

| 进程 | 职责 | 硬性约束 |
|---|---|---|
| **main** | 窗口与分栏布局、IPC 路由、本地文件读取、会话分区配置、启动自检 | 绝不发起或代理大模型相关网络请求；**绝不向网页写入任何内容** |
| **editor renderer**（`persist:editor-ui`） | Monaco 渲染、文件树、编辑与保存 | `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`；无文件系统能力；CSP `connect-src 'none'` |
| **webview renderer**（`persist:postcheck`） | 加载目标平台网页 | 顶级独立视图（`WebContentsView`）；程序**只读不写** |

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

## 已知实现陷阱（均已踩过并修复）

| 陷阱 | 症状 | 正确做法 |
|---|---|---|
| 沙箱 preload 不能 `require` 相对路径模块 | `Error: module not found: ../shared/contract`，bridge 完全不存在（而页面仍能加载，极易误判） | preload 只能 require `electron` 等内置模块；通道名**内联为字面量**，并用自检比对防漂移 |
| `contextBridge` 对象不暴露 `ownKeys` | `Object.keys(bridge)` 为空，误判为"未注入" | 用**实际调用**（`await bridge.getRoot()`）验证能力 |
| 会话级 `session.setUserAgent()` 对视图不生效 | UA 变体"报告说改了、实际没改" | 对 `webContents.setUserAgent()` 显式设置，并在自检中比对 `getUserAgent()` |
| Monaco 的 `window.require` 看似 Node 泄漏 | 误判渲染进程有 Node 能力 | 用 AMD 的 `require.config` 与 Node 的 `require.resolve` 区分；自检 D4/D10 覆盖 |
| `fs.cpSync` 在本项目执行环境报 EIO | 静态复制失败 | 用显式 `mkdirSync` + `writeFileSync` 递归复制 |
| Monaco worker 在 `file://` 下被 CSP 阻止 | 控制台报错并回退主线程 | 已知取舍：语法高亮可用，语言服务不可用；后续若需要，需改为本地 HTTP 或打包 worker |

## 代码入口

- 主进程：`src/main/index.ts`、`src/main/fileService.ts`、`src/main/ipc.ts`、`src/main/selfTest.ts`
- 预加载：`src/main/preload.ts`
- 渲染进程：`src/renderer/`
- 纯逻辑（可单测）：`src/shared/`
- 脚本：`scripts/install-electron.mjs`、`scripts/copy-static.mjs`

## 依赖安装注意

`pnpm install` 默认拦截 `postinstall`，因此 Electron 二进制不会被下载。首次需执行：

```powershell
pnpm install
node scripts/install-electron.mjs   # 走镜像；或从 tools/ 复制已有二进制
```
