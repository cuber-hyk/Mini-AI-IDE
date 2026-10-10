---
artifact_type: plan
status: archived
created: 2026-10-10
updated: 2026-10-10
owner: 胡运宽
plan_readiness: ready
source_audit: ""
covered_findings: []
deferred_findings: []
---

# 工具设置改为独立原生浮层

## Goal

设置在原生官网视图上方显示，打开和关闭不改变协作 dock 与官网高度，原设置功能继续使用同一配置 owner。

## Scope

- 迁移工具与提示词设置 UI 至关联主窗口的独立非模态 BrowserWindow；移除设置 DOM 浮层及其 dock 高度预留。
- 保留自动发送间隔、未保存策略、音效预听、自动复制、当前项目规则清理和提示词编辑入口。
- 原工作区既有 UI 改动继续保留；不提交、合并或发布，不修改已合并的自动继续业务逻辑。

## Confirmed Decisions

- 用户要求“独立原生浮层”；窗口靠齿轮定位并钳制至屏幕和主窗口可见范围，内部滚动。
- 关闭、Escape、失焦、主窗口移动/缩放时收起；明确关闭恢复齿轮焦点，失焦不抢回焦点。
- 独立 preload 仅提供窄设置接口；权限模式和 automatic 开关继续由本地操作栏持有。
- 当前 `codex/stable-tool-results-header` 为相关 UI 任务分支；已存在的 UI 改动属于上下文，原未跟踪的超时审计不纳入本任务。

## Sources And Placement

- 当前 UI 与几何：`toolHarness.js/css`、`toolPanelLayout.js`、`workspaceLayout.js`、`index.html`。
- 窗口/IPC 模式：`applicationUpdateWindow.ts`、`applicationUpdateIpc.ts`、`updatePreload.ts`。
- 配置事实：`tools/integration.ts`、`tools/harness.ts`、`tools/store.ts`。
- dev-split: 局部迁移；新增 ToolSettingsWindow 与 ToolSettingsIpc 专属 owner，主入口仅接线。音效实现供主编辑器和浮层两个真实消费者复用。
- Do not add to: `src/main/index.ts` 的窗口行为、设置校验或渲染实现；`tools/integration.ts` 不持有原生窗口。
- design_system_impact: update；保留既有分组、左右对齐、语义控件与 token，记录原生浮层交互规则。

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PLAN-1 | done | 建立原生浮层、专用窄 preload 与主 frame IPC | 几何与 IPC 测试通过；原生窗口关联、独立桥检查通过；销毁与监听清理经代码评审 |
| PLAN-2 | done | 迁移现有设置 UI、统一音效实现、接配置广播和提示词入口 | 设置、音效、工具 UI 与相关 integration 共 89 项测试通过，无跳过 |
| PLAN-3 | done | 移除设置 DOM 浮层与 dock 预算，更新原生探针 | 原生探针 107/107；布局尺寸/缩放检查通过；打开与关闭几何一致、失焦收起、Escape/关闭恢复焦点通过 |
| PLAN-4 | done | 更新文档和变更记录、审查最终差异 | 构建及 diff 检查通过；手动评审无本任务遗留项；文档/综合自检的既有问题见验证记录 |

## Acceptance Criteria

- 浮层是独立原生窗口，主窗口关联且无任务栏入口；官网原生视图不能覆盖它。
- 打开/关闭不增加 dockHeight，工具列表和输入区不被挤高。
- 窄设置窗口不能调用文件、命令、工具执行、官网写入或任意配置字段；切项目不清错项目规则。
- 四项配置保存同步至操作栏，失败明确提示；音效开启保存成功后预听一次。
- Escape/明确关闭恢复触发焦点，外点/失焦不抢焦点；关闭主窗口销毁浮层。

## Routing And Closeout

- 更新 `DESIGN.md`、`docs/capabilities/tool-harness.md`、`docs/ai/context-map.md`、`CHANGELOG.md` 和仓库设置边界规则。
- ADR gate: not needed；沿用已接受的独立本地窗口模式，配置事实和工具授权 owner 不变。
- 完成后归档本计划；审批前展示差异，不提交或合并。

## Verification And Review

- `pnpm build` 通过，renderer 裸标识符未绑定为 0；现有非阻断语义诊断 95 条。
- `toolSettingsIpc/toolSettingsWindow/toolSettingsUi/toolHarnessUi/toolPanelLayout` 50 项通过；`toolIntegration/toolAttachmentIntegration/workspaceLayoutController/windowLayout` 39 项通过，均无跳过。
- 原生离线 workspace-probe 107/107，columns.ok=true，截图失败为 0；现场截图位于临时目录 `C:/WINDOWS/TEMP/mini-workspace-probe-KAaCjm/tool-settings-window.png`。
- 探针发现迁移模板缺少提示词/规则区及闭合标签，已补全并加入模板控件归属测试；旧技能夹具为 audit，自检预期仍为 /review，已将断言对齐 /audit。
- `--self-test` 157/160：E2 的旧清单遗漏 updatePreload、L1d 未识别原有附件按钮绑定、F3d 预期十四组而现有示例十五组。对照 HEAD 确認为既有自检覆盖问题；本任务新增通道和设置入口自检通过，不扩大范围修改旧检查。
- Dev Flow 文档校验仍报告既有五项错误：brand-font/file-tree-icons 归档计划缺 created，p2-shell/p3-return-path-logic/first-turn-auto-collection 旧审计含未关闭发现；本任务文档未新增错误。既有 DESIGN fileExplorer.css 路径警告保留。
- 手动评审核对：专用主 frame 身份及四字段白名单、无路径/工具正文投影、当前项目校验、规则清理 root 在 await 前捕获、窗口导航禁止、焦点恢复、迟到配置读取、原生视图覆盖及主窗口关闭销毁。原 UI 改动保留，未触碰工具自动继续业务逻辑。
- 本任务实施于桌面仓库 `codex/stable-tool-results-header`；2026-10-10 用户在上述验证及既有检查问题披露后批准提交合并。UI 提交为 `753bd92`，本地 master 集成 UI 与已批准的自动继续修复；两处文档冲突同时保留新设置/自适应按钮和自动继续终态规则，合并后构建通过。未推送；未跟踪的旧超时审计草稿保留，不纳入 UI 提交。
