---
artifact_type: plan
status: archived
created: 2026-10-12
updated: 2026-10-12
owner: Codex
plan_readiness: ready
---

# 平台切换禁用与简短提示

## Goal

主进程已有切换锁实时反映到顶栏：工具执行、存活后台命令和需求/结果发送时禁用；倒计时及网页生成时可切换；竞态拒绝仅显示约 3 秒简短原因。

## Scope

- In scope: 原平台状态契约、权威忙原因、通知接线、顶栏禁用/原因/短提示与相应验证。
- Out of scope: 回传状态识别、ChatGPT 输入整理、自动重试、登录保持、发布与 Git 提交合并。

## Plan Readiness

用户明确选择此前建议的“临时禁用切换框＋简短原因提示”，工程 owner 和主进程原锁已核验，执行路线已由用户确认。

## Assumptions And Decisions

- 主进程仍核验每次请求，禁用展示与执行锁共用一处原因判定；摘要 phase 不能替代 busy/后台命令/本地需求发送事实。
- 保留原生 select、既有标题提示、共用禁用样式；禁用外层可悬停并可键盘读取原因。操作不弹对话框，不抢焦点；技术异常留在日志。
- 独立 worktree 从 master/751be86 建立，原目录三份审计原样保留且不纳入本任务。
- dev-split: no split；新状态和守卫归 webPlatformController/shared webPlatform，本地需求仅增加发送状态通知；index 只接线，不增加 UI 或 DOM 规则。

## Confirmed Choices

| Decision | Chosen route | Confirmed by | ADR gate |
|---|---|---|---|
| 禁止切换时的交互 | 禁用原下拉框，标题简短原因，竞态约 3 秒轻提示 | 用户本轮确认 | not needed（延续原切换语义） |

## Steps And Verification

| ID | Status | Step | Verification |
|---|---|---|---|
| PSF-1 | done | 读取状态 owner、调用方、既有 UI 与权限锁，隔离任务分支 | 原主进程锁已确认，独立工作区无未跟踪审计 |
| PSF-2 | done | 共用权威忙原因与状态通知，顶栏即时禁用和固定中文提示 | 执行/后台/本地需求/结果发送被锁；倒计时/AI 等待不锁；竞态恢复平台，技术异常仅日志 |
| PSF-3 | done | 构建、相关回归与原生本地 UI 验证 | 935 项测试通过且无跳过，构建通过，原生离线 16 项通过；本地视觉已检查 |
| PSF-4 | done | 设计/能力/CHANGELOG 同步、文档增量检查与评审 | 独立只读评审无剩余阻断，git diff --check 通过；文档增量无新问题，旧问题未混入修改 |

## Acceptance Criteria

- 忙状态开始/结束无需点击即禁用/恢复，禁用时可获取明确原因。
- 主进程仍拒绝竞态切换；恢复原平台，短提示 3 秒后退出，技术错误不进入 UI。
- 发送倒计时、AI 生成/等待及空闲均不误锁；采集与文件编辑不受此次新增禁用影响。

## Artifact Routing

- Capability updates: docs/capabilities/web-platforms.md。
- Design: DESIGN.md 更新原平台交互规则，复用 token。
- Changelog: Unreleased。
- Audit output: 既有回传审计不属于本任务，不修改。
- ADR gate: not needed，未改变平台执行与取消语义。
- Tests: webPlatformController、webPlatformUi、localPromptController、原生平台夹具。

## Git Visibility

计划在独立任务工作区可见，完成后归档；当前未提交、合并或 push。

## Closeout

实现与验证已结束，计划归档；未提交、合并或 push，任务仍保留在独立工作区供审阅。

- 回归先复现即时禁用与短提示问题；独立评审进一步发现迟到状态查询竞态。新增两条回归先失败，修复后 43 项相关测试通过。
- 最终 `pnpm test`：935/935，通过，0 失败、取消或跳过；`pnpm build` 通过，裸标识符未绑定 0。构建语义参考诊断 115 条（基线 114），仅多一条已存在类别的 HTMLElement.disabled 检查，不构成新增诊断类别。
- `pnpm exec electron tools/verify-web-platform.cjs`：16/16 通过，拦截官网网络，仅核验本地顶栏、权限和平台生命周期。隐藏夹具关闭后台节流以核验 3 秒计时，生产配置未更改。
- 临时离屏窗口使用真实顶栏静态文件验证禁用与短提示布局；图片已检查。没有替换或重启用户当前应用，不将离线检查当作官网自动回传验收。
- 评审模式 subagent；计划符合、范围纯净、验证证据、设计、CHANGELOG 和知识沉淀均通过。评审发现的状态竞态已修复并复核，忙原因广播仅发送顶栏，不重复改写本地需求反馈。
- 文档检查保留基线 5 个错误与 3 个警告（既有归档元数据及审计问题），本任务无新增。其修复不属于本任务；未宣称全仓文档校验通过。
