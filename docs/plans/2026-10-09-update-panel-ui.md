---
artifact_type: plan
status: active
created: 2026-10-09
updated: 2026-10-09
owner: 胡运宽
---

# 计划：更新面板 UI 优化

## 目标

把独立更新窗口从「大标题 + 裸版本标签 + 单按钮」的稀疏布局，改为「状态图标 + 版本卡片 + 按动作分权按钮」的结构，覆盖无更新、有更新、下载中、已就绪、出错五种状态，且不改变任何状态机与 IPC 契约。

## 非目标

- 不改 `updateService.ts`、`appUpdater.ts`、`applicationUpdateIpc.ts` 的职责与接口。
- 不改 `updateDialog.js` 的状态映射、按钮动作决策、revision 去重逻辑。
- 不改更新网络边界、安装边界、未保存文件确认流程。
- 不引入新依赖、不引入 CSS 框架。

## 事实来源

- `docs/capabilities/application-update.md`
- `docs/adr/2026-10-09-independent-update-window.md`
- `DESIGN.md`（第 60 行更新窗口规则、Foundations、Component Rules）
- `design-tokens.json`、`src/renderer/ui.css`
- `src/renderer/update.html`、`src/renderer/updateDialog.js`、`src/renderer/applicationUpdate.css`、`src/renderer/applicationUpdate.js`
- `test/applicationUpdate.test.ts`、`test/applicationUpdateIpc.test.ts`

## 假设与决策

- 已确认：采用状态图标 + 版本卡片 + 按钮按动作分权（用户已确认效果图）。
- 已确认：状态图标使用内联线性 SVG，新增 DOM 节点。
- 已确认：hint 移到按钮上方，主按钮独占一行。
- 保留：所有既有 DOM id（`update-heading`、`update-versions`、`update-message`、`update-notes`、`update-notes-toggle`、`update-progress`、`update-percent`、`update-hint`、`update-action`、`update-close`）不变。
- 保留：远程说明继续用 `textContent`，绝不进入 `innerHTML`。
- 保留：折叠阈值（前 3 非空行 或 160 字）与既有断言文案不变。
- 说明阈值边界、图标语义如需成为长期规则，由 `/dev-distill` 走 ADR gate 判定；本次先更新 `DESIGN.md`。

## 步骤

1. todo — 更新 `src/renderer/update.html`：加状态图标容器、版本卡片标签位、hint/按钮分层；不删既有 id。
   - 验证：`npm test` 中 `test/applicationUpdate.test.ts` 仍通过。
2. todo — 更新 `src/renderer/updateDialog.js`：按状态设置图标 SVG、图标语义类、版本卡片标签文案；保留动作决策与折叠逻辑。
   - 验证：同上测试；新增断言覆盖图标类与版本标签文案。
3. todo — 更新 `src/renderer/applicationUpdate.css`：状态头、版本卡片、按钮分权、hint 下移；配色全部走 token。
   - 验证：`npm test`、`npm run typecheck`。
4. todo — 更新 `DESIGN.md` 第 60 行更新窗口规则，写入状态图标、版本卡片、按钮分权、hint 位置。
   - 验证：人工比对 `DESIGN.md` 与实现一致。
5. todo — 补 `test/applicationUpdate.test.ts` 断言：无更新时主按钮非 primary；有更新时 primary；图标类随状态变化。
   - 验证：`npm test`。

## 验证

- `npm test`（沙箱内可跑）。
- `npm run typecheck`。
- 人工在普通 PowerShell 启动应用查看五种状态视觉效果（沙箱内 `npm start` 不可用）。

## 风险

- `update.html` 结构变化可能影响既有测试的 id 查找；已确认 id 全保留。
- 图标新节点需要与 `updateDialog.js` 选择器一致，否则静默不显示。

## 验收标准

- 五种状态视觉与效果图一致。
- 所有既有测试通过，新增断言通过。
- `DESIGN.md` 与实际实现一致。
- 远程说明仍为纯文本。

## 产物路由

- 计划：`docs/plans/2026-10-09-update-panel-ui.md`
- 能力文档：本次不改 `docs/capabilities/application-update.md`（行为未变），如需补视觉说明由 `/dev-distill` 判定。
- ADR：本次不需要。
- 设计系统：`DESIGN.md` 更新。

## 收尾

- 完成后归档到 `docs/plans/archived/`。
- 变更记录由 `/dev-changelog` 或 `/dev-branch` 处理。
