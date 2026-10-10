---
artifact_type: adr
status: accepted
created: 2026-10-07
updated: 2026-10-10
owner: 胡运宽
source_of_truth: [src/main/toolWorkspaceStatus.ts, src/renderer/toolAttention.js, src/renderer/fileWorkspace.js, src/renderer/editorTabs.js, test/fileWorkspace.test.ts, test/toolAttention.test.ts, src/main/windowLayout.ts, src/main/workspaceLayoutController.ts, src/main/workspaceService.ts, src/main/workspaceController.ts, src/main/settings.ts, src/shared/contract.ts, src/main/preload.ts, src/renderer/workspaceLayout.js, src/renderer/workspaceNavigation.js, src/renderer/index.html, test/windowLayout.test.ts, test/workspaceLayoutController.test.ts, test/workspaceService.test.ts, DESIGN.md]
---

# ADR：多项目导航与 AI 居中的本地工作区外壳

## Context

用户已批准以参考项目的工作区组织方式调整 UI：左侧管理可切换的本地项目，中间展示官网 AI 对话、官网输入框与本地工具状态，右侧提供编辑和 Diff，项目目录树位于最右。用户明确第一阶段不做项目与官网会话绑定；多项目后台并行作为后续独立议题，不纳入本次布局实施。

Electron 官网与本地编辑器必须保持独立渲染进程，不能为方便排版将官网放入 iframe，也不能向官网增加文件桥或任意输入能力。布局涉及多个原生视图、权限入口与持久设置，需要一个统一的几何 owner，避免各视图自行计算造成遮挡或状态分歧。

## Decision

1. 采用“左项目导航、中 AI 协作、右文件区”的职责划分。文件区内文件、可关闭的“工具”与只读“本批改动”共用标签栏和正文，改动标签由右侧工具标签“查看改动”按需打开、可关闭并重新打开，目录树始终位于最右；工具详情放在右侧工具标签，中间官网顶栏显示精简状态及查看入口；按需展开的需求编写放在官网下方 dock，展开后的附件、初始化、权限、自动继续、设置与发送合成一行，窄列换行，官网在常规布局显示，文件区全屏时临时隐藏，官网输入框保持官网自身界面。webbar 提供只读采集、工作区切换、文件区恢复、精简工具状态查询与工具标签打开的窄接口，移除网页显隐按钮、菜单、快捷键与 IPC；本地配色不得修改官网 CSS。
2. 本地 editorView 作为全窗口底层外壳；独立 webbarView、webView、previewView 按主进程计算的精确矩形覆盖其对应区域。previewView 仅覆盖文件正文，不覆盖目录树或顶部标签栏，正文直接接标签栏，不保留第二行项目路径栏；提示词设置视图维持独立覆盖浮层。
3. `windowLayout.ts` 的 `computeLayout()` 是纯几何唯一入口，`WorkspaceLayoutController` 统一应用原生 bounds 并广播。renderer 仅消费矩形、测量 dock 并提交用户调整意图，不再独立建立另一套分栏计算。
4. `workspaceRoots` 独立于最近 5 项的 `recentRoots`，按加入顺序持久保存，Windows 路径大小写不敏感去重。项目根由左侧工作区控制，右侧不展示打开目录、开始编辑及最近目录欢迎页。添加通过系统目录选择，切换与移除使用主进程注册列表的索引；移除只取消注册、不删除文件。活动项目离开沿用未保存确认与现有工具作用域保护。
5. `settings.workspaceLayout` 保存项目栏、文件区和目录树各自的展开宽度与显隐；需求 dock 高度及工具、改动标签当前显示状态是本次运行状态。隐藏不得丢失展开偏好，临时拓宽 Diff 不写入持久宽度。
6. 新布局参数接口仅允许编辑器主 frame 的白名单字段和有限范围数值；webbar 的工具摘要查询及打开入口均为零参数且限本地顶栏主 frame，preview 保留原窄接口。布局移动不改变编辑器根目录权限、工具权限、网页只读采集及唯一工具结果回传边界。
7. 本地主题参考 deepseek-harness 的中性深灰层级，背景、侧栏、控件、悬停、选中及边界统一维护在 `design-tokens.json`；本地页面、Monaco 和提示词设置面板同源取色。
8. 工具标签关闭仅隐藏展示并保留执行、结果与阅读位置。真实新批次开始时，仅右侧文件区已展开且工具页未显示才自动打开工具标签；右侧已折叠则保持折叠，工具页已显示时不重复打开；同批普通进度和成功完成不切换标签；新批准请求、执行失败或回传暂停自动恢复文件区、切换工具并展开相关内容，同一事件仅一次，初始化、历史恢复与重复广播不触发。不主动聚焦批准按钮或重建文件模型。文件区最大化/收起位于标签栏，目录树在自身标题栏收起，隐藏时在标签栏恢复，路径仅在目录面板保留。
9. 一次只有一个当前本地项目和一个官网视图。项目切换保持当前官网对话，不保存或恢复项目会话映射，不承诺后台 AI 任务并行。后续并行需另行决定任务归属、独立网页上下文、迟到结果和回传目标。

## Alternatives Considered

- 仅美化原三列：改动较小，但无法满足用户已确认的多项目导航与 AI 居中操作路径。
- 将官网嵌入本地 DOM：排版较直接，但违反独立渲染进程与禁止 iframe 的边界。
- 为每个项目创建独立官网视图并自动恢复会话：可支撑后续并行，但需处理会话删除、登录、后台生命周期和回传归属，超出本次已批准范围。

## Consequences

项目导航与当前任务区域分离，用户可以方便切换多个注册项目；编辑、工具和 Diff 共享文件阅读空间，最右目录树稳定可达。原生视图覆盖依赖统一矩形与缩放处理，必须通过真实 Electron 检查遮挡、窄窗口、显隐恢复、焦点与浮层。纯几何与 IPC 测试不能替代运行时验收；验证结果记录在任务计划和当次报告中。

单一当前项目模型仍有作用域切换限制，多项目列表不提供每项目独立编辑会话或后台执行上下文。该限制不得在 UI 文案中表述为已经支持并行开发。


文件工作区收起不保留独立窄条，恢复入口并入中间网页顶栏最右侧，透明背景、悬停底色。`ui:restore-file-workspace` 只允许该本地顶栏的主 frame 恢复文件区，不开放通用布局或网页操作。文件区全屏仅更改显示矩形，不导航/销毁官网，不中断工具；退出恢复原宽度、目录及文件／工具／改动显示状态。移除复制上下文菜单与全文复制 bridge，选区浮动按钮仅复制真实选中内容，无全文回退；需要全文时用户在官网描述文件路径，由模型请求本地读取。
