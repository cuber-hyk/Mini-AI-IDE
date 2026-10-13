---
artifact_type: reference
status: current
created: 2026-10-12
updated: 2026-10-12
owner: Codex
---

# 历史网页诊断资料

| 文件 | 原文件名 | 用途 |
|---|---|---|
| [deepseek-reply-diagnostic.txt](deepseek-reply-diagnostic.txt) | 诊断json.md | 回复候选、归属、原生控件及代码结构快照 |
| [deepseek-page-controls.txt](deepseek-page-controls.txt) | 控件结构.md | 页面控件与回复完成识别的历史采样 |

原始内容是 Console 返回的转义文本，移动前后 SHA256 一致，保留为 txt；不将其改名为可直接解析的 JSON，也不执行文本内容。采集环境和时点以引用这些文件的审计/计划为准，其中曾有外部浏览器取样。不能把快照当作当前 IDE 网页状态、登录或发送成功证据。

实现规则和可运行检查入口见 `docs/capabilities/tool-harness.md`、`tools/inspect-reply-state.js`；本目录只保留历史数据。
