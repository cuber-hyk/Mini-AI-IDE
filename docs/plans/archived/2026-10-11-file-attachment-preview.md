---
artifact_type: plan
status: archived
created: 2026-10-11
updated: 2026-10-11
owner: Codex
---

# 右侧附件只读预览

## 目标、范围与确认

用户确认在现有文件标签中预览 PNG/JPEG/WebP/GIF、PDF 和新版 Word `.docx`。图片支持缩放、适应窗口；PDF 支持分页、翻页、缩放；Word 展示文字、表格和图片，复杂排版允许与 Word 不同。旧版 `.doc` 提供系统应用打开入口。保持本地只读，不上传、不编辑二进制、不改变官网与工作区几何 owner。

## 事实与代码放置

当前 `FileService.readFile` 仅支持文本。`editorWorkspace.js` 负责统一标签、草稿与异步生命周期；继续保留此单一入口。`renderer.js` 与 `index.ts` 只增加适配与注册。新增 `filePreview` 主进程 owner 负责受根目录保护的限量二进制读取，专用 IPC 只允许编辑器主 frame；新增渲染预览 owner 管理图片、PDF/Word 渲染和释放，不在入口堆积格式实现。`dev-split` 判定现有入口 no split，本次新行为有独立职责，不迁移无关代码。

PDF.js、docx-preview 静态资源随包分发，不联网加载。Word 内容放进无脚本、无文件桥的 sandbox iframe，禁止外部资源；拒绝过大文件与过度展开的 ZIP。类型、尺寸、根目录切换均明确报错。复用 DESIGN.md 的标签、按钮、焦点和主题 token；design_system_impact: update，仅补充只读预览规则。

## 步骤与验证

1. [done] 验证文本入口与文件桥边界；用户确认类型方案。
2. [done] 增加类型契约、受限二进制读取与 IPC；测试越界、大小、格式、ZIP 限制及根目录变化。
3. [done] 增加本地预览 owner 和静态依赖；验证图片缩放、PDF 翻页、DOCX 表格图片、错误与资源释放。
4. [done] 接入统一标签生命周期；回归草稿、保存、切换项目、改名、删除和延迟读取。
5. [done] typecheck、build、完整测试、离线渲染检查；更新 CHANGELOG、能力文档、上下文路由与 DESIGN，归档计划；独立只读评审作为分支提交门禁。

## 风险与验收

异步 PDF/Word 渲染不得覆盖后选文件；切换、关闭、刷新应释放 worker/object URL。预览不能调用 writeFile，不污染 dirty，也不能丢失文本草稿。损坏或超限文件显示原因并可用现有系统打开入口；外部图片、链接和脚本不得获取桥或网络能力。命令行测试通过不等于已验证原生窗口，渲染检查无法运行时必须说明。

## 产物与收尾

更新文件工作区能力、context-map、DESIGN、CHANGELOG；规则优先落测试。ADR gate：沿用主进程路径白名单和沙箱渲染边界，未新增官网运输或网络出口，无独立 ADR。两份已有未跟踪审计报告不修改、不纳入本任务。提交、合并、清理仍等用户显式批准，绝不 push。

## 验证结果

- TypeScript typecheck 与 build 通过；含新 owner 的 renderer scope 检查无未绑定名字。
- 完整测试 833 项通过，0 失败、0 跳过。
- 原生 Electron 离线预览验收 11 项通过：实际图片缩放、PDF 正文与翻页、Word 表格图片及窄列适应；HTTP 请求和渲染错误均为 0。已检查截图。
- 独立评审发现跨类型改名沿用旧 kind，已修复并补测试：关闭旧只读标签后重新打开按新类型读，文本草稿保留。
- 文档校验仅保留 HEAD 已有的 5 项历史错误及 3 项历史警告，本任务未新增；不扩展范围修改历史记录。
- 无独立 ADR；能力、路由、DESIGN 和 CHANGELOG 已更新。等待用户提交/合并授权。
