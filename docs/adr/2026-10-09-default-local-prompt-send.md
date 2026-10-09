---
artifact_type: adr
status: accepted
created: 2026-10-09
updated: 2026-10-09
owner: 胡运宽
source_of_truth: [src/main/localPromptController.ts, src/shared/localPrompt.ts, src/main/settings.ts, src/renderer/localPrompt.js, src/renderer/index.html]
---

# 本地需求默认主动发送

用户确认在 IDE 需求输入框 Enter 即表示提交需求，并取消独立发送开关。输入框默认 Enter 发送、Shift+Enter 换行；输入法组合与重复按键不发送，技能菜单 Enter 仅确认技能。右下角圆形箭头按钮与 Enter 共用同一个提交入口。无需常驻键盘说明；发送图标提供可访问名称、焦点、忙与禁用状态。

仅初始化提示词附带选项持久化，用户决定且发送后不复位。用户主动提交与工具 automatic 独立；用户确认移除复制提示词及其专属更多菜单，仅保留输入框主动提交链路。移除 sendOnEnter 字段，不保留双轨行为；设置规范化不将无关旧字段纳入当前配置。

本地主动提交继续经过可信编辑器主 frame 的窄 IPC、LocalPromptController 和唯一 WebComposerSender 运输，保留项目、会话、忙状态、官网 origin、空输入、附件就绪、已知控件、一次点击及不确定不重试。输入法和技能选择不授予发送资格；不引入官网模拟键盘、API、剪贴板代送或额外写入口。

该决策承接固定技能与本地需求发送 ADR 的用户触发方式；工具执行授权、自动继续及网页进程边界保持现有 owner。
