---
artifact_type: plan
status: active
created: 2026-10-08
updated: 2026-10-08
owner: 胡运宽
design_system_impact: none
---

# 真实首发会话路径与发布

用户实测本地0.2.0修复包不闪退，授权上传Github；同时首轮工具输出仍无法采集，官网会话变化触发unknown提示。

复核原有selfTest使用 /a/chat/s/ID，但新增首发helper/watcher误用 /a/chat/ID，离线夹具也用假路径而未发现。统一helper为真实路径，sender/watcher共享，所有首发fixture改真实格式，保留不同origin/已有会话/二次导航拒绝。

1. 修复前只读验证真实路径被拒绝；改动与纯函数、watcher、native回归，全量测试/构建。
2. 等用户选择Github修复发布方式：推荐新v0.2.1使已装0.2.0可更新；不擅自替换旧公开附件。准备对应版本源代码、说明、打包与隔离启动验收。
3. Git操作前展示status/diff和验证，按仓库规则等待用户明确提交/推送批准；只有远端对应源码到位才发布四附件，校验hash/目标与更新清单。
4. 更新文档和发布结果、归档；真实官网首轮仍需用户现场验证，不用离线测试宣称现场通过。


确认：用户选择发布v0.2.1并手动覆盖安装到原目录，保留原v0.2.0；修复前helper对仓库既有真实/s/路径返回false，修正后30项影响测试通过。版本package.json更新0.2.1、CHANGELOG收录本轮Skills/采集及安装包修复。Git提交/推送仍须完成具体验证与展示后取得明确批准。


发布前验证：用户提供了实际地址，确认首页 / 首发分配 /a/chat/s/UUID，匹配本次修复。666项全量测试、25项真实路径native离线夹具与独立41项影响测试均通过，0跳过；构建、typecheck、图标嵌入、四附件SHA512/blockmap验证通过。新0.2.1包包含249个当前src/dist非vendor匹配文件；用隔离配置和120条实际工具记录副本正常启动12秒、编辑器与signin页加载，自检PASS、exit0；rules/config和ledger数量保留。真实官网首轮仍待用户现场复测，未假称验证通过。

ADR gate：实际路径纠正属于现有首发发送/内容观察规则实现，沿用docs/adr/2026-10-08-output-driven-collection.md、docs/adr/2026-10-08-skills-and-local-demand-send.md；公开更新源/四附件与对应tag源码规则沿用docs/adr/2026-10-05-application-update-source-and-boundary.md，不新增架构决策。v0.2.1发布方案经用户明确确认，保留旧v0.2.0附件。

提交范围为当前skills/本地需求、输入UI、自动采集和路径修复及相关测试/文档/版本；用户IDE接入网页版AI.md排版改动不纳入。用户已明确批准Git提交、合并、推送对应源码/tag以及发布记录操作，不能以新包对应旧源码标签。
