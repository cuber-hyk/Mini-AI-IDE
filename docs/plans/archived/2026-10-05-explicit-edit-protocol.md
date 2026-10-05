---
artifact_type: plan
status: archived
created: 2026-10-05
updated: 2026-10-05
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 明确操作与精确文本替换协议

## Goal

AI 不再计算或回传用于定位的行号；IDE 根据明确的文件、操作和原内容定位，提供准确的预览、受保护的写入与撤销，同时统一更新全部提示词与复制入口。

## Scope

- In scope：替换／新建／覆盖全文三种操作；逐块元数据采集；精确匹配与操作校验；同文件多片段；冻结预览基线；复制原文；两版内置提示词及自定义提示词提醒；列表和 Monaco 预览；现有 IPC、测试、验收脚本与当前文档同步。
- Out of scope：模糊匹配、忽略缩进、正则替换、批量替换全部匹配、片段 ID、AST 编辑、Patch 格式、自动修复模型回复、自动执行命令、网页写入、自动发送、跨文件事务与 Git 提交／合并。
- 已按用户后续明确授权实施：前序分支提交 a988f07 并合并本地 master，删除旧分支后建立 codex/explicit-edit-protocol；本任务未提交、未合并、未推送。用户配置与官方网页不改写。

## Plan Readiness

- Goal clear：从 AI 提供行号改为 IDE 根据原文定位。
- Scope clear：保留三列、逐条／全部应用、预览与撤销，统一修改相关协议链路。
- Source of truth known：shared/returnPath、shared/snippet、shared/formatSpec、ReturnPathService、FileService、主进程 IPC 与现有本地预览组件。
- Critical decisions confirmed：用户同意精确 SEARCH／REPLACE、明确新建与覆盖全文、行号仅由 IDE 显示；全局指令要求替换旧实现而非保留双轨。
- Validation path known：纯解析／计算测试、服务临时目录测试、提示词示例实执行及离线 Electron 窗口探针。
- persistent_plan：yes，跨模块且改变用户输出协议；design_system_impact：update，复用原有组件，只更新操作文案和计算范围显示。

## Assumptions And Decisions

### 已确认产品规则

| Decision | Chosen route | Confirmed by | ADR gate |
|---|---|---|---|
| 局部定位 | 非空原文唯一精确匹配后替换，新内容可任意增减行 | 本轮用户确认 | needed：跨模块定位与应用规则 |
| 新建 | 明确操作“新建”，提供全文，目标已存在则拒绝 | 本轮用户确认 | 同一协议决策 |
| 整文件修改 | 明确操作“覆盖全文”，提供全文，目标不存在则拒绝 | 本轮用户确认 | 同一协议决策 |
| 行号 | AI 不提供定位行号，IDE 计算预览范围 | 本轮用户确认 | 同一协议决策 |
| 旧行号协议 | 取消落盘支持，只识别为需补充新格式的错误线索；不自动猜操作 | 已确认统一格式及仓库 Single Implementation First | 同一协议决策 |
| 自定义提示词 | 保留用户原文、分版本草稿及恢复默认流程；不自动改写 | 现有 SettingsStore 明确约定 | not needed：保持已有效规则 |

### 工程约束与事实

- 文件路径仍须明确，只采用本块标注／紧邻元数据，不由当前文件、正文、其他块或最后复制选区回填。操作必须明确，不能因磁盘存在状态自动推断。
- 换行仅按 CRLF／LF／CR 统一为逻辑 LF 做定位计算；保留缩进、Tab、空格、首尾空行和文本。禁止 trim、去行号前缀或忽略空白来增加匹配率；写盘保留已有文件的换行风格，混合换行文件保留未修改部分的原始字符。
- IDE 显示行号用于查看，不重新作为输入指令。操作块的路径与操作冲突、范围旧格式混入、非法语法均给出可见诊断，不能降级写盘。
- 替换只能精确定位原内容，无法验证修改本身是否符合需求；覆盖全文只能检查采集／预览后文件未变化，无法证明 AI 依据的旧上下文仍有效，必须完整展示 diff。
- 采集会重建网页代码框围栏，因此无法仅凭重建围栏证明全文没有被 AI 截断。提示词要求完整输出，保留失败诊断；不宣称能自动识别所有省略／截断。
- 现有单测基线 329/329、workspace 81/81、inline 47/47。整体自检现有 Y6／I1 两项失败；本任务涉及提示词协议，实施时需更新对应断言并核验，不能删除或跳过。文档校验现有 14 errors／13 warnings，应逐条比较增量，不借任务扩大清理范围。

## 协议与解析契约

### 唯一推荐输出

每个操作块用紧邻头部 `### 文件：相对路径`、`### 操作：替换|新建|覆盖全文` 和成对围栏；围栏至少四个反引号，内容含更长反引号时加长。语言只用于显示。新建及覆盖全文围栏内是完整文件文本，替换围栏内使用下列结构：

> `````text
> ### 文件：src/example.ts
> ### 操作：替换
> ````typescript
> <<<<<<< SEARCH
> export function greet() {
>   return "hello";
> }
> =======
> export function greet() {
>   return "你好";
> }
> >>>>>>> REPLACE
> ````
> `````

- SEARCH、分隔线、REPLACE 为独立标记行，按结构移除它们的换行，不移除正文换行；空 REPLACE 表示删除，空 SEARCH 拒绝。一个操作块可含多个完整替换对，作为一次可撤销的操作；各对均须在同一原文中唯一匹配且不重叠。
- 同文件多个围栏仍是多个可逐条应用的操作，顺序与回复一致。首次统一定位检查重叠；不得让前一个 REPLACE 生成的代码成为后一个 SEARCH 的隐含目标。重叠操作、同文件新建重复、覆盖全文与其他操作并存，阻塞该文件的冲突操作；其他文件有效操作保持可用。
- 新建或覆盖全文可以提供空文本；必须实际存在一个完整围栏，不能把缺失内容当空文件。替换正文中存在与协议相同的独立标记行而无法无歧义解析时，报告标记冲突，提示该文件使用明确的覆盖全文，不猜测分隔位置。
- 只有操作“替换”才解释正文中的 SEARCH／REPLACE；新建／覆盖全文正文按字面保存，不能把文件本身含有的协议示例当成第二层修改。采集器保留具有明确操作的空代码框，以区别空文件与根本没有内容块；上下文标注与修改操作混用时诊断冲突。
- SEARCH 缺失或匹配为 0 次提示原文不匹配；匹配多次提示补充上下文；缺少操作、未知操作、路径／操作冲突、残缺替换对或未闭合文本围栏，保留原文并阻塞。不要将此类块收进普通只读内容。
- 没有文件修改线索的命令、流程图、普通代码示例继续进入默认折叠的“其他内容（只读）”；有文件／操作／SEARCH／旧范围修改线索但信息不足时显示待补充。操作“新建”的 bash 文件是正常文件，不能按语言排除。
- 原内容标记不会进入文件，路径注释不能从 SEARCH／REPLACE 正文剥除，语言猜测不能改变正文。

### 复制上下文

- 复制选区与整文件均声明 `### 上下文文件：相对路径` 和 `### 上下文：原文片段|完整原文`，不包含操作指令和定位范围；解析器明确将此类内容作为只读上下文。
- “复制整个文件”只提供上下文，不代表请求覆盖全文；AI 根据用户需求选择已确认的三种输出操作。
- 精确保留 Monaco 选中文本或整文件文本，不删除尾部空白／末尾换行，不加 `N|` 等行号前缀；可保留本地复制反馈中的行数，但不得要求模型回传。
- 选区重复或过短时先让匹配规则给出具体诊断，用户补选上下文后复制；不自动扩大用户选区或写入网页。

## 预览、应用与状态

- 采集／预览时由服务准备 before、after、操作类型、实际字符区间／行范围及目标存在状态，保存根目录版本、规范化路径和文件原文基线；渲染层只选择操作，不能传入替换内容或计算写盘坐标。
- 列表、Monaco 和写入使用同一准备结果：替换显示实际原范围→新范围与增减，跨行及行内替换均准确；删除显示删除区域，新建显示全文增加，覆盖全文展示完整 diff 和“覆盖全文”操作文案。元数据字符数／代码行数只计写入内容，不把 SEARCH 及分隔标记计为新增代码。
- 应用前重新读取文件，与已展示基线比较，仍检查 dirty 文件、目录版本、改名／删除失效和路径白名单；不能从当前文件重新生成所谓原基线让检查失效。外部变化、同名创建或文件消失均拒绝，要求重新核对预览。
- IDE 自己成功应用后以已知 after 更新该文件基线，重新准备剩余操作并广播实际范围／适用性；全文未等于已知 after 或剩余 SEARCH 不再唯一时停止继续写入。撤销成功同样更新已知基线并重算，错误与警告继续可见；不重新执行已经应用的操作。
- 全部应用沿用顺序执行；同一操作块内多个替换对先全部校验再一次写盘。单条失败不影响独立文件，存在相同目标冲突时不尝试部分冲突写入；汇总成功与失败，不承诺跨文件原子事务。
- 新建复用排他创建与缺失父目录处理；替换／覆盖只更新已有文件。已有文件写入增加“预期原文”参数校验，缩短检查与写入间隔；不得宣称能锁住任意外部程序的并发写入。
- 撤销保留原 before／after、创建对象身份与空目录保护；每个操作块一次撤销，同文件多个操作按既有顺序撤销，保留其他文件标签与草稿。全部删除内容、最后一行、无末尾换行、新内容包含代码围栏均必须准确。

## 提示词同步与用户迁移

- SHORT 与 FULL 共用同一协议骨架；简洁版必须覆盖三种操作的最小正例、唯一匹配和保留原文规则，完整版补充重复原文、插入、删除、同文件多处、多文件、嵌套围栏、纯文本、`.env`、无扩展名、只读命令与格式错误示例。
- 删除所有“照抄范围”“原末行”“新建也需范围”“缺范围回填”等旧规则；明确 SEARCH 必须逐字来自提供的原文，不能改写、加行号、用省略号代替，不存在匹配时请补充上下文。
- 插入通过把一段真实上下文放入 SEARCH、在 REPLACE 保留上下文并追加内容实现；删除用空 REPLACE；新建与覆盖全文不包装 SEARCH。每个文件／操作重新声明完整头部，正文说明与运行命令不加修改元数据。
- 覆盖所有消费入口：底部复制提示词、菜单复制当前／简洁／完整格式、设置面板默认文本与示例、恢复默认、选区浮动复制按钮、复制上下文菜单和状态反馈。协议从 shared/formatSpec 单一来源生成，不继续人工维护 prompt.js 中易失同步的默认模板副本；若本地兜底仍需要，构建从权威模板生成两版资源。
- 设置中的自定义两版原文及草稿不改写、不删除；提示词面板明确提示当前解析协议及旧格式不再可应用，有自定义内容时提示检查并提供既有恢复默认入口。旧范围线索可作提示，但不能用自然语言规则宣称已验证任意自定义提示词兼容性。恢复默认仍是载入→用户保存，保持各版互不影响。
- 对已有网页对话只提示用户手动粘贴新版格式；不自动重新发送、不采集旧回复后转换、不清除用户对话。同一回复中有效新格式与无效旧格式并存时分别处理。

## Fact Sources 与模块约束

- 当前事实：CONTEXT.md、DESIGN.md、docs/capabilities/return-path-and-format-contract.md、local-file-access.md、现有 ADR-0004。
- 代码入口：src/shared/returnPath.ts、snippet.ts、formatSpec.ts、contract.ts；src/main/returnPathService.ts、fileService.ts、replyCollector.ts、index.ts、settings.ts；src/renderer/changeTree.js、preview.js、renderer.js、prompt.js、promptComposer.js；scripts/copy-static.mjs。
- 调用及验证：test/returnPath.test.ts、returnPathService.test.ts、snippet.test.ts、formatSpec.test.ts、replyCollector.test.ts、changeTree.test.ts、inlineDiff.test.ts、fileService.test.ts；src/main/workspaceProbe.ts、selfTest.ts；tools/verify-prompt-panel-offline.mjs、verify-range-normalize.mjs、verify-bubble-selfrules-offline.mjs、verify-inline-diff.cjs、verify-e2e-inline-diff.cjs。
- dev-split 分类：shared/returnPath 与 ReturnPathService 为 no split，已有协议／应用职责完整，本任务用新模式替换旧模式；index.ts、renderer.js、selfTest.ts 的结构拆分为 defer，理由是本次可沿既有 owner 修改，扩大拆分会影响无关 IPC／UI。
- Do not add to：src/main/index.ts（禁止匹配、编辑坐标、冲突处理算法）；src/renderer/renderer.js（禁止协议解释或磁盘基线规则）；src/main/selfTest.ts（禁止继续以大段字符串重述业务算法）。这些文件只做契约接入、调用或必要验收适配。
- defer 重新评估触发：实施中必须新增独立批次状态所有权，或者 IPC 需要承载定位／冲突算法；此时先停该扩展，重跑 dev-split，并明确责任模块再修改。不得为缩短文件创建 utils/helpers/part-*。
- 现有复制／预览／应用 IPC 通道名和公开方法保留，调整的是载荷语义与操作类型；不为名称含 Numbered 或 range 做无关 API 改名。行范围仅保留为 IDE 计算的显示数据，不能作为隐含写入路径。

| Module | Owner responsibility | May depend on | Must not own |
|---|---|---|---|
| shared/returnPath.ts | 元数据与 SEARCH／REPLACE 解析、唯一匹配、区间与文本纯计算 | shared 契约与纯逻辑 | 文件访问、IPC、网页 DOM |
| shared/snippet.ts | 无损上下文文本、语言与安全围栏组装 | shared/contract.ts | 写盘、应用操作推断 |
| shared/formatSpec.ts | 两版默认提示词和示例、版本选择 | shared 纯逻辑 | 用户设置写入与网页操作 |
| main/returnPathService.ts | 准备、基线复核、同文件冲突与应用／撤销编排 | FileService 与 shared 纯逻辑 | 网页 DOM、UI 渲染 |
| main/fileService.ts | 白名单、编码／换行、存在性、预期原文检查与磁盘副作用 | fs/path 与路径守卫 | 理解模型回复 |
| main/index.ts | IPC、现有批次注册、准备结果适配与广播 | owner 服务与共享契约 | 文本定位算法或双轨兼容 |
| main/replyCollector.ts | 只读 DOM 保留逐块文件／操作元数据与内容 | 既有采集策略 | 操作推断、文本替换 |
| renderer/changeTree.js 与 preview.js | 操作、实际范围、状态与只读内容呈现 | 本地桥与显示模型 | 搜索原文、磁盘写入 |
| renderer/prompt.js 与 promptComposer.js | 两版编辑、恢复与迁移提醒 | 桥返回状态及生成的默认资源 | 第二份手写协议真相源 |

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 用现有单测／临时文本复现合法错误行号无法证明目标原文；冻结前序工作区基线，建立三操作、标记冲突和上下文样本 | 记录现有通过项／失败项；样本包含不等长替换、重复原文、删除、插入、新建与覆盖冲突，测试必须反映误改风险 |
| PLAN-2 | done | 替换旧行号解析／计算契约；保留旧格式诊断、只读分类，更新采集器操作元数据与无损复制原文 | 解析与计算纯测试覆盖精确唯一匹配、行内／跨行、空白／换行、完整／残缺围栏、SEARCH 对、多文件关联；复制文本与输入逐字一致 |
| PLAN-3 | done | 服务统一准备结果，冻结预览基线，接入明确三操作、同文件冲突、逐条／全部应用及撤销重算 | 临时目录服务测试：写入与预览相同，0／多匹配和冲突不写盘，外部变化拒绝，先改上方后改下方正确，身份／目录／草稿保护无退化 |
| PLAN-4 | done | 更新 SHORT／FULL 全部规则与示例、默认资源和提示词设置说明；保留自定义内容，更新所有复制入口 | 将模板示例交给真实解析器与计算入口执行，不以关键字正则代替行为验证；两版、菜单、恢复默认、用户草稿及嵌套围栏一致 |
| PLAN-5 | done | 接入主进程与两侧本地 UI，按服务实际定位显示范围／操作／按钮；刷新剩余操作，更新探针与相关自检／离线脚本 | 真实离线 Electron 验证复制→本地样例采集→diff→应用→撤销；既有三列、标签、其他内容和诊断折叠行为保持；完整执行所有受影响脚本 |
| PLAN-6 | done | 更新当前文档与 ADR／CHANGELOG，运行必要回归、独立只读评审及文档增量校验，交付用户验收 | pnpm test、typecheck、build、verify:workspace、verify:prompt、verify:range、inline 验证和 self-test；新协议失败须修复，不跳过；git diff --check；评审通过后依 dev-distill 归档计划 |

## Acceptance Criteria

1. AI 回复无需任何行号；局部修改仅 SEARCH 唯一匹配定位，结果长度与原文长度无关。
2. SEARCH／REPLACE 结构、路径或操作不完整时原文可查看、错误可解释、磁盘不变；旧行号格式不可应用且明确提示新版格式。
3. 新建只创建缺失文件，覆盖全文只覆盖已有文件；权限、链接、非法路径或读取失败不能伪装为目标缺失。
4. 多次出现／0 次匹配、同文件重叠、覆盖混用、重复新建均拒绝对应冲突操作；多个不重叠修改在行数移动后仍定位正确。
5. 预览不创建或改动文件；应用内容与已展示结果一致，预览后外部变化拒绝写盘，重新核对后才可操作。
6. 原文空白、末尾换行、行内片段、空替换删除、真实插入、Unicode、嵌套围栏和独立协议标记冲突均有行为测试。
7. 同文件多操作仍可逐条／全部应用和逐条撤销；自身成功写入后剩余项状态更新，外部写入不得当成自身成功；未保存标签和目录失效保护有效。
8. 复制选区／全文不会删空白、加行号或暗示覆盖；默认短／长提示词及设置面板的示例都能解析执行，自定义内容和各版本草稿不丢失。
9. 命令及普通示例继续只读且默认折叠；显示范围、行数和 diff 均不包含协议标记，不扩大项目网页操作权限。
10. 计划阶段仅写本文档；实施不隐含提交、合并、推送授权。实施完成后实际测试结果、独立评审、未解决限制及既有文档诊断须如实记录。

## Risks 与验证重点

- 精确匹配可能因 AI 抄错空白或省略内容失败：通过无损复制、明确原文示例及 0／多匹配反馈改善，不用模糊匹配掩盖。
- 网页提取会处理结构性换行：以包含首尾空行／Tab 的 DOM 样本验证各采集策略，代码区真实字符不能被控件或段落转换污染。
- 元数据重建遗漏“操作”将误判为缺失：扩展 metadata 白名单与逐块标题测试，兜底策略也保留本块操作而不跨块借用。
- 协议标记与真实文本冲突：拒绝歧义，要求明确覆盖全文，不把用户文件中的冲突标记误当编辑指令。
- 自定义提示词仍可能请求旧格式：保留配置且明示升级，不覆盖个人内容，不声称自然语言兼容检查可靠。
- 多片段依赖与冲突：第一版仅支持同一原文中的独立替换；依赖前一替换生成内容的后续修改分轮进行。剩余项必须重校验，不能复用失效坐标。
- 任意外部程序仍可能在最后检查之后同时写盘：预期原文核对与串行本地操作降低风险，明确不提供跨进程文件锁保证；不引入复杂事务框架。

## Artifact Routing

- Capability updates：实现后更新 docs/capabilities/return-path-and-format-contract.md、local-file-access.md，删掉失效行号规则与冲突描述。
- Stable terminology：必要时更新 CONTEXT.md 的格式约定／回程操作术语，不写过程证据。
- Design：更新 DESIGN.md 的操作标签、显示范围与只读上下文说明；复用 ui.css、现有 details、提示词面板和 Monaco 内联 diff，无新视觉布局。
- ADR gate：needed；dev-distill 就新的定位与明示操作规则更新既有 ADR-0004，以代码和测试落实已确认规则，避免创建重复信任边界文档。
- CHANGELOG：实现后记录输出协议变更、旧格式退出与自定义提示词提醒。
- Context map：实现后校对路由和事实入口，只有 owner 或入口改变才更新，不把计划当默认能力文档。
- Audit output/source audit：none，本次不是审计派生，不创建发现报告。
- Tests：按 owner 更新现有测试；新协议样本放 test/fixtures，离线验收不操作官方页面、不使用自动化驱动。

## Git Visibility

- 计划创建后执行 git status --short --branch --untracked-files=all，确认 docs/plans/2026-10-05-explicit-edit-protocol.md 可见。
- 前序工作已单独提交并合并；本任务的源码、测试、协议样例与文档均在新分支可见。

## Closeout

全部非延期步骤为 done、必要验证完成且独立评审通过后，由 dev-distill 将本计划移至 docs/plans/archived/ 并改为 archived；执行 dev-check 比较文档校验增量。真实页面格式遵守率仍由用户手动试用检验，不以离线样本承诺模型永不出错。

## 验收结果

- `pnpm test`：306/306，0 失败、0 跳过。旧行号与前缀剥离测试整组替换为唯一明确协议的行为测试，不保留失效写入兼容。
- `typecheck`、`build` 通过；renderer scope 裸未绑定标识符为 0（其余 73 条既有语义诊断不作失败判据）。
- `verify:workspace`：94/94，原 81 项保护保持，新增无损草稿复制、同文件定位偏移、外部基线、旧格式拒绝、零/多匹配、空文件与撤销后再改路径。
- `self-test`：160/160，历史 Y6/I1 已改为当前真实行为断言并通过。
- `verify:prompt`：27/27；范围计算 4/4、离线选区/样式检查 10/10、内联检查 47/47、真实源码内联链路 9/9。
- `git diff --check` 通过。未自动操作真实 DeepSeek 网页；真实模型格式遵守率需用户试用，不承诺截断检测或跨进程锁。
- 独立只读复审 mode=subagent。纯协议/UI findings 已由独立 reviewer 重跑 78 项并确认无剩余阻塞；服务 reviewer 的改路径冲突、目标缺失依赖、撤销历史路径三项发现均已核实修复，前两项由其真实临时文件复验，最后一项由主线新增实际 Electron IPC 流程验证。最后返审受账号额度限制未能执行，主线完成最终 diff 检查和针对性回归；不把未执行的返审声称为通过。
- Review：plan compliance=pass；audit coverage=not applicable；related changes only=pass；verification evidence=pass；没有未处理代码阻塞项。Changelog 与 distill 已同步，ADR-0004、CONTEXT、DESIGN 和能力文档记录当前协议。
- 文档增量校验无新增诊断，修复本任务触及文档的 3 项 frontmatter 解析问题；全仓仍有历史 11 errors / 13 warnings（原 14/13），范围外审计、模板、历史计划未改。Check gate 以已确认的增量基线验收，不能称全仓校验通过。
