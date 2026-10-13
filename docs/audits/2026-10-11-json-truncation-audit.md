---
artifact_type: audit
status: active
created: 2026-10-11
updated: 2026-10-11
scope: "规则 JSON 截断的可能来源：回复采集、工具协议、命令与文件输出、结果回传"
source_of_truth: code
---

# 规则 JSON 截断来源排查

## Scope

用户提供 AI 解释“规则太长导致 JSON 截断，改用纯文本规则文件”，并确认此前命令已经执行并返回结果。核查哪些环节真的裁剪内容、哪些只是报错或转换结构。未提供现场命令、stdout/stderr、truncated 字段或原规则文件，因此不认定某个机制就是本次根因。本轮不改实现或既有任务文件。

## Fact Sources

- Code: `src/main/replyCollector.ts`, `src/shared/toolProtocol.ts`, `src/shared/toolJsonDiagnostic.ts`, `src/main/tools/files.ts`, `src/main/tools/processes.ts`, `src/main/tools/resultClipboard.ts`, `src/main/webComposerSender.ts`, `src/renderer/toolResultPresentation.js`。
- Tests: `test/toolFiles.test.ts`, `test/toolProcesses.test.ts`, `test/toolProtocol.test.ts`, `test/replyCollector.test.ts`, `test/toolJsonDiagnostic.test.ts`, `test/webResultSender.test.ts`。
- Docs: `docs/capabilities/return-path-and-format-contract.md`、`docs/capabilities/tool-harness.md`。
- Runtime checks: 临时合法长 JSON 文件经过真实 ToolFiles.read_file；本机 Windows PowerShell 5.1 默认/显式深度序列化对比；Node spawnSync 超长 PowerShell 命令。
- External primary sources: [ConvertTo-Json](https://learn.microsoft.com/zh-cn/powershell/module/microsoft.powershell.utility/convertto-json)、[CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)、[cmd.exe 长度限制](https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation)。

## Findings

下列是已验证机制与现场待核实项，不把设计上限直接判为缺陷。

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| JT-1 | P2 | verified | read_file 单次最多 50,000 字符，含行号与换行；超长单行会从中间裁断。原文件完整，但 AI 可见的文件 JSON 内容可能不完整，外层 tool_results 仍合法。 | files.ts:7, 126-137；长行返回 truncated:true、next_start_line 为当前行，note 提示改用命令查询剩余字符 | none | 只读排查 | 60,012 字符合法单行 JSON 实际返回 50,000 字符，去除行号后 JSON.parse 报未闭合字符串；原文件与结果外层均可解析 | 现有限制已核实，不据此要求修改；不是现场根因确认 |
| JT-2 | P2 | verified | 命令 stdout/stderr 合计最多保留 1,000,000 UTF-16 字符；超过后丢弃后段，分页只能访问已保留部分。另有交替输出块 65,536 的元数据限制，也可能提前裁剪；均设置 truncated:true。 | processes.ts:8, 67-79, 84-95；toolProcesses.test.ts 长输出测试 | none | 只读排查 | 已有实测测试验证总量 1,010,000、保留 1,000,000、truncated:true；元数据限制静态核对 | 已核实约束，是否触发现场待确认 |
| JT-3 | P2 | verified | 命令内部的 ConvertTo-Json 默认深度 2 会丢失深层对象结构，JSON 语法仍可合法；这是序列化深度限制，不是字符数量裁剪。 | 微软官方文档；本机 powershell.exe 5.1.26100.9444 | none | 只读排查 | 深层 hashtable 默认转成 System.Collections.Hashtable 字符串，显式 -Depth 10 保留 leaf | 已核实机制，现场是否用了该命令未知 |
| JT-4 | P3 | verified | 工具参数字符串超过 200,000 字符会整批拒绝；超长 Windows 内联命令可能无法启动。两者均不是静默裁剪。 | toolProtocol.ts:41, 98-110；processes.ts:107-111；微软 CreateProcess 文档 | none | 只读排查 | 60,000 级规则内容请求解析成功；200,001 字符 content 返回参数错误；33,000 字符内联命令 spawnSync 返回 ENAMETOOLONG，无执行结果 | 已区分拒绝/启动失败与输出截断 |
| JT-5 | P2 | open | 用户现场的具体截断来源尚未确认；AI 自述不足以证明原因，执行过命令也不代表命令成功或其产物完整。 | 只有 AI 原话及“命令已执行并返回结果”，缺少上一条回执与产物 | none | 只读排查 | 暂未复现用户原始命令 | 需要原命令、stdout/stderr、truncated/retained_chars/total_chars 与原文件完整性才能归因；无代码修复计划 |

## 排除与边界

- 回复采集读取当前代码 DOM 的完整 textContent；未发现固定字符长度裁剪。正式工具 JSON 由 JSON.parse 整体解析，残缺或非法请求不执行；没有按 JSON 嵌套层级裁剪工具协议的逻辑。官网是否只渲染部分内容未现场检查。
- 复制与回传通过 JSON.stringify 包装完整现有结果；界面 120 字符摘要不影响详情、复制或回传。发送器遇 textarea.maxLength 超限明确暂停，并复核输入值仍与 payload 相等，没有主动取前 N 字符发送的逻辑。
- read_file 的 16 MiB 文件限制是明确拒绝，不是裁剪；搜索字符/条数上限也会标记 truncated。
- stdout/stderr 在停止或超时时可能只包含进程终止前真实输出；命令本身的分页、显示格式化、错误转义、提前退出也可能产生片段。没有现场原文，不能按其中一种归因。
- 改用一级|二级|关键词的规则文件可减少嵌套和转义，但仍受字符上限影响，不能代替根因核验；mini-ai-tools 执行协议仍为 JSON。

## ADR Gate

- Needed: no
- Reason: 仅验证现有行为，无产品或架构决策；不改变上限或输出格式。

## Verification

- Commands run: 六份相关测试文件共 68 项通过、0 失败、0 跳过；临时长 JSON / PowerShell 深度 / 超长命令探针；静态追踪采集、解析、复制与发送调用关系。
- Not verified: 用户原始命令与规则文件、官网实际 DOM 和平台输出限制、交替输出块上限的专门运行时复现。未修改实现。

## Git Visibility

创建后通过 git status --short --branch --untracked-files=all 确认本文件可见。既有未提交的手动中断修复及 timeout 审计保持原样。

## Closeout

保持 active：JT-5 的现场归因仍待原始结果核验。本报告不自动产生修改上限或替换规则格式的任务。
