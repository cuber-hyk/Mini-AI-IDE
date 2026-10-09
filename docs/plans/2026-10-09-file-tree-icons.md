---
artifact_type: plan
status: active
updated: 2026-10-09
owner: 胡运宽
---

# 计划：文件树类型图标扩充与配色 token 化

## 目标

把 `src/renderer/fileIcons.js` 的类型覆盖从约 18 类扩充到约 75 类，并把 `src/renderer/fileExplorer.css` 里散落的硬编码色值收敛到 `design-tokens.json`，使文件树在不同技术栈项目下都能一眼区分类型，同时保持既有安全约束与调用接口不变。

## 非目标

- 不改 `fileIcons` 对外签名（`kind` / `render`）。
- 不改 `fileExplorer.js`、`workspaceNavigation.js` 调用方式。
- 不引入 seti / vscode-icons / material-icon-theme 等图标包。
- 不调整图标尺寸（维持 17px）与文件夹开合语义。

## 决策（用户已确认）

- 未跟踪的 `docs/诊断json.md` 不纳入本分支。
- 图标类型按方案 A 全面扩充（语言、框架、配置、文档、媒体、包管理/构建、CI/编辑器、特殊文件名）。
- 颜色允许改 `design-tokens.json`；尺寸与具体色相由实现方按推荐方案决定。
- 执行中追加：图标风格改为参考 deepseek-harness 的「折角纸张 + 白色符号 + 彩色品牌标」；文件夹改线性描边（关闭灰、打开蓝）；`package.json` 用 Node JS 六边形标；文件树显示点文件但跳过 `.git` 目录。

## 步骤

1. `design-tokens.json` 新增文件类型颜色 token（按语义分组，约 14–17 个）。
2. `src/renderer/fileExplorer.css` 将硬编码色值替换为 `var(--ui-file-*)`，并补齐新分组规则。
3. `src/renderer/fileIcons.js` 扩充 `special` / `extensions` / `shapes`，新增类型到颜色分组的映射。
4. `test/fileIcons.test.ts` 扩充 `kind()` 断言表，新增安全断言。
5. `DESIGN.md` 的 `Sources` 段补充"文件类型颜色统一走 token"。
6. 归档本计划（合并后执行 `/dev-distill`）。

## 验证

- `npm run typecheck`
- `npm test`

（`npm run self-test` / `npm start` 在 AI 沙箱内因 GPU 限制无法运行，见 `docs/ai/context-map.md`，不作为本任务门禁。）

## 代码归属（dev-split）

本任务不新增模块、不跨归属边界：图标数据与渲染逻辑继续归 `src/renderer/fileIcons.js`，颜色值继续归 `design-tokens.json` 与 `src/renderer/fileExplorer.css`，测试归 `test/fileIcons.test.ts`。不产生大文件风险。
