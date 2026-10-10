---
artifact_type: audit
status: archived
created: 2026-10-10
updated: 2026-10-10
scope: "自动继续开启后的暂停、等待人工与发送前取消路径"
source_of_truth: code
---

# 自动继续中断情况排查

## Scope

核查自动继续开启后所有暂停、等待人工及发送前取消路径，区分可安全回传的已完成结果与必须保留的人机/状态边界。

## Fact Sources

- Code: `src/main/tools/processes.ts`, `src/main/tools/harness.ts`, `src/main/tools/autoContinuation.ts`
- Tests: `test/autoContinuation.test.ts`, `test/toolResultReturn.test.ts`, `test/toolResultClipboard.test.ts`, `test/toolExecutionIntegration.test.ts`
- Docs: `docs/capabilities/human-machine-boundary.md`, `docs/adr/2026-10-07-automatic-result-return-boundary.md`
- Runtime checks: Windows 真实 PowerShell 超时、逐条中断、权限拒绝和取消整批已通过 integration 验证；官网 sender 使用受控替身；用户已确认三项真实官网测试通过。

## Findings

Allowed finding statuses:

- `open`: confirmed or strong finding that still needs routing or work.
- `planned`: finding is assigned to a plan and owned by follow-up work.
- `resolved`: finding has been handled; record the closeout reason such as `fixed`, `accepted_risk`, `wont_fix`, or `not_reproducible`.
- `verified`: fix or disposition has been verified and the finding is closed.

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| AUD-1 | P2 | verified | 超时命令会被 Harness 正确归类为 `failed`，但其进程回执同时保留 `data.status: 'stopped'`。`AutoContinuation.blocked()` 不区分超时停止与用户中断，看到 run_command 的 stopped 回执就立即暂停，因此完成事件不会进入倒计时发送。 | `processes.ts` 超时后调用 `stop(p)`，而 `stop()` 成功后设置 `p.status = 'stopped'`；`harness.ts` 仅在 `!timed_out` 时标成 `cancelled`，超时则标为 `failed`；`autoContinuation.ts` 的 `blocked()` 对 `data.status === 'stopped'` 无条件阻断。截图显示失败、退出码 1、已超时，与该路径一致。 | `docs/plans/archived/2026-10-10-auto-continuation-stops.md` | `task/20261010-auto-continuation-stops` | 36 项终态/回传/复制测试及 7 项真实进程 integration 测试通过，均无跳过；用户已在修复版完成三项官网实测并确认通过。 | 已修复并通过类型检查、构建及代码路径审查。 |
| AUD-2 | P2 | verified | 单条 run_command 被用户停止时，Harness 将结果标为 `cancelled`，自动继续无条件暂停；结果回传资格又只接受 done/failed，停止产生的部分输出无法回传。 | `harness.ts` 根据 `data.status === 'stopped' && !timed_out` 标记 cancelled；`autoContinuation.ts` 屏蔽 cancelled/stopped；`resultReturn.ts` 拒绝 cancelled/stopped。整批取消另由 `completion.cancelled` 表示。 | `docs/plans/archived/2026-10-10-auto-continuation-stops.md` | `task/20261010-auto-continuation-stops` | 36 项终态/回传/复制测试及 7 项真实进程 integration 测试通过，均无跳过；用户已在修复版完成三项官网实测并确认通过。 | 已修复并通过类型检查、构建及代码路径审查。 |
| AUD-3 | P2 | verified | 权限拒绝回执即使批次已完整结束，也会被自动继续直接暂停；全批拒绝还会因没有 started_at 被当作无执行而等待用户。拒绝信息可安全回传，后续请求仍经过原权限检查。 | `harness.ts` 生成 `permission_denied` 且不启动工具；`autoContinuation.ts` 无条件阻断 permission_denied，并要求至少一项 started_at 的 done/failed；`resultReturn.ts` 只允许 done/failed/skipped_dependency。 | `docs/plans/archived/2026-10-10-auto-continuation-stops.md` | `task/20261010-auto-continuation-stops` | 36 项终态/回传/复制测试及 7 项真实进程 integration 测试通过，均无跳过；用户已在修复版完成三项官网实测并确认通过。 | 已修复并通过类型检查、构建及代码路径审查。 |

## 暂停与等待情况判断

| 情况 | 排查时行为 | 判断：是否应自动继续 | 理由 |
|---|---|---|---|
| 命令超时，`timed_out: true` 且进程树清理结束 | 命令结果为 `failed`，但 `data.status: 'stopped'` 触发统一阻断；自动复制与附件手动回传资格也同样把 stopped 视为阻断 | **应继续回传** | 超时已作为真实失败记录，包含实际输出与退出信息；不是用户中断。超时只应阻断到进程清理结束。AUD-1。 |
| 用户点击“中断”停止单条命令，进程树清理已结束 | 前台命令结果通常为 cancelled；后台命令可能保持结果状态但数据为 stopped，都会暂停 | **可考虑继续回传** | 停止单条命令不等于取消整批自动继续；实际部分输出及 stopped 事实可明确回传给 AI，原权限门槛仍会约束后续请求。需要把“单命令停止”和“取消整批”区分开。 |
| 用户取消整批、项目/会话切换造成取消 | completion.cancelled 或旧来源失效，取消旧发送 | **保留取消** | 防止将用户明确撤销、旧项目或旧会话的结果发送出去。 |
| 权限拒绝（包括全批均被拒绝或批次内有其他已执行结果） | 只要包含 permission_denied 就暂停；全批拒绝也因无 started_at 不发送 | **可考虑继续发送拒绝回执** | 回传“未执行/拒绝”不会放宽工具权限，能让 AI 知道拒绝原因并改提方案；但这会改变现行“拒绝后等待用户”产品规则，需用户明确决定。 |
| 状态 unknown / 执行状态无法持久保存 / 重启后状态未知 | 自动继续暂停，不发送 | **保留暂停** | 无法证明请求是否产生副作用或结果是否完整，自动发送可能伪报执行结论；不能因可复制状态元数据而继续。 |
| 命令仍运行、清理未完成或仍待权限 | 处于 waiting_tools，不开始发送倒计时 | **保留等待** | 结果还不完整，后台树可能仍运行。 |
| AI 仍生成、回复中断等待续写、结束状态 unknown | 自动采集等待生成结束/继续生成/人工确认；不会产生可发送完成事件 | **保留等待** | 尚无可信完整工具批次；不能把半成品发回。 |
| 纯对话、没有新完成事件、没有实际执行的普通批次、历史/重复状态 | waiting_user，不重放发送 | **保留等待** | 没有当前新执行结果可供自动回传。 |
| 倒计时期间本批正文/批次或项目会话改变，或用户已发起新一轮 | 取消旧待发送结果 | **保留取消** | 避免发送过期结果或发到后续对话。 |
| 官网已有草稿、官网仍生成/等待续写、会话或批次复核不匹配、控件未知/不唯一、附件状态不确定 | sender 发送前拒绝，进入暂停 | **保留暂停** | 自动覆盖草稿、发送到错误回复或上传不确定附件都不安全；用户仍可自行复制/处理。 |
| 官网点击后的发送回执无法确认，或一次发送失败 | 暂停且不重试 | **保留暂停** | 可能已经提交；重试可能造成重复回复或重复上传。明确确认未点击的前置错误也统一消耗本次发送尝试，当前没有安全重试状态。 |
| 连续 5 次批次格式/执行前校验错误 | 第 6 次起暂停 | **保留暂停** | 这是防止错误回执无限循环的既定熔断上限，不是普通工具执行失败。 |
| 普通实际执行失败（例如非零退出码、未超时的 failed 结果），且有 started_at | 现有逻辑允许进入自动回传 | **继续回传** | 已有真实失败输出，适合发给 AI 修正；无需额外中断。 |

超时结果还存在旁路影响：`ResultClipboard.complete()` 和 `ToolResultReturn.eligible()` 也无条件阻断进程 `status: 'stopped'`，因此超时命令的自动复制和含附件手动回传也会被挡住。此处与 AUD-1 是同一判别错误，不另立发现。

## ADR Gate

- Needed: no
- Reason: 不需要改变结果回传边界；超时本身已被执行层定义为真实失败输出，修正门禁应按既有语义处理。

## Verification

- Commands run: `pnpm typecheck`、`pnpm build`、`git diff --check`；并静态核对停止、权限拒绝、取消及进程清理状态。
- 实测来源：用户从 auto-continuation-pauses worktree 启动修复版，确认超时、逐条停止、权限拒绝三项测试通过。此前失败截图对应桌面原 UI 分支进程，该目录当时未包含修复。自动化官网发送使用替身，真实官网结论来自用户实测。

## Git Visibility

- 需通过 `git status --short --branch --untracked-files=all` 确认本审计文件可见。

## Closeout

AUD-1、AUD-2 和 AUD-3 已修复，通过 43 项针对性自动化测试，包括 Windows 真实命令进程与结果回传联动。文档记录自动化验证范围，用户已确认修复分支的三项官网实测通过并授权提交合并。能力事实已写入对应 capability，计划与本审计保留归档。
