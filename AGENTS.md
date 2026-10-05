# Mini-AI-IDE — 仓库级代理指令

> 本文件是仓库级（项目级）指令。用户级全局指令见 `~/.dsh/AGENTS.md`；两者冲突时，以更具体、更严格的那条为准。

## 1. 项目是什么

Mini-AI-IDE 是一个 **Windows 桌面工具**：左侧用 Monaco 编辑本地文件，右侧在**独立渲染进程**中加载官方大模型网页（当前目标平台为 DeepSeek 网页版），并**只读**读取模型回复、解析代码、经用户确认后写回本地文件。出程（复制代码、粘贴、写提示词、发送）全部由用户手动完成。

三条不可动摇的项目原则：

1. **不逆向 API、不伪造网络协议。** 所有业务流量由内嵌 Chromium 内核直接发出，主进程绝不代理大模型相关请求。
2. **不伪造、不自报、内部自洽。** UA 如实反映真实内核版本，但**不主动声明 Electron 构建**（移除 UA 中的 `Electron/<ver>` 与应用名标记）；**不伪造任何能力或指纹**（不动 `window.chrome`、`userAgentData`、Canvas/WebGL、字体、TLS）。依据：P0b 受控实验证明"自报 Electron"会直接触发平台警告，而那些未被消除的差异反而未触发。
3. **零注入：程序不向网页写入任何内容。** 复制代码、粘贴、写提示词、按发送全部由用户手动完成；程序对网页**只读不写**。

本项目**不是**：通用浏览器、反检测浏览器、批量自动化工具、网页端 API 客户端、指纹伪装工具、任何形式的网页自动化工具。

## 2. 技术栈与运行环境

| 项 | 值 |
|---|---|
| 目标平台 | Windows 10/11（x64） |
| 运行时 | Electron（**不 patch Chromium 构建**，见 ADR-0001） |
| 语言 | TypeScript（strict） |
| 包管理 | pnpm |
| 编辑器 | Monaco Editor（渲染进程内，沙箱化） |
| 当前仓库状态 | 脚手架阶段，尚无实现代码 |

## 3. 目录约定

```text
.
├─ AGENTS.md                     # 本文件：仓库级代理指令
├─ CONTEXT.md                    # 稳定词汇表
├─ CHANGELOG.md                  # 面向人的变更记录（Keep a Changelog）
├─ IDE接入网页版AI.md            # 需求来源文档（初步想法，非最终裁决）
├─ docs/
│  ├─ ai/context-map.md          # 上下文路由：做哪类任务该读什么
│  ├─ plans/                     # 任务计划（过程证据，非默认上下文）
│  ├─ audits/                    # 审计与发现（过程证据）
│  ├─ adr/                       # 架构决策记录
│  └─ capabilities/              # 模块当前事实（唯一推荐行为）
└─ src/                          # 实现代码（待建，见计划）
   ├─ main/                      # 主进程：窗口、IPC、文件读取、回程只读采集
   ├─ editor/                    # 编辑器渲染进程（沙箱，无 Node、无网络）
   └─ webview/                   # 网页渲染进程（纯净 Chromium 视图，只读）
```

## 4. 硬性工程约束（实现时必须遵守）

- **进程边界**：编辑器与网页视图必须在**不同渲染进程**；右侧不得用 `<iframe>`。
- **渲染进程权限**：编辑器渲染进程 `nodeIntegration: false` + `contextIsolation: true`，**不得直接访问文件系统**；一切文件读写经主进程 IPC，且路径必须过白名单。
- **网页层零磁盘访问**：网页视图不读本地文件、不上传附件；进模型的只有文本。
- **网络出口**：不得引入 Node.js 包装的 HTTP 请求；不得在渲染进程发起业务网络调用。唯一例外是主进程的软件更新模块通过 `electron-updater` 检查和下载公开仓库 `cuber-hyk/Mini-AI-IDE` 的 GitHub Release 及其分发资源；不得复用该模块访问 AI 平台、上传文件或提供任意 URL 代理。见软件更新 ADR。
- **零注入（硬边界）**：程序**不向网页写入任何内容**。禁止 `SendInput`、`sendInputEvent`、合成事件、DOM 赋值、模拟回车或点击、代写剪贴板。对网页的接触**只有读取**。
- **无自动化特征**：不得暴露 CDP 调试端口；不得引入 Selenium / Puppeteer / Playwright 及其默认驱动模式；不得设置 `navigator.webdriver` 等自动化标记。
- **会话**：固定且中性的 `persist:` 分区名，禁止每次启动随机生成分区（会被判定为异常登录）。
- **UA（硬性规则）**：**移除**自我声明标记 `Electron/<ver>` 与 `<appName>/<ver>`；**保留**真实的 `Chrome/<内核版本>`、平台段与 `WebKit/Safari` 段。禁止把版本号改成"最新 Chrome"（造成 UA 与内核时空错乱），禁止伪造平台。实现上**必须**在创建 `WebContentsView` 时用 `webPreferences.userAgent` 显式传入（`session.setUserAgent` 不生效）。
- **不自报但不伪造**：只允许移除"我方主动声明的标识"；**禁止**为"看起来更像浏览器"而补齐 `window.chrome`、改 `userAgentData`、伪造 TLS/Canvas/字体等任何能力或指纹。

## 5. 允许 / 禁止

**允许**：如实暴露宿主真实属性与内核真实能力；**移除自我声明标记**（UA 中的 `Electron/<ver>`、应用名）；移除**非浏览器原生**的 Node 注入痕迹（`window.require`、`process` 等）以保持环境自洽；不引入任何自动化框架。

**禁止**：patch / fork Chromium 构建；伪造或篡改 `window.chrome.*`、`userAgentData`、Canvas/WebGL、字体列表、CPU/内存/时区、TLS 等任何身份或指纹属性；把 UA 版本号改成非真实内核版本；伪装成 Chrome；使用 Selenium/Puppeteer/Playwright 驱动；**任何向网页写入的手段**（键盘注入、DOM 修改、合成事件、模拟发送、代写剪贴板）；把大模型流量改走 Node。

**软件更新**：NSIS 安装版从公开 GitHub Releases 检查稳定版本，下载和重启安装分别经用户确认；不得在普通退出时自动安装，安装前必须处理未保存文件。Portable、开发模式和自检/探针不走自动安装。发布更新必须同时提供构建生成的 NSIS 安装包、`latest.yml` 和对应 `.blockmap`，不得把 GitHub 凭据打入客户端。

**边界判定**：改动前先问两句——
1. 这是在**消除自动化特征**（允许），还是在**伪造身份/指纹**（禁止）？
2. 这是在**不再主动声明**（允许），还是在**谎报能力**（禁止）？

依据见 ADR-0001「受控实验结论与 UA 规则」。

## 6. Dev Flow 文档路由

| 产物 | 位置 | 规则 |
|---|---|---|
| 任务计划 | `docs/plans/YYYY-MM-DD-topic.md` | `status: active/archived`；完成后归档到 `docs/plans/archived/` |
| 审计/评审 | `docs/audits/YYYY-MM-DD-topic-audit.md` | 发现项必须有稳定 ID；不得放进 `docs/capabilities/` |
| 架构决策 | `docs/adr/YYYY-MM-DD-title.md` | `status: proposed/accepted/archived` |
| 模块当前事实 | `docs/capabilities/*.md` | 只写当前推荐行为，含 `source_of_truth`；不写计划/审计内容 |
| 稳定术语 | `CONTEXT.md` | 只收跨模块复用的词 |
| 面向人的变更 | `CHANGELOG.md` | 只记用户/运维可见变化 |
| 可执行规则 | 测试 | 能用测试表达的规则优先写成测试 |

## 7. 工作流约定

- 非平凡任务先 `dev-orient` → `dev-plan`，实现走 `dev-branch`（独立任务分支 + 评审门），**绝不自动 push**。
- 提交/合并必须等用户显式批准。
- 存在未决的产品/架构决策时停止实现并提问，不得把决策藏成假设。
- 详细执行顺序、验收标准与门禁见当前活跃计划（`docs/plans/`）。

## 8. 生命周期状态

禁止使用 `completed` / `distilled` / `superseded` / `deprecated` 作为持久状态。计划与审计只用 `active` / `archived`，ADR 只用 `proposed` / `accepted` / `archived`，能力文档固定 `current`。
