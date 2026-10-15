---
artifact_type: plan
status: archived
created: 2026-10-15
updated: 2026-10-15
owner: agent
plan_readiness: ready
source_audit: docs/audits/2026-10-13-performance-exploratory-audit.md
covered_findings: [PERF-08]
deferred_findings: [PERF-03, PERF-07, PERF-09]
---

# 文件树局部刷新与稳定节点

## Goal And Scope

让已知创建/删除/改名只读取最近可见父目录并复用未变化节点，保持展开、选中、焦点、截断提示及新项目隔离。手动刷新仍重新读取已展开的整树以发现外部变化；项目切换立即移除旧节点。用户验收反馈要求修正树内重命名UI与逻辑，纳入同一树owner、配套fileExplorer.css、直接测试及原生离线测量，不改IPC/磁盘操作/路径校验/权限/整体布局/拖拽入口，也不开展其他性能项。

## Decisions And Code Placement

- 用户授权开始后续优化，本轮承接PERF-08的前端刷新剩余工作，基线master/f9e5ee0；新独立分支codex/20261015-file-tree-refresh。两个既有未跟踪路径保留，不提交/合并/push。
- 复用单一refresh入口，新增可选变化路径缩小读取范围；缺少可见父目录时向上选择已显示祖先，不把未显示目录当作空目录，也不自行拼接未知磁盘条目。主进程listDir的排序、500上限及安全检查保持唯一来源。
- 稳定路径/类型的行复用节点与事件，已删除/变类型子树移除；目录改名仍按已有事件迁移展开路径、选择和编辑缓冲，改名子树可重建，其他分支不重建。手动刷新重新核查所有展开目录，保留稳定节点。
- 项目代次用于reset隔离；目录请求身份拒绝同目录迟到结果且独立目录不会互相取消。节点移除后旧请求不得复活旧子树，A→B→A也不能恢复旧节点。复用节点事件必须读取当前代次，不能闭包绑定首次渲染代次。
- 聚焦只针对树内原焦点，不把用户等待期间已转移到编辑器的焦点抢回；未变分支节点不移动/移除。原有树菜单、键盘、原生拖拽和创建失败反馈保持。
- dev-split: local cleanup / no split。fileExplorer是树状态owner，新增记录/请求身份仍归该owner；不在renderer.js复制树状态，不加通用缓存管理器，不机械拆分。若新增逻辑演变为独立跨树状态服务，停止扩展并重新评估。
- ADR不需，无新权限、数据格式或架构；前轮刷新优化无视觉规则变化。本轮重命名反馈复用原名称输入owner与token，并在DESIGN补齐原位编辑交互规则。新增记录仅是当前DOM的对应关系，不跨目录/项目保留权限或路径安全结论。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| TR-1 | done | 当前刷新基线及调用链 | 旧源码快照原生测4分支×100文件：单项变化均5次读取、约4000元素；创建无广播/改名删除有事件调用链已核对 |
| TR-2 | done | 稳定节点与有界刷新范围 | 局部只读最近可见父目录；稳定记录与目录请求身份，手动保留全部展开读取；创建及事件回执单路接线 |
| TR-3 | done | 竞态/交互回归及原生测量 | 原生36项、针对性29项通过，涵盖并发/交错/关闭重开/改名删除/ABA/焦点滚动接管/读取失败继续/截断/变类型；真实工作区119项通过 |
| TR-4 | done | 构建、全套及独立评审 | 类型/作用域/构建、完整并发4条件1183项、自检159项、工作区119项与布局10项通过；文档/校验/独立评审收尾，待用户验收 |
| TR-5 | done | 验收反馈：重命名原位编辑及事件隔离 | 33针对性、47真实聚焦原生、1187完整测试无跳过及119实际工作区功能通过；布局5/10失败单独记录，未扩展修复缩放 |

## Acceptance Criteria And Closeout

相同数据集单项变化只读取受影响最近可见父目录，其他分支读取/节点重建均0；未变节点身份和焦点保留。手动刷新能发现其他分支的外部变化，不能以少读隐藏变化。所有实际文件访问仍经原IPC与FileService。报告读取/创建次数及原生交互，不将DOM夹具耗时称为实际项目FPS。完成后active待验收，验收归档；原审计按PERF-08验证范围更新，旧缩放检查限制仍保留。

## Verification Record

- 生产基线master/f9e5ee0；旧脚本快照C:/WINDOWS/TEMP/mini-file-tree-baseline-source。正式计数报告C:/WINDOWS/TEMP/mini-file-tree-before-final.json（旧快照measure，三操作仅验证数据变动有效，不把新行为断言称为旧版通过）、C:/WINDOWS/TEMP/mini-file-tree-final2.json（最终生产hash 7b98feb2910032312edcfc30ac79e1075a1e337ef23584a1decca556c7845c2a，36项通过）。
- 四个展开分支、每分支100文件：创建/删除/改名读取次数均5→1，创建元素4046/4026/4036→10/0/10；未变分支行/选中/焦点均保留，旧版会重建。生产脚本/CSS与真实Chromium DOM，但目录桥为内存，不测实际文件系统、IPC、FPS或安装版速度；报告elapsedMs含夹具等待，不能算提速。
- 删除视口上方一行时scrollTop由420变390.67，是Chromium自然锚定；可见锚点相对位置仅约0.33px差，创建/改名锚点不变。等待期间用户scroll至750或转入外部输入框，最终保持，不强制复原旧scrollTop。
- 原生首次严格scrollTop相等断言失败，按实际阅读意图改为可见锚点位置与焦点；未新增强制滚动。完整/局部交错曾发现旧full继续派发b/c/d，原始失败保留C:/WINDOWS/TEMP/mini-file-tree-after-interleave-failure.json；修复为失效子请求向上撤回、祖先不续派，单元与原生均覆盖。普通读取失败另用null区分，失败目录保留内容且完整刷新继续其他分支。
- 直接单元新增8项，文件树15/15；与文件管理/工作区控制共29/29。完整`pnpm exec tsx --test --test-concurrency=4 "test/**/*.test.ts"`1183/1183，0失败/取消/跳过（约78秒），日志C:/WINDOWS/TEMP/mini-tree-full-tests.log。类型/构建/renderer作用域检查通过，裸未绑定0；没有新增依赖。
- `pnpm exec electron . --workspace-probe`119/119功能及10/10布局、exit0，日志C:/WINDOWS/TEMP/mini-tree-workspace.log；实际IDE覆盖真实文件创建/读写/改名/回收站/永久删除及主进程事件。`pnpm exec electron . --self-test`159/159、PASS、exit0，日志C:/WINDOWS/TEMP/mini-tree-self-test.log。
- 旧阶段缩放检查5/10失败的历史记录保留；本轮同一完整工作区命令10/10通过，但没有修改缩放实现，不声称定位/修复历史根因，也不保证任意环境稳定通过。
- 前轮刷新优化的Design system check：复用既有树DOM/图标/ARIA/键盘/菜单/原生拖拽和焦点规则，无样式/token/布局变化。其后的重命名反馈变更见下节。ADR不需，权限及IPC稳定。Changelog/Distill更新local-file-access、context-map与原审计，计划active待验收，禁止自动提交/合并/push。
- 独立只读评审最终通过（mode: subagent）：计划符合、审计覆盖、改动范围、验证证据、设计规则、变更记录、知识收尾及文档检查均pass，无剩余阻断项；已复核源码hash、36项原生报告及1183项无跳过完整测试证据。用户验收仍待完成，本轮未提交或合并。

## 验收反馈：原位重命名

用户截图显示重命名输入位于目录顶部，目标行仍存在。代码确认rename复用新建条目的prepend输入，键盘冒泡也会误触行Enter/空格动作。本轮替换为目标行名称编辑，保留原图标/缩进/顺序/行高；文件选主体、文件夹全选，Enter提交、Esc或失焦取消，原名确认不IPC，错误原位可修改，组字事件不提交。提交中只读以保留焦点，并防重复提交与假取消。创建入口与主进程安全校验不扩展。

dev-split仍为local cleanup / no split，原名称输入owner承担单一交互，不拆通用组件；DESIGN记录当前树名称规则，颜色/边框复用现有token。本次视为当前未提交任务的用户反馈，沿用分支，原未跟踪文件不纳入。

- 最新生产hash：6632357b88b04297373f557e2ad9d94af9a2a9337124c01488c201a81fdac46a；构建/类型/作用域通过，日志C:/WINDOWS/TEMP/mini-tree-rename-build-final.log。33项针对性通过；最终完整并发4测试1187/1187、0失败/取消/跳过，日志C:/WINDOWS/TEMP/mini-tree-rename-tests-final.log。
- 离线原生真实聚焦窗口47/47通过，C:/WINDOWS/TEMP/mini-file-tree-rename-final3.json与同名PNG：原行位置/图标/选区/行高、组字、点击空格、原名确认、重名后修正、Esc、失焦和底部240px窄树错误可见性。截图已目视核对中文文件在原行编辑、扩展名未选中。目录桥仍为内存，不宣称安装版速度或磁盘性能。
- 首轮隐藏原生窗口不派发真实blur，误报失焦取消失败；改为真实显示聚焦后该项通过。加入生产token与tree类后的真实行高检查发现约1.83px额外高度，以名称容器flex对齐修复；底部错误原先可能裁切，现仅在本名称输入owner按树及父容器可用空间向上定位并限高滚动。
- 实际IDE工作区119/119功能通过，覆盖真实改名与未保存内容保留；缩放布局仅5/10通过，完整命令exit1，日志C:/WINDOWS/TEMP/mini-tree-rename-workspace.log。viewportReady及需求dock高度检查失败与前阶段记录的现象一致，本轮未定位其根因或修改缩放实现，不把整体验证报为通过。前轮10/10通过记录保留为历史样本。
- 独立只读复审已复核原位改名、pending/readonly、项目隔离及47项原生证据，无新增生产阻断；DESIGN/Changelog/能力文档与计划同步，待用户验收，未提交/合并/推送。
- 最终独立门禁：mode=subagent；plan compliance/audit coverage/related changes/design/changelog/distill/check均pass，verification evidence因完整工作区exit1为fail。本轮相关单元与原生证据通过，无新增代码阻断；可交用户验收，但提交前仍需处理或明确接受5项布局检查失败限制，不得将所有门禁报为通过。

## 最终验收与归档

2026-10-15，用户在已告知5项缩放布局检查失败、其余验证范围及尚未提交状态后回复“通过，可以提交收尾合并”。本轮文件树局部刷新与原位重命名验收通过，按该授权提交并合并到master，计划归档。已知缩放布局限制按accepted_risk保留，本轮不修复、不把完整工作区命令改报成功；其余PERF-03/07/09仍由原审计保持open，不随本计划关闭。用户既有未跟踪文件不纳入提交，不推送远程。
