---
artifact_type: audit
status: archived
created: 2026-10-02
updated: 2026-10-07
owner: 胡运宽
scope: P0b 可达性与登录实测（真实访问 chat.deepseek.com，全人工操作）
source_of_truth: ["docs/plans/archived/2026-10-02-mini-ai-ide-poc.md","docs/adr/2026-10-02-zero-injection-and-automation-trace-baseline.md","docs/adr/2026-10-02-honest-electron-identity.md","tools/reachability-probe/","docs/audits/2026-10-02-p0b-reachability-raw.json","docs/audits/2026-10-02-p0b-experiment-noident.json"]
---

# P0b 可达性与登录实测报告

## 观测目标

回答本项目**唯一的存亡问题**：平台会不会因为我们是 Electron 客户端而针对性拦截。

对应计划步骤：`docs/plans/2026-10-02-mini-ai-ide-poc.md` 的 **P0b**。

## 方法与证据链

| 项 | 内容 |
|---|---|
| 工具 | `tools/reachability-probe/`（只读采集，内置 `--self-test` 已通过） |
| 运行方式 | **全人工**：用户手动登录、手动提问、手动关窗。零注入、零代填、零代答 |
| 采集内容 | 导航/加载事件、验证与风控关键词命中、HTTP 4xx-5xx、第三方请求域、Cookie 名与长度 |
| 目标 | `https://chat.deepseek.com/` |
| 会话分区 | `persist:neutral-profile`（中性命名） |
| 环境 | Windows 10.0.26200 x64；Electron 44.5.1；Chromium 152.0.7977.130 |
| 观测时段 | 2026-10-02 09:14:17 → 09:15:54（约 97 秒） |
| 原始证据 | `docs/audits/2026-10-02-p0b-reachability-raw.json` |
| 人工旁证 | 用户截图：登录成功（手机号可见）、对话成功（"你好"→ 正常回复）、输入框可用。**用户确认登录页看到了「使用环境异常」警告。** |

## 结果：登录与对话成功，但平台当场给出明确警告

### 时间线（报告原始时间戳）

| 时刻 | 事件 |
|---|---|
| 09:14:17 | 加载 `chat.deepseek.com` |
| 09:14:18 | 302/跳转至 `/sign_in`，登录页就绪 |
| 09:14:20 | ⚠️ **命中警告文案**（关键词：验证 / 异常） |
| 09:14:24 | 登录页再次命中（关键词：验证，短信验证码流程） |
| 09:15:22 | 回到聊天页（登录成功） |
| 09:15:50 | 进入会话 `/a/chat/s/968af23f-…`，对话正常 |

### 警告原文（报告逐字记录）

> **使用环境异常**
> 当前页面的使用环境可能存在数据和隐私泄露风险，为保障安全，建议您使用我们的官方产品。

### 会话事实

- 5 个 Cookie：`HWWAFSESTIME`、`HWWAFSESID`（**华为云 WAF**）、`ds_session_id`（**登录态有效**）、`smidV2`（**设备指纹 cookie**）、`.thumbcache_*`
- 0 个 4xx/5xx 响应；0 次加载失败；0 次渲染进程崩溃；**未出现人机验证挑战**

### 观测到的第三方域（按性质归类）

| 类别 | 域名 | 含义 |
|---|---|---|
| **风控 / 验证码 / 设备指纹** | `captcha1.fengkongcloud.cn`、`castatic.fengkongcloud.cn`、`fp-it-acc.portal101.cn` | 风控云验证码服务 + 设备指纹采集在**我们环境内实际运行** |
| 字节 APM 遥测 | `apm.volccdn.com`、`apmplus.volces.com`、`gator.volces.com`、`lf3-data.volccdn.com` | 埋点与性能数据上报 |
| 微信登录 | `open.weixin.qq.com`、`lp.open.weixin.qq.com`、`res.wx.qq.com`、`support.weixin.qq.com`、`localhost.weixin.qq.com:13013-13015/14013-14015` | 扫码登录 SDK（在 Electron 下尝试拉起本地微信客户端） |
| Apple 登录 | `appleid.cdn-apple.com` | Apple 账号登录资源 |

## 发现项

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| P0B-1 | High | verified | 平台**可识别**本客户端非官方产品，并在登录页展示明确警告：「使用环境异常…建议您使用我们的官方产品」 | 报告 `challenges[0].excerpt` 逐字记录；用户确认在登录页看到该警告 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P0b） | task/20261002-p0b-reachability-harness | 报告时间戳 09:14:20 命中，URL 为 `/sign_in` | 已确认，转由 P0B-3 定位触发点 |
| P0B-2 | High | verified | 尽管出现警告，**平台未做阻断**：登录成功、会话有效、对话正常、无验证码挑战、无 4xx/5xx | 报告 `summary`（challengesDetected=2、httpErrors=0、loadFailed=0）；Cookie 含 `ds_session_id`；用户截图显示正常对话 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P0b） | task/20261002-p0b-reachability-harness | 09:15:22 回到聊天页、09:15:50 进入会话；`thirdPartyHosts` 无验证码挑战回调 | 结论：当前为"提示级"而非"拦截级" |
| P0B-3 | High | verified | **警告触发点已定位**：由 UA 中**自报**的 `Electron/<ver>` 与应用名标记引起，而非 `window.chrome` 缺失、`userAgentData` 缺 `Google Chrome`、TLS 差异或账号/IP 因素 | 受控实验报告 `docs/audits/2026-10-02-p0b-experiment-noident.json`：单变量生效（`variant.effective` 与运行时 `sessionFacts.userAgent` 逐字一致、均不含 `Electron/`），警告在登录页**不再出现**（基线为 2 条命中，实验仅 1 条且为短信验证码文案误命中）；用户确认"没有警告了" | docs/plans/2026-10-02-mini-ai-ide-poc.md（P1） | task/20261002-p0b-reachability-harness | 登录成功、对话正常、0 个 4xx/5xx；`window.chrome` / `userAgentData` / TLS **未做任何改动**却未触发警告 | 已关闭。结论写入 ADR-0001「受控实验结论与 UA 规则」并成为实现约束 |
| P0B-4 | Medium | verified | 目标平台在我们的环境内实际运行第三方**风控与设备指纹**服务（风控云验证码 + 设备指纹采集），且网关侧存在华为云 WAF | `thirdPartyHosts` 含 `captcha1.fengkongcloud.cn`、`castatic.fengkongcloud.cn`、`fp-it-acc.portal101.cn`；Cookie 含 `HWWAFSESTIME`/`HWWAFSESID` | docs/plans/2026-10-02-mini-ai-ide-poc.md（P0b） | task/20261002-p0b-reachability-harness | 基线报告与实验报告的 `thirdPartyHosts` 全量清单**均为同一组**（实验组也照常加载） | 已留档；后续若检测强度上升，这些域是首要观察对象 |
| P0B-5 | Low | verified | 工具结论字段 `signal` 过于保守：命中"验证/异常"关键词即报 `blocking-signal-observed`，但实际可能为**非阻断警告**（基线登录与对话均成功） | 报告 `summary.signal = blocking-signal-observed`，而同报告 `httpErrors=0`、`loadFailed=0`，且人工确认使用正常 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P0b） | task/20261002-p0b-reachability-harness | 对比 `summary` 各字段与人工观察 | 已知偏差：`signal` 仅作提示，判定须结合人工观察与 `httpErrors`/`loadFailed`；已在手册结果判定表中说明 |
| P0B-6 | **High** | verified | **告警消除未引入新的矛盾**：实验后风控服务照常运行，但平台未再判定环境异常 | 实验报告 `thirdPartyHosts` 与基线**完全一致**（风控云验证码、设备指纹、华为云 WAF 均在）；`window.chrome`、`userAgentData`、TLS 未做任何改动 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P1） | task/20261002-p0b-reachability-harness | 实验组：警告消失、登录成功、对话正常、0 个 4xx/5xx | 已关闭。含义：差别是"被看见了但未被标为异常"，而非"没被看见" |
| P0B-7 | Medium | verified | 实现陷阱：`session.setUserAgent()` **不会**改变 `WebContentsView` 发出的 UA，必须在 `webPreferences.userAgent` 显式传入；否则实验会记录"已应用变体"而运行时 UA 未变，导致**完全错误的结论** | 自检报告显示 `variant.applied=true` 但 `sessionFacts.userAgent` 仍含 `Electron/44.5.1`；修正后两者逐字一致 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P1） | task/20261002-p0b-reachability-harness | 修正后自检：`variant.effective === sessionFacts.userAgent` 且不含 `Electron/`、保留 `Chrome/152.0.7977.130` | 已关闭。已写入 AGENTS.md 硬性规则与 ADR-0001 UA 规则 |

## 结论

1. **基线：平台看见了我们，但没有阻断**——给出「使用环境异常」提示级警告；登录、会话保持、对话全部正常。
2. **受控实验：触发点已精确定位**——是 UA 中**我方自报**的 `Electron/<ver>` 与应用名标记；移除后警告消失，而 `window.chrome` 缺失、`userAgentData` 无 `Google Chrome`、TLS 差异**全部照旧存在**却未触发警告。
3. **告警消除未引入新矛盾**（P0B-6）：风控云验证码、设备指纹、华为云 WAF 在实验组照常运行——差别是"被看见了但未被标为异常"。
4. **对 ADR-0001 的影响**：原表述"如实 Electron 身份"不准确，已修正为 **"不伪造、不自报、内部自洽"**。本实验恰好验证了该原则：我们**没有伪造任何能力**，只是不再主动声明。
5. **无未决 High 发现项**：P0B-1/2/3/4/5/6/7 全部 `verified`。方案可以进入 **P1 Gate**。

> **后续步骤**：**P1（Gate）** 待执行——确认 A 级自动化特征为零、UA 规则落实、无针对性拦截。本报告不构成对方案整体可行性的最终判定。

## 复现步骤

```powershell
# 0. 工具自检（不联网）
pwsh -File tools\run-p0b-reachability.ps1 -SelfTest

# 1. 基线（已完成，产生警告）
pwsh -File tools\run-p0b-reachability.ps1 -Profile baseline

# 2. 受控实验（已完成，警告消失）：仅移除 UA 中的 Electron/ 与应用名标记，其余一律不动
pwsh -File tools\run-p0b-reachability.ps1 -Variant noident -Profile noident
```

> **关于重复登录的风险**：反复登录本身可能触发风控，因此**不建议**为"再确认一次"而反复跑上述两步。
> 会话已持久化在 `persist:neutral-profile*` 分区中；后续运行会**复用登录态**，无需重新登录。

## 未覆盖 / 范围外

- 未做**反向复现**（在全新分区重跑基线确认警告回归）。判断：成本（多一次登录暴露）高于收益，且单变量对照已足够；该限制在此明确记录。
- 未采集 DOM 侧指纹表面（`window.chrome`、`userAgentData.brands` 等）——属 P0a 的范围，本次未纳入。
- 未做长时挂机观测（计划中的 24 小时观测未执行）。
- 未在打包（`isPackaged: true`）形态下实测；当前为开发形态。
- 未验证多设备/多网络下的稳定性；本次为单机单网络单账号。
