---
artifact_type: plan
status: archived
created: 2026-10-08
updated: 2026-10-08
owner: agent
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 文件默认打开与更新入口修复

## Goal

让文件树可通过系统默认应用打开条目、左侧工作区标题栏显示当前版本并提供更新入口，同时修复安装版更新在首次“重启并安装”时可能未显示安装器的生命周期竞态。

## Scope

- In scope:
  - 文件树右键“在默认应用中打开”及主进程安全 IPC。
  - 左侧工作区标题栏的当前版本显示与更新按钮布局。
  - 更新安装器启动、退出协调和失败可观测性。
  - 相关单测、渲染测试和安装版更新验证。
- Out of scope:
  - 修改 Electron/Chromium 指纹、网页层能力或更新源。
  - Portable 版原地更新。
  - 重做整体窗口布局或文件管理权限模型。

## Plan Readiness

- Goal clear: yes
- Scope clear: yes
- Source of truth known: yes
- Critical decisions confirmed: yes
- Validation path known: yes

## Assumptions And Decisions

- “在默认应用中打开”对文件调用 Windows 文件关联；对文件夹调用资源管理器打开目录。
- 更新入口统一保留在左侧工作区标题栏，版本号位于更新按钮左侧；不再增加中间网页区域或左下角第二入口。
- 版本号来自主进程 `app.getVersion()` 通过现有更新状态传播，不硬编码。
- 更新安装继续只接受已校验的 NSIS 安装器，先修复现有自定义启动链路；只有验证证明其无法稳定接管时才评估切换 electron-updater 原生安装路径。
- 工作区中现有 `IDE接入网页版AI.md` 改动属于用户内容，保留但不纳入本任务提交。

## Confirmed Routes

| Decision | Chosen route | Confirmed by | ADR gate |
|---|---|---|---|
| 默认打开的对象范围 | 文件和文件夹都支持；文件使用默认关联，文件夹使用资源管理器 | 用户确认方案 | not needed |
| 更新入口位置 | 左侧工作区标题栏，版本号在按钮左侧，单一入口 | 用户确认方案 | not needed |
| 更新安装策略 | 保留现有 installer launcher，修正 Windows 参数转义并将退出排到安装器启动后的下一事件循环 | 工程推荐，用户授权实施 | not needed；未切换安装架构 |

## Split Guidance

- `src/main/index.ts` 已是大型启动编排文件；本任务不向其中新增独立业务逻辑，只接入已有 owner 的注册结果。
- 默认打开行为归 `src/main/workspaceController.ts` 的条目操作 owner；更新行为归 `src/main/updateInstaller.ts`、`src/main/updateService.ts` 和 `src/main/appUpdater.ts`；渲染布局归现有 `applicationUpdate.js/css` 与 `index.html`。
- 不新建通用 `utils`/`helpers` 模块，不把更新状态逻辑移入渲染层。
- `src/main/index.ts` 仅允许新增契约接线或状态广播，不承载安装器实现。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 增加默认应用打开的契约、preload、主进程安全处理、右键菜单和测试 | `fileExplorer`、`workspaceController`、IPC/类型检查通过 |
| PLAN-2 | done | 调整顶部版本号和更新按钮布局，复用现有更新状态与焦点/可访问性规则 | `applicationUpdate` 测试、构建通过 |
| PLAN-3 | done | 修复更新安装器启动与退出生命周期，增加失败/退出诊断和回归测试 | update service/installer 测试通过；真实安装版验收需在 Windows 安装环境执行 |
| PLAN-4 | done | 完成整体回归、更新能力文档和 CHANGELOG，执行独立审查 | `npm test` 677 pass、`npm run typecheck`、`npm run build` 通过 |

## Acceptance Criteria

- 文件和文件夹右键菜单均出现“在默认应用中打开”，路径越界、目录切换和系统打开失败均可见。
- 版本号显示实际运行版本，并位于左侧工作区标题栏更新按钮左侧；更新按钮原有状态动画和面板行为保持可用。
- 安装版首次点击“重启并安装”即可可靠启动安装器；启动失败不静默退出并保留可重试状态。
- 不增加网页 IPC、任意路径输入或新的网络出口。
- 用户原有 `IDE接入网页版AI.md` 改动未被覆盖或提交。

## Artifact Routing

- Capability updates: `docs/capabilities/local-file-access.md`, `docs/capabilities/application-update.md` only if current behavior/source routing changes.
- Audit output: none.
- Source audit: none.
- Covered findings: none.
- Deferred findings: none.
- ADR gate: not needed; 本次保留现有安装器 owner，只修正参数转义和退出时序。
- Tests: existing file explorer, workspace controller, update service, update installer, application update suites; add focused cases only where current behavior lacks coverage.
- Design system impact: local layout reuse only; check `DESIGN.md`, no new reusable component rule expected.

## Git Visibility

- Plan is created on the task branch and must be visible in `git status --short --branch --untracked-files=all`.

## Closeout

During `dev-distill`, archive this plan under `docs/plans/archived/` with `status: archived` after all non-deferred steps and verification are complete.
