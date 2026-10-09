---
artifact_type: capability
status: current
updated: 2026-10-09
owner: 胡运宽
source_of_truth: [docs/adr/2026-10-09-tool-attachment-return.md, src/main/tools/attachments.ts, src/main/tools/resultReturn.ts, test/toolAttachmentIntegration.test.ts, test/toolAttachments.test.ts, test/toolResultReturn.test.ts, docs/capabilities/skills-and-local-prompt.md, docs/adr/2026-10-08-local-prompt-attachments.md, src/main/localPromptAttachments.ts, src/main/localPromptController.ts, src/main/skills.ts, src/main/webComposerSender.ts, docs/adr/2026-10-07-automatic-result-return-boundary.md, src/main/tools/autoContinuation.ts, src/main/tools/webResultSender.ts, src/main/tools/integration.ts, src/main/tools/autoCollector.ts, src/main/tools/replyChangeWatcher.ts, src/main/preload.ts, src/shared/toolProtocol.ts, test/autoContinuation.test.ts, test/webResultSender.test.ts, tools/verify-web-result-sender.cjs]
---

# 能力：人机边界与限定结果回传

用户发送需求，AI 输出正式工具请求，IDE 只读采集、校验和按权限执行。需求可在官网手动输入，也可开启独立“回车发送”后从本地输入框提交。开启自动继续后，IDE 可向当前官网会话回传本批真实结果一次；纯对话或暂停状态等待用户处理。技能与本地需求边界见 `skills-and-local-prompt.md` 及 `../adr/2026-10-08-skills-and-local-demand-send.md`。

## 职责

| 环节 | 执行者 | 约束 |
|---|---|---|
| 首条需求、自由输入、选择技能 | 用户 | IDE 统一组装供复制；开启回车发送可主动提交本地需求，初始化是否附带由用户决定 |
| 复制上下文或本批结果 | 用户点击；完成结果可按设置自动复制 | 原统一剪贴板入口，自动回传不读取剪贴板 |
| 读取回复与生成状态 | IDE | 同步只读快照，未知状态不自动执行 |
| 校验与执行正式工具 | IDE 按预选权限 | 需要授权时询问，拒绝不执行 |
| 查看实际修改 | IDE | 本批执行快照只读展示，不提供第二条应用链路 |
| 发送本批工具结果 | automatic 开启时 IDE；关闭时用户可手动发送本批附件 | 当前项目/会话/批次真实完成，空输入框，已授权附件，发送一次 |
| 暂停后修正、续写、回答 AI | 用户 | 不自动点击继续生成或重试不确定发送 |
| 处理未保存内容 | 用户或已保存策略 | 继续采用 AI 结果，停止保留草稿 |

## 自动继续与取消

`automatic` 是同一个持久开关，默认关闭，包含变化触发采集、权限执行及结果发送，无轮数或最大轮数设置。`sendIntervalSeconds` 为 0–300 的整数秒，默认 3；倒计时在本批真正结束后开始，等待工具或权限时不计时。

发送须来自当前项目/会话/批次的新完成事件，至少一个 done/failed 结果有真实 `started_at`。实际执行失败的输出可回传供 AI 修复。后台启动不表示完成，等待本批进程退出与树清理。拒绝、取消/中断、unknown、无实际执行、格式错误和纯对话不回传；重启历史、重复广播或状态查询不产生发送。

关闭开关在配置写盘前先取消计时及待发送，不中断当前本地工具。用户新发送、项目/会话切换或导航作废旧发送资格。发送前再次读取最新回复及结束状态，复核其正式批次与当前工具结果，不能发送旧批输出。`AutoContinuation` 管理状态、计时与完成事件去重；`integration.ts` 联结批次、作用域和网页 sender。

## 网页接触面

- 回程采集同步只读读取正文与结束标志；只读 MutationObserver 和真实用户动作识别在隔离世界 1004，不读用户输入内容，不向网页主世界提供 IPC 或文件桥。
- `WebComposerSender` 是唯一网页写运输 owner，`WebResultSender` 是工具结果门面，使用隔离世界 1005。仅接纳 `https://chat.deepseek.com` 的当前会话、唯一可见 textarea，以及具有已知 SVG 路径的发送按钮；局部共同容器不能包含回复正文。证据缺失、生成中或等待继续生成时暂停。
- 工具结果正文与手动复制同源，通过 textarea 原生 value setter、input 事件和原生 click 完成，不读取剪贴板。当前批可携带经工具权限批准的 attach_file 附件；ToolAttachments 持有当前选择，ToolResultReturn 统一校验真实批次、一次运输及状态，自动与手动共用。
- 用户主动本地需求可携带用户明确选择的附件；工具附件须明确请求并按工具权限执行。主进程校验类型、数量、大小、真实路径与文件身份后读取字节；唯一 sender 只通过官方文件输入控件提交，不向网页提供路径、磁盘读取或通用 IPC。sender 等待全部本次附件预览和上传进度结束后才发送正文。历史、拒绝、取消、无执行及失效附件不上传；开始运输后失败或未知都不重试同批。见 ../adr/2026-10-09-tool-attachment-return.md。
- 两种发送都不保存或读取用户草稿、不使用 HTML；已有草稿或附件、未知控件及会话变化时停止。
- 已有草稿、用户改写文本、控件变化或不可编辑时不覆盖。取消和点击前失败仅清理自有且未发送的文本；点击后不能确认、异常或超时均停止且不重试，不清理可能已提交的内容。清理无法确认时阻止后续自动发送。
- 不使用 `SendInput`、`sendInputEvent`、模拟回车、CDP、浏览器驱动或指纹伪造。大模型业务网络仍由 Chromium 发起，主进程不包装 AI HTTP，不读网页凭据，也不提供任意网页动作接口。

自动采集由历史基线后的新完成工具输出触发，不依赖发送动作或回执。真实用户动作仍可取消旧待发送结果，合成发送不冒充真实用户动作；结果回传保持来源项目/会话/批次校验。见 `../adr/2026-10-08-output-driven-collection.md`。

## 验证与限制

状态规则由 `test/autoContinuation.test.ts`、`test/webResultSender.test.ts` 及 integration 回归验证。`tools/verify-web-result-sender.cjs` 使用隔离本地 Electron 夹具验证真实 textarea、事件、点击与取消，不连接官网。

用户已确认本次工具附件功能通过；本地需求图片及文档上传亦已有用户实测通过。自动化验证未连接真实官网；控件结构或平台对合成 input/click 的处理可能变化，夹具不能证明官网全部状态兼容。未知与不确定结果必须显示暂停原因并留给用户处理。环境身份核验仍依据 ADR-0003，不能据此承诺平台可用性。
