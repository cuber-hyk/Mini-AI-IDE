---
artifact_type: plan
status: archived
updated: 2026-10-09
owner: 胡运宽
---

# 计划：品牌区字体与图标（Baloo 2 + 机器人图标）

## 目标

左上角品牌区从 `Mini AI [IDE]` 纯文字，改为「机器人图标 + Baloo 2 700 品牌名 + IDE 方框标签」，做出接近 deepseek-harness 品牌区的现代圆润观感。

## 决策（用户已确认）

- 字体：Baloo 2 weight 700（OFL，可商用）。
- 图标：线性机器人（圆角方头 + 天线 + 两眼点）。
- 字体文件来源：从 Google Fonts 下载到 `src/renderer/fonts/`（已下载 Baloo2-700.ttf，417KB）。

## 步骤

1. 新增 `src/renderer/fonts/Baloo2-700.ttf`（已下载）。
2. `src/renderer/style.css`：加 `@font-face` 定义 Baloo 2；`.workspace-brand` 指定字体与字重。
3. `src/renderer/index.html`：品牌区加内联机器人 SVG。
4. `DESIGN.md`：记录品牌字体规则。
5. `CHANGELOG.md`：条目。
6. 验证：`npm run typecheck` + `npm test`；`scripts/copy-static.mjs` 确认字体进 dist。

## 非目标

- 不改其它区域字体。
- 不引入 Baloo 2 之外的字重。

## 代码归属

品牌区结构归 `index.html`；样式归 `style.css`；字体资源归 `src/renderer/fonts/`。不新增模块。
