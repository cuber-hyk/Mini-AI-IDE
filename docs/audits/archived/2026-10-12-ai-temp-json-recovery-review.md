---
artifact_type: audit
status: archived
created: 2026-10-12
updated: 2026-10-12
scope: AI 临时目录与工具 JSON 局部恢复实施和验收
source_of_truth: [src/main/tools/aiTempDirectory.ts, src/main/tools/jsonDraft.ts, src/main/tools/integration.ts, src/main/tools/resultReturn.ts, src/shared/toolProtocol.ts, test/aiTempDirectory.test.ts, test/aiTempIntegration.test.ts, test/jsonDraft.test.ts, test/toolAutoContinueIntegration.test.ts, tools/verify-chatgpt-tools.cjs]
---

# AI 临时目录与 JSON 草稿恢复审核记录

## Scope

当前任务实现项目内专用临时目录，以及整批未执行的 JSON 语法错误草稿局部修复。用户授权 Codex 接替 IDE 完成后续修复；现有命令运行失败回传、工具权限、持久去重和唯一网页发送 owner 保持。临时文件无自动删除，不创建第二条执行或发送通道。

基线 master/HEAD 为 `073756a849b7485f71f1ddd675d1980dc5305018`，任务分支 `codex/ai-temp-json-recovery`，任务差异仍未提交。原有三份无关审计及用户讨论记录原样保留。正式计划归档于 `docs/plans/archived/2026-10-12-ai-temp-json-recovery.md`，ADR `docs/adr/2026-10-12-ai-temp-json-recovery.md` 为 accepted。

## Fact Sources

- 协议与恢复：toolProtocol 根属性分类，jsonDraft.capture/apply/matchesRecovery，integration.collectReply/verify，harness 与 resultReturn。
- 临时目录：aiTempDirectory.ensure/ownedFile、原工具权限及执行账本；文件系统与权限集成回归。
- 自动继续：原 autoContinuation、错误额度及修复来源回归。
- 独立只读评审：29 专项两次、最终草稿 7 项与根 token 探针、git diff --check；评审未改源码或执行 Git 写操作。
- 真实官网：2026-10-12 用户明确确认 DeepSeek 和 ChatGPT 两平台完成，所有阶段全程自动采集回传，没有手动辅助。Codex 另进行只读磁盘核验。

## Findings

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| ATR-001 | P2 | resolved | 逐级真实路径和归属检查不提供对抗同账户恶意并发替换的文件系统沙箱。 | aiTempDirectory 的 lstat、realpath、wx 写入和复核；AGENTS 的通用本地工具账户边界。 | docs/plans/archived/2026-10-12-ai-temp-json-recovery.md | codex/ai-temp-json-recovery / 073756a（未提交差异） | 常规链接与 junction 拒绝通过；敌对并发保证不属于确认的第一版范围。 | accepted_risk：按已有桌面工具边界保留该声明，不因本任务引入跨进程锁或宣称完整沙箱。 |
| ATR-002 | P2 | verified | 两平台真实常规闭环已由用户确认通过。 | 用户提供 AI 真实回执总结，并明确回答“两平台都已完成”“全程自动成功”。 | docs/plans/archived/2026-10-12-ai-temp-json-recovery.md | codex/ai-temp-json-recovery / 073756a（未提交差异） | 错误 JSON 零执行，真实 ID/版本短补丁恢复，目录复用、文件创建读取，错误及后续结果自动采集回传。 | fixed：关闭本任务现场验收缺口；取消、历史和竞态的证据仍限定离线回归。 |
| ATR-003 | P2 | resolved | 全仓文档六项既有错误、三项既有警告与本任务增量分开管理。 | 正式 CLI 退出码 1，诊断文件均为基线归档或预存讨论文档，本任务无新增诊断。 | docs/plans/archived/2026-10-12-ai-temp-json-recovery.md | codex/ai-temp-json-recovery / 073756a（未提交差异） | 未改动这些文件；本任务 frontmatter、路由和归档引用独立核查。 | wont_fix：不在本任务修改无关材料，不宣称全仓文档校验通过。 |
| ATR-004 | P3 | verified | 临时文件持续保留由用户管理，符合已确认不自动清理的范围。 | aiTempDirectory 无递归删除，复用测试保存已有脚本及用户数据；能力与 ADR 明确责任。 | docs/plans/archived/2026-10-12-ai-temp-json-recovery.md | codex/ai-temp-json-recovery / 073756a（未提交差异） | 保留、复用、未知目录拒绝回归及用户实际 reused=true。 | accepted_risk：不自动过期/清理为确认行为，Git 忽略不等于保密或安全删除。 |
| ATR-005 | P2 | verified | 畸形修复与普通正文的分类问题已改为根对象属性位置识别。 | toolProtocol.hasRootRepairProperty、jsonDraft 与 toolAutoContinueIntegration 回归。 | docs/plans/archived/2026-10-12-ai-temp-json-recovery.md | codex/ai-temp-json-recovery / 073756a（未提交差异） | 三条正式回归先红后绿；漏冒号、裸属性、单引号、转义属性名不建替代草稿，原 ID/版本仍可恢复。 | fixed：替换全正文正则，嵌套正文不丢失恢复资格。 |
| ATR-006 | P3 | verified | 根字符串值的未转义 repair_draft 曾被误判，已严格限制属性位置。 | 私有扫描和 jsonDraft 根值回归；独立评审最新磁盘复核。 | docs/plans/archived/2026-10-12-ai-temp-json-recovery.md | codex/ai-temp-json-recovery / 073756a（未提交差异） | 新案例先红后绿，最终 7 专项及三条根 token 探针通过。 | fixed：只在根起始或逗号后的 token 判断属性，不补全或执行非法 JSON。 |

## Verification

### 初审与修复证据

IDE 初始自报全量 949 项，Codex 独立复跑确认 949 pass、0 fail/cancelled/skipped，类型与构建通过。额外分类探针复现 ATR-005：缺冒号的 `{"repair_draft" {...}}` 被建立成新草稿，普通工具正文中的未转义 `"repair_draft":` 字样反而失去草稿资格。两条预期断言失败，日志 `C:/WINDOWS/TEMP/mini-ai-temp-review-probes.log`。

正式补入两条解析分类及一条保留原草稿的集成回归，首次 15 pass / 3 fail，修复后通过；独立评审补充裸属性、单引号及根值位置案例，同样先复现再修复。词法扫描只做分类，完整 JSON 解析、协议、路径、权限、执行和去重仍走原链路，不猜测任意破损文本的意图。

### 最终离线验证

- `pnpm test`：958 pass、0 fail、0 cancelled、0 skipped，30 suites，退出码 0。日志 `C:/WINDOWS/TEMP/mini-ai-temp-takeover-all-final.log`。
- `pnpm run build` 和 `pnpm run typecheck`：退出码 0；复制 212 文件、未绑定标识符 0，115 条非阻断参考诊断。日志 `mini-ai-temp-takeover-build-final.log`、`mini-ai-temp-takeover-type-final.log` 位于系统 TEMP。
- 正式回归包含 40 请求、超过 80000 字符的 JSON 通过小于 200 字符补丁恢复；修复前零执行、恢复后一次完整回传、重复补丁拒绝。
- 版本递增及关开 automatic 不重置五次错误额度，第六次暂停；关闭期间出现补丁不补执行，平台/会话/reset 和取消使旧草稿失效。
- `pnpm exec electron tools/verify-chatgpt-tools.cjs`：11 项通过、退出码 0。真实 Chromium 本地 DOM 采集错误与补丁，实际创建临时目录和文件，由 WebComposerSender 回传；复制同字节，重复补丁不重放。只使用本地模拟地址，不连接源站或读取凭据。日志 `C:/WINDOWS/TEMP/mini-ai-temp-takeover-native-final.log`。
- 原生夹具扩展首跑因脚本重复声明局部变量失败，不计为通过；改用局部作用域并确保失败标志产生非零退出，重跑通过。生产网页运输未改。
- 独立只读评审最新结论：无剩余代码阻断。亲自执行 29 专项（两次）、最终 7 草稿测试与根 token 探针；全量/构建/原生为主代理实际日志，不冒称评审者复跑。
- `git diff --check` 通过。security-review 输入与权限核验无新增 eval、网页桥、任意 IPC、凭据读取或业务网络；Design gate 无 UI 变更，不适用。

### 真实官网与磁盘证据

固定测试 JSON 结尾为 `],}`，含 get_ai_temp_dir 与 get_project_info 两请求。用户提供的回执总结确认 batch_error failed 且 tool_results 空；随后用真实草稿 ID、版本 1，以 `],}` → `]}` 短补丁恢复，两请求 done，同 task_id 第二次路径一致、reused=true，再创建和读取 recovery-ok 文本。

用户随后明确确认：该验收已在 DeepSeek、ChatGPT 两平台分别完成；错误诊断、恢复结果和后续结果均全程自动采集并回传，无手动点击采集或发送。此现场证据为用户确认，非 Codex 直接操作网页或完整抓取对话。

Codex 另只读核对 `C:/Users/胡运宽/Desktop/IDE_test/.mini-ai-ide/ai-temp/e2e-json-recovery-20261012/`：归属标记 task_id 正确，recovery-ok.txt 存在、11 字节、原始内容恰为 recovery-ok。回执中的 `1: recovery-ok\n` 是 read_file 带行号呈现。没有写入测试项目文件。

真实验收范围为本任务常规闭环；取消、历史、版本过期和异步来源变化等边界证据来自离线回归，不扩展为所有官网页面、敌对文件系统并发或每种失败场景均现场验证。

### 文档检查边界

配置的 `C:/Users/胡运宽/plugins/dev-flow/bin/dev-flow.js validate-docs .` 保留六项基线错误、三项警告，退出码 1。错误为预存讨论文档 frontmatter、两份归档计划 created 字段、三份既有归档审计 unresolved 标记；警告为既有文件图标和品牌计划。未修改这些材料，不把本任务归档等同全仓检查通过。

## ADR Gate

已确认路线经实施、独立评审和两平台用户验收，专门 ADR 为 accepted。当前能力、CHANGELOG 和上下文路由同步；不向默认上下文添加本审计或归档计划。

## Git Visibility

任务分支 codex/ai-temp-json-recovery，HEAD 073756a849b7485f71f1ddd675d1980dc5305018，没有新增提交。任务差异为 13 个已跟踪修改及 8 个新增文件，原有四份无关材料单独保留。完整状态和差异在最终审批前输出；新增文件不能仅依赖 git diff 查看：

- src/main/tools/aiTempDirectory.ts、src/main/tools/jsonDraft.ts。
- test/aiTempDirectory.test.ts、test/aiTempIntegration.test.ts、test/jsonDraft.test.ts。
- 本归档审计、归档实施计划及 accepted ADR。

重点审核入口：根 token 分类、草稿版本/唯一匹配/来源对象、integration 恢复前后核验、临时目录真实路径及归属、原权限/去重、结果回传和新增回归/原生夹具。记录归档不授予提交、合并、删分支、push 或发布权限。

## Closeout

2026-10-13 最终组合复核：全量 975 项、原生离线恢复 11 项均通过；构建与类型检查通过，独立评审及专项 31 项通过。此前文档基线问题已由另行授权的 docs 整理修正，本轮正式 validate-docs 为 No issues found；不改写前次检查的历史事实，也不补称本轮重新进行了官网验收。相关整理与验证记录见 `docs/plans/archived/2026-10-13-uncommitted-work-closeout.md`。

实施、离线验证、独立评审及用户两平台常规验收结束；发现已修复验证，或按确认范围关闭为已声明限制。审计与计划 archived、ADR accepted。Git 操作仍等待用户单独批准。
