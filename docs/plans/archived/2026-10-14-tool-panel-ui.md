---
artifact_type: plan
status: archived
created: 2026-10-14
updated: 2026-10-14
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 工具结果面板紧凑与宽度适配

## Goal

在工具区独立缩放至 240、320、460、620px 时保持可读、无横向溢出，宽列紧凑单行，窄列明确保留状态与中断入口。

## Scope

- 调整现有工具面板标记、局部样式、菜单布局与纯展示信息；沿用主题 token、按钮及原操作入口。
- 保留已有任务分支 `task/20261014-tool-panel-ui` 及用户相关未提交改动；原型只作参考，`.mini-ai-ide/` 不纳入修改。
- 不改工具执行、权限、IPC、官网、复制与回传业务；不提交、合并或推送。

## Assumptions And Decisions

- 用户已确认“小幅调整结构＋容器自适应”的方向并授权开始。
- 根据工具容器而非窗口宽度切换布局；38px 头部保持稳定。
- 窄列查看改动收进既有菜单；JSON、复制/发送、状态与命令中断保持可用。
- 正常成功摘要窄列可收进展开详情；异常、截断、跳过、后台运行及待清理信息不隐藏。
- 保留真实结果与完整路径提示，展示转换不影响复制和运输。
- ADR gate: not needed；没有新增持久业务边界。

## Code Placement Constraints

- dev-split: no split；当前职责已明确，不做文件拆分。
- `toolHarness.css` 拥有容器查询；`toolResultPresentation.js` 拥有摘要重要程度；`toolPanelLayout.js` 拥有菜单定位与关闭；`toolHarness.js` 只做现有渲染接线。
- 不向主进程、workspaceLayout 或新通用模块增加逻辑；所有副作用继续归原业务 owner。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 确认当前分支、相关改动、现有表现与失败测试 | 上轮相关50项测试49通过；窗口级620px规则与独立工具几何不一致 |
| PLAN-2 | done | 实现容器适配与紧凑头部、结果行和窄列菜单 | verify-tool-panel.cjs 199/199，通过240/320/460/620/900px及宽窗口内独立缩窄；截图检查无挤出 |
| PLAN-3 | done | 保留异常重要摘要与现有交互 | 6组相关测试68/68、0跳过；夹具检查JSON焦点、独立中断、菜单收缩与长目标；成功提示不能遮盖当前失败/授权/后台状态 |
| PLAN-4 | done | 完成构建、设计/文档同步与独立评审 | pnpm build通过（未绑定标识符0）；DESIGN/能力/CHANGELOG已同步，validate-docs与diff检查通过；独立subagent复审pass、无阻断 |

## Acceptance Criteria

- 工具区独立缩窄时布局正确切换；不依赖整个窗口宽度。
- 所有状态中头部38px稳定，无关键操作被挤出；窄列菜单查看改动仍走同一入口。
- 中断独立命令、复制/发送与JSON校验确认的业务行为不变。
- 失败、截断、后台运行与待清理信息保持可见；普通长路径省略且title完整。
- 正文单层滚动，不更改中间dock或原生布局。

## Artifact Routing

- design_system_impact: update；更新 DESIGN.md 的当前响应式规则并检查主题与焦点。
- Capability updates: docs/capabilities/tool-harness.md。
- Changelog: CHANGELOG.md 的 Unreleased。
- Tests: 工具展示/布局/UI/JSON既有测试与离线 tools/verify-tool-panel.cjs。
- Audit output: 无；context-map owner未变，不需更新路由。

## Git Visibility

- 创建后以 git status 验证计划可见；用户已验收并授权提交合并。

## Closeout

- 本任务实现与离线验证已完成，计划归档，用户已验收并授权提交合并。无来源审计、无新增ADR。
- 验收覆盖真实本地Electron渲染与内存工具桥，不操作官网、真实剪贴板或真实命令；用户已确认最终布局通过。
- 构建检查还报告116条非阻断语义诊断，本任务没有将其描述为全部诊断清零。
- 用户后续确认中断只显示图标：按钮改为24px方块，保留动作名称与悬停，中断过程中禁用并显示圆环；工具UI37/37、离线布局204/204、构建及文档检查通过，无跳过，局部人工评审无阻断。
- 用户后续提出耗时前置、状态置后：宽列按动作、目标、耗时、摘要、状态排列，窄列优先保留状态与中断；原执行时钟和真实结果不变。相关测试40/40、离线布局222/222、构建及文档校验通过，截图与局部人工评审无阻断。
