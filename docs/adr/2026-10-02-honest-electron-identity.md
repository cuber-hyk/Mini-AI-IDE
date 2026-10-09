---
artifact_type: adr
status: accepted
created: 2026-10-02
updated: 2026-10-07
owner: 胡运宽
source_of_truth: [src/shared/userAgent.ts, src/main/index.ts, test/limits-and-ua.test.ts, docs/audits/2026-10-02-p0b-experiment-noident.json]
---

# ADR-0001：不伪造、不自报、内部自洽（原题「采用如实 Electron 身份」）

> 本 ADR 替换了同一议题上的早期结论（原结论为"打补丁的 Electron 构建 + UA 与官方 Chrome 对齐"，原文件名 `2026-10-02-chromium-patch-strategy.md`）。原结论源自需求文档 `IDE接入网页版AI.md` 的"风控规避要求"一节；经用户澄清，**该节属于理想化需求，不是正式指导方案**，正式方案按真实约束重新分析。
>
> **术语修正（2026-10-02，受控实验之后）**：本 ADR 早期用"如实 Electron 身份"概括决策，该提法**不准确**。P0b 的受控实验证明：UA 中自报 `Electron/<ver>` 会直接触发平台警告（见下文「受控实验结论与 UA 规则」）。准确的原则是 **"不伪造、不自报、内部自洽"**。

## 状态

已接受（accepted）。用户明确澄清目标为：

> **平台知道我们是 Electron 没关系，只要不认为"这是程序在操作"即可。**

即：**目标是抹掉"自动化特征"，不是抹掉"Electron 身份"**。

## 背景

需求文档把"必须与真实 Chrome 指纹完全一致"列为第一优先级，由此推出一整条 patch Chromium 构建的路线。重新分析后，该前提不成立，理由有四条：

**1. 该目标本身是自己的选择，不是外部强加的条件。** 平台风控的实际关切是区分"真人在用浏览器"与"程序在自动化操作"。前者与后者之间有一大类可识别的自动化特征（`navigator.webdriver`、CDP 调试端口、Puppeteer/Playwright 固定指纹、无头模式特征、非浏览器网络栈），这些**才是风控的判定依据**。"是否恰好是官方 Chrome 构建"不是判定依据。

**2. "撒谎"比"诚实"更显眼。** 假装 Chrome 会制造**内部矛盾**：UA 声称 Chrome，而 TLS 握手与 `window.chrome.*` 暴露 Electron 构建。风控对"不一致"的权重远高于对"差异"的权重。

**3. 可行性旁证。** Obsidian 的核心插件 Web viewer 基于 Chromium webview 标签，可正常加载并登录 `chat.deepseek.com`——该站点**未通过 `X-Frame-Options` / CSP `frame-ancestors` 禁止嵌入**，也未对 Electron 客户端做一刀切拦截。Obsidian 从未伪装 Chrome，同样没有因此被阻断。

**4. "主动自报"与"被发现"是两件事（实测得出）。** 见下文受控实验：把自己的构建标识写进 UA，是**我们主动提供**的、平台据此可直接下判断的证词；而 TLS 差异、`window.chrome` 缺失这类是**平台需要自己推断**的。前者触发警告，后者没有。

**同时必须承认旁证的界限**：Obsidian 只证明了"打开页面"（被动浏览）是安全的，**未证明"程序向输入框写入"（主动输入）也是安全的**——而后者才是风控真正关注的行为。因此本 ADR 不声明"零风险"，只声明"目标是可验证的"。本项目的限定工具结果回传见自动结果回传 ADR；身份核验不能证明平台接受主动输入或合成发送。

## 决策

**不伪造、不自报、内部自洽；不对抗指纹识别。**

1. **不 patch Chromium 构建。** 放弃"与官方 Chrome 完全一致"的目标，不 fork、不维护 rebase 流水线。
2. **UA 不自报 Electron**：移除 `Electron/<ver>` 与 `<appName>/<ver>` 两个**自我声明**标记；保留**真实的** Chromium 版本号、平台信息与 WebKit/Safari 段。这不是伪装——内核本来就是该版本；而同时声称 Chrome 与 Electron 才是**自相矛盾**。规则见下节。
3. **只消除自动化特征**（这是唯一需要主动处理的一类）：
   - 不启用任何远程调试入口，不暴露 CDP；
   - 不引入 Selenium / Puppeteer / Playwright 及其任何默认驱动模式；
   - 不设置 `navigator.webdriver` 等自动化标记；
   - 不注入用于"伪装浏览器身份"的 JS。
4. **不伪造任何指纹**：不随机化 Canvas/WebGL、不改字体列表、不伪装 CPU/内存/时区、不动 `window.chrome`、不动 `userAgentData`。宿主真实属性与内核真实能力如实暴露。
5. **不追求"最新版"**：Electron 自带的 Chromium 版本是目标平台的正常分布之一，无需跟进官方 Chrome 发布节奏。
6. 本 ADR 只负责身份与自动化特征判据。网页交互按 `docs/adr/2026-10-07-automatic-result-return-boundary.md` 执行限定结果回传，不能以交互便利为由伪造身份或指纹。

## 受控实验结论与 UA 规则

### 实验设计（P0b 受控实验，一次只改一个变量）

| | 基线 | `--variant noident` |
|---|---|---|
| UA 中的 `Electron/44.5.1` | 有 | **移除** |
| UA 中的应用名 `reachability-probe/0.1.0` | 有 | **移除** |
| UA 中的 `Chrome/152.0.7977.130` | 有 | 保留（**真实内核版本，未改**） |
| `window.chrome` 成员 | 原样 | **原样**（不做任何 JS 注入） |
| `navigator.userAgentData`（sec-ch-ua） | 原样 | **原样**（内核生成，动不了） |
| 语言 / 时区 / 分辨率 / 硬件 | 原样 | **原样** |

### 结果（证据：`docs/audits/2026-10-02-p0b-reachability-audit.md`）

| 观察项 | 基线 | noident |
|---|---|---|
| 登录页「使用环境异常…建议您使用我们的官方产品」警告 | **出现** | **消失** |
| 登录 / 对话 | 成功 | 成功 |
| 4xx/5xx | 0 | 0 |
| 风控云验证码 + 设备指纹服务加载 | 有 | **照旧有** |

**结论：触发点是 UA 中自报的 Electron 与应用名标记。** 不是 `window.chrome` 缺失、不是 `userAgentData` 缺 `Google Chrome`、不是 TLS、也不是账号/IP。且风控服务**照常运行**——差别不是"没被看见"，而是"被看见了但没被标为异常"。

### 由此确定的 UA 规则（实现约束）

1. **移除**自我声明标记：`Electron/<ver>`、`<appName>/<ver>`。
2. **保留**真实信息：`Chrome/<真实内核版本>`、平台段、`AppleWebKit/537.36`、`Safari/537.36`。
3. **禁止**：把版本号改成"最新 Chrome"（会造成 UA 与内核的时空错乱）、伪造平台、改动 `sec-ch-ua` / `userAgentData`。
4. **实现要点**：Electron 下**必须**在创建 `WebContentsView` 时通过 `webPreferences.userAgent` 显式传入；仅调用 `session.setUserAgent()` **不会生效**（实测教训，详见 P0b 报告）。

## 备选方案

| 方案 | 为什么未采用 |
|---|---|
| 打补丁的 Electron 构建（早期结论） | 唯一目的是"像 Chrome"，而该目标已被证明非必要；代价是长期的构建与 rebase 维护成本，且 TLS 一致性本身不保证成功。**风险与收益不成比例。** |
| 假装 Chrome（改 UA 为最新版 Chrome 号 + 补 `window.chrome`） | **最差选项**：制造内部矛盾（UA 与 TLS/`window.chrome` 不一致），比不做任何处理更可疑。本 ADR 只移除**自报**标记，不新增任何伪造。 |
| CEF 自编译 | 控制力最强，但等于重写整个外壳；在"不必伪装"的前提下毫无必要。 |
| **本机 Chrome 直启**（`--app` + 独立 `--user-data-dir`） | 保留为**战略备选**。价值是"用正品 Chrome 承载页面、彻底避免一切 Electron 特征争议"。**触发条件**：若实测发现平台针对 Electron 客户端做单独处理，这是唯一能完全绕开该问题的路线。（P0b 目前**未**触发该条件。） |

## 后果

**正面**：

- 删除项目中最贵、最不确定、维护成本最高的一块（构建流水线 + 版本跟进）。
- 不再有"撒谎被抓"的风险——内部自洽本身就是最低可疑度的姿态。
- 验收标准变得**可验证**：从"像不像 Chrome"（模糊、无阈值）变成"有没有自动化特征"（明确、可枚举）。
- P0b 实测确认：移除自报标记后，平台不再给出环境警告（`window.chrome`、`userAgentData`、TLS 等差异**仍然存在**却未被据此报警）。

**负面 / 代价**：

- 放弃"与真实 Chrome 无异"这一理想目标；在**专门针对非 Chrome 桌面客户端**做区分的平台上，本方案不适用（届时切战略备选）。
- **语义边界必须守住**：本决策授权的是"不主动声明"，**不是**"伪装成 Chrome"。任何以"消除差异"为名的伪造（补 `window.chrome`、改 `userAgentData`、伪造 TLS）都属越界，违反第 4 条。

**已知风险**：

- 平台若把"Electron 客户端"整体视为高风险来源，本方案无法通过配置规避，只能切换战略备选。P0b 基线实测**未**出现该情况。
- 宿主环境如实暴露意味着**不使用指纹伪造类工具**，因此不适用于"必须隐藏身份"的场景——这属于明确的范围外。

## 关联

- 受控实验与证据：`docs/audits/2026-10-02-p0b-reachability-audit.md`
- 验收判据：`docs/adr/2026-10-02-zero-injection-and-automation-trace-baseline.md`（ADR-0003）
- 嵌入方式选型：`docs/adr/2026-10-02-filesystem-permission-model.md`（ADR-0002）
- 能力文档：`docs/capabilities/app-shell.md`、`docs/capabilities/session-persistence.md`
- 计划：`docs/plans/archived/2026-10-02-mini-ai-ide-poc.md`
