---
artifact_type: audit
status: archived
created: 2026-10-08
updated: 2026-10-08
scope: "147689e 后新会话首轮自动采集遗漏：官网直接发送、本地发送与历史基线交接"
source_of_truth: code
---

# 首轮自动采集失败分析

## 修复跟进（2026-10-08）

下文故障分析保留为 147689e 的复现记录。修复位于独立工作区的 codex/first-turn-collection 分支，尚未提交；原始主目录未改动。FTA-01、FTA-02、FTA-03 已完成实现及离线验证，FTA-04 界面摘要调整不在本次范围，仍 open。真实官网端到端仍待用户复测。

## Scope

结论：存在两个已复现的采集状态缺陷。用户本次补充的“直接在官网输入框发送首条消息”对应 FTA-01；147689e 新增的本地提交标记根本不覆盖这个入口。另有 FTA-02：从已有会话进入空白首页后，即使本地标记有效，采集器仍可能保留等待历史状态并吞掉首轮。

分析目标：解释“首轮自动采集失败、手动采集无需结束确认即可执行并自动回传、后续轮次正常”。范围包含 watcher、采集器、快照读取、integration、发送入口和相关夹具；不修复实现，不提交或合并，不接触真实账号或向官网发送测试需求。

执行步骤与验收：核对提交及入口 → 用原状态机复现首轮遗漏和冷启动对照 → 用原生 Electron 离线 integration 验证完成快照、工具执行与手动恢复 → 汇总发现与验证边界。

用户现场事实：

- 本次失败使用官网输入框直接发送首条消息。
- AI 已输出正式工具请求，自动继续开启，工具结果显示 0 项和“等待你回答”。
- 手动采集未见“确认已结束”弹窗，立即有工具任务执行，完成后自动提交。
- 后续轮次可自动采集。

未取得本次真实站导航及 DOM 事件时间线。下述故障路径由当前代码及离线实验证实；“本次现场恰好按该时间线发生”属于高置信解释，不能宣称已现场抓到。

## Fact Sources

- 基准：master HEAD `147689ea3017482201abec08d9b1d60388d4c2d9`。
- 代码：`src/main/tools/replyChangeWatcher.ts`、`autoCollector.ts`、`replyObservation.ts`、`integration.ts`、`autoContinuation.ts`；`src/main/index.ts`、`localPromptController.ts`、`webComposerSender.ts`；`src/renderer/toolHarness.js`。
- 测试：`test/replyChangeWatcher.test.ts`、`toolAutoCollector.test.ts`、`replyObservation.test.ts`、`deepseekReplyState.test.ts`、`toolAutoContinueIntegration.test.ts`、`toolIntegration.test.ts`；`tools/verify-web-result-sender.cjs`。
- 文档：能力文档 tool-harness、skills-and-local-prompt、human-machine-boundary；输出驱动采集 ADR；用户点名的 `docs/plans/archived/2026-10-08-first-turn-send-confirm.md`。
- 运行检查：临时 VM 状态机测试；临时扩展的原生 Electron 离线夹具，官方 origin 由独立内存 session 的本地 HTML 响应，不连接官网。
- 仓库 dist 中可以找到 localSubmitAt 和 markLocalSubmit；这不证明截图使用的安装包版本。

## Findings

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| FTA-01 | P1 | verified | 官网直接发送无本地标记，地址先到且生成态不可识别时，首轮被判为历史 | replyChangeWatcher.ts:23、55、65、130、188；integration.ts:285 | docs/plans/archived/2026-10-08-first-turn-collection-lifecycle.md | codex/first-turn-collection / 未提交 | 修复前反例失败；最终单测 677/677、原生夹具 28/28；官网待验 | fixed：实现及离线回归已验证 |
| FTA-02 | P1 | verified | 从已有会话回首页后，preserve 不清理采集器遗留的历史等待状态 | autoCollector.ts:17、19、35；integration.ts:179 | docs/plans/archived/2026-10-08-first-turn-collection-lifecycle.md | codex/first-turn-collection / 未提交 | 修复前反例失败；最终单测 677/677、原生夹具 28/28；官网待验 | fixed：实现及离线回归已验证 |
| FTA-03 | P2 | verified | 既有首轮夹具未覆盖真实空档、官网入口和已有会话状态，且结束控件走简化分支 | verify-web-result-sender.cjs:184、231、238、248、278；replyChangeWatcher.test.ts:218 | docs/plans/archived/2026-10-08-first-turn-collection-lifecycle.md | codex/first-turn-collection / 未提交 | 修复前反例失败；最终单测 677/677、原生夹具 28/28；官网待验 | fixed：实现及离线回归已验证 |
| FTA-04 | P2 | open | 结果回传的 waiting_user 覆盖采集状态摘要，使基线等待表现为“等待你回答” | autoContinuation.ts:62、107；toolHarness.js:211、218 | 无 | master / 147689e | 原生复现同时输出 complete、0 项、waiting_user、已有回复不执行 | 待明确采集与回传状态呈现优先级 |

### FTA-01：本次官网发送入口仍走旧的失败路径

147689e 只在 `integration.sendLocalPrompt()` 调用 `watcher.markLocalSubmit()`。`WebComposerSender` 的输入框断开确认同样仅服务受控发送，不参与用户在官网直接点击发送或回车的动作。

官网真实动作进入 `userAction()`：先把 `localSubmitAt` 清零，识别出发送或回车后只增加 `turn`。`navigation` 的 preserve 判据不看 turn；主进程导航处理还会把它记入 consumedTurn。即使发送动作被正确识别，也不能使首轮交接避开历史分支。

可复现时序：

1. 首页 `/` 已开启自动采集，尚无回复。
2. 用户官网发送；`turn=1`，`localSubmitAt=0`。
3. 地址先切到 `/a/chat/s/new`；回复节点尚未出现，生成按钮无可识别标签。
4. `firstSession=true`，但 marked、新回复节点、generating 三个附加依据都为 false；得到 `preserve=false`。
5. watcher 建立 history，integration 执行 `auto.reset(true)`。
6. 回复开始挂载；没有可识别的生成证据，变化被当作目标历史加载，发出 historyReady，再次重建基线。
7. 完成时 `ReplyMonitor` 返回非空正文及 complete；`AutoCollector.tick()` 却仍处于 baseline 分支，执行 `last=reply.text` 并直接返回，不调用 collect。
8. 后续通知看到 `reply.text===last` 再次返回；同一轮永久遗漏。

生成期间 `ReplyMonitor.read()` 遇到 unknown 不读取当前全文，而是返回缓存正文或空串（replyObservation.ts:102）。因此历史基线可能一直等到 complete 才拿到首条非空正文，恰好把真正要执行的完整首轮吞掉。500ms 历史安静计时只清理网页侧 history，不清理 AutoCollector 的 awaitingHistory，等待更久不会自动恢复这条回复。

这是一条确定的缺陷路径；不能把任何官网首轮都描述为必然失败。若导航检查时新回复已出现，或已识别生成态，原判据仍可能保留首轮。

### FTA-02：preserve=true 仍可能保留错误状态

从已有会话回到空白首页时不符合“首页到真实会话”的谓词，因此 `auto.reset(true)` 合理地进入历史等待。但首页没有历史回复，网页侧 history 在无回复、无可识别生成态时会直接忽略变化，采集器的历史等待未结束。

随后即使本地发送标记正确命中，integration 也只调用：

```ts
continueAt(url: string): void { this.revision++; this.scope = url; }
```

它既不清除 awaitingHistory，也不结束 baseline。实验中首页交接已成功、preserve=true 后，采集器实际状态仍为：

```json
{"awaitingHistory":true,"baseline":true,"last":"","observedGenerating":false}
```

首条 complete 正文因此进入同一基线分支，被保存为 last；第二轮正文不同才执行。单纯扩大标记窗口不能解决此问题。

冷启动空白首页对照可以成功：初始 `reset(false)` 后空快照就能结束 baseline。既有测试总在首页重新建立监听，丢掉了“此前从旧会话导航过来”的关键状态。

### FTA-03：为何多轮修复和测试未发现

- 首轮集成场景通过 `system.sendLocalPrompt()` 发送，默认获得标记，遗漏官网直接发送入口。
- `firstSetup()` 先重新 loadURL 到首页，之后才创建 integration 并启用自动采集；未覆盖“同一个 watcher 从旧会话回到首页”。
- `marked-url-first` 的 pushState 与 mountReply 在同一个同步 click 回调内；主进程随后执行 navigation 脚本时，回复往往已经存在。实验去掉标记、保留同步挂载仍采集成功，说明该用例不能独立证明标记修复有效。延后挂载 250ms 才暴露无标记路径。
- 原有 url-first / fast-url-first 人工生成带“停止生成”文本的按钮，允许生成检测绕过历史等待；该输入没有覆盖用户报告的无标签场景。
- 标记单测仅断言 reset 回调参数为 preserve=true，没有继续断言实际第一批工具执行；因此看不到 FTA-02。
- 集成 fixture 将 `ds-assistant-message-main-content` 放在父 frame，而 markdown 节点只有 `ds-markdown`；完成检测进入一般的“复制文本”分支。真实控件 fixture 使用同一回复节点上的两个类名，走 SVG、朗读和发送箭头的严格分支。已有严格分支单测有价值，但未与首轮导航时序组合。

### FTA-04：截图中的“等待你回答”不是故障定位依据

没有工具 completion 时，AutoContinuation 返回 waiting_user；render 随后以“等待你回答”覆盖摘要及标题。它不能证明模型要求用户回答，也不能证明采集器没收到 DOM 通知。

原生复现同时观察到：

```text
completion=complete
results=0
continuation=waiting_user
message=自动采集已就绪，等待新的 mini-ai-tools 工具回复；已有回复不执行
```

真正的历史基线判断被更泛化的回传状态遮住，增加了排查难度，但不是导致首轮遗漏的执行层根因。

### 手动恢复与后续正常如何解释

手动入口使用 `readAutoReply()`，完成态明确为 complete 时不弹结束确认；它调用 `auto.acknowledge()` 清除 baseline/awaitingHistory，再直接调用 harness.collect，绕过自动采集的“历史文本不执行”分支（integration.ts:300–316）。

工具完成生成新 completion 事件，AutoContinuation 就能照常倒计时发送。本次原生离线复现中，手动恢复得到 `batch=first-native status=done continuation=countdown`。后续轮次没有首页到会话的地址交接，正文又不同于 last，因此自动采集恢复正常。原生实验确认到倒计时；真正官网自动提交由用户现场反馈支持。

用户“无结束确认弹窗”的反馈支持手动采集时完成态已可识别；不能据此完全排除完成控件此前短暂 unknown 或变化通知漏检。不过无需这些附加假设，上述历史状态缺陷已能独立产生整组症状。

## ADR Gate

- Needed: maybe。
- 当前输出驱动 ADR 明确发送识别不授予采集资格。修复应明确区分“判断首页地址交接属于哪一轮”与“授权执行工具”，完成快照、协议、权限、去重不能省略。
- 若扩展发送证据的作用或更改历史隔离策略，需要在后续 dev-plan 中明确与现有 ADR 的一致性；本次不替用户裁决架构方案。
- 工程建议：统一首页交接的生命周期语义，覆盖官网与本地入口，并保证已确认的新轮交接不继承旧历史等待。不要继续只追加某个 UI 信号或扩大 8 秒窗口。
- 不建议把任意会话导航均视为新轮，也不建议全局移除历史基线，这会引入历史工具重放风险。

## Verification

运行的既有测试：

```powershell
node --import tsx --test test/replyChangeWatcher.test.ts test/toolAutoCollector.test.ts test/replyObservation.test.ts test/deepseekReplyState.test.ts test/toolAutoContinueIntegration.test.ts test/toolIntegration.test.ts
```

结果：63/63 通过，0 跳过。只运行相关测试，没有宣称全量通过。

临时审计测试保存在系统 TEMP，未改仓库测试或实现：

```powershell
node --import tsx --test --test-name-pattern='AUDIT:' "$env:TEMP/mini-ide-first-turn-audit.test.ts"
node "$env:TEMP/mini-ide-first-turn-native-audit.cjs"
```

- VM：复用原 watcher 测试夹具，连接原 AutoCollector；3 个审计测试全部通过，包括可信 click、Enter 两个变体。这里的“通过”指成功断言当前缺陷及对照行为，不表示修复完成。
- 原生 Electron：原夹具临时副本扩展两个模式，29/29 通过，0 跳过。使用生产 integration、watcher、monitor、harness，独立临时数据目录，测试后原脚本清理目录。
- 原生无标记模式通过受控 sender 在本地 HTML 触发页面更新，但绕过 sendLocalPrompt，保证不设置标记；它验证无标记后的真实 DOM/IPC/采集链路，不冒充真实可信点击。可信用户事件处理由 VM 两个变体验证。
- 第一次无标记原生实验保留同步挂载，预期“遗漏”的断言失败（实际采集 1 项）。这被保留为时序对照证据；改为地址切换后延迟 250ms 挂载后，稳定观察到 complete、0 项及手动恢复。没有修改业务实现来让断言通过。

| 场景 | 验证结果 |
|---|---|
| 冷启动首页 + 本地标记 + 延迟回复 | 首轮自动执行 |
| 无标记 + 同步切地址/挂载回复 | 本次原生实验首轮自动执行，回复连续性判据可命中 |
| 官网可信 click/Enter + 无标记 + 地址先到 | VM 中首轮被吞，发送动作已识别 |
| 原生无标记 + 地址先到 + 延迟回复 | 完成态 complete，0 项；手动采集 done，进入 countdown |
| 已有会话 → 空首页 → 有效本地标记 → 新会话 | preserve 已命中仍吞首轮，第二轮自动执行 |
| 目标历史分批挂载 | 扩展原生夹具继续通过历史不执行的反例 |

未验证：本次真实官网的导航/DOM 时间线、截图所用安装包、平台是否改变当前控件结构。没有连接真实官网运行自动发送，没有新增日志采集实现。

后续最小验收应覆盖：官网点击与回车、本地发送；直接启动首页与旧会话中新建；回复先到与地址先到；无标签生成；手动恢复；真正打开历史、二次导航和重复批次不重放。标记存在或 preserve=true 不能再单独作为成功标准，必须断言首批实际工具执行且只执行一次。

## Git Visibility

分析阶段仅新增本报告；后续修复在独立 worktree / codex/first-turn-collection 分支进行，主目录用户修改 IDE接入网页版AI.md 保持原样。修复包含两个生产 owner、对应单测和原生夹具、CHANGELOG、能力文档与现有 ADR。计划与本报告均被 Git 显示为未跟踪文件，未被忽略；未提交、合并或 push。

## Closeout

保留 active：FTA-01 至 FTA-03 已通过修复后的回归，状态 verified（仅实现与离线验证）；FTA-04 仍 open，且真实官网复测尚无证据。执行计划已归档到 docs/plans/archived/2026-10-08-first-turn-collection-lifecycle.md。

## 修复验证

- 共享官网 click/Enter 与本地提交记录，首轮地址交接清除遗留历史等待；不伪造生成态，不放宽完成/协议/权限/去重。
- 独立评审发现并修正“用户点击历史，历史节点先于导航检查挂载”的风险；新增冷/热首页反例，非发送真实动作取消整次交接，旧提交与节点兜底均不能恢复。
- 最终 npm test：677/677，通过且无跳过；node tools/verify-web-result-sender.cjs：28/28。与上一节原始分析使用的临时故障复现断言不同，本节测试断言修复后的正确行为。
- npm run build（含 TypeScript）通过；渲染脚本未绑定标识符 0，另有检查器报告的 105 条非阻断语义诊断，未清理。
- dev-flow validate-docs：No issues found；git diff --check 通过。
- 独立评审：subagent，评审最终结论待回填。