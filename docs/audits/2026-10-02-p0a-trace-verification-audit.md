---
artifact_type: audit
status: active
created: 2026-10-02
updated: 2026-10-02
owner: 胡运宽
scope: P0a 自动化特征核验（默认 Electron 构建、未打补丁、未伪装）
source_of_truth:
  - docs/plans/2026-10-02-mini-ai-ide-poc.md
  - docs/adr/2026-10-02-zero-injection-and-automation-trace-baseline.md
  - docs/adr/2026-10-02-honest-electron-identity.md
  - tools/trace-verifier/
  - docs/audits/2026-10-02-p0a-trace-verification-raw.json
---

# P0a 自动化特征核验报告

## 核验目标

在**默认 Electron 构建、未打补丁、未伪装**的条件下，逐项核验 ADR-0003 定义的 **A 级（自动化特征，必须为零）** 判据，并如实记录 **B 级（与真 Chrome 的差异，仅留档不作为修补目标）**。

对应计划步骤：`docs/plans/2026-10-02-mini-ai-ide-poc.md` 的 **P0a**。

## 方法与证据链

| 项 | 内容 |
|---|---|
| 工具 | `tools/trace-verifier/`（自建核验台，Electron 44.5.1） |
| 采集方式 | 本地静态 HTTP 服务（`127.0.0.1` 随机端口）由 **Chromium 自身**加载探针页；探针经 `contextBridge` 只读采集；主进程侧另采集进程/开关/端口事实 |
| 是否接触目标平台 | **否**。全程 `127.0.0.1`，零平台暴露 |
| 是否使用 CDP | **否**。并把"无调试端口"作为 A 级判据之一核验（A7） |
| 是否写入页面 | **否**。探针只读取可观测值，不修改属性、不覆写 getter、不派发合成事件 |
| 运行次数 | 2 次（用于一致性核验） |
| 原始证据 | `docs/audits/2026-10-02-p0a-trace-verification-raw.json` |
| 环境 | Windows 10.0.26200 x64；Electron 44.5.1；Chromium **152.0.7977.130**；Node 24.21.0；V8 15.2.124.28-electron.0 |
| 对照组（本机真 Chrome） | `C:\Program Files\Google\Chrome\Application\chrome.exe`，版本 **154.0.8037.58** |
| 复现命令 | 见文末「复现步骤」 |

## A 级判据结果（自动化特征，必须为零）

| ID | 判据 | 结果 | 观测值 |
|---|---|---|---|
| A1 | `navigator.webdriver` 非真值 | **PASS** | `false` |
| A2 | 无 Playwright/Puppeteer/Selenium 痕迹 | **PASS** | `[]` |
| A3 | 无 `cdc_*` 类 CDP 注入痕迹 | **PASS** | `[]` |
| A4 | 无无头模式特征 | **PASS** | `[]`（plugins=5、languages 非空、`Notification` 存在、`window.chrome` 存在） |
| A5 | 渲染进程无 Electron/Node 全局泄漏 | **PASS** | `[]`（`require`/`module`/`process`/`global`/`Buffer`/`ipcRenderer` 等均不存在于页面世界） |
| A6 | 无注入式身份伪装痕迹（未覆写原生属性） | **PASS** | `[]`（UA/platform/webdriver/languages/hardwareConcurrency/screen 的原生描述符未被改为 accessor） |
| A7 | 未开启 CDP 远程调试（无调试端口） | **PASS** | `DevToolsActivePort` 文件不存在；相关命令行开关为空 |
| A8 | UA 声称的内核主版本 == 实际内核主版本 | **PASS** | UA 主版本 `152`，实际内核 `152.0.7977.130` |

**A 级结论：8/8 通过，无失败项。**

## C 级判据结果（伪装造成的内部矛盾，不得出现）

| ID | 判据 | 结果 | 说明 |
|---|---|---|---|
| C1 | UA 声明的 Chrome 主版本与声明的内核版本自洽 | **PASS** | `152` == `152`，无版本错乱 |
| C2 | 未声称 Chrome 却缺失 Chrome 能力（反向伪造矛盾） | **PASS** | 本项目未做任何身份伪装，前提不成立 |

> **判据修正记录（重要）**：C1 的初版判据为"UA 不得同时声称 Chrome 与 Electron"，首次运行被判 `FAIL`。复核后确认这是**判据定义错误**：Electron 默认 UA 同时含 `Chrome/<kernel>` 与 `Electron/<ver>` 属于**如实披露**，而按 ADR-0001"如实表明 Electron 身份"正是决策本身；若强行删除 `Electron/` 标记却保留 Chrome 标记，反而才是真正的矛盾。故 C1 改为判定"声明之间的版本自洽性"，重跑后通过。

## B 级差异（如实记录，不作为修补目标）

以下差异**均非自动化特征**，按 ADR-0001/0003 属于"知情记录"：

| 项 | 观测值 | 与真 Chrome 的差异 |
|---|---|---|
| `window.chrome` 键 | `[]`（`chrome.app`/`chrome.runtime` 均无；`chrome.csi`/`chrome.loadTimes` 为 `undefined`） | 真 Chrome 具备这些成员 |
| `navigator.userAgentData.brands` | `[{Not?A_Brand/24}, {Chromium/152}]` | 真 Chrome 含 `Google Chrome` 条目 |
| UA 字符串 | `... trace-verifier/0.1.0 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36` | 含 Electron 标记与应用名（**按 ADR-0001 属预期披露**） |
| 内核版本 | 152.0.7977.130（Electron 44.5.1 自带） | 本机真 Chrome 为 154.0.8037.58（**版本落后，ADR-0001 已判定不构成风险**） |
| 请求头 | `sec-ch-ua` 未出现在本次请求中（`localhost` 非 HTTPS 外部源）；`Accept-Language: zh-CN` | 真实站点上的头集合需在 P0b 观测 |
| 权限查询 | `notifications`/`geolocation`/`clipboard-read` 在 `localhost` 下均为 `granted` | `localhost` 属安全上下文的默认行为，非自动化标记 |
| 一致性核对 | `hardwareConcurrency=16`、`deviceMemory=16` 与宿主一致；`platform=Win32` | 如实暴露，符合"不伪造" |

## 发现项

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| P0A-1 | High | verified | 默认 Electron 构建下，A 级自动化特征全部为零：不存在 `navigator.webdriver`、无自动化框架痕迹、无 CDP 痕迹、无 Electron/Node 全局泄漏、无调试端口 | `docs/audits/2026-10-02-p0a-trace-verification-raw.json` 中 `aLevel` 8 项 `pass: true`；两次运行结论一致 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P0a） | task/20261002-p0a-trace-verifier | 两次独立运行 `summary.verdict` 均为 `PASS`，且逐项结果一致 | 结论已记录，无后续动作 |
| P0A-2 | Medium | verified | 核验工具初版把"UA 同时含 Chrome 与 Electron 标记"误判为 C 级内部矛盾，属判据定义错误；会导致误报并可能诱导实施被禁止的 UA 伪装 | 首次运行 `summary.cFailures = [C1]`；修正后 `cFailures = []`；推理见本报告「判据修正记录」 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P0a） | task/20261002-p0a-trace-verifier | 修正判据后重跑两次，C1/C2 均 `PASS` | 判据已修正并留档，无后续动作 |
| P0A-3 | Medium | verified | 运行环境存在两个会静默破坏 Electron 启动/安装的陷阱：`ELECTRON_RUN_AS_NODE=1` 使 Electron 以 Node 模式启动（无窗口、无输出、退出码异常）；默认 GitHub Releases 源在本机 pnpm 环境下 `fetch failed`，且 pnpm 默认拦截 `postinstall` 导致二进制未下载 | 首次运行无任何输出且退出码缺失；`node_modules\electron\path.txt` 不存在；改用 `electron_mirror=https://npmmirror.com/mirrors/electron/` 并手动执行 `install.js` 后成功（245,726,208 bytes） | docs/plans/2026-10-02-mini-ai-ide-poc.md（P0a） | task/20261002-p0a-trace-verifier | 清空 `ELECTRON_RUN_AS_NODE` 后两次运行均正常出报告；`tools/trace-verifier/.npmrc` 已固化镜像配置 | 已在 `.npmrc` 与复现步骤中固化，无后续动作 |
| P0A-4 | Low | verified | B 级差异清单已建立：`window.chrome` 成员缺失、`userAgentData.brands` 无 `Google Chrome`、UA 含 Electron 标记、内核落后本机 Chrome 两个主版本 | 同上报告 `bLevel.browserSurface` 与 `bLevel.electronDisclosure` | docs/plans/2026-10-02-mini-ai-ide-poc.md（P0a） | task/20261002-p0a-trace-verifier | 逐项在报告中留档；按 ADR-0003 不作为修补任务 | 留档完成，后续仅在 P0b/P1 复核是否被针对性利用 |
| P0A-5 | Medium | open | **平台是否对 Electron 客户端做针对性拦截尚未验证**——这是本方案唯一的封号风险，P0a 无法回答（需真实访问目标平台） | 本报告范围仅为离线性核验；ADR-0003「已知风险」与计划风险表均标注该风险由 P0b 判定 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P0b） | — | 待 P0b 实测：登录 + 一轮完整人工对话（人工复制粘贴、人工发送） | 待 P0b 给出结论后关闭或转计划 |

## 结论

1. **A 级自动化特征 8/8 为零，C 级内部矛盾 0 项**——在"如实 Electron 身份"的前提下，默认构建本身没有自动化特征需要清理。
2. **P0a 不存在需要修补的项**：B 级差异按 ADR-0003 只作留档；任何"消除 B 级差异"的改动都会滑向被禁止的指纹伪装。
3. **唯一未决风险是 P0A-5（Medium, open）**：平台是否针对 Electron 客户端，只能由 **P0b** 回答。P0a 的价值在于**把"我们这边干不干净"这个问题彻底关闭**，让 P0b 的结论可以单义归因。

> **后续步骤说明**：本文只覆盖计划的 **P0a**。**P0b（真实可达性与登录实测）与 P1（Gate）尚未执行**，本报告的 PASS 结论不构成对方案整体可行性的判定——那由 P0b/P1 给出。

## 复现步骤

```powershell
# 1. 安装（注意：Electron 二进制需手动下载，pnpm 默认拦截 postinstall）
cd tools\trace-verifier
pnpm install
node node_modules\electron\install.js     # 依赖 .npmrc 中的 electron_mirror

# 2. 运行（必须先清掉环境里的 ELECTRON_RUN_AS_NODE，否则 Electron 不进入 GUI 模式）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& .\node_modules\electron\dist\electron.exe . --out="..\..\docs\audits\2026-10-02-p0a-trace-verification-raw.json"

# 3. 退出码 0 = PASS；1 = 有 A/C 级失败；2 = 工具自身异常
```

## 未覆盖 / 范围外

- 未访问任何真实站点（零平台暴露是 P0a 的设计约束）。
- 未采集 TLS/JA3 等信息——按 ADR-0001，该维度已明确**不追求与 Chrome 一致**，不属本项目判据。
- 未在打包（`isPackaged: true`）形态下核验；当前为开发形态。若打包后可观测表面发生变化，需重跑本核验。
