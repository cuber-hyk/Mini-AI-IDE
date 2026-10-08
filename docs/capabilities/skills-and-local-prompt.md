---
artifact_type: capability
status: current
updated: 2026-10-08
owner: 胡运宽
source_of_truth: [docs/adr/2026-10-08-skills-and-local-demand-send.md, src/main/skills.ts, src/main/localPromptController.ts, src/main/webComposerSender.ts, src/main/firstPromptSession.ts, src/main/tools/replyChangeWatcher.ts, src/main/settings.ts, src/main/tools/integration.ts, src/shared/skills.ts, src/shared/localPrompt.ts, src/renderer/localPrompt.js, test/skills.test.ts, test/localPromptController.test.ts, test/localPrompt.test.ts]
---

# 能力：技能与本地需求发送

全局技能位于当前用户的 `.agents/skills/<目录>/SKILL.md`，项目技能位于当前项目 `.mini-ide/skills/<目录>/SKILL.md`。frontmatter 提供 `name`、`description`，正文是完整指令。名称区分大小写，项目同名优先；项目同名文件无效时报告错误，不悄悄使用全局版本。同层重复名称禁用并报告。

只扫描这两个固定根的一层技能目录，只读取大小受限的 SKILL.md；解析 YAML 数据，不执行代码。全局目录允许技能目录符号链接和 Windows 目录联接，解析后的真实技能目录作为该技能的读取边界；SKILL.md 不得链接到该目录之外。项目技能目录不得链接到项目技能根之外，编辑器文件桥不扩大。目录内 scripts/references/assets 不会自动执行或加载；后续操作仍走原工具协议与权限。没有可用技能或目录扫描失败时，选择列表为空，不显示原因。

本地需求输入框输入 `/` 显示名称、描述与来源，方向键/Enter 选择，Escape 关闭。选中的技能可查看完整正文；删除引用后不再附带。项目切换清理旧目录与预览，迟到读取不能更新当前项目。显式选择的技能完整说明进入提示词；初始化提示词附带可用技能摘要，模型可用只读 `load_skill({name})` 按需获取完整说明。

“附带初始化提示词”默认勾选，用户选择持久保存；不根据会话猜测，也不在发送后复位。勾选包含统一协议、项目环境/目录、技能摘要与需求；关闭仅包含需求与显式技能正文。复制与发送共用同一组装入口。

“回车发送”默认关闭，与工具 `automatic` 独立。开启后 Enter 提交、Shift+Enter 换行，输入法组合与重复按键不发送；发送按钮同样受开关控制。用户本地正文经可信编辑器主 frame 的窄 IPC 提交，不读取剪贴板。发送不清空本地需求，保留复制入口。

`LocalPromptController` 校验当前项目、会话、选项与忙状态；`WebComposerSender` 是唯一 DOM 写入运输 owner，与工具结果互斥。只向已识别的官方 DeepSeek 空输入框填入本次文本并点击一次；草稿、生成、未知控件或作用域变化拒绝。取消仅清理未点击的自有文本，点击后无法确认不重试。独立隔离世界 1005 无网页 IPC/文件桥。

本地需求发送与自动采集独立。automatic 开启时，历史基线之后的新完成工具输出可自动采集，不依赖需求发送动作、回执或本地主动首发资格。发送器只在实际点击后允许首页一次同文档官方会话地址分配，以确认发送自身结果，不授予采集资格。采集 watcher 的本地发送记录与官网可信发送共用一次短期首页交接记录；识别交接后清除历史等待，仍独立检查实际新回复是否完成。生成/未知/中断不执行；协议、权限、去重及结果回传来源校验保留。离线测试不证明实际官网全部状态兼容。见 `../adr/2026-10-08-output-driven-collection.md`。
