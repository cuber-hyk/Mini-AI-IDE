---
artifact_type: capability
status: current
updated: 2026-10-02
owner: 胡运宽
source_of_truth:
  - docs/adr/2026-10-02-honest-electron-identity.md
  - docs/adr/2026-10-02-zero-injection-and-automation-trace-baseline.md
  - docs/plans/2026-10-02-mini-ai-ide-poc.md
  - tools/reachability-probe/main.js
---

# 能力：会话与登录持久化

> 状态说明：**契约已定并已实测验证**（P0b 登录产生的会话已在磁盘上生效）。实现后本文件记录当前事实。

## 职责

让网页视图拥有一个**稳定、独立、可跨重启保持登录态**的浏览器上下文，避免因"每次启动都是全新环境"而触发异常登录风控。

## 分区（唯一权威值）

| 项 | 值 |
|---|---|
| **分区常量** | **`persist:postcheck`** |
| 磁盘目录 | `%APPDATA%\<appName>\Partitions\postcheck` |
| 命名理由 | 中性，不含应用名/项目名，长期留痕在磁盘上也不暴露工具身份 |
| 多平台 | 每个目标平台一个独立分区（当前仅 DeepSeek） |
| 实验隔离 | 需要隔离实验时用后缀（如 `persist:postcheck-experiment`），**不得**用后缀替代正式分区 |

**这个常量被两处共用，必须一致**：
1. P0b 实测工具 `tools/reachability-probe/`（`PARTITION` 常量）；
2. P2 外壳（实现时同样读取该值）。
两处不一致的后果是**外壳拿不到已登录会话，用户被迫重新登录**——而重复登录本身可能触发风控。

## 规则

1. **分区固定**：固定在上述常量。**禁止每次启动随机生成分区名**——随机分区等价于每次都是新浏览器，是最典型的异常登录信号。
2. **分区名中性**：不得包含应用名、项目名或任何可识别本工具身份的字符串。
3. **禁止随意改名**：改名等于换一个新浏览器，会丢弃登录态并迫使重新登录。**改名视为破坏性操作**，需评估后再做。
4. **登录方式**：不预设。P0b 实测中"手机号 + 短信验证码"与"微信扫码"入口均可用；以实测最稳的方式为准。
5. **不共享**：不得与用户日常浏览器的 profile 混用。
6. 会话数据只存放于分区内；应用自身的配置与状态不得写入该分区。

## 登录次数最小化（重要）

**反复登录本身可能被判定为异常。** 因此：

- 会话已持久化，**正常运行不需要重新登录**；
- 验证"是否仍需登录"应使用**只探测模式**，而不是重新走一遍登录流程：
  ```powershell
  pwsh -File tools\run-p0b-reachability.ps1 -ProbeOnly
  ```
  该模式加载页面后自动退出，并报告 `session.loggedIn`。
- 报告中的 `session` 字段即为免登录判定的依据：
  `{ loggedIn, hasSessionCookie, onSignIn, onChat, currentUrl }`

### 已实测结论（2026-10-02）

| 项 | 结果 |
|---|---|
| 会话是否跨进程持久化 | **是**。分区重命名后重跑，仍为 `loggedIn: true` |
| 是否出现告警 | **无**（挑战命中 0 条；基线为 2 条） |
| 是否出现验证码 | **无** |
| 风控服务是否仍在运行 | **是**（设备指纹域照常加载） |

## 验收

- 重启应用后无需重新登录即可继续对话（由 `--probe-only` 的 `session.loggedIn === true` 判定）。
- 代码中分区名为常量，运行期未创建任何随机命名的分区目录。
- 抓包显示会话相关请求的 Cookie 完全来自该分区。
- UA 与会话分区**正交**：UA 处理规则见 `app-shell` 能力文档与 ADR-0001，不要写入分区名。

## 实现要点（已知陷阱）

- `WebContentsView` 的 UA **必须**通过 `webPreferences.userAgent` 显式传入（`session.setUserAgent` 不生效）；会话分区只影响存储与 Cookie，不影响 UA。
- 分区名一旦落到用户磁盘即为长期状态；发布前务必确定，避免升级时"换会话"。
