---
artifact_type: plan
status: archived
created: 2026-10-23
updated: 2026-10-23
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 工作区紧凑树形导航

## Goal And Scope

按用户批准的绘图效果改进左侧工作区密度与层级，保留项目/平台账号/会话组织和全部既有绑定、导航、静默保存行为。仅修改本地导航展示、操作菜单及相关验证/文档，不改变主进程、协议、官网 DOM、权限或持久化 schema。

## Decisions And Structure

- 已批准：项目行内链接图标绑定、项目/会话省略号菜单、紧凑行距、小图标、弱化账号分组、选中会话细蓝线、无绑定项目只占一行、搜索与长标题省略、无说明页脚。
- 标题只在显示时去掉与所在平台一致的明确末尾后缀；原始标题、悬停说明、搜索及持久化保持原文。
- 绑定按钮当前项目常显，其他项目悬停/键盘聚焦可见；不可用原因由已有会话状态推导，不扩展授权。
- 结构分类 no split：导航 JS/CSS 是现有专属 owner，图标与菜单在其中管理，复用 file-menu 样式与键盘语义；不新增通用模块。index 主进程不得添加界面逻辑。
- 现有未提交改动全部属于此前会话任务，继续使用同一独立分支，不提交、合并或推送。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| UI-1 | done | 对照用户截图/批准效果及现有规则，确认入口与范围 | 读取导航、DESIGN、能力文档、原生夹具及测试 |
| UI-2 | done | 紧凑样式、行内绑定、明确菜单、纯展示标题处理 | UI行为测试：绑定/菜单/键盘/旧回执/纯文本 |
| UI-3 | done | 原生窄栏、长名称、菜单边界与密度验收 | 真实Electron离线截图与几何检查，原保存/切换回归 |
| UI-4 | done | 文档/设计与变更记录、独立评审、计划归档 | 构建、类型检查、相关测试、文档检查和diff评审 |

## Artifact Routing And Closeout

- design_system_impact: update；更新 DESIGN、workspace-sessions 能力与 Unreleased；已有 ADR 的业务选择不变，无新增架构决策。
- 测试沿用 test/workspaceSessionsUi.test.ts 与 tools/verify-workspace-sessions.cjs，不为纯CSS建立镜像测试。
- 完成后归档计划并记录验证；真实官网已由用户反馈绑定与切换可用，本次视觉验收不宣称新的官网连续闭环证据。

## Verification And Review

- `pnpm run build` 通过（包含 TypeScript 编译与 renderer scope 检查）；全仓 1313/1313 测试通过，失败、取消、跳过均为0。UI专属17项覆盖明确菜单、纯展示标题、同名项目/会话焦点及旧菜单动作失效。
- 完整应用 self-test 159/159 PASS，正常退出码0。
- `node tools/verify-workspace-sessions.cjs` 最终24/24通过，0弹窗/网络请求；真实IPC与双文档保存、失败保护保持通过。340px与200px项目/会话实测34px/30px，长名省略、原文提示、空项目单行与菜单界限通过，实际截图已检查。
- Tab/Shift+Tab处理先将焦点交回菜单入口且不阻止默认行为；原生夹具以合成键盘事件验证DOM处理，不把它视作物理键盘端到端证据。
- 独立只读 subagent 评审通过：计划符合、仅相关范围、证据通过，无阻断；追加Tab入口焦点的小修由主代理复核并回归验证。
- DESIGN、能力、CHANGELOG已同步，validate-docs及diff --check通过；无需新ADR，业务策略未变。
- 原工作目录保持原状；改动留在 `codex/20261023-workspace-conversations`，未提交、合并或推送。
