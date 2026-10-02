---
artifact_type: audit
status: active
created: 2026-10-02
updated: 2026-10-02
owner: 胡运宽
scope: P0b 可达性与登录实测（真实访问 chat.deepseek.com，全人工操作）
source_of_truth:
  - docs/plans/2026-10-02-mini-ai-ide-poc.md
  - docs/adr/2026-10-02-zero-injection-and-automation-trace-baseline.md
  - docs/adr/2026-10-02-honest-electron-identity.md
  - tools/reachability-probe/
  - docs/audits/2026-10-02-p0b-reachability-raw.json
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
| P0B-3 | High | open | **警告的触发点未定位**：无法判定由"UA 如实披露 Electron"、`window.chrome` 能力缺失、TLS 差异，还是账号/IP 侧因素引起 | 本次为单变量未知的观测；报告中未包含 DOM 侧指纹采集（只读采集未覆盖 `window.chrome`） | docs/plans/2026-10-02-mini-ai-ide-poc.md（P0b） | — | 受控实验 `--variant noident`（仅移除 UA 中的 Electron 与应用名标记，其余一律不动）：① 警告是否复现；② 是否出现验证码；③ 能否正常对话 | 结果出来后：若警告消失 → 评估把"不主动声明 Electron"作为稳态；若仍在 → 停止进一步伪装，转 ADR-0001 战略备选 |
| P0B-4 | Medium | verified | 目标平台在我们的环境内实际运行第三方**风控与设备指纹**服务（风控云验证码 + 设备指纹采集），且网关侧存在华为云 WAF | `thirdPartyHosts` 含 `captcha1.fengkongcloud.cn`、`castatic.fengkongcloud.cn`、`fp-it-acc.portal101.cn`；Cookie 含 `HWWAFSESTIME`/`HWWAFSESID` | docs/plans/2026-10-02-mini-ai-ide-poc.md（P0b） | task/20261002-p0b-reachability-harness | 报告 `thirdPartyHosts` 全量清单 | 已留档；后续若加强检测强度，这些域是首要观察对象 |
| P0B-5 | Low | verified | 工具结论字段 `signal` 过于保守：命中"验证/异常"关键词即报 `blocking-signal-observed`，但本次实际为**非阻断警告**（登录与对话均成功） | 报告 `summary.signal = blocking-signal-observed`，而同报告 `httpErrors=0`、`loadFailed=0`，且人工确认使用正常 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P0b） | task/20261002-p0b-reachability-harness | 对比 `summary` 各字段与人工观察 | 已知偏差：`signal` 仅作提示，判定须结合人工观察与 `httpErrors`/`loadFailed`；已在手册结果判定表中说明 |

## 结论

1. **不构成"通过"**：平台给出了明确的、针对环境本身的警告，说明"如实 Electron 身份"**确实被看见了**。
2. **也不构成"失败"**：警告是**提示级**，没有任何阻断——登录、会话保持、对话全部正常。项目未被判死刑。
3. **唯一未决项是 P0B-3（High, open）**：警告的触发点尚未定位。**在定位之前，不应进入 P2 外壳开发**——否则可能把成本投到一个需要改架构的方向上。
4. P0B-4 提供了重要背景：风控与设备指纹服务正在我们环境内运行，因此"没被拦"不代表"没被分析"。

> **后续步骤说明**：P0b 的**受控实验**（`--variant noident`）与 **P1（Gate）** 尚未执行。本报告的结论不构成对方案整体可行性的最终判定。

## 复现步骤

```powershell
# 0. 工具自检（不联网）
pwsh -File tools\run-p0b-reachability.ps1 -SelfTest

# 1. 基线（已完成）
pwsh -File tools\run-p0b-reachability.ps1 -Profile baseline

# 2. 受控实验：仅移除 UA 中的 Electron/ 与应用名标记，其余一律不动
pwsh -File tools\run-p0b-reachability.ps1 -Variant noident -Profile noident
```

## 未覆盖 / 范围外

- 未采集 DOM 侧指纹表面（`window.chrome`、`userAgentData.brands` 等）——属 P0a 的范围，本次未纳入。
- 未做长时挂机观测（计划中的 24 小时观测未执行）。
- 未在打包（`isPackaged: true`）形态下实测；当前为开发形态。
- 未验证多设备/多网络下的稳定性；本次为单机单网络单账号。
