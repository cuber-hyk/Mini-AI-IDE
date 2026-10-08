---
artifact_type: plan
status: archived
created: 2026-10-08
updated: 2026-10-08
owner: 胡运宽
design_system_impact: update
---

# 技能列表 UI 参考 Harness

用户要求技能选择器参考本地 deepseek-harness。读取 `packages/client/ui-input-trigger/src/client/MenuView.tsx` 及 module.css，采用紧凑单行、名称左列/描述右列、单一活动高亮、圆角菜单与弱化信息；沿用现有中性设计 token。范围限本地列表呈现与活动项可见性，不改变技能扫描、权限和发送。

实施：选项拆分斜杠图标、名称、来源标签与描述；长描述省略、title 和可读名称保留全文。鼠标与键盘统一 aria-selected，键盘只调整菜单自身 scrollTop，不滚动外层 dock。受独立官网原生视图边界约束，保留本地 dock 内菜单，不复制跨视图浮层。人工复核名称、来源、描述均通过 textContent 创建，无 HTML 注入。

验证：24 项本地输入区/提示词回归通过，0 跳过；构建通过，原生探针通过全部交互检查与7种布局。新增长英文描述原生场景验证34px单行、224px菜单上限、文字省略与全文悬停，并检查实际 `skills-menu.png`。首次截图发现 scrollIntoView 拉动外层，改为菜单自身滚动并复验截图正常。DESIGN、CHANGELOG同步，不提交或发布。

ADR gate：沿用 `docs/adr/2026-10-08-skills-and-local-demand-send.md` 的发送边界与 `docs/adr/2026-10-07-workspace-ui-shell-layout.md` 的原生视图布局，无新增长期架构决策。
