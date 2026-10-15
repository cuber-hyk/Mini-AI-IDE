---
artifact_type: plan
status: archived
created: 2026-10-15
updated: 2026-10-15
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# ChatGPT 本地需求与工具附件

## Goal

在普通ChatGPT会话中，使用户本次选择的本地需求附件、当前授权工具批的attach_file附件，经官网上传控件确认接收后随正文只发送一次；两入口保持DeepSeek现有权限和取消边界。

## Scope And Decisions

用户要求两入口像DeepSeek一样支持。复用LocalPromptAttachments、ToolAttachments、ToolResultReturn、既有自动/手动发送资格及WebComposerSender；用户截图只作为诊断证据，不执行图中命令。文件类型、单文件100MiB和数量50的本地暂存上限沿用现值，官网实际限制和拒绝须显示真实失败；128MiB是本地文档预览上限，不改变上传限制。

仅普通首页和/c/<id>。不扩展GPTs/项目路径、不引入网络上传API、Node HTTP、驱动、模拟drop或额外网页写入owner。用户手动JSON批仍不向官网上传附件，权限拒绝、旧批和未知提交不补发。附件运输要求官网输入为空且没有既有附件；ChatGPT纯文本工具结果的草稿备份继续保留，附件批不覆盖或备份已有草稿。

## Readiness And Code Placement

已完成官网只读结构核验：空输入、图片上传中/就绪、图片与文档同时就绪。上传失败尚无官网样本，已知告警/错误结构及无法识别的附件均暂停，离线覆盖错误与取消清理；不以构造样本声称官网错误状态验收完成。

dev-split: no split，保留运输状态、写入与取消在webComposerSender.ts唯一owner；复用chatgptPage.ts承载只读附件结构解释。分块组装、文档/token守卫和现有入口复用，未新增独立状态机或写入owner。只读工具归tools/inspect-chatgpt-attachments.js，显式诊断接线复用tools/chatgpt-ide-preview.cjs。文件读取与权限不放入渲染器或诊断脚本。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| CA-1 | done | 核对现有禁止入口、暂存与发送owner | localPromptController、index平台门禁、integration两处工具门禁及sender明确拒绝；当前附件未上传 |
| CA-2 | done | 只读附件结构诊断与真实官网核验 | 官网手动图片和文档均已添加、未发送；唯一通用文件控件、进度与两类附件卡结构已核对；失败未知结构暂停 |
| CA-3 | done | 在唯一sender适配有界附件运输 | TXT及修复后的PDF＋图片由IDE实际发送，用户确认验收通过；数字编号双向唯一核对及其他边界由回归覆盖 |
| CA-4 | done | 接通本地需求和工具附件两入口 | 选择/拖入/粘贴、ask/rules/full、自动/手动、拒绝及平台失效等55项入口测试通过 |
| CA-5 | done | 生命周期、取消与回归评审 | 编号修复后全量1161/1161、ChatGPT原生77/77、sender单元13/13、DeepSeek原生39/39及独立复评通过，0跳过 |
| CA-6 | done | 文档和现场验收收口 | 用户验收通过并明确批准收尾、提交和合并；能力/ADR/CHANGELOG同步，计划归档 |

## Acceptance Criteria

- 两入口共用同一发送运输，纯文本与DeepSeek行为不回退。
- 空输入和无既有附件、官方普通会话、唯一受约束上传控件是前提；附件批直接拒绝已有草稿，纯文本工具结果继续按原规则备份。
- 上传就绪依据必须来自本次附件的官网接收/完成状态，不能把input.files赋值、文件名文字或固定等待时间单独当成功。
- 上传开始后不自动重试，未知点击不重发，未确认清理不伪报清理成功。
- 诊断不记录正文、文件名、文件内容、路径、图片URL、会话ID或凭据，不改变输入或上传文件。

## Artifact Routing And Closeout

ADR gate: needed，扩展已接受的限定发送、平台附件与草稿处理边界，先有真实结构事实再更新推荐能力。不另建旁路协议。能力更新web-platforms、skills-and-local-prompt、human-machine-boundary、tool-harness及context-map；验证在相关owner测试和原生ChatGPT夹具。新计划在所有步骤及用户验收收口后归档；本任务不提交、合并、推送或发布既有未跟踪原型/AI临时目录。

## Verification Record

以下为各阶段过程证据，最终结论见“验收与收尾”。

- 定位三层主动拒绝（本地需求、工具integration、sender）；附件尚未进入实际上传，不属于截图命令内容或文件读取失败。
- 独立分支codex/20261015-chatgpt-attachments从982ba01建立，既有原型与AI临时目录未改。
- 原生离线62/62通过（原有59项及新增3项），0失败：官方普通会话诊断、外置文件控件与有回复FORM拒绝误判、无正文/文件名/原始属性值输出、MutationObserver零变更，以及膨胀结构截断。日志C:/WINDOWS/TEMP/mini-chatgpt-attachment-diagnostic-native-bounded.log；不表示真实上传已验证。
- 只读输出限制文件控件16、composer4、祖先8层、属性名24项且每项80字符、表单扫描摘要240节点、进度/告警各16、树180节点及7层；超限提供truncated，不作为完整结构证据。新启动的专用诊断日志按进程独立文件、80条及2MiB上限保留，未删除历史诊断。
- 独立复核提出的输出/日志无界风险已补限制并新增原生回归；诊断阶段最终review/scope gate为pass。日志名含PID和启动UUID，避免PID复用时追加旧文件。诊断阶段仅检查文档与语法，后续功能验证见下。
- 使用独立profile的诊断窗口取得官网事实：唯一可见ProseMirror归属form[data-chatgpt-composer]；4个同属FORM的隐藏文件控件中，唯一multiple且无accept者为通用入口。官网接收后input.files清空，不能据此认定附件消失。图片卡为DIV/role=button/aria-haspopup/data-state=closed及已解码data:image；文档卡为SPAN、精确文件名及可选ready缩略图，文档缩略图不能计作图片附件。移除按钮前缀为“移除”；上传中有role=progressbar，就绪消失，混合卡就绪时唯一发送按钮启用。
- 用户已用官网入口手动选择图片和文档，明确未发送。结构证据不等同程序上传或取消闭环；官网程序运输及现场验收仍待验证。
- 用户反馈没有看到窗口，已通过诊断程序既有second-instance唤起，确认Mini-AI-IDE主窗口句柄非零。运行窗口是在日志字节保护修订前启动，保留旧writer的80条限制；按需加载的附件只读脚本已更新为有界输出。未强制重启或清除用户登录资料。
- 两入口55/55、sender单元12/12、文档隔离恢复10/10通过。最终全量1157/1157通过，0失败、0跳过；ChatGPT原生离线73/73、DeepSeek原生离线39/39通过。覆盖逐字节文件运输、4控件唯一目标、消费后清空FileList、图片/PDF/DOCX/混合附件×需求/结果、延迟进度、用户接管、异步取消及失败清理、已点击未知不重试。日志C:/WINDOWS/TEMP/mini-chatgpt-attachments-native-final.log、mini-chatgpt-attachment-full-tests-verified.log与mini-chatgpt-attachment-deepseek-native.log。类型检查、构建、renderer作用域和文档校验通过。
- 首轮全量1157项中2项失败：取消/清理改为异步后，文档隔离VM夹具仍比较Promise与同步值；测试补await，保持“拒绝旧nonce、零DOM操作”业务断言后通过。收紧附件reader的中间原生回归暴露未知无type移除按钮遗漏，纳入unknown检测后最终73项全部通过，未删除或放松旧保护。
- 独立功能评审发现CAF-01（P1）：纯文本预检遗漏FileList清空且无缩略图的手动文档卡；已统一复用附件reader，需求/结果/草稿备份三个入口均验证零写入、零点击、零备份。CAF-02（P2）：取消异步等待期间提前释放监听可能清空用户新文件；已保留接管监听至清理成功，并持续核对文件身份、FORM和会话，可信接管及单独FileList变化均保留现场。两项修复及新增回归经独立只读复核通过，无剩余代码阻断。
- review mode=subagent；plan compliance、audit coverage、related changes、verification evidence、changelog/distill/check均pass。Design system gate不涉及新设计规则：仅启用现有附件交互，没有新增布局或组件。官网程序运输及连续回传尚未验收，CA-6保持待办，计划不归档。
- 为加载新代码关闭独立验收窗口后，确认本次33796诊断进程无窗口但未退出，只结束匹配本仓库helper路径的该进程后重开；未结束安装版或其他窗口，沿用独立profile。未发送的测试附件需重新选择。
- 现场反馈：有内容TXT已由IDE附加并发送到官网；0字节TXT在本地暂存按现行规则拒绝、未上传，错误被Electron包装及泛称“重新添加图片”遮盖。已修错误展示并保留真实原因、失败阻断与既有附件语义，选择/拖入及空文件原子拒绝等32/32相关测试通过。未修改空文件规则。
- PDF＋图片实际上传出现超时，正文未填入。结构日志记录先2个进度、再1个、最终0个，PDF缩略图ready、图片可解码、发送按钮启用；不能归结为单纯上传慢。文件名精确匹配或其他就绪条件仍待进一步核验，不放宽发送保护或盲目延长等待。用户已手动移除或关闭，原现场不可重读。
- 新增只读nameShape诊断，仅返回移除标签与卡片文本/标题的比较布尔值及白名单扩展名，不保存文件名、正文或属性原值；无需重启独立窗口，待用户重新添加官网附件再取证。现阶段仅TXT实际发送验收通过，混合附件及工具附件官网闭环未通过。
- 用户先将附件重新添加到底部需求框，已核对位置后转为官网重新添加。新增只读运行态比较，将唯一sender持有的期望元数据与当前卡片仅作布尔比较，不输出名字或字节，也不调用发送或清理。用户确认PDF同一路径；期望名称61字符、官网显示64，原文件stem和.pdf保持相同，扩展名前增加ASCII数字编号，旧匹配false。当前全部卡ready、无进度/错误、按钮启用，因此是名称身份判断遗漏。
- 新增CHATGPT_DOCUMENTS_MATCH作为发送/清理共用只读核对：完整原名，或同时出现在移除标签与卡内文本的原stem＋数字编号＋原扩展名；双向唯一才接纳，任意前缀、错误扩展、非数字和歧义暂停。构建后新规则对当前官网真实卡只读核验ready=true、ambiguous=false、matched=1，未运输或修改用户已添加附件。新增回归及独立复评进行中；实际程序重发仍待新版窗口验收。
- 编号修复回归最终全量1161/1161、ChatGPT原生77/77、sender单元13/13通过，0失败和跳过；类型、构建、作用域检查、文档校验、diff检查通过。新增图文编号两入口、编号取消/未来新批、同批原名/编号名歧义和错误前缀/扩展/非数字/不一致移除标签/原名已有编号等边界。新测试运行已载入修复代码，没有独立取得旧实现red证据；原生和unit日志为C:/WINDOWS/TEMP/mini-chatgpt-numbered-attachment-native.log与mini-chatgpt-numbered-attachment-unit.log，全量为mini-chatgpt-attachment-numbered-full-tests.log。
- 独立只读复评pass，无新增代码阻断；确认唯一匹配同时约束发送和清理，文档/nonce/接管守卫及未知不重试保留。运行态诊断已收敛为就绪/匹配布尔值与类型/计数，不保留排查过程的多种名称转换对比字段；官网程序发送尚未最终验收，不以只读ready替代发送证据。新构建不会替换旧进程缓存，需重开独立窗口后再由用户正常入口提交。
- 编号修复后DeepSeek原生重复39/39通过。独立窗口38820正常关闭后残留无窗口进程，只结束匹配本helper的该进程，沿用独立profile启动新版26196，已确认Mini-AI-IDE可见窗口句柄。默认加载DeepSeek，待用户切ChatGPT，从IDE底部需求框重新选择同PDF＋图片提交；不恢复或重发此前未知旧批。未提交、合并、发布或改动既有未跟踪原型/临时目录。

## 验收与收尾

2026-10-15，用户在新版独立IDE复测后回复“通过, 可以收尾, 提交, 合并”，确认本次附件功能验收并授权提交合并。实际官网证据覆盖有内容TXT和修复后的PDF＋图片本地需求发送；工具attach_file入口的权限、批次资格和共用运输由入口及原生回归覆盖，不额外宣称取得了单独的工具附件人工连续闭环记录。

本任务实现、评审、文档及验收已收口，计划归档。上传仍为单文件100MiB、最多50个，空文件拒绝；128MiB仅适用于本地PDF／DOCX预览。无版本升级、打包、发布或推送；不包含既有未跟踪原型与AI临时目录。提交合并按用户本次批准执行。
