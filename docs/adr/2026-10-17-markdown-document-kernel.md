---
artifact_type: adr
status: accepted
created: 2026-10-17
updated: 2026-10-17
source_of_truth: decision
---

# Markdown 两种模式共用文本内核

## Context

用户要求 Typora 式实时编辑，默认进入排版模式、可以切源码，并同时支持数学及 Mermaid。已有 Monaco 文件模型与统一保存/未保存保护；将渲染 DOM 转回 Markdown 容易使未编辑段落被格式化，保留两份正文则增加同步与撤销风险。

## Decision

- Markdown 使用 CodeMirror 6，一份文档与历史同时服务源码和实时模式；通过重配显示扩展切换，不重建内容。其他文本保留 Monaco。
- `editorWorkspace.js` 仍拥有文件缓冲与保存生命周期。Markdown 模型通过窄文本接口接入，主入口只选择呈现 owner。Markdown 不作为只读附件种类，不新增文件写入权限。
- 排版基于真实语法范围和文本事务；数学由 KaTeX、图表由 Mermaid 本地渲染，HTML/SVG 不是保存数据。公式/图表错误保留原文可修改。
- 本地 ESM 及动态模块在构建时打包，字体随包，维持原 CSP。数学禁可信资源命令，图表固定 strict 并拒绝图内配置与资源，SVG 二次净化。

## Alternatives Considered

- Monaco 源码加只读预览：无法满足用户直接编辑排版正文的要求。
- Vditor 即时渲染：可直接提供完整交互，但其即时模式从 DOM 转回 Markdown，不适合本次保持源文与统一文本撤销的目标。
- Monaco 和独立富文本内核各保留 Markdown：需要双向同步、撤销及格式转换，增加状态路径。

## Consequences

- 源文可作为单一事实来源，模式切换不引入保存修改，复用原草稿/保存保护。
- 需要维护 Markdown 装饰、小部件与中文输入交互，原 Monaco 专用探针必须区分活动内核。
- 图表资源加载与同步布局需要规模限制、修订核验和真实离线/视觉验证；库的 API 文档不能代替项目内验收。

## Status History

- 2026-10-17：用户确认实时编辑、默认模式、公式与 Mermaid 范围并授权实施，采用已说明的 CodeMirror 工程路线。
