---
artifact_type: plan
status: archived
created: 2026-10-17
updated: 2026-10-18
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# Markdown 实时编辑、公式与 Mermaid

## Goal

让本地 `.md` / `.markdown` 文件默认以 Typora 式实时编辑呈现，并可切换源码；普通 Markdown、数学公式及 Mermaid 均可编辑和渲染，保存仍为原 Markdown，沿用现有草稿与文件权限保护。

## Scope

- 范围：源码/实时编辑切换，标题、强调、删除线、段落、引用、链接、图片、列表、任务清单、代码块、GFM 表格，行内/块级公式，Mermaid 代码围栏。
- 公式采用 KaTeX 支持的 TeX 数学语法，支持 `$...$`、独立行包围的 `$$...$$`、`\(...\)`、独立行包围的 `\[...\]`；不承诺完整 LaTeX 文档或全部宏包。
- Mermaid 使用随安装包分发的正式库及内置图型，验证流程、时序、类、状态、ER、甘特、饼图、思维导图和时间线；不增加远程渲染服务或自定义脚本插件。
- 包含现有保存、未保存保护、多标签、改名/删除、AI 写盘刷新、选区原文复制、查找及文件区显隐的接入和回归。
- 不包含图表导出、图片上传、公式可视化符号面板、富文本工具栏、协同编辑和官网视图改造。原始 HTML 保留源码，不作为可执行 HTML 渲染。

## Plan Readiness

- 目标与交互：用户已确认 Typora 式实时编辑，并明确公式及 Mermaid 属于此次范围；2026-10-17 已选择打开 Markdown 默认实时编辑、按需切源码。
- 当前事实：`renderer.js` 将 Markdown 映射到 Monaco 语言；`editorWorkspace.js` 管理各文档缓冲、保存与生命周期；当前没有 Markdown 排版视图。
- 工程路线：采用此前已向用户说明的 CodeMirror 6 路线；Markdown 两种模式共用同一文档及历史，其他文本继续 Monaco，不保留两套 Markdown 编辑实现。
- 验证路径：纯解析/状态测试、现有工作区回归、构建与类型检查，以及离线 Electron 原生夹具和中文输入人工验收。
- 实现前置：先验证第三方库在真实本地加载器、CSP 与 file 页面下可用；若需要放宽安全边界或发现路线无法满足保真要求，记录证据并重新讨论，不能静默换成 DOM 转 Markdown。

## Assumptions And Decisions

- Markdown 原文为唯一内容事实来源。渲染装饰不写回原文，切换模式不重新解析并序列化整篇；打开、渲染或切模式不产生 dirty。
- 每个打开的 Markdown 文档持有一份 CodeMirror 状态；切源码只重配显示扩展，保留撤销、选区及有效阅读位置。模式在当前文件标签生命周期内保留，不新增持久设置。
- 非活动文档的后台保存、AI 修改刷新、改名及关闭，不得切换当前标签或复活旧异步渲染。磁盘写入仍只有现有主进程文件入口。
- 光标或选区进入语法对应区域时展示可编辑源码；离开后显示排版。表格、公式、Mermaid 点击可进入对应源码，修改通过统一文本事务记录；不从生成的 HTML/SVG 反推 Markdown。
- 公式与 Mermaid 语法错误就地显示简短原因及原文，继续允许编辑；不吞错、不保存渲染产物、不丢弃未知语法。
- 图片只通过当前项目既有安全读取边界显示支持格式的本地图片。外链不自动取资源，正文不能使编辑器导航到任意 URL；链接激活沿用明确的用户操作入口。
- 库、字体和动态模块完整随包提供，保留 `connect-src 'none'`。首次使用时按需加载，普通代码编辑不承担专用渲染初始化。
- KaTeX 禁用可信 HTML/资源命令并限制宏展开与尺寸；宏状态不得跨文档泄漏。Mermaid 固定 strict 安全级别，不绑定图表脚本回调，关闭 HTML 标签，净化 SVG，并防止图内配置覆盖宿主的安全限制。
- 渲染结果只在文档身份、正文修订、块范围和视图代次仍有效时应用。Mermaid 排队并合并失效请求，控制文本/边数规模；不能把 Promise 超时当作已中断同步渲染。
- 当前工作树已有工具协议等未提交改动。本计划只新增本文件；后续实现遵循 dev-branch，隔离现有工作，不提交、合并或推送。

## Fact Sources

- 本地约束：`AGENTS.md`、`CONTEXT.md`、`DESIGN.md`、`design-tokens.json`、`docs/ai/context-map.md`。
- 能力：`docs/capabilities/local-file-access.md`、`docs/capabilities/app-shell.md`。
- 文件 owner：`src/renderer/editorWorkspace.js`、`renderer.js`、`editorTabs.js`、`fileWorkspace.js`、`filePreview.js`，以及 `src/main/editorSession.ts`。
- 构建与安全边界：`scripts/copy-static.mjs`、`src/renderer/index.html`、`src/main/preload.ts`、`src/shared/contract.ts`、`package.json`。
- 现有回归：`test/editorWorkspace.test.ts`、`test/fileWorkspace.test.ts`、`test/fileExplorer.test.ts`，原生 `src/main/workspaceProbe.ts`、`src/main/layoutProbe.ts`。
- CodeMirror 文档状态/事务：[System Guide](https://codemirror.net/docs/guide/)；[Markdown 语言支持](https://github.com/codemirror/lang-markdown)。文本内核具备基础能力，不代表自带完整 Typora 交互。
- KaTeX：[浏览器与 AMD 加载](https://katex.org/docs/browser)、[选项与错误行为](https://katex.org/docs/options)、[安全说明](https://katex.org/docs/security)。
- Mermaid：[浏览器渲染 API 与安全级别](https://mermaid.js.org/config/usage.html)、[配置与 secure 键](https://mermaid.js.org/config/schema-docs/config.html)。这些是接入依据，尚不属于本项目运行验证。

## Decisions

| 决策 | 路线 | 依据 | ADR gate |
|---|---|---|---|
| 编辑方式 | Typora 式实时编辑，保留源码模式 | 用户确认 | maybe，随编辑器所有权一起记录 |
| 默认模式 | 实时编辑 | 用户明确选择 | not needed |
| 公式/Mermaid | 本次同时交付 | 用户明确要求 | not needed |
| 文档内核 | Markdown 两种模式统一 CodeMirror，其他文本保留 Monaco | 已沟通的工程建议；减少双向同步及格式转换 | needed，新增 Markdown 内核与现有工作区的所有权边界 |
| 安全与保存 | 本地渲染，原文保存，现有 IPC 权限不扩大 | 仓库硬约束 | 沿用既有决策 |

## Split Guidance

- 分类：`no split`。本次不拆分现有入口或顺手清理代码；新行为放入具名 Markdown owner，原文件只做必要接线。
- 候选扫描：dev-split 脚本扫描 `src/renderer`，700 行候选阈值下 `renderer.js` 为 978 行。行数只是复查信号；判断依据是该文件现有初始化/事件接线职责，不适合继续承载解析与渲染实现。
- `Do not add to: src/renderer/renderer.js`：不加入 Markdown 解析、装饰构建、数学渲染和 Mermaid 排队实现；只接入当前文档、查找、选区与布局入口。
- `editorWorkspace.js` 保持唯一文件缓冲/保存生命周期 owner，提供必要的文本模型接入，不持有第二套 Markdown 正文，不包含第三方库细节。
- 新模块沿用 renderer 中具名功能 JS/CSS 的现有约定；实施时仅建立有真实调用的模块，不预建通用适配框架。

| 模块 | 单一职责 | 可依赖 | 不得负责 |
|---|---|---|---|
| `src/renderer/markdownEditor.js`（新增） | Markdown 文档状态、模式、选区/命令与工作区接入 | CodeMirror、排版/渲染 owner、现有工作区回调 | 独立写盘、官网、第二套 dirty/保存流程 |
| `src/renderer/markdownPresentation.js`（新增） | 按语法范围生成实时排版装饰与源码显隐 | 语法树、CodeMirror、内容渲染 owner | 保存、网络、全文反序列化 |
| `src/renderer/markdownMath.js`（新增） | 数学定界解析扩展与 KaTeX 小部件 | Markdown 解析扩展、KaTeX | 文档/磁盘生命周期、共享全局宏 |
| `src/renderer/markdownMermaid.js`（新增） | 图表渲染队列、净化与修订核验 | Mermaid、DOMPurify、宿主文档身份 | 任意脚本、远程资源、持有可写正文副本 |
| `src/renderer/markdownEditor.css`（新增） | 编辑排版与当前主题适配 | 既有主题 token、随包字体 | 官网样式 |
| `editorWorkspace.js` / `renderer.js` / `fileWorkspace.js` | 文件生命周期与必要接线 | 既有 owner 和 Markdown 公共入口 | 吸收 Markdown 渲染实现 |
| `scripts/copy-static.mjs` 及必要构建入口 | 随包资源与本地可加载模块产物 | 固定版本依赖、现有构建链 | 运行时 CDN 或业务请求 |

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| MD-1 | done | 核对现有源码展示路径、保存/草稿 owner，确认交互范围与官方 API，完成模块边界评估 | 静态核对语言映射、模型/保存及选区直接调用；用户确认默认实时模式；不声称已运行新功能 |
| MD-2 | done | 在隔离任务分支验证 CodeMirror、KaTeX、Mermaid 的本地加载和最小渲染，再接入正式构建 | 实际 Electron 页面在原 CSP 下显示中文、行内/块公式和流程/时序图；断网可用；无远程资源请求；失败则先报告事实 |
| MD-3 | done | 接入统一 Markdown 文档内核、源码/实时切换和现有文件工作区 | 打开/切换不改原文；两模式编辑与撤销连续；Ctrl+S、后台保存、关闭确认、切项目、改名/删除、AI 刷新及文件区显隐回归 |
| MD-4 | done | 实现常规 Markdown 排版与可编辑小部件，包括表格、任务清单、链接及安全本地图片 | 真实输入/粘贴、中文 IME、方向键、跨块选区、查找、原文行号复制；检查长文和窄正文，不只比较静态截图 |
| MD-5 | done | 实现数学语法扩展及 KaTeX、Mermaid 渲染/编辑切换、错误和失效结果处理 | 公式矩阵/上下标/分式与各列明图型；错误可修复；代码块/转义/金额不误识别公式；快速修改、换标签、关闭和 AI 改写后旧结果不覆盖新内容；验证安全配置不可被文档覆盖 |
| MD-6 | done | 完成单测、离线原生集成与文档审阅；真实 Windows IME 人工验收作为已披露未验项保留 | 类型检查、构建、相关与必要全量回归；报告通过/失败/跳过和现场未验项；更新能力/设计/路由/变更记录，运行文档校验，独立评审门后展示差异；不自动 Git 提交/合并/推送 |

## Acceptance Criteria

- Markdown 默认实时编辑，可切源码；两模式共用原文、历史、文件标签和保存入口。
- 模式切换不改写标题/列表符号、空行、尾随空格、代码围栏、Front Matter、未知语法和公式/Mermaid 原文；换行编码按现有文件层约定验证，不凭空承诺原系统未实现的字节保真。
- 支持范围中的常规 Markdown、公式和图表可显示并直接定位源码编辑；渲染异常可见、可修复，正文不丢失。
- 原文复制必须是真实选中的 Markdown 及其真实行号，不复制排版 DOM 文本来冒充源文。
- 所有写盘、未保存确认与 AI 修改冲突保护沿用原 owner；异步任务不能跨项目/文件/修订串写。
- 依赖、模块块文件及字体在安装包内完整，离线可用，原 CSP 与进程隔离保持。图表和公式不授予文档脚本、官网或额外磁盘能力。
- 中文输入、查找、撤销、混合长文、多图、滚动和窄正文有真实原生验证；未验证项必须明确列出，不能用纯函数测试替代现场编辑体验。

## Risks

- CodeMirror Markdown 语言支持不等于完整实时编辑器；隐藏语法、选区与高度变化是主要开发风险，必须用实际交互验证。
- 当前主入口、选区浮层和探针直接依赖 Monaco。接入必须按活动文件路由，不能出现切到 Markdown 后复制旧 Monaco 模型的情况。
- KaTeX 支持范围与完整 TeX 不同；不支持命令必须保留源码和错误，不自动替换成其他公式引擎。
- Mermaid 为异步且可能涉及耗时同步布局，图表规模限制和失效结果丢弃都要验证；计时器不能保证终止同步计算。
- 渲染字体、离线动态导入、SVG 净化及标签宽度可能影响图形布局，浏览器文档只能证明接口存在，不能替代项目内运行验证。

## Artifact Routing

- `persistent_plan: yes`：跨编辑器、构建、安全渲染与文件生命周期，预计多轮实施。
- 能力：实现后更新 `docs/capabilities/local-file-access.md` 和 `app-shell.md`，仅写已验证当前行为。
- 设计：`design_system_impact: update`；复用现有主题、焦点/按钮、文件标签与正文显隐；记录已确认模式切换与数学/图表交互。视觉验收含暗色、窄列、键盘焦点与 reduced-motion。
- ADR：dev-distill 执行 ADR gate，记录 Markdown 文档内核及与统一文件生命周期的责任边界。
- 路由与变更：实现后更新 `docs/ai/context-map.md`、必要的 `AGENTS.md` 入口及 `CHANGELOG.md`；本计划不提前声明新能力已可用。
- 测试：按 Markdown 编辑/排版、数学、Mermaid owner 新增行为测试，扩展现有工作区回归；原生夹具使用隔离项目和资料目录，不连接官网。
- 审计：无来源审计与发现项；实现评审产生的发现遵循稳定 ID 和审计路由。

## Git Visibility

- 创建后运行 `git status --short --branch --untracked-files=all` 核验本计划可见，并运行 dev-flow `validate-docs`。
- 代码已在独立工作树 codex/20261017-markdown-live-editor 实现；核验记录见下节，不自动提交、合并或推送。

## Closeout

- 2026-10-18：用户在已获知测试与人工验收限制后授权提交、收尾、push 和发布；实现及自动验证收尾归档，真实 Windows IME 未验项继续在能力文档与版本说明中披露，不声明已通过。
- 全部非延期步骤完成、验证记录和独立评审门完成后，由 dev-distill 移至 `docs/plans/archived/` 并设为 archived，或删除无独立价值的过程记录。
- 不以预算、停止当前轮或技术调研结束作为功能完成依据。

## Execution Record

- 工作树：`C:/Users/胡运宽/.codex/worktrees/markdown-live-editor/Mini-AI-IDE`，分支 `codex/20261017-markdown-live-editor`；基线为 master `cfcbea386320a0c105e3de4ceb285d778e1b7d69`。原工作区工具协议未提交内容未搬入本任务。
- 构建、类型检查、作用域检查（未绑定名称 0）、文档校验和差异空白检查通过。最后 SVG 时间线配色修复后再次构建本地静态资源。
- 原生 Markdown 验收最终 35/35，通过九类图型、公式、表格内联格式、点击回源、跨模式撤销、CRLF、草稿/AI 重载、图片、窄正文、对比度和失效异步结果。非本地网络请求及 rendererErrors 均为空；13 张截图位于 `C:/Windows/Temp/mini-markdown-editor-probe-J7S5AF/`，宽、320/240 px 与九图均已目视复核。
- 原生工作区探针退出 0，Markdown 新建、输入、文件/目录改名、保存和关闭保护通过。探针的两次截图采样报告 `UnknownVizError`，不能称为这些截图采样成功；Markdown 视觉证据以上述专用原生夹具为准。
- 独立只读评审发现 MD-R1（表格内联格式露出源码）；修复后由评审独立重跑 7/7 表格/排版测试确认解除，无新增阻断。其余原文、撤销、异步身份与文件权限未发现已证实的回归。
- 全量并行测试一次 1210/1211，通过项无跳过，失败为未修改的 `toolAutoContinueIntegration.test.ts` 中“40 请求长 JSON”五秒等待超时；单独重跑相同失败。将原始 master 归档到独立临时目录、使用相同依赖重跑该单例，也在同一断言超时（0/1）。因此保留为已复现的基线验证限制，不修改工具链实现或延长其测试时间来宣称通过。最终冻结代码串行完整回归 1211/1212 通过、失败 1、取消/跳过 0，仍仅同一长 JSON 基线超时，耗时约 417 秒；没有通过延长等待或跳过用例消除失败。
- 尚需人工验证：真实 Windows 中文输入法候选窗、物理键盘与输入法切换。原生夹具对此明确 skipped，只验证中文事务与 composition 期间模式保护，不作为物理 IME 已通过的证据；该未验范围在用户发布授权后作为披露限制保留，不阻断本次自动验证收尾。
- 2026-10-18 获得用户显式 Git 与发布授权，进入 v0.6.0 发布；真实发布结果由发布记录补充。
