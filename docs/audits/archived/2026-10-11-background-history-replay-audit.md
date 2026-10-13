---
artifact_type: audit
status: archived
created: 2026-10-11
updated: 2026-10-12
scope: "窗口被遮挡时的工具可靠性，以及回看对话引发历史采集、执行与诊断回传"
source_of_truth: code
---

# 后台节流与历史重放排查

## Scope

用户确认“隐藏”指切换到其他窗口、IDE 被遮挡；同时报告回看对话时部分命令似乎再次执行，并引起 AI 继续输出。目标是核实这两种现象是否有实现层面的可能，区分本地命令、网页采集、解析诊断与结果发送。截图中的“通道正常、payload 太大/截断”仅作为症状，不作为根因证据。

本轮是排查，不修改应用实现、不操作正在使用的官网会话、不发送官网消息、不提交 Git。新增隔离离线复现脚本与本报告。未确认回看具体是同会话向上滚动还是打开其他历史会话，因此分别检查同 URL 的 DOM 重挂载与导航历史基线；不假定官网滚动一定会卸载消息。

## Fact Sources

- Code: `src/main/index.ts:173`、`src/main/tools/autoCollector.ts:45`、`src/main/tools/replyObservation.ts:12`、`src/main/replyCollector.ts`、`src/main/tools/replyChangeWatcher.ts:83`、`src/main/tools/harness.ts:133`、`src/main/tools/store.ts:84`、`src/main/tools/autoContinuation.ts`、`src/main/tools/integration.ts:281`、`src/main/webComposerSender.ts:157`、`src/main/tools/processes.ts:96`。
- Tests: `test/toolAutoCollector.test.ts`、`test/replyObservation.test.ts`、`test/replyChangeWatcher.test.ts`、`test/toolHarness.test.ts`、`test/toolStore.test.ts`、`test/autoContinuation.test.ts`、`test/webResultSender.test.ts`、`test/toolIntegration.test.ts`。
- Docs: `docs/capabilities/tool-harness.md`、`docs/capabilities/human-machine-boundary.md`、`docs/adr/2026-10-08-output-driven-collection.md`。该 ADR 已承认 500ms 历史安静窗口之后的分批加载存在不可辨识风险。直接相关的 `2026-10-11-json-truncation-audit.md` 用于区分既有字符上限与本次后台假设。
- Runtime checks: `tools/audit-background-history.cjs`，真实 Electron BaseWindow + WebContentsView、隔离临时 userData 和工具账本、真实 PowerShell，无 CDP/浏览器驱动/官网连接。仅夹具构造和切换本地 DOM；产品采集器与发送 owner 使用现有实现。诊断回传采用记录发送的替身，执行真实 integration 的采集、诊断、资格和来源复核；未实际发送到官网。
- External primary source: [Electron WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences)、[WebContents backgroundThrottling](https://www.electronjs.org/docs/latest/api/web-contents/#contentssetbackgroundthrottlingallowed)：后台节流影响定时器、动画与 Page Visibility。
- Existing runtime evidence: 当前生产 tools.json 只读查看到 624 个批次；保存批次/作用域哈希/请求状态，不保存命令、输出或当时窗口可见性。仓库 collection-trace.log 最后写入为 2026-10-09，不能据此解释本次现场事件。

## Findings

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| BH-1 | P1 | verified | 同会话的历史 DOM 重新成为最后一条回复时，会被当作新完成输出；未入账历史批次可实际启动命令。 | replyObservation.ts:12-20 选择 DOM 最后 markdown；autoCollector.ts:59-66 只比较上次文本，complete 时不要求新消息身份；replyChangeWatcher.ts:83-107 在导航历史等待结束后将相关 DOM 改变通知采集。 | docs/plans/archived/2026-10-11-background-history-repair.md | codex/chatgpt-web-platform（包含已同步的后台修复） | 真实离线历史及节点复用回归通过；927 项最终全量测试通过，0 跳过 | fixed：已确认实现路径修复并验证；官网现场及不可辨识顺序历史保留限制，见修复验收 |
| BH-2 | P2 | verified | 旧的残缺 JSON 在其他回复之后重新出现，会获得新的诊断 ID 并再次自动回传，足以使原本结束的对话重新生成。 | harness.ts:139 仅对当前 diagnostic.sourceText 去重；142-145 清空后递增诊断 ID；AutoContinuation 按来源 ID 去重；integration.ts:281-289 的当前原文复核无法区分已重挂载的历史。 | docs/plans/archived/2026-10-11-background-history-repair.md | codex/chatgpt-web-platform（包含已同步的后台修复） | 真实离线历史及节点复用回归通过；927 项最终全量测试通过，0 跳过 | fixed：已确认实现路径修复并验证；官网现场及不可辨识顺序历史保留限制，见修复验收 |
| BH-3 | P2 | verified | 官网视图使用默认后台节流，窗口完全被遮挡也会影响网页定时器/画面帧；采集通知及发送短时限因此存在延迟和失败风险。 | index.ts:173-181 未设置 backgroundThrottling；replyChangeWatcher.ts:100 使用网页 150ms 通知计时器；webComposerSender.ts:172-189 网页 25ms 检查、3 秒就绪/回执时限，主进程另有 7500ms 时限。 | docs/plans/archived/2026-10-11-background-history-repair.md | codex/chatgpt-web-platform（包含已同步的后台修复） | 真实前台/遮挡/隐藏/最小化四场景通过；计时器、rAF、发送和命令均正常 | fixed：已确认实现路径修复并验证；官网现场及不可辨识顺序历史保留限制，见修复验收 |

## Runtime Evidence

最终一轮原生探针结果如下。网页定时器目标间隔为 25ms，统计窗口约 2.2 秒；命令为真实 `Start-Sleep -Milliseconds 500; Write-Output audit-command-ok`，耗时包含 PowerShell 启动。前台通过显式显示 View、置前和焦点确认，遮挡由另一原生窗口完全覆盖；同时记录原生窗口状态与网页 visibility，不能只按场景名字推断可见性。

| 场景 | 网页 visibility | 定时器次数 / 最大间隔 | 画面帧次数 | 命令状态 / 耗时 | 普通计时器夹具发送耗时 |
|---|---|---|---|---|---|
| 展开并置前 | visible | 89 / 27ms | 360 | done / 1076ms | 95ms，成功 |
| 展开但被完全遮挡 | hidden | 2 / 1005ms | 0 | done / 954ms | 1164ms，成功 |
| hide | hidden | 2 / 1004ms | 0 | done / 1022ms | 2574ms，成功 |
| 最小化 | hidden | 2 / 1010ms | 0 | done / 936ms | 1471ms，成功 |
| 仅夹具关闭后台节流 | visible | 89 / 27ms | 356 | done / 913ms | 80ms，成功 |

另将夹具发送按钮的 input 后就绪更新安排在 requestAnimationFrame：前台 54ms 成功，完全遮挡时 3299ms 返回“网页发送按钮未就绪，请手动发送”。这验证现有发送器与后台停帧组合的失败路径；它不是 DeepSeek 使用 rAF 更新按钮的现场证明。关闭后台节流只用于夹具对照，未修改产品配置，也没有据此决定产品应采用该选项。

历史复现的三次采集：`older-unreserved → another-unreserved → older-unreserved`。前两次实际进入命令执行器；第三次显示“已采集，未重复执行”。因此应区分未入账历史请求被首次执行、已入账请求只恢复展示，以及历史解析错误被再次回传三种现象，不能统称为账本失效。

## ADR Gate

- Needed: 本轮 no；后续修复 maybe。
- Reason: 本轮仅调查。历史来源身份识别需要符合既有“新输出可独立采集、不依赖发送回执”的决策；不得简单要求每轮都看到发送动作或生成态，导致快速完成的新输出被吞。若选择改变后台运行策略，应明确其对资源消耗和 Page Visibility 的影响，再评估是否需要 ADR。

## Verification

- Commands run: `node tools/audit-background-history.cjs` 最终完整一轮退出码 0，9 个场景；`node --import tsx --test test/toolAutoCollector.test.ts test/replyObservation.test.ts test/replyChangeWatcher.test.ts test/toolHarness.test.ts test/toolStore.test.ts test/autoContinuation.test.ts test/webResultSender.test.ts test/toolIntegration.test.ts`：137 项通过，0 失败、0 取消、0 跳过。
- 脚本使用临时目录，Electron 退出后核对目录父路径并清理；生产 tools.json、用户项目与官网会话未修改。脚本导出为单独 cjs，不参与产品构建。
- 验证边界：证据覆盖本文已确认的实现路径，不推断用户原始命令、当时官网 DOM、安装版对应关系、多显示器或长时间系统休眠的现场归因。原始 payload/截断归因由活动的 JSON 截断审计 JT-5 保留；短探针不能估计实际错误率。
- 未发现窗口遮挡直接截断 PowerShell 命令或输出的代码路径；本地命令由主进程 spawn、读取 stdout/stderr 和设置超时。既有字符/命令长度上限参见 JSON 截断审计，不能混同为后台节流。

## Git Visibility

新增本报告和 `tools/audit-background-history.cjs` 后检查文件存在以及 `git status --short --branch --untracked-files=all` 可见性。当前工作区另有正在进行的未提交实现与文档改动，本轮未修改这些文件。

## Closeout

BH-1/BH-2/BH-3 已修复且回归验证，当前能力和来源限制已写入对应 capability/ADR，本报告归档。未被识别的现场 payload 归因继续由 `docs/audits/2026-10-11-json-truncation-audit.md` 的 JT-5 管理，不转成已确认的后台截断根因，也不新增长度上限或官网 API 任务。

## 修复验收

最终合并验收：最新 ChatGPT DOM 适配后的全量 920 项通过，0 失败、0 跳过；原工作区同步后构建及 100 项定向测试通过，独立适配复核无新增阻断。Dev Flow 文档验证仍报 5 项既有归档错误，同步前基线同样存在，本轮无新增错误；不将该文档门禁记为通过。源码已同步并构建，未重启用户程序、未提交或发布。

2026-10-11，用户确认开始修复。replySource 在隔离世界提供历史指纹、消息尾部顺序、完成快照节点身份与代次封存；旧正文、整段重挂载、同节点复用、合并期间生成见证串用、idle 接纳后的异步变更及导航均有定向回归。来源更新随合并通知与完成快照运行，历史节点不反复计算全文指纹。两平台原生 backgroundThrottling:false 不改写网页 getter 或身份；后台资源代价写入 app-shell 能力文档。

修复后 `tools/audit-background-history.cjs` 的历史场景：回看已见/未挂载/已执行历史，历史采集数 0、历史命令启动数 0，两个合法新增命令实际执行；旧 JSON 错误首次回传 1 次，经过普通回复再追加与重挂载均无第二次回传。脚本中的节流场景保留默认策略作为故障对照，不能误读为产品修复配置。产品配置由 `tools/verify-web-background.cjs` 独立读取并验收，前台/完全遮挡/隐藏/最小化均保持计时器与 rAF，受控发送与真实命令均完成。ChatGPT 两轮真实离线工具闭环和 DeepSeek 原生发送/附件夹具通过；官网未自动发消息或操作用户会话。

独立只读评审发现的同节点覆盖、idle 漏封存与快照确认竞争均已修正，最终无阻断问题。只读 DOM 下从未挂载的历史后段若完全以新输出同样的顺序追加，仍不可完全区分；此限制沿用输出驱动 ADR，不声称所有官网历史加载行为都已解决。
