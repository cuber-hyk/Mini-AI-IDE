---
artifact_type: capability
status: current
updated: 2026-10-17
owner: 胡运宽
source_of_truth: [src/renderer/markdownEditor.js, src/renderer/markdownPresentation.js, src/renderer/markdownMath.js, src/renderer/markdownMermaid.js, src/renderer/markdownImages.js, src/renderer/markdownEditor.css, src/renderer/editorWorkspace.js, src/renderer/renderer.js, src/renderer/fileWorkspace.js, scripts/build-markdown.mjs, test/markdownMath.test.ts, test/markdownMermaid.test.ts, test/markdownPresentation.test.ts, test/markdownImages.test.ts, test/promptComposer.test.ts, tools/verify-markdown-editor.cjs]
---

# 能力：Markdown 实时编辑

内核与文件生命周期边界见 `docs/adr/2026-10-17-markdown-document-kernel.md`。

## 文档与保存

打开 `.md` / `.markdown` 文件默认实时编辑，可在同一文件正文切换源码。Markdown 两种模式共用一个 CodeMirror 文档、撤销历史及选区；普通文本仍使用 Monaco。文件标签、dirty、Ctrl+S、后台保存、关闭确认、项目切换和 AI 修改冲突继续由 `editorWorkspace.js` 与原主进程文件服务负责，不新建写盘入口。

渲染只生成显示装饰，不转换并序列化整篇 Markdown。未修改时及撤销回原始文档时返回原文本（包括原换行）；真实编辑后的行分隔沿用初始化文档的换行约定。修改、切模式及保存均不使用渲染 HTML/SVG 作为文件内容。扩展名改名保留打开时的编辑内核和草稿，关闭后再打开按当前扩展名选择内核。

## 编辑与排版

实时模式显示标题、强调/删除线、引用、列表、任务清单、行内代码、代码块、表格、链接及本地图片。光标或选区进入对应区域时显示源码；表格、公式、代码及图表渲染块可点击或用 Enter/空格定位源码。任务勾选通过文本事务修改真实标记，可撤销。源码模式显示行号，使用同一查找/替换和保存能力。

表格单元格支持安全的强调、删除线、行内代码、链接及数学嵌套展示；单元格内图片保留源码并标明可编辑，不从表格 DOM 反序列化内容。

选区复制从 CodeMirror 文档取真实 Markdown 和实际起始行，复用编号片段 IPC；不会取已隐藏 Monaco 的旧内容，不从排版文字反推源码。Front Matter 和原始 HTML 保留源码，不作为可执行 HTML 展示。

## 数学与 Mermaid

KaTeX 支持 `$...$`、`\(...\)` 行内公式，独立行包围的 `$$...$$`、`\[...\]` 块公式，以及同一独立行成对的块公式。代码、转义和 Front Matter 中的数学标记不渲染；金额通过定界边界排除。支持范围以随包 KaTeX 为准，不等于完整 LaTeX。宏每次渲染隔离，可信资源命令关闭，展开与尺寸有界；错误原位保留原文和原因。

Mermaid 围栏渲染随包内置图型，图表保持源码可编辑。渲染串行并核验宿主身份与修订，过期结果不更新已离开文档；普通输入复用未变化块的显示。图表最多 30000 字符、500 行、300 条边，并有连线标记预检。图内 frontmatter、初始化指令和资源地址会明确报错，不能覆盖宿主 strict、无 HTML 标签和资源限制。返回 SVG 进一步净化，不绑定点击脚本，不保留外部图片、链接、事件或逃出图内作用域的样式。同步布局不承诺能被 Promise 超时中断。

## 本地资源边界

专用 CodeMirror/KaTeX/Mermaid 代码在首次打开 Markdown 时加载；Mermaid 图型模块继续按需加载。所有模块、公式 CSS 与字体随包提供，保持 `connect-src 'none'`；不调用在线图表服务。

图片只接受相对 Markdown 路径，禁止协议/绝对路径/项目外回退；通过既有 `readFilePreview` 主进程校验真实文件，返回后复核项目修订和文档身份，仅接纳图片类型，再以可释放的本地 Blob 显示。源文外链不自动加载，文档不能向官方 AI 网页或磁盘增加能力。

## 验证入口

- `pnpm run verify:markdown`：隔离临时项目与 profile 的原生 Electron 验收，检查实际排版、公式、图型、原文/撤销、草稿、失效异步结果、离线资源和窄正文；截图保存到报告目录。
- `test/markdownMath.test.ts`、`markdownMermaid.test.ts`、`markdownPresentation.test.ts`、`markdownImages.test.ts`：数学边界、图表配置/队列/净化、装饰与安全图片读取。
- `test/editorWorkspace.test.ts`、`promptComposer.test.ts`、`src/main/workspaceProbe.ts`：原工作区和 Markdown 路由回归。

合成 composition 事件只能验证组字期间不切模式；真实 Windows IME 候选窗、输入法切换与物理键盘体验另需人工检查，不能将原生自动测试称为该项已通过。
