---
artifact_type: adr
status: accepted
created: 2026-10-16
updated: 2026-10-16
owner: 胡运宽
source_of_truth: [test/toolTextBodies.test.ts, test/toolTextDraft.test.ts, tools/verify-chatgpt-tools.cjs, src/shared/toolProtocol.ts, src/shared/toolTextBodies.ts, src/shared/formatSpec.ts, src/main/tools/jsonDraft.ts, test/toolProtocol.test.ts, test/formatSpec.test.ts, test/jsonDraft.test.ts, test/toolAutoContinueIntegration.test.ts]
---

# ADR：短 JSON 清单与具名原文块

## Context

用户在长命令中遇到JSON、PowerShell与Python引号和反斜杠嵌套错误，字符补丁又要求复述已转义长文本，连续修复仍失败。用户接受保留官方普通网页版接入、把长正文移出JSON的路线。该接入方式无法获得模型API生成时的strict约束，不能靠提示词宣称同等保证。

## Decision

1. 执行仍只接受单个顶层完整mini-ai-tools围栏。先写protocol_version:1、batch_id、requests的JSON清单，后跟可选具名原文块；短JSON是同一合同的无块形式。解析门面toolProtocol.ts在正文引用还原后生成同一种内部ToolBatch，不增加另一执行入口。
2. 原文以独立`@@body id`行和对应`@@end id`行包围。块名匹配`[A-Za-z0-9][A-Za-z0-9_.-]{0,99}`，manifest为清单替换保留名。仅command、文件content、old_string/new_string和草稿替换content接受单字段对象`{ "text_ref": "id" }`；路径、工具名、cwd等不插值。每块恰好引用一次，无闲置、重复或缺失。最多100块，带块整个围栏正文最多200000字符。
3. 运输换行统一LF，其他字符不trim。标记相邻的单个换行是分隔符，额外空行保留为正文末尾换行；空正文明确由边界分隔。正文中任何独立@@body或@@end标记词行（标记词后接空白或行尾，含缩进歧义行）都拒绝。外层围栏长于正文内同类围栏。歧义、截断、越位引用或多容器整批拒绝，解析器不补括号、不猜测意图，不先执行正常部分。
4. toolTextBodies.ts是原文边界与指定槽引用的纯逻辑owner；文件、命令、权限、持久去重、完整来源链及结果回传继续由现有owner负责。模型不计算正文长度或摘要，IDE确定性计算。格式变化不修正错误工具参数或命令语义。
5. jsonDraft.ts保持未执行内存草稿owner。可明确分离清单和正文但清单语法错误时才建立草稿；下一完整回复可用真实draft_id/version和body_id/content替换manifest或已有正文块，其他块保留。补丁content可引用补丁自身原文块，不需复述原长内容。短old_string/new_string唯一匹配补丁仍可用，默认指导优先重发短清单。修订后必须完整重新解析、检查权限及去重。畸形补丁不递归建立草稿，过期版本不修改当前草稿；已执行命令失败通过新批次处理。
6. 内置示例默认把多行及引号/反斜杠复杂正文提取为原文块。长脚本先取得真实AI临时目录，经apply_changes创建脚本，再短run_command并依赖创建成功。已有网页会话由用户重新附带新版格式，不静默修改历史或重放未执行历史。

## Alternatives Considered

- 仅加强JSON提示词与字符修复：不能消除多层转义，修复仍受同一问题影响。
- YAML/XML/Base64：增加缩进、标签冲突或难以检查的编码，未解决命令语义问题，不采用。
- API原生工具调用：可获得生成时结构约束，但改变接入方式、费用和项目边界，本任务不采用。
- 普通代码块自动执行、猜测补齐JSON或先执行合法请求：缺少正式来源及整批校验，不采用。

## Consequences And Verification Boundary

长正文可按原文表达，清单保持短小；执行安全边界不因表达方式改变。标记保留行无法直接作为正文，需调整文件生成步骤或分批提出明确请求，不静默转义或增设第二解析路径。

测试应覆盖中文、引号、反斜杠、空白、空正文、末尾换行、内嵌围栏、截断、引用越位、重复与闲置块、修复版本及来源变化，并检查默认示例可解析、示例包装不执行。离线正文往返与执行测试不能代表模型错误率下降百分比，也不能替代真实官网连续协作验收；本ADR接受协议方向，不宣称官网现场已验收。
