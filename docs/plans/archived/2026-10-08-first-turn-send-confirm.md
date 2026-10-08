---
artifact_type: plan
status: archived
created: 2026-10-08
updated: 2026-10-08
owner: 胡运宽
design_system_impact: none
---

# 首轮发送「发送后未确认网页接收」确认信号修复

v0.2.1 已修正首发地址 `/a/chat/s/<ID>` 的 `/s/` 匹配（消除「网页会话已变化」误取消），但新会话首轮本地需求发送仍报「发送后未确认网页接收，已停止且不会重试」。真实现象：点击发送后地址正常变为 `/a/chat/s/<ID>`，消息已受理、会话已建立，但确认环节超时。

## 根因

`src/main/webComposerSender.ts` 内嵌 `sendScript` 点击后只用两个信号确认「网页已接收」，二者在真实首轮都观测不到：

1. `input.isConnected && input.value === ''`：真实首轮从首页 `/` 同文档切到 `/a/chat/s/<ID>` 会卸载首页 composer、挂载聊天 composer，脚本持有的旧 textarea 被断开（`isConnected === false`），该信号永假。
2. `stateOfPage() === 'generating'`：依赖 `/停止生成|stop generating|…/` 可读标签或 `aria-busy`/`data-is-streaming`。真实 DOM 快照 `docs/控件结构.md` 中按钮均为无文本、`aria`/`title` 为 null 的 `<div>` 图标按钮，该关键词与属性 0 命中，生成态检测在真实站失效。

离线夹具 `tools/verify-web-result-sender.cjs` 默认 click 处理器是「原地 `input.value=''` + pushState」，从未模拟首轮 composer 重挂载导致 textarea 断开，因此首轮测试通过、真实站失败。

## 修复方案（最小改动）

在点击后的成功信号中补第三项：**点击后旧输入框已断开（`!input.isConnected`）即视为消息已受理**。真实首轮 composer 重挂载必然断开旧 textarea，该信号可靠；点击前导航仍被 `state.clicked` 前置条件拒绝，二次会话迁移仍被 `boundScope === scope` 只交接一次约束拒绝，不改变既有取消语义。

```ts
if (state.clicked) {
  if ((input.isConnected && input.value === '') || !input.isConnected || stateOfPage() === 'generating') return finish({ ok: true, session: boundScope });
  if (Date.now() - clickedAt >= 3000) return finish({ ok: false, error: '发送后未确认网页接收，已停止且不会重试', uncertain: true });
}
```

## 步骤

1. 改 `webComposerSender.ts` 确认信号，新增 `!input.isConnected` 分支。
2. 离线夹具补「点击后重挂载 composer 断开旧输入框」的首轮场景，证明修复有效。
3. 复核既有首轮夹具（地址先到/回执先到/二次迁移/点击前拒绝/工具结果不继承例外）不回归。
4. 全量测试与构建；真实官网首轮仍需现场复测，不假称现场通过。

## 验收

- 新增夹具断言「点击后 composer 重挂载」首轮发送 `ok === true` 且 session 为 `/a/chat/s/allocated`。
- 既有 `webResultSender.test.ts`、`firstPromptSession.test.ts`、`replyChangeWatcher.test.ts` 与 `tools/verify-web-result-sender.cjs` 全量通过。
- 构建/typecheck 通过；不改 UA、网络出口、写入 owner 边界。

## 第二轮：发送确认修复后，真实首轮仍不采集（用户现场反馈）

用户本地夹具 26 项全过（含重挂载用例），真实官网现象变为「需求已发送到官网」但 AI 的 `load_skill` 回复完成后工具结果 0 项——发送确认已修复，**采集侧**仍有缺口。

### 根因

首轮真实时序是「地址分配先于正文挂载，且生成控件无可读标签」：

1. 点击发送 → DeepSeek 先 `pushState` 到 `/a/chat/s/<ID>`（乐观建会话），此刻回复正文尚未挂载、生成态检测不出 → `replyWatchScript('navigation')` 的 `preserve` 判据（`已有新回复 || generating()`）两个都为假 → 误判为「打开历史会话」→ `auto.reset(awaitHistory=true)` 重建基线。
2. 回复随后出现并完成 → `historyReady` 再次 `reset(true)`；`AutoCollector.tick()` 基线分支把首轮完整文本记入 `last` 并返回。
3. 完成 `complete` 时 `reply.text === last` → 永不采集。

离线夹具未暴露：`url-first` 模式的停止按钮带「停止生成」可读文本（真实站没有），靠 `observeGeneration` 绕过基线；`reply-first` 模式回复先于地址挂载，`preserve` 原判据直接命中。真实站两条路都断。

### 修复（本地提交短期标记）

- `replyWatchScript` 新增 `local-submit` action：脚本 state 记 `localSubmitAt`；`navigation` 判定改为 `firstSession && (标记 8 秒窗口内 || 已有新回复 || generating)`，消费即清；任何 `isTrusted` 用户动作立即清标记（标记只覆盖无用户干预的一次交接），主进程 `ReplyChangeWatcher.markLocalSubmit()` 注入。
- `integration.sendLocalPrompt` 发送前打标记（失败退回既有判据）。自动结果回传（results）不经过此路径，语义不变。
- 夹具新增 `marked-url-first` 模式：地址先分配、无停止按钮、回复直接完成挂载 → 仍自动执行首轮；单测补「标记保留新轮 / 消费后二次交接重建历史 / 用户动作清标记」。

ADR gate：属现有首轮发送确认与内容观察规则实现，沿用 `docs/adr/2026-10-08-output-driven-collection.md` 与 `docs/adr/2026-10-08-skills-and-local-demand-send.md`，不新增架构决策。

## 实施结果与验证

- 改动：`webComposerSender.ts` 确认信号补 `!input.isConnected`；`replyChangeWatcher.ts` 增 `local-submit` 标记与 `markLocalSubmit()`；`integration.ts` 发送前打标记；夹具补「composer 重挂载」与 `marked-url-first` 两个首轮场景；单测补标记三态。
- 验证：typecheck 通过；受影响单测（webResultSender / firstPromptSession / replyChangeWatcher / toolIntegration / localPromptController / toolAutoContinueIntegration）共 54 项全过；全量 668 项 663 过，5 项失败均为 toolProcesses / toolExecutionIntegration / toolSamples 的负载时序 flaky（单独重跑 63/63 全过，与改动前同模式、零交集）；原生离线夹具在沙箱因 electron.exe 被占用（EBUSY）无法运行，新增用例由用户本地跑 `node tools/verify-web-result-sender.cjs` 验证。
- 真实官网首轮端到端（本地发送 → 自动采集执行 → 结果回传）仍待用户现场复测，未假称现场通过。Git 提交/合并已获用户明确批准；push 另待批准。
