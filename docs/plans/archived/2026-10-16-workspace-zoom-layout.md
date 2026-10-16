---
artifact_type: plan
status: archived
created: 2026-10-16
updated: 2026-10-16
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 工作区缩放与需求区布局核验

## Goal And Scope

复现此前完整工作区探针的5项缩放布局失败，区分真实几何错误与采样时序错误，修复有证据的问题，使可见控件、需求区及原生视图在缩放、窗口改变和文件区全屏往返后正确对齐；不放宽几何断言掩盖错误。

本轮仅涉及本地布局与核验，不改官网DOM、权限、会话或工具执行，不进行PERF-03/07/09，也不改变已确认的布局与操作习惯。用户授权实施，未授权本轮提交/合并/push。基线master/6c5338a，独立分支codex/20261016-workspace-zoom-layout；两个既有未跟踪用户路径保留，不纳入任务。

## Assumptions And Decisions

- 已知失败为viewportReady和需求dock范围检查，根因尚未确认；不能将等待超时直接当作产品错误，也不能将原生bounds相等当作可见内容正确。
- 原生DIP几何仍由windowLayout.ts计算、WorkspaceLayoutController应用；本地CSS布局与dock测量归workspaceLayout.js，输入自动增高归promptComposer.js；诊断归layoutProbe.ts及离线原生工具。若根因仅在探针，修正采样前置条件并保留失败证据，不添加产品重试。
- dev-split: local cleanup / no split。上述owner责任明确，index.ts仅允许必要的窄接线，不堆放新的同步状态服务、不机械拆分、不新增通用utils。不改稳定IPC或公开入口；需要新的跨进程状态设计时停止扩展并明确决定。
- 复用DESIGN及已有token/样式规则，无新UI方向。ADR预期不需要；如需改变坐标真源或缩放语义则重新评估。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| ZL-1 | done | 复现并记录真实尺寸、缩放、CSS视口及需求区范围 | 前台10/10、遮挡3/10、最小化0/10、无截图恢复后10/10；诊断确认遮挡旧视口机制 |
| ZL-2 | done | 按根因修改唯一owner并补回归 | 仅修layoutProbe采样，未改产品缩放/布局；39单元通过，原10用例和几何断言保留 |
| ZL-3 | done | 验证多次缩放、resize及全屏/显隐往返 | 两轮20原生场景符合期望，100布局用例通过；恢复前无截图核对视口与dock边界通过；完整工作区119功能+10布局通过 |
| ZL-4 | done | 构建、完整回归、知识收尾与独立评审 | 构建/39针对性/1187完整单元无跳过通过；文档校验与diff检查、独立代码复审通过；active待用户验收 |

## Acceptance Criteria

100%/125%/150%缩放及复位、宽窄窗口、需求区展开/折叠、文件区全屏与工具/预览状态下，CSS可见矩形与原生几何正确对应，关键控件与需求区不越过可见视口；校验实际期望缩放而非只接受原生报告。无无界等待、强制重载、布局反馈风暴或新增持久化写入。完整探针的既有119功能与10布局检查保留。若检查无法稳定复现或尚有失败，明示限制，不报全部完成。

## Artifact Routing And Closeout

按实际改动更新app-shell能力及Changelog；需要时更新上下文路由/已有布局ADR，不归档仍有open项的原性能审计。原生报告保留在本次TEMP文件，计划记录版本与路径。待用户验收后归档到docs/plans/archived/；禁止自动提交/合并/push。

## Evidence And Implementation

- 原始基线`mini-layout-20261016-before.log`完整119功能+10布局通过；诊断-only的`mini-layout-20261016-diagnostic1.log`也通过，说明失败间歇，不据一次通过关闭。报告路径均在C:/WINDOWS/TEMP/。
- `mini-workspace-zoom-before.json`真实IDE对照：前台10/10、置顶本地空窗完全遮挡3/10、最小化0/10、移除遮挡并恢复后不做截图10/10。遮挡失败中原生几何正确、CSS/visualViewport停留1586×897、document.visibilityState为hidden；最小化原生绘图区为0×0。旧历史5项失败未记录可见性，不能断言其每次都由同一原因引起，但已找到能复现同类停滞的机制。
- `mini-workspace-zoom-frame.json`加入原生画面采样后，前台/遮挡/恢复均10/10，最小化仍0/10，符合没有绘图区的事实。最终探针因此明确拒绝初始隐藏/最小化窗口，而非把无效的几何结果改成通过；对有绘图区的窗口采样当前帧后仍执行原断言。
- `mini-workspace-zoom-final.json`首次两轮中遇到一次真实`UnknownVizError`而整体失败，保留原证据；仅该已观察的截图首帧错误有限重采，最多3次/100ms间隔，其他错误、空图、3秒超时均失败。新工具验证一次该错误可恢复及3次耗尽明确失败，错误记录不会丢弃。
- 产品owner `windowLayout.ts`、`workspaceLayoutController.ts`、`workspaceLayout.js`、`promptComposer.js`未修改。无UI样式/token/操作变化，Design system gate为复用既有规则；ADR无需更新。改动是诊断采样，不宣称修复后台持续渲染、安装版速度或未证明的旧失败根因。

## Final Verification

- 最终探针源码SHA256 `fa9e574c973902d4ee7159fca3f110de3feb10c813162a5a3150f72682b6ef53`与原生报告一致；构建通过，C:/WINDOWS/TEMP/mini-layout-build-final.log，作用域未绑定0，其余119条既有非失败诊断保留。
- 39针对性布局/输入区单元通过，C:/WINDOWS/TEMP/mini-layout-unit.log；完整并发4测试1187/1187、0失败/取消/跳过，C:/WINDOWS/TEMP/mini-layout-full-tests.log。完整测试快照在最后helper返回图像及保存截图路径统一前；该最后修正在最终原生采样/截图场景中直接覆盖，未重复无关全套测试。
- C:/WINDOWS/TEMP/mini-workspace-zoom-final3.json（exit0）两轮20场景符合期望：前台/遮挡采样后/恢复后/暂时读回失败恢复/保存PNG共100布局用例通过；最小化及空图、拒绝、超时、耗尽共10场景验证明确失败，不计为几何通过。两轮恢复前直接读数不调用capturePage，视口和需求区右/底边界均正常；输出场景各核对10类PNG真实写入且非空，已目视检查125%截图。
- 最终完整`pnpm exec electron . --workspace-probe`exit0、119/119功能与10/10布局通过，captureFailures为空，C:/WINDOWS/TEMP/mini-layout-workspace-final.log。沿用真实项目创建/编辑草稿/文件管理等既有功能核验。此轮未额外执行self-test，不将历史159项结果当作本轮执行。
- Changelog/Distill同步app-shell、context-map及原性能审计，未关闭尚未实施的PERF-03/07/09。Design system check：无产品UI及样式改变，保留既有坐标真源、控件范围及操作；ADR不需。validate-docs无问题、git diff --check通过。
- 独立只读评审mode=subagent已核对源码/编译hash、20场景/100布局结果、无截图恢复及PNG输出，无代码阻断；用户验收待完成，未提交/合并/push，既有未跟踪文件保留。

## 最终验收与归档

2026-10-16，用户在获知本轮仅修正布局验收采样、实际恢复布局正常及验证范围后，同意“先提交收尾当前任务，再单独测量工具历史存储”。按该授权提交合并至master，本计划归档；原始间歇失败与本轮机制验证均保留，不将其描述为产品缩放性能提升。后续PERF-07测量另立任务，PERF-03/09保持原审计open；本轮不推送，既有用户未跟踪文件不纳入提交。
