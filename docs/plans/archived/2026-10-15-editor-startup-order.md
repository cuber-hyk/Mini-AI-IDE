---
artifact_type: plan
status: archived
created: 2026-10-15
updated: 2026-10-15
owner: agent
plan_readiness: ready
source_audit: docs/audits/2026-10-13-performance-exploratory-audit.md
covered_findings: [PERF-04]
deferred_findings: [PERF-03, PERF-07, PERF-08, PERF-09]
---

# 编辑器首屏初始化顺序

## Goal

在所有必要IPC、工具恢复与工作区恢复就绪后优先加载编辑器，让本地辅助页面的加载与重试不再阻塞首次可编辑，并以隔离原生启动验证顺序、可用性和耗时。

## Scope

只处理PERF-04：index.ts的启动接线、辅助页面加载和早期关闭/打开提示词的时序保护；复用既有startup-only探针，补原生顺序与故障验证。不改变官网加载/采集/发送、权限、工具账本格式、构建入口、文件树安全检查或布局设计。既有未跟踪原型和AI临时目录不纳入任务。

## Plan Readiness And Decisions

- 用户已在当前性能清单后授权“好, 开始吧”，本轮按上一条推荐的编辑器首屏初始化推进；不包含提交、合并或推送授权。
- 保留工具恢复及IPC注册在编辑器之前，保留根目录恢复在编辑器之前。源码确认工具恢复在空账本基线约5ms，不为推迟它新增未就绪工具代理或权限状态。
- 编辑器先加载；提示词设置、网页工具栏、变更预览继续顺序加载及既有4次/递增间隔重试。未知加载失败明确失败，不静默丢辅助功能，不无保护并行创建页面。
- 用户在辅助加载期间打开提示词，等待同一受控加载完成；关闭、退出撤回迟到显示。窗口关闭/未保存保护在编辑器可交互之前注册，不让提早可编辑带来无保护窗口。
- 不确定性：原生夹具收益不等于安装版冷/热启动收益；工具历史较大时的恢复耗时不在本轮改变。实际Monaco初始化时间单独测量，不把窗口创建或DOM加载当作首次可编辑。
- ADR gate: not needed，既有owner内调整初始化顺序，权限、存储与用户操作入口不变。Design system impact: none。

## Code Placement（dev-split）

local cleanup / no split：index.ts是已有bootstrap组合入口，本轮移动现有加载与关闭接线，并仅增加提示词加载就绪保护；不因文件长而机械拆分，不新增通用启动管理器、utils或权限代理。原生验证归tools/verify-startup-sequence.cjs，既有启动探针归workspaceProbe.ts。若实现需要新的状态owner、共享能力代理或协议改动，先停止扩展并重评。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| ES-1 | done | 取得当前基线并核对立即调用的IPC | 三次独立离线启动；真实Monaco mark、必要IPC及原startup-only各9项通过；基线夹具宽console规则误判单独保留 |
| ES-2 | done | 调整加载顺序与早期操作保护 | 编辑器先于辅助页面；工具/IPC/根目录先就绪；关闭守卫提前，提示词等待排定加载，末尾补布局；失效目录提示核对启动revision |
| ES-3 | done | 原生回归及前后对比 | 新原生10场景76项通过；三组前后同口径计时完成；正常模式草稿、提示词撤销、目录竞态及辅助初态通过 |
| ES-4 | done | 全量验证及独立评审 | 类型/构建/1161单测/159自检/119工作区通过，独立代码与夹具评审通过；原有缩放布局5/10未通过，master同条件对照相同，用户知悉并接受该既有验证限制，未将失败改为通过 |
| ES-5 | done | 文档、审计与验收 | 文档及证据已更新，validate-docs通过；用户明确验收通过，计划归档，Git仍未授权 |

## Acceptance Criteria

- 编辑器页面在辅助页之前启动并能实际打开、编辑文件；不凭loaded或创建窗口推断可编辑。
- 不引入缺失IPC、早期请求访问未初始化状态、迟到面板抢焦点或关闭期间丢草稿。
- 辅助页面仍必需且有重试与明确失败；官网与自动继续资格、源文档校验、权限行为不变。
- 同条件独立profile的测量报告原始样本及中位数，描述范围和负载，不承诺安装版体感比例。

## Verification Record

- 起点master/1a165c5；无已跟踪未提交改动，保留既有两个未跟踪路径。
- 现有startup-only基线首轮9/9通过：bootstrap至editor-load-start约1263ms，editor-loaded约2439ms；渲染器自身导航至Monaco就绪约1151ms。提示词约659ms、工具就绪约664ms、webbar约934ms、preview约1259ms。该样本不等于安装版启动指标，后续补同口径重复样本。
- 同一离线原生夹具、串行独立临时profile，各三次。测试装载入口到真实Monaco mark回执（ms）：基线2817.0 / 2512.3 / 2451.1，中位2512.3；调整后1704.8 / 1596.5 / 1453.8，中位1596.5，提前约915.8ms。渲染器自身导航到该mark（ms）：基线1044.1 / 1033.7 / 1065.2，中位1044.1；调整后1167.0 / 1234.3 / 1063.5，中位1167.0。收益来自提前开始编辑器加载，不能声称Monaco本身变快、安装版冷/热启动提速或P95提升。
- 原始报告：`C:/WINDOWS/TEMP/mini-editor-startup-baseline.json`、`C:/WINDOWS/TEMP/mini-editor-startup-after.json`。三次基线既有startup-only均9/9且exit0；初版夹具将既有vendor/editorWorkerHost的`Uncaught [object Event]`计为失败，因此wrapper的pass为false，原始数据不改写。最终夹具保留console观测，只精确允许该既有vendor worker事件；其余缺失IPC、Unhandled与Uncaught应用错误均失败，没有宣称无console错误。两个基线还观测到快速项目切换期间已有skills:list失效提示，不把它算为本轮启动回归。
- 类型检查、构建与渲染脚本作用域检查通过；全量1161项通过，0失败/取消/跳过。独立只读评审发现的辅助布局初态、失败强退、旧目录提示竞态均已处理，production最终复核无阻断项。

- 最终专项原生：`node tools/verify-startup-sequence.cjs`，10场景76/76、exit0；报告`C:/WINDOWS/TEMP/mini-editor-startup-sequence.json`。辅助延迟、单次重试、4次失败（探针非零/正常模式保存保护）、提示词早开早关、真实打开并编辑、旧目录通知竞态、顶栏恢复与预览宽度初态均通过。夹具超时仅终止自有进程树并校验临时资料范围后清理。
- 正式入口自检159/159、exit0；完整工作区功能119/119。完整工作区附带布局仅5/10，因第3/4/5/7/9（从0计数）场景CSS视口停留1066×538而原生尺寸已增大，整体命令exit1；不能声称完整工作区/缩放全部通过。master原入口源码临时编译、复用其余相同dist产物，同正式命令方式对照也是119/119、布局同5/10，失败场景及视口完全相同。没有改动断言、放宽等待或把该失败标为成功；对照用临时编译入口已删除。
- 隐藏启动方式曾使双方工作区118/119（设置失焦）与布局5/10；改为正式`pnpm exec electron ... --workspace-probe`后双方设置失焦通过，但缩放检查仍失败。因此确认非本轮新增差异，尚不能断言缩放失败的根因仅为隐藏窗口。保留报告：`C:/WINDOWS/TEMP/mini-editor-startup-workspace-visible.out.log`与`C:/WINDOWS/TEMP/mini-editor-startup-workspace-baseline-visible.out.log`。
- Design system gate: not needed，未改样式、布局规则或复用组件。ADR gate: not needed，owner与权限不变。Changelog/Distill已更新当前事实，Check无问题；完整原生布局验证门仍未通过，暂不进入提交批准阶段。

## Artifact Routing And Closeout

能力更新docs/capabilities/app-shell.md；现有性能审计只推进PERF-04，不关闭其他未优化项；CHANGELOG记录实际行为变化。测试优先表达依赖和故障边界。完成并验收后归档到docs/plans/archived/；本任务不自动提交、合并、清理分支或推送。

用户验收（2026-10-15）：用户在完整结果及缩放5/10限制告知后回复“通过, 可以继续后续优化”，本项按已有专项证据验收并归档；用户接受的是本轮优化及验证限制，缩放问题未修复且不改写测试事实，不据此扩大为提交/合并授权。
