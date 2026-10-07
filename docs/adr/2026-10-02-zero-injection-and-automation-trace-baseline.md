---
artifact_type: adr
status: accepted
created: 2026-10-02
updated: 2026-10-07
owner: 胡运宽
source_of_truth: [src/shared/userAgent.ts, src/main/selfTest.ts, tools/trace-verifier/, docs/adr/2026-10-02-honest-electron-identity.md, docs/adr/2026-10-07-automatic-result-return-boundary.md]
---

# ADR-0003：身份自洽与自动化驱动特征核验

## 状态与范围

已接受。此 ADR 管理 Chromium 环境、驱动与身份特征的核验。当前网页交互授权统一见 `docs/adr/2026-10-07-automatic-result-return-boundary.md`：采集只读，automatic 开启时允许唯一 owner 回传当前批次真实工具结果。

## 背景

项目直接使用 Electron 的真实 Chromium 构建。把环境改成“与 Chrome 高度一致”既没有可复现阈值，也可能引入 UA、内核和能力之间的矛盾。P0b 受控实验表明 UA 中主动自报 Electron 触发平台告警，而未消除的 `window.chrome`、`userAgentData` 等差异没有据此告警；因此仅移除主动声明，不伪造浏览器能力，详见 ADR-0001。

网页是否接受限定合成输入与点击，是另一个独立验收问题；不能把环境清单通过当作自动回传可用的证明。

## 决策

在本机 Electron 内嵌 `WebContentsView`（默认构建、未打补丁、未伪装）中核验可枚举清单。

| 层级 | 判据 | 判定 |
|---|---|---|
| **A 级：必须为零** | 无 `navigator.webdriver`；无 CDP 调试端口暴露；无 Playwright/Puppeteer/Selenium 驱动痕迹（含会话标记泄漏）；无无头模式特征；无注入式身份伪装；UA 与实际内核自洽 | 任一不符则 Gate 不通过 |
| **B 级：如实记录** | 与真实 Chrome 的 TLS、Canvas/WebGL、字体、插件、编解码器和 `window.chrome.*` 表面差异 | 知情记录，不能作为补齐或伪造目标 |
| **C 级：不得出现** | UA/内核版本错配，伪造能力或指纹造成的内部矛盾 | 出现即阻断并撤回对应伪造改动 |

允许移除我方 UA 中 `Electron/<ver>` 和应用名标记，保留真实 Chromium 版本及平台。不得补齐 `window.chrome`、篡改 `userAgentData` 或伪造 TLS/Canvas/字体等指纹。

该清单不授权任意网页动作。网页写入只能来自结果回传 ADR 的当前作用域、控件核验、草稿与取消规则；该 sender 产生的合成事件不冒充可信用户事件，也不通过伪装消除其可观测性。

## 备选方案

| 方案 | 未采用原因 |
|---|---|
| patch/fork Chromium 或补齐 Chrome 表面 | 增大维护成本并可能制造内部矛盾，违背真实能力边界 |
| 将 UA 改为最新 Chrome | UA 与实际内核时空错配，不可接受 |
| 以“与 Chrome 高度一致”作为验收标准 | 无阈值、不可回归，错误地把真实差异当成缺陷 |
| 使用 CDP 或浏览器驱动控制官网 | 引入明确驱动特征及任意动作表面，超出项目授权 |

## 后果

核验具有可重复、明确的通过/不通过语义；指纹差异留档，不进行伪装修补。平台是否整体限制 Electron，或是否接受合成结果发送，需要分别实测。既有可达性实验不能代替最新官方网页交互验收；未知时暂停并报告，不声称可用。

## 关联

- 身份与构建：`docs/adr/2026-10-02-honest-electron-identity.md`（ADR-0001）
- 限定结果回传：`docs/adr/2026-10-07-automatic-result-return-boundary.md`
- 当前边界：`docs/capabilities/human-machine-boundary.md`
