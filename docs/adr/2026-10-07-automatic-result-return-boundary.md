---
artifact_type: adr
status: accepted
created: 2026-10-07
updated: 2026-10-09
owner: 胡运宽
source_of_truth: [src/main/tools/autoContinuation.ts, src/main/tools/webResultSender.ts, src/main/tools/integration.ts, src/main/tools/autoCollector.ts, src/shared/toolProtocol.ts, src/main/tools/store.ts, test/autoContinuation.test.ts, test/webResultSender.test.ts, tools/verify-web-result-sender.cjs]
---

# ADR：自动继续与限定工具结果回传边界

## Context

用户明确授权：开启自动继续后，IDE 可将全部正式工具真正执行结束的当前批次结果填入官方网页输入框并发送，以减少每轮手动搬运工具结果。首条需求与自由输入仍由用户完成。该授权改变网页交互 policy，但不扩大网页的本地权限、工具授权范围、网络出口或身份伪装边界。

当前批次可能含多文件修改、查询、执行失败和后台命令。仅靠界面显示“已返回”无法证明整批结束；重复状态、历史恢复与会话切换也不能产生新发送。发送动作一旦提交便难以撤回，因此必须使用完成事件及作用域核验，并停止不确定重试。

## Decision

1. 沿用持久化 `automatic` 单开关，默认关闭，统一控制变化触发采集、权限执行与本批结果回传，不引入轮数参数。发送间隔 `sendIntervalSeconds` 是 0–300 的整数秒，默认 3。
2. `AutoContinuation` 拥有状态、计时和完成事件去重。当前项目/会话/批次的新完成事件须至少含一个实际启动、具有 `started_at` 的 done/failed 结果；后台命令及树清理均结束后才发送。等待权限不开始计时；实际失败输出可回传供 AI 修复。拒绝、取消/中断、unknown、无执行、无效 JSON、纯对话、历史或重复状态不发送。
3. 采集独立于发送确认：历史基线后的新完成输出经协议、权限与去重核验后执行，不以发送动作或回执授予资格。关闭再开启不能复活已取消发送。关闭先取消倒计时和待发送，不等待配置写盘、不中断当前本地工具。用户新轮、项目/会话切换与导航取消旧结果。integration 发送前复核最新回复已完成、批次匹配、结果正文和完成事件属于当前作用域。见输出驱动采集 ADR。
4. `WebResultSender` 是工具结果门面，唯一网页写运输 owner 为 `WebComposerSender`，独立隔离世界 1005，仅支持官方 `https://chat.deepseek.com` 的当前会话。可见 textarea 与已知发送 SVG 必须唯一且有不含回复正文的局部共同容器；输入可编辑、页面空闲及草稿为空才允许填入。控件未知、已有草稿或状态证据不足时暂停。
5. 当前批附件授权与自动/手动一次运输依据 `2026-10-09-tool-attachment-return.md`；正文直接使用与手动复制同源的本批真实结果，通过 textarea 原生 value setter、input 事件及原生 click 提交一次。不读系统剪贴板，不写 HTML，不保存或上传用户草稿；仅判断空输入或输入仍等于本程序刚填入的结果。
6. 点击前取消或失败只清理本程序仍拥有的文本；用户改写后不清理。点击后无法确认、超时或异常不重试，也不清理可能已提交的内容。清理状态无法确认时阻止后续自动发送，提示用户处理。
7. 回程仍由只读隔离世界 1004 的变化监听、动作识别及同步快照负责。DOM 新完成输出驱动采集，合成发送不冒充真实用户动作；真实动作只用于取消旧结果发送，自由输入和继续生成按钮由用户操作。
8. 网页主世界不得获得 IPC、文件桥或本地工具接口。保留工具权限、正式协议、去重和草稿守卫；不代理 AI HTTP、不读凭据、不暴露 CDP、不引入浏览器驱动、不伪造身份或指纹，不使用 OS 键盘注入或任意网页自动化。

## Alternatives Considered

| 方案 | 取舍 |
|---|---|
| 每轮由用户复制、粘贴和发送结果 | 保留用户逐轮干预机会，但连续工具协作增加重复搬运成本；手动入口仍可在关闭或暂停时使用 |
| 从系统剪贴板取文本模拟粘贴 | 全局内容可能被其他应用改写，难以证明属于当前批次；采用内部真实结果同源格式直接回传 |
| 通用网页自动化或浏览器驱动 | 扩大网页动作、身份与本地能力表面，超出本次授权；采用唯一官网 sender 和严格控件证明 |
| 发送异常时自动重试 | 无法区分未提交与已提交但未确认，会重复产生 AI 新轮；采用失败暂停、用户处理 |
| 多开关、轮数和最大轮数调度 | 当前授权是统一自动继续，无需维护多套循环入口；采用同一个 automatic 与发送间隔 |

## Consequences

用户可从一次需求开始，让正式工具与结果回传连续协作，仍由既有权限决定哪些工具可以执行。调度采用确定性代码，完成事件及当前作用域是唯一发送来源，界面广播与历史不能重放。

限定回传会产生合成 input/click；环境身份核验不能证明这些动作被平台接受，程序也不能伪装成真实用户事件。控件变动、草稿竞争和不确定提交会暂停自动继续，可能需要用户手动发送。没有新的网络 API、任意动作桥或自动格式修复入口。

## Verification Boundary

`test/autoContinuation.test.ts` 与 `test/webResultSender.test.ts` 覆盖调度与 sender 规则；`tools/verify-web-result-sender.cjs` 是本地 Electron 夹具验收入口。真实官方网页尚未验收，不能将本地成功等同官网可用。

身份与自动化驱动特征判据仍见 ADR-0003；通用工具权限与执行 policy 见 `docs/adr/2026-10-06-native-tool-harness-boundary.md`，当前能力事实见 `docs/capabilities/human-machine-boundary.md`。
