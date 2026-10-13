---
artifact_type: audit
status: archived
created: 2026-10-02
updated: 2026-10-12
owner: 胡运宽
scope: P3（回程解析器、格式模板、应用计算、目录记忆、行号片段替换、只读采集与应用/撤销）
source_of_truth: ["docs/adr/2026-10-02-return-path-contract-and-trust-boundary.md","docs/capabilities/return-path-and-format-contract.md","src/shared/returnPath.ts","src/shared/formatSpec.ts","src/main/replyCollector.ts","src/main/returnPathService.ts"]
---

# P3 核验报告（回程链路）

本报告保留 2026-10-02 旧回程协议的历史证据。2026-10-12 核对确认旧四策略及旧文件操作协议不再是当前执行路线，P3-5 按旧方案退出关闭；不补称旧版本四策略已通过真实页面验收。当前正式工具协议与采集边界见 capabilities/return-path-and-format-contract.md 和 tool-harness.md。

## 范围说明

P3 分两段，**两段均已实现**：

| 段 | 内容 | 验证方式 |
|---|---|---|
| **① 纯逻辑** | 回程解析器、格式模板、应用计算、目录记忆、行号片段替换 | 离线充分验证（单测 + 自检） |
| **② 采集与应用** | 只读采集回复、解析预览、应用、撤销 | 合成页面运行器 + 样例目录闭环；旧版真实页面验收未取得；P3-5 按旧方案退出关闭 |

## 原阶段核验结果（2026-10-02）

| 项 | 结果 |
|---|---|
| 类型检查 | `tsc --noEmit` 通过 |
| 单元测试 | **104/104 PASS**（回程解析 50 项） |
| 启动自检 | **58/58 PASS**（F 解析/模板、G/H 目录记忆、I prompt 组装、J 行号与三向校验、K 采集与应用撤销闭环） |

## 已实现

1. **回程解析器**（`src/shared/returnPath.ts`）：围栏切分、三类路径线索、行区间指令、
   路径注释剥离、语言归一化、行号片段格式化/还原、三种应用模式的计算（含三向校验）。
2. **格式模板与 prompt 组装**（`src/shared/formatSpec.ts`）：短版/完整版；需求 + 工作环境 +
   目录树 + 要改的文件 + 格式要求的组装（自检 F3/I1–I4 保证模板与解析器一致）。
3. **只读采集**（`src/main/replyCollector.ts`）：4 套候选策略 + 失败时的页面结构诊断。
4. **应用与撤销**（`src/main/returnPathService.ts`）：三向校验、写回、内存撤销快照。
5. **目录记忆**（`src/main/settings.ts`）：上次打开的目录与分栏宽度，失效时清空并通知。

## 发现项

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| P3-1 | **High** | verified | 解析器早期把"标题块"判定为空：`"a\n\n".split("\n")` 会产生**两个**尾随空串，而代码只跳过一个，导致 `### src/b.ts` 这类最常见形态**完全失效**，静默退化为"唯一候选"或 unresolved | 测试 "(b) 围栏上方标题提供路径" 期望 `preceding-heading` 实得 `unique-mention`；逐步追踪脚本显示 `lines=["### src/b.ts","",""]`、`block=[]` | docs/plans/archived/2026-10-02-mini-ai-ide-poc.md（P3） | — | 改为跳过**所有**尾随空行后，该测试通过；37 项解析测试全绿 | 已修复。这是"看起来能跑、实际对最常见输入失效"的一类，靠人工试不会发现 |
| P3-2 | Medium | verified | 路径清洗把**下划线**当强调符删掉，`train_caption.py` 被读成 `traincaption.py` —— 而 Windows 代码库中带下划线的文件名极常见 | 测试 "识别「文件名：」式指引" 实得 `traincaption.py` | docs/plans/archived/2026-10-02-mini-ai-ide-poc.md（P3） | — | 只清理 `*` 与反引号，保留下划线；测试通过 | 已修复 |
| P3-3 | Medium | verified | 标题识别过宽/过窄的两次纠偏：① 曾把"请把 `src/c.ts` 改成："这类**正文句子**误判为标题行，抢占了"唯一候选"线索；② 收紧后又把 `**path**` 这类**整行强调**形态漏掉 | 测试 "(c) 全文唯一候选路径被采用" 曾得 `preceding-heading`；"(b)" 与 "识别加粗路径" 相继失败 | docs/plans/archived/2026-10-02-mini-ai-ide-poc.md（P3） | — | 现规则：仅当整行具备标题形态（Markdown 标题/列表项/带标签/整行强调）时才视为标题行；正文句交给"唯一候选"线索 | 已修复并固化为测试用例 |
| P3-4 | Low | verified | "插入到光标处"的换行规则存在歧义（VS Code 的粘贴是逐字插入，不补换行；但代码块补换行更可读） | 测试对 `'abc'` + 光标 3 的期望先写错，经复核后确定规则 | docs/plans/archived/2026-10-02-mini-ai-ide-poc.md（P3） | — | 规则明确并写入代码注释：光标左侧非行首/换行则补前导换行，右侧有内容且非换行则补尾随换行；两种情形各有测试 | 已澄清。因默认路径是 **diff 预览**，用户落盘前能看到确切结果 |
| P3-5 | **High** | resolved | 旧四候选采集策略缺真实页面验收 | 旧合成运行器记录；当前 replyCollector.ts:189 采用最新回复三策略；正式执行由 replyObservation.ts 完成快照、协议、权限与去重链路核验 | docs/plans/archived/2026-10-12-ai-temp-json-recovery.md | 当前工作树 / 基线 073756a | 当前采集/来源回归通过；用户已确认 DeepSeek、ChatGPT 两平台工具闭环全程自动成功；该证据不证明旧四策略通过 | wont_fix：已退出的旧四策略/文件操作协议不再追加验收；当前执行路线独立验证 |
| P3-6 | Medium | verified | 片段替换的校验基线**必须由读文件的一方提供**。早期设计让渲染进程转手代码与区间，则"复制时的原文"无处可取，三向校验形同虚设 | 实现时发现 `applyChange` 若只接收 `code/range`，主进程无法知道"用户当初复制的是哪几行" | docs/plans/archived/2026-10-02-mini-ai-ide-poc.md（P3 第二阶段） | — | 改为：`collectReply` 在主进程缓存解析结果（`collectionId` → 代码块），渲染进程只传 `collectionId + index + filePath`；片段替换时主进程**在读文件的同一时刻**抓取该区间内容作为基线 | 已修复。附带收益：渲染进程不再经手大块代码文本，权限面更小 |
| P3-7 | Medium | verified | 采集失败时若只报"没采到"，无法区分"选择器过期"与"页面确实没输出"，只能靠猜 | 目标站点结构会变，而我们**不能改页面**去适配 | docs/plans/archived/2026-10-02-mini-ai-ide-poc.md（P3 第二阶段） | — | 新增 `DIAGNOSTIC_SCRIPT`：只读探测页面标题、可见文本长度、是否含围栏、各候选选择器命中数，并给出判断结论 | 已实现并接入预览面板 |
| P3-8 | Low | verified | "应用全部"与"逐条确认"的取舍：批量落盘更省事，但违背"默认预览、逐条确认" | 设计权衡 | docs/plans/archived/2026-10-02-mini-ai-ide-poc.md（P3 第二阶段） | — | 「应用全部」保留按钮但**明确提示需逐条确认**，不做批量静默落盘 | 已按 ADR-0004 方案 A 处置 |

## 结论

1. **P3 两段均已实现**：纯逻辑（解析/模板/应用计算/目录记忆/行号片段）+ 采集与应用
   （只读采集/预览/应用/撤销）。验证：单测 **104/104**、自检 **58/58**。
2. **三个"对最常见输入静默失效"的缺陷（P3-1/2/3）** 证明单测的价值高于人工试用 ——
   人工试用很可能恰好碰到带注释的代码块而"看起来正常"。
3. **P3-6 是本轮最重要的一条**：三向校验的基线必须由**读文件的一方**在同一时刻抓取，
   否则"防行号漂移"只是纸面承诺。这条直接决定了主进程/渲染进程的职责划分。
4. P3-5 按旧方案退出关闭；原始验收缺口保留为历史事实，当前路线有独立采集与闭环证据。
5. 目录记忆（用户要求）已完成并纳入自检，且**自检会复原用户设置**。

## Closeout（2026-10-12）

旧四策略和文件操作协议的验收建议不再作为当前待办。当前正式执行仅接受 mini-ai-tools，拒绝旧文件操作文本；采集还原与完成状态/来源资格分别核验，不能因采到文本就执行。后续变更查看已采用 Diff，与本报告旧摘要预览不同。

核对当前代码、capability 和两平台官网自动闭环用户反馈；聚焦测试 156 项通过、0 失败/取消/跳过，含 replyCollector、replySource、watcher、autoCollector 和布局/状态测试。未重跑 2026-10-02 旧方案，也未编造旧策略识别率。全部发现已 verified 或带关闭原因的 resolved，本报告归档。
