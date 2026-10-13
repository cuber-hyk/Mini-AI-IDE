---
artifact_type: adr
status: accepted
created: 2026-10-13
updated: 2026-10-13
owner: 胡运宽
source_of_truth: [src/main/webComposerSender.ts, src/main/composerDraftBackup.ts, src/main/index.ts, src/main/tools/integration.ts, src/main/tools/resultReturn.ts, test/composerDraftBackup.test.ts, test/chatgptComposerSender.test.ts, tools/verify-chatgpt-composer.cjs]
---

# ADR：ChatGPT 工具回传前备份并替换纯文本草稿

## Context

用户明确授权：ChatGPT自动工具回传遇到已有纯文本输入时，先给用户留底，再用当前工具结果替换，以减少已有草稿阻断连续协作。已有不覆盖草稿约定需为这个受控来源增加明确例外；真实用户编辑、附件、未知网页结构及点击后不确定不能因此失去保护。

## Decision

1. 仅WebComposerSender当前有效ChatGPT工具结果/诊断运输有备份替换资格。用户主动本地需求、DeepSeek和ChatGPT程序附件仍无此资格；不新增任意正文入口或剪贴板读取。
2. 原文从唯一已知ProseMirror/FORM中以现有纯文本reader读取（包含已核验、仅允许class及data-prompt-literal-paste属性的粘贴文本SPAN，以及无属性STRONG中的递归纯文本）；备份保留可见输入中的全部正文及空白，不取隐藏编辑器的内容。未知节点、正文丢失、超过1MiB、无当前项目或不可编辑时暂停，不以任意innerText/HTML猜测草稿。采集与动作监听世界1004继续不读取用户输入，运输世界1005在本次准备阶段读取必要纯文本。
3. 先在世界1005冻结原输入/FORM、文本和一次token，安装真实编辑接管处理器，不改输入。主进程ComposerDraftBackup核验并保存成功后，主进程再次核对当前项目/会话/批次资格；一次恢复脚本复核原输入/FORM、纯文本字节、附件和生成状态，全部仍有效才填入并发送一次。真实编辑即使文本相同也作废本次覆盖，保存成功不重新授权；取消或导航不补发。
4. 当前项目`.mini-ai-ide/composer-drafts/`仅保存独占创建的UTF-8 TXT原文；专用归属标记及.gitignore拒绝冲突/未知目录，祖先链接与真实路径别名拒绝。文件名使用UTC时间、规范化会话hash摘要、随机ID，不记录原会话ID。写入sync并核对字节/路径后才返回；不修改项目.gitignore，不覆盖历史备份、不自动清理。
5. 保存失败或不确定时保留官网原草稿并暂停。备份期间用户编辑、节点替换、附件/生成/作用域变化同样不覆盖。填入后的取消仍只清理自有文本，备份保留供用户人工恢复；点击后不重试或清理可能已发送内容。工具结果状态显示已取得的备份绝对路径，不把草稿写入日志、工具结果或系统剪贴板。
6. 网页无本地文件桥、任意IPC或磁盘路径查询。备份服务只由受控发送器的主进程调用方注入，所有DOM写入仍归WebComposerSender；官网业务网络仍由Chromium发出。
7. 已保存且当前发送资格有效的草稿，通过编辑器专用单向通知交付当前项目、工作区版本和备份相对路径，不交付正文、不增加invoke或官网桥。编辑器核对作用域后自动打开实际TXT、显示已保存提示，每份一次，不主动聚焦或覆写其他编辑缓冲；打开失败保留路径提示，不使网页发送失败或重试。此通知在覆盖前发出，界面展示异步进行，发送不等待文件打开。

## Alternatives Considered

| 方案 | 取舍 |
|---|---|
| 遇到任何草稿都暂停 | 保留每轮干预，但已有纯文本持续阻断结果回传；用户选择先落盘再替换 |
| 只复制草稿到剪贴板 | 后续工具结果自动复制可能覆盖留底；采用文件备份，剪贴板行为不变 |
| 不备份直接覆盖或编辑后继续覆盖 | 会丢失新需求并打断真实介入；先备份，真实编辑继续暂停 |
| 发送失败后恢复草稿或重发 | 无法可靠区分已接收与未接收，也可能覆盖之后输入；人工恢复，不重试 |

## Consequences And Limits

用户获得项目内持久草稿留底，可能累积磁盘和私密正文，由用户自行管理；不包含附件、图片或未知富文本原子节点。目录和文件检查不提供跨进程文件锁，Node路径API不能彻底消除其他进程恶意替换祖先的竞争；发现变化则不覆盖官网，失败可能留下备份/初始化文件。运行权限仍不高于当前账户。

## Verification

真实文件系统测试覆盖UTF-8原文、独占多份/项目隔离、标记冲突、链接、无项目和超限。原生离线composer验证先保存后写入、备份失败及竞争不覆盖、取消及真实编辑见证不补发；类型/构建/全量与独立评审证据记录于归档计划`../plans/archived/2026-10-13-chatgpt-composer-draft-backup.md`。用户已在普通ChatGPT会话确认自动回传成功，备份位于当前项目composer-drafts；逐字及竞争保护由离线反例验证。

自动展示增强另见`../plans/archived/2026-10-13-composer-draft-feedback.md`：用户确认自动打开备份TXT、内容完整、保存提示、焦点保持及连续自动回传均符合预期；全量1000项、原生57项及独立34项验证通过。
