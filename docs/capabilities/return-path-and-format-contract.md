---
artifact_type: capability
status: current
updated: 2026-10-08
owner: 胡运宽
source_of_truth: [docs/capabilities/skills-and-local-prompt.md, src/main/localPromptController.ts, src/main/skills.ts, src/main/webComposerSender.ts, docs/adr/2026-10-06-native-tool-harness-boundary.md, src/shared/toolProtocol.ts, src/shared/formatSpec.ts, src/shared/returnPath.ts, src/main/replyCollector.ts, src/main/tools/changes.ts, src/main/tools/changeReview.ts, src/main/tools/integration.ts, src/main/returnPathService.ts, src/main/previewPreload.ts, src/main/fileService.ts, src/renderer/preview.js, src/renderer/editorWorkspace.js, test/replyCollector.test.ts, test/toolProtocol.test.ts, test/toolChanges.test.ts, test/formatSpec.test.ts, test/toolSamples.test.ts]
---

# 能力：工具修改与变更查看

## 职责与唯一输出

AI 的实际文件读取、修改和命令统一输出一个顶层 mini-ai-tools JSON 批次，格式、参数及拒绝规则由 shared/toolProtocol.ts 定义。普通解释、讨论和引用资料不执行。手动采集也拒绝旧文件操作文本，不退回另一条可写盘协议；网页独立、无文件 IPC，采集只读；开启自动继续时按限定回传边界发送真实工具结果，关闭或暂停时粘贴与发送由用户完成。九类工具及权限见 tool-harness.md。

apply_changes 使用 changes，每项含 path 和 operation。replace 提供 edits 中的 old_string/new_string；create/overwrite 提供完整 content，可为空。替换原文必须非空、真实、唯一且不重叠；同文件所有修改集中在一条请求。JSON 字符串正确转义换行、引号和反斜杠，正文按字面保存。

同批次路径及真实目标别名冲突先检查，在任何请求产生副作用前拒绝。依赖只决定前置成功后的执行顺序，不提供输出插值。需要读取或进程 ID 时，AI 应先请求工具，等 IDE 自动回传或用户手动返回真实结果后再生成下一批。

replyCollector 只读还原代码正文及语言：读取 code/pre 的 language-* 类名，或同一单代码框内、正文之前的独立工具栏语言标签。到回复根或多个代码框边界停止，不从正文提及、普通 JSON 或其他代码框补写正式协议。缺少明确语言仍作为资料。

## 复制与提示词

选区和全文输出只读上下文头，保留当前 Monaco 草稿、空白、空文件及末尾换行，不含执行操作或定位行号。复制全文不暗示覆盖。实际读取工具使用磁盘内容，AI 必须区别草稿与执行时原文。

shared/formatSpec.ts 是唯一默认来源：简洁版 6 个示例、完整版 14 个示例均使用工具协议，普通讨论示例只含解释。构建生成 formatSpecDefaults.js。菜单复制格式要求与本地需求提交经过同一个有效格式入口，始终保留强制执行协议。

自定义设置与两版草稿原文独立保存；有效提示词将其逐字附为补充，不能取消执行协议或权限管理。恢复默认由用户保存；新版要求由用户手动粘贴到已有网页对话，IDE 不改写或重发历史回复。

## 修改 owner 与原文基线

tools/changes.ts 将工具参数转换为 ReturnPathService 的内部编辑模型。内部模型用于计算、基线和撤销，不是第二套 AI 回复格式。定位仅统一 CRLF/CR/LF，不忽略空白、缩进或 Tab，不进行模糊、全部匹配或自动剥行号替换。未修改部分保留原字符，替换文本采用原文件换行风格。零次或多次匹配要求重新获取原文或补上下文。

本请求先准备全部变更，再处理所有真实目标别名对应的未保存内容，然后逐项写入。准备冻结原文及根目录版本；应用复核，不能把外部变化临时接纳为新基线。用户继续则采用 AI 结果 C，替换草稿 B；停止保留磁盘 A 与草稿 B，不先保存 B、不合并 B。处理策略可保存。

已有文件使用 r+ 打开并复核预期原文、文件身份及目录版本，不静默重建消失目标。新增排他创建，并逐级检查父目录、链接、越界及身份；外部授权目标使用隔离 FileService，不扩大编辑器文件桥。文件查询、修改及目录切换通过 WorkspaceController 的明确 owner 管理。

## 更新编辑器与撤销

成功写盘后通知打开文档及真实路径别名，刷新内容和目录树；只有用户批准替换草稿时允许丢弃旧草稿，异步读取期间的新编辑仍需保护。失败保留真实错误和已经完成的写入事实，不假称跨文件原子提交。

工具修改保留最多 20 项内存撤销，使用唯一源身份避免撤销另一条人工变更。已有文件撤销复核当前内容为此次 after；新增撤销核对文件和本次创建目录身份，只移除匹配的文件及空目录。失败保留快照，部分清理错误明确返回。未保存内容、项目或会话切换不能被撤销绕过，撤销不跨重启保存。改名／删除移除相关路径及后代的撤销记录，其他目标仍可撤销；已完成的执行快照继续呈现原事实。旧会话未启动的排队修改拒绝执行，已启动修改的迟到写入不进入新会话撤销记录。

## 本批实际变更查看

`apply_changes` 按预选权限直接执行，右侧展示执行时捕获的真实 before/after 与差异。查看不再要求用户应用，不提供改路径、重新应用或编辑器内联预览，不打开或替换左侧当前文档。每项显示待执行、已修改、失败、未执行或已撤销；部分写入保留各项真实结果，失败项不伪造成功快照。

`ChangeReviewOwner` 只持有当前项目、会话和批次的内存快照；新轮、切换项目／会话或销毁清理，迟到事件按代次拒绝，后续编辑不污染已捕获的差异。不重新读盘猜测修改前内容，不持久化源码，不把查看快照放入 `tool_results`、剪贴板或去重账本；授权的外部文件只展示该次工具记录，不扩大编辑器文件桥。

右侧按目录／文件分组并支持路径筛选，选中后可查看差异、修改前或修改后全文；统计来自实际 diff。`review:get-state` 和 `review:state` 提供快照查询与广播，仅对应本地查看视图；`review:undo` 复用原工具撤销 owner，不产生第二个文件写入入口。按钮撤销最近一次工具修改，沿用同项目／会话内最多 20 项的撤销栈，不是选中条目的重写入口。撤销后同步已撤销状态，快照仍用于查看原执行事实。批次 ID 内容冲突或执行前停止时，待执行项明确显示未执行，不永久等待。

## 验证与限制

formatSpec.test.ts 实际解析并执行示例的查询和修改；toolProtocol/toolIntegration 回归验证手动入口不接受旧格式；toolChanges/FileService/ReturnPathService 测试验证原文、别名、草稿、写入与撤销。docs/工具调用测试样例.md 提供 35 场景，toolSamples.test.ts 直接读取其原文并实际执行关键工具。

离线样例不能保证任意网页版本的结束状态或模型遵守率，权限弹窗、Monaco 草稿和真实网页需手测。原文核验不提供跨进程文件锁；逐文件写盘后遇到系统错误可能部分成功。唯一匹配证明定位，不能证明生成代码符合用户需求。
