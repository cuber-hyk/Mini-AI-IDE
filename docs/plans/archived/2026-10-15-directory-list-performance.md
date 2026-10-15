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

# 目录列举安全校验调度

## Goal And Scope

测量大目录列举的真实耗时，减少文件树等待逐项安全检查的时间。先测根目录与深层目录、不同条目规模；有证据后仅调整listDir内检查的调度。每项仍经原resolveSafePath全部检查，不缓存根/父路径、不修改读写与权限；500项上限、排序、点文件与跳过目录策略不变。前端整树刷新、文件操作入口、官网及工具存储不在本轮修改范围。

## Assumptions And Decisions

- 用户授权继续后续优化，先处理PERF-08。假设串行真实路径检查是可降低的等待，收益须以相同数据集前后测量证实；若没有收益不强行更改。
- 工程路线：仅在listDir内部采用固定且小的并发上限，输出按原索引组装；每项仍完整校验。项目修订变化停止领取后续条目、等待已在途检查结束，整次返回失败与空列表，不能泄露旧项目条目。数量值由真实磁盘基线/调度验证决定，不开放新设置。
- dev-split: local cleanup / no split。FileService虽大，现有listDir是明确owner；只调整该方法，不拆分无关服务，不引入通用并发工具、缓存或第二路径校验实现。
- ADR/Design system gate: not needed，权限、校验算法、界面与owner不变。若需放宽安全检查或改路径模型，停止并重新确认。
- 沿用当前独立性能分支及已验收未提交改动；两个既有未跟踪用户路径保留，不自动提交、合并或推送。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| DL-1 | done | 根/深层目录基线 | 10/100/500/600项、根/五层各3样本，before-verified24真实磁盘样本，完整校验计数及输出核对 |
| DL-2 | done | 有界调度且保序 | 最多4项，逐项完整校验、不缓存；排序/过滤/截断、在途切根/切回、全部汇合、合法root junction及外部祖先回归通过 |
| DL-3 | done | 同口径复测和回归 | 前后48样本全量输出一致；50针对性、并发4条件1175全套、自检159均通过无跳过；类型/构建通过 |
| DL-4 | done | 文档与独立评审 | 能力/CHANGELOG/原审计/计划已更新，validate-docs无问题；独立生产/测试/测量评审通过，用户批准本阶段收尾提交合并 |

## Acceptance Criteria

真实样本显示可解释的目录等待减少；不减少每项安全检查。并发完成顺序不能改变展示排序、截断与条目字段；单个消失/越界路径继续跳过，目录失效/切换不能返回混合列表。测量不作为机器相关的单测耗时门槛，不宣称FPS/真实官网或安装版总体性能。

## Artifact Routing And Closeout

仅新增tools/measure-directory-list.ts、直接回归test/fileService.test.ts（必要时同owner专门测试）并更新local-file-access、CHANGELOG和原性能审计。验证后active待用户验收，验收再归档；PERF-08仍有前端整树刷新部分时保持明确未完成记录。

## Verification Record

- 正式基线`C:/WINDOWS/TEMP/mini-directory-list-before-verified.json`，after为`C:/WINDOWS/TEMP/mini-directory-list-after.json`；两轮各24样本exit0，所有entries字段/排序/truncated/outputHash完全一致。10/100/500/600项各11/101/501/501次完整resolveSafePath调用，峰值在途1→4；500条限制在安全跳过前计算，不补齐后项。
- 中位ms（根/五层）：10项6.2161→3.8926 / 25.3170→11.7577；100项50.6757→30.0151 / 273.2934→86.1116；500项308.8697→124.3585 / 2716.0031→301.9221；600项截断500为708.0154→340.2787 / 2351.3190→1103.0968。原始样本保留，after500深层约301/302/860ms，存在显著机器/磁盘波动；不能推导现场倍数、整树GUI刷新或安装版总体收益。
- 新增5项意图回归时旧代码33/36、3项失败（串行/切根后仍领取）；改动后36/36。补齐3项根检查后切换/等待最后在途/合法junction根及外部祖先后，文件服务与文件树/工作区控制针对性50/50，0跳过；类型/构建/作用域检查通过。测量脚本单独strict类型检查通过。
- Security review：沿用路径白名单/真实路径/根版本核验，没有新IPC、磁盘桥、缓存授权或网页改动。单次并发上限4；未声称解决旧路径模型的TOCTOU或全局IPC并发问题。Design system/ADR不需新增。
- 首轮测量C:/WINDOWS/TEMP/mini-directory-list-before.json已保存数据，但清理时遇到Windows路径大小写断言失败，因此正式基线另存before-verified，不覆盖原数据。旧临时目录C:/WINDOWS/TEMP/mini-directory-list-measure-joxUuV的后续原生清理被自动审批返回`rejected: blocked by policy`，未给更具体原因；目录保留，未换工具绕过拒绝。校正版before及after自有目录已在canonical路径范围校验后正常自动清理。

- 完整回归：`pnpm exec tsx --test --test-concurrency=4 "test/**/*.test.ts"`，1175/1175、0失败/取消/跳过、exit0；`pnpm exec electron . --self-test`159/159、PASS、exit0。日志C:/WINDOWS/TEMP/mini-directory-tests.log、mini-directory-self-test.log；本轮不重复默认高并发，以前已记录的超时条件和GUI缩放限制不改写。
- 独立评审subagent：生产有界调度、校验完整性、在途切换、稳定排序、测试与测量均无阻断；前后报告已逐组核对。文档当前状态导语与Closeout已同步，validate-docs及git diff --check通过。Changelog/Distill/Check通过，ADR/Design system无需新增。计划active待用户验收，PERF-08仍为局部实现，未修改前端整树刷新；未提交、合并或推送。

用户收尾（2026-10-15）：用户要求已完成的性能工作先收尾、提交合并，后续优化单独开展；本轮局部实现按上述验证归档。前端整树刷新保留原审计open，不把列举调度通过记为整项完成。提交合并授权不包含push或删除其他分支。
