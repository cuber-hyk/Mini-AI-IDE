---
artifact_type: capability
status: current
updated: 2026-10-07
owner: 胡运宽
source_of_truth: [docs/adr/2026-10-02-honest-electron-identity.md, docs/adr/2026-10-02-filesystem-permission-model.md, DESIGN.md, design-tokens.json, src/main/windowLayout.ts, src/main/layoutProbe.ts, src/renderer/changeTree.js, src/renderer/editorToolbar.js, src/renderer/ui.css, test/windowLayout.test.ts, test/changeTree.test.ts, test/editorToolbar.test.ts, src/main/index.ts, src/renderer/index.html, src/renderer/style.css, src/renderer/promptComposer.js, test/promptComposer.test.ts, src/renderer/toolPanelLayout.js, test/toolPanelLayout.test.ts, src/main/workspaceController.ts, src/main/workspaceProbe.ts, src/renderer/fileExplorer.js, src/renderer/editorTabs.js, src/renderer/editorWorkspace.js, test/editorWorkspace.test.ts]
---

# 能力：应用外壳与进程架构

> 状态说明：P2 已实现；本节记录当前事实。检查数量以运行结果为准。
> 自检命令：`npm run self-test`（构建 + `electron . --self-test`，不联网）。
> 运行时探针：`npm run ui-probe`（编辑器状态 / 几何）、`npm run ui-probe:bubble`（选区浮层按钮是否真的出现）。
> 目录管理验收：`pnpm run verify:workspace`（临时用户数据、临时目录、自有静态回复页面；不访问官方网页，不改正常目录历史）。
> 断言条数以 `src/main/selfTest.ts` 中 `add(` 的调用数为准（以 grep 实际计数为准，勿硬编码）。
> `npm run build` 会顺带跑 `tools/check-renderer-scope.mjs`，对编辑器、输入区、复制菜单、网页工具条及变更树脚本做真实作用域分析。

## 目录与文件管理

Monaco、AI 网页和变更列表保持三列布局。目录恢复与最近 5 项由主进程管理，顶部、菜单和空白编辑区的打开入口汇聚到 `WorkspaceController`；关闭目录后保留最近记录。启动不恢复编辑文件或光标。

文件树顶部提供新建文件、新建文件夹和刷新；条目右键提供新建、改名、移入回收站；空白处右键提供根目录新建文件／文件夹与刷新，F2 改名，Enter／Esc 确认或取消名称输入。创建后的文件打开、文件夹展开；重名失败不覆盖。文件树由 `fileExplorer.js` 管理，各文件缓冲及模型生命周期由 `editorWorkspace.js` 管理，顶部标签由 `editorTabs.js` 管理；标签切换保留草稿、撤销栈和视图位置，重复打开激活已有标签。

关闭未保存标签、切换／关闭目录和退出统一询问“保存／放弃／取消”；保存失败不能继续离开，改名保留草稿并更新保存路径。AI 写盘先检查所有标签中的目标未保存状态；目录切换清理原目录 AI 记录，文件改名／删除仅使相关路径失效。权限、契约及测试入口见 `local-file-access.md`。

## 当前技术栈（已落地）

| 项 | 值 |
|---|---|
| 运行时 | Electron **44.5.1**（Chromium 152.0.7977.130 / Node 24.21.0） |
| 语言 | TypeScript 5.9.3（strict，含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`） |
| 包管理 | pnpm（**依赖 postinstall 的二进制需单独安装**，见下） |
| 编辑器 | Monaco Editor 0.57.0（AMD 发行版，从 `node_modules` 复制到 `dist`） |
| 测试 | Node 内置测试运行器 + tsx（`npm test`） |
| 打包器 | [electron-builder](https://www.electron.build/) 26.15.3（devDependency；配置见 `electron-builder.config.cjs`，入口 `scripts/package-win.mjs`） |

## 进程契约

现在共 **5 个 `WebContentsView`**（此前 4 个，提示词设置面板是本轮新增的）：

| 进程 | 职责 | 硬性约束 |
|---|---|---|
| **main** | 窗口与分栏布局、IPC 路由、本地文件读取、会话分区配置、提示词设置的持久化、启动自检、安装版软件更新 |绝不发起或代理大模型相关网络请求；**绝不向网页写入任何内容**；更新模块专用网络例外见 `application-update.md` 与 ADR-0005 |
| **editor renderer**（`persist:editor-ui`） | Monaco 渲染、文件树、编辑与保存、需求输入区 | `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`；无文件系统能力；CSP `connect-src 'none'` |
| **webview renderer**（`persist:postcheck`） | 加载目标平台网页 | 顶级独立视图（`WebContentsView`）；程序**只读不写** |
| **webbar renderer**（`persist:editor-ui`） | 网页区顶部 40px 工具条（网页可见）/ 恢复把手（网页隐藏）：只读采集与列显隐 | 只能请求只读采集和切换显隐；不能读写文件或向网页写入内容。**永不隐藏**——它是"把网页叫回来"的常驻入口 |
| **preview renderer**（`persist:editor-ui`） | 最右侧变更树：文件筛选、片段预览、集中应用与撤销 | 同上；落盘只经主进程精确定位与预览基线复核 |
| **prompt renderer**（`persist:editor-ui`） | 提示词设置面板（覆盖式浮层，默认隐藏）：**分页查看/编辑两套版本的「输出格式要求」** | 只能读/写**这一份设置**（5 个通道）；不能读写文件、不能碰网页。**为什么单独开一个视图**：编辑器渲染进程持有文件写权限，而"编辑一段纯文本"不需要任何文件能力——不把提权面顺手扩大 |

## 布局规则（三列与独立显隐）

```text
编辑器（内含目录树）  │  AI 网页               │  变更列表
目录与短路径         │  采集回复 / 显隐       │  全部应用 / 撤销 / 收起
文件头 / 复制上下文   │  官方网页原内容         │  文件筛选
Monaco 编辑与内联预览 │                        │  目录 → 文件 → 片段
需求输入与提示词控件  │                        │  选中片段详情 / 应用 / 改路径
```

- 几何由 `src/main/windowLayout.ts` 的纯 `computeLayout()` 计算，主进程 `relayout()` 统一应用。窗口默认 1600×960，最小 1080×600；编辑器、网页、变更列常规最小宽度分别为 360、420、260px。
- 编辑器初始占约一半宽度，变更列默认 300px。两处分隔条分别调整编辑器与变更列；宽度持久化。隐藏变更列以 `ui:set-preview-panel(0)` 表达，返回 `{width,visible}`；正数统一表示列宽。
- 网页隐藏时，变更列继续显示。工具条变为编辑器与变更列之间的 28px 恢复把手；两列都隐藏时把手仍可恢复网页。主进程不销毁工具条。
- 网页按钮、恢复把手、视图菜单与 `Ctrl+Shift+A` 汇聚到 `setWebVisible()`；`ui:chrome-state` 向各本地视图同步真实显隐与列宽。变更列可由自身收起按钮关闭，由网页工具条或视图菜单恢复。
- 目录树开关在编辑器文件头，目录树隐藏后仍可点击；`Ctrl+B` 保留。
- 复制操作位于编辑器「复制上下文」菜单，保留全文与片段两条链路，支持方向键、Escape、Tab 与外点关闭。路径显示末两级，悬停显示完整路径。
- 「采集回复」位于 AI 网页顶栏，忙时禁用；失败和无新内容均明确反馈。
- 变更树按目录/文件分组，同文件多个片段展开子项，显示原→新范围、增删统计及状态。文件筛选不改变批次索引；应用/撤销集中在头部与选中详情区。刷新保留当前控件焦点、路径编辑草稿与光标。
- 本地基础样式参见 `DESIGN.md` 和 `design-tokens.json`；构建生成 token CSS，控件复用 `ui.css`。布局探针验证大小窗口和独立显隐，不能以静态示意替代运行时验收。

### 提示词设置面板（覆盖式浮层）

不是第四块"区域"，而是**盖在现有布局之上的浮层**，因此它**不参与 `computeLayout()`**：

- 几何独立：`promptPanelBounds()` 按窗口比例算出居中矩形（宽 560–980、高 420–900，`y` 取 `0.42` 略偏上）。
  窗口 resize 时只重算它自己 —— **不调 `relayout()`**，否则打开面板就会把用户拖好的分栏宽度悄悄改掉。
- 显示/隐藏靠 `setVisible` + `bounds` 移到屏幕外的零尺寸位置（`PROMPT_HIDDEN_BOUNDS`）；关闭后把键盘焦点交还编辑器。
- **在 `addChildView` 顺序里最后添加**（最上层），否则会被编辑器/网页盖住。
- **三个入口汇聚到 `showPromptPanel()`**：① 设置菜单的「修改提示词…」；② 文件菜单的同名行；③ 输入区设置浮层的「编辑提示词与格式要求」。快捷键 `CmdOrCtrl+Shift+P`。
  显示后主进程广播 `ui:open-prompt-panel` 给编辑器，由它点亮提示词编辑入口的激活态（面板是独立进程，编辑器看不到它）。
- 面板文案明确写清"改的是**输出格式要求那一段**"，因为 `## 用户需求 / ## 工作环境 / ## 目录结构` 是由程序生成、不应由用户改的骨架。

## 关键规则

1. 编辑器与网页视图必须在**不同渲染进程**。
2. **程序不向网页写入任何内容**：主进程不调度任何注入，对网页的接触只有回程**只读**采集（见 `human-machine-boundary`）。
3. IPC 只暴露窄接口（声明式参数），不接受任意表达式或任意路径。
4. **无自动化特征**（A 级判据，必须为零）：不暴露 CDP 调试端口；不引入 Selenium / Puppeteer / Playwright；不设置 `navigator.webdriver`；不注入任何"伪装浏览器身份"的脚本。
5. **UA 规则（硬性）**：
   - **移除**自我声明标记：`Electron/<ver>` 与 `<appName>/<ver>`；
   - **保留**真实信息：`Chrome/<真实内核版本>`、平台段、`AppleWebKit/537.36`、`Safari/537.36`；
   - **禁止**把版本号改成"最新 Chrome"、禁止伪造平台；
   - **实现要点**：必须在创建 `WebContentsView` 时通过 `webPreferences.userAgent` 显式传入。**仅调用 `session.setUserAgent()` 不生效**（实测教训）。
6. **不自报但不伪造**：只允许移除"我方主动声明的标识"；**禁止**为"看起来更像浏览器"而补齐 `window.chrome`、改 `userAgentData`、伪造 TLS/Canvas/字体。
7. 启动时自检"UA 声明的内核版本 == 实际内核版本"，不一致即告警。

## 已知边界

- 仅 Windows 10/11 x64。
- 单窗口、单网页视图；多标签不在范围内。
- **不 patch Chromium 构建**；不追求与官方 Chrome 指纹一致——与 Chrome 的差异（TLS、Canvas/WebGL、字体列表、`window.chrome` 成员、`userAgentData`的 `Google Chrome` 条目等）**只作为知情记录留档，不是修补目标**。
  - 实测依据：P0b 受控实验显示，`window.chrome` 与 `userAgentData` 的差异**存在却没有**触发平台告警；触发告警的只有 UA 中的自报标记。
- **UA 与会话分区正交**：UA 规则见上方第 5 条；会话分区见 `session-persistence` 能力文档（`persist:postcheck`）。

## 已知实现陷阱（均已踩过并修复）

| 陷阱 | 症状 | 正确做法 |
|---|---|---|
| 沙箱 preload 不能 `require` 相对路径模块 | `Error: module not found: ../shared/contract`，bridge 完全不存在（而页面仍能加载，极易误判） | preload 只能 require `electron` 等内置模块；通道名**内联为字面量**，并用自检比对防漂移 |
| `contextBridge` 对象不暴露 `ownKeys` | `Object.keys(bridge)` 为空，误判为"未注入" | 用**实际调用**（`await bridge.getRoot()`）验证能力 |
| 会话级 `session.setUserAgent()` 对视图不生效 | UA 变体"报告说改了、实际没改" | 对 `webContents.setUserAgent()` 显式设置，并在自检中比对 `getUserAgent()` |
| Monaco 的 `window.require` 看似 Node泄漏 | 误判渲染进程有 Node 能力 | 用 AMD 的 `require.config` 与 Node 的 `require.resolve` 区分；自检 D4/D10 覆盖 |
| `fs.cpSync` 在本项目执行环境报 EIO | 静态复制失败 | 用显式 `mkdirSync` + `writeFileSync` 递归复制 |
| Monaco worker 在 `file://` 下被 CSP 阻止 | 控制台报错并回退主线程 | 已知取舍：语法高亮可用，语言服务不可用；后续若需要，需改为本地 HTTP 或打包 worker |
| 在 `document` 上监听 `keydown` 想拦截编辑器输入 | **永不触发**（Monaco 获得焦点后吞掉键盘事件），"输入即进入编辑"这类逻辑静默失效，编辑器实际不可编辑 | 不要指望在 document 层拦截编辑器按键；需要时用 Monaco 的命令/事件 API。**并且默认不要设 `readOnly`** |
| 用 `document.getElementById` 取 HTML 元素 | 取不到返回 `null`，随后静默失效；**tsc 看不到 HTML** | 自检 L1 静态比对"JS 引用的 id ⊆ HTML 定义的 id" |
| `renderer.js` 不经 `tsc` | 语法错误只在运行时暴露 | 自检 L2 用 `node:vm` 解析该文件 |
| **隐藏侧栏时把开关放在侧栏内部** | 侧栏一隐藏，按钮跟着消失，用户**再也点不回来** | 开关必须放在**始终可见**的地方（目录树开关因此放在编辑器顶部条） |
| **折叠时把开关和被折叠的板一起隐藏** | 网页一隐藏，开关也没了，**再也展不开**（本项目实际犯过，且已写进本表上一行） | 承载开关的视图**永不隐藏**：网页隐藏时工具条贴到窗口右边缘变成竖把手；再加View 菜单勾选项兜底 |
| **带中文文字的按钮塞进小尺寸圆形按钮** | 「复制 prompt」被折成两行、挤成一团（用户实测截图） | 尺寸与文案必须匹配：药丸形按钮放文字，圆形按钮只放图标 |
| **同一分区下多个沙箱视图连续 `loadFile` 偶发失败** | `ERR_FAILED (-2)`，且**失败对象会在视图之间飘移**（把 webbar 内容换成 preview 内容、换加载顺序都试过） | 与内容/顺序无关，是渲染进程创建时序问题 → 用 `loadLocalView()` 重试（4 次、递增间隔）吸收 |
| **AI 沙箱内跑不了 GUI 自检** | `GPU process isn't usable. Goodbye.`（GPU 缓存目录 `AppData\Roaming\mini-ai-ide\GPUPersistentCache` 被占用，GPU 进程反复 `exit_code=-1073741819`） | 这是**环境限制不是代码缺陷**（改动前基线同样失败）。`--disable-gpu` 也无效。代码正确性用 `npm test` + `npm run typecheck` + 静态自检逻辑验证；`npm run self-test` 与 `npm start` 需在普通 PowerShell 跑 |
| **Monaco 0.57 没有官方内联 diff API** | 想做"diff 与原文件整合显示"时找不到 `InlineDiff` 相关 API（`monaco.d.ts` / `editor.api.d.ts` 搜 `InlineDiff` 命中 0），容易误判为"做不了"而退回左右并排 | VS Code 的内联 diff 依赖编辑器内部协议，第三方确实拿不到；但 `createDecorationsCollection` + `changeViewZones` 两个**公开** API 足够自绘：前者标删除行，后者把新增行插到指定行之后（不进入文档、不影响 undo） |
| **bash heredoc 会展开 `${...}`** | 用 `cat > x.cjs <<'EOF'` 写含模板字符串的验证脚本，`${o.kind}` 被 shell 展开成空值，比对结果恒为 `undefined@undefined`，排查时极易误判为算法错误 | 写含 `${}` 的脚本一律用编辑器工具落盘，不要走 heredoc。同类问题还有：`\s` 在 heredoc 里被吞、`node -e "..."` 里的正则也会被吃掉（改用 `String.includes` 做临时排查） |
| **跨进程写盘后必须广播** | 主进程落盘后**不广播**，另一个渲染进程里的编辑器一直显示旧内容（用户实测："应用后仍是旧代码，关闭文件重开才对"） | 写盘成功后 `send(CHANNELS.fileChanged, filePath)`，渲染进程订阅后重新读盘。且**刷新入口要唯一** —— 别一处自己 `openFile`、另一处靠广播，会重复刷新甚至竞态 |
| **`textarea` / `div` 在 Windows 上的原生滚动条** | 深色主题里出现一条**带上下箭头的白色原生滚动条**，视觉上极扎眼（用户截图指出） | 隐藏原生条 + 自绘细条：`::-webkit-scrollbar { width: 0 }` 配 `::-webkit-scrollbar-thumb` 定宽定色，hover 才加深。与项目内 Monaco 滚动条同一手法 |
| **`position: absolute` 的浮层要先确认定位祖先** | 浮动按钮挂到某个容器下，若该容器没有 `position: relative`，会退到更外层祖先定位，位置完全错乱 | 浮层所在容器显式写 `position: relative`，并用自检断言该规则存在。（**2026-10-03 起本条对选区浮层不再适用** —— 已改用 `IContentWidget`，节点挂在 Monaco 自己的 overflow-guard 内，由 Monaco 自己 `setPosition("absolute"\|"fixed")`） |
| **`IContentWidget` 的 DOM 节点由 Monaco 独占 `display` / `visibility`** | 我们同时在样式表写 `.selection-copy{display:none}` + `bubble.hidden=true` + `.visible{display:inline-block}`，与 Monaco 的三处**内联**样式写入抢同一属性（构造 `setDisplay("none")`+`setVisibility("hidden")`；`setPosition()` 条件写 `block`/`none`；`render()` 写 `inherit`/`hidden`）。内联样式优先于样式表 → **谁最后写谁赢**，表现为"时而出现时而不出现"，且与折行多少（`render()` 频次）弱相关，看起来像"只在 md 上坏"（用户三次反馈） | **我们一次都不碰 `display` / `visibility`**。显隐的唯一真源是 `getPosition()` 的返回值：`null` → Monaco 自己收起，合法锚点 → Monaco 自己摆出。锚点须带 `preference`（否则 `setPosition` 里 `preference.length > 0` 过不去、Monaco 主动 `setDisplay("none")`）与 `positionAffinity: Left`（折行行锚在该视觉行左缘） |
| **`useDisplayNone: true` 会把 widget 钉死在 `display:none`** | 名字看着像"我自己管 display"，但在 `setPosition()` 里它被**取反**参与三元判断：`!this.useDisplayNone && 有锚点 && preference非空 ? setDisplay("block") : setDisplay("none")`。设成 `true` 条件恒假 → **永远走 else 被钉死**，想显示反而得自己写 `display`，正好退回"两方抢属性"的老问题 | 保持默认（`false`），把 `display`/`visibility` 完整交给 Monaco。改用 `getPosition()` 返回值控制显隐 |
| **`editor.layoutContentWidget()` 必须传原始 widget 对象** | 公开层会执行 `w.getPosition()` 并把结果写进包装器的 `position` 字段再转交视图层；传错对象（传包装器 / `undefined`）→ 锚点直接丢失 → 按钮不出现，而代码看起来完全正常 | 传**带 `getPosition` 的那个原始对象**；自检 V3 断言调用形状与锚点字段 |
| **`updateTooltip()` 不会重建 hover 容器 —— "每次重画都重建"是错的** | 曾据此错误结论写了 `freezeFindWidgetHover()`（第十轮），并在能力文档里把它记成"正确做法"。**读源码后证伪**：`actionViewItems.js` 的 `updateTooltip()` 是 `if (!this.customHover && title !== '') { 建 } else if (this.customHover) { update }` —— **只在首建，之后只 update**；`update()` 内部仅 `await hoverWidget?.update(...)`，**既不 show 也不 hide** | 排查此类问题**必须读到函数体**，不能停在"看到 `updateTooltip` 就以为是重建"。反例价值：这条错误结论直接导致了一整轮无效修复 |
| **在 Monaco 的 hover 节点上做 DOM 属性补丁，会被官方逻辑主动撤销** | `setupManagedHover()` 里有 `if (targetElement.title !== '') { console.warn('HTML element already has a title attribute, which will conflict with the custom hover...'); targetElement.title = ''; }` —— 它**会主动清掉**我们写的 `title`；而它自己 `setAttribute('custom-hover','true')` 是**属性写入**，`MutationObserver` 只监听 `childList/subtree` 管不到，于是形成"删属性 → 被加回 → 清 title → 再写 title"的 churn。**补丁本身成了噪声源** | 不要用 DOM 属性补丁去改变 Monaco 的 hover 行为。真因只能在**上游**（patch Monaco 产物，见下条）解决 |
| **Monaco 的 hover 浮层是自绘 DOM，不是原生 `title`** | 查找框关闭按钮的提示反复闪烁（用户反馈三轮，**仍未修复**）。已定位全部源码：`close` / `prev` / `next` 三个按钮构造**逐字相同**（`new SimpleButton({..., hoverLifecycleOptions})`，`hoverLifecycleOptions = { groupId: 'find-widget' }`），**唯一差别是 close 多一个只处理 Tab 的 `onKeyDown`**。由此得到两条互斥假设：H1（三者都闪 → 补丁打在共用的 `_setupDelayedHover`，把 delayed 改 instant）/ H2（只有 close 闪 → close 独有触发源） | **必须实测二选一**，不能靠读代码定论（前两轮的教训正是"猜机制"）。新增只读探针 `window.__uiFindHoverProbe()` + `npm run ui-probe:findhover`：在窗口期内派发合成 Alt 事件、统计 `monaco-hover` 节点增删次数来判定归属。**该探针只读、不写 DOM、不触碰网页** |
| **Monaco 产物里 `setBaseLayerHoverDelegate` / `setHoverDelegateFactory` / `createInstantHoverDelegate` 已被 tree-shake 掉** | 想从外部替换 hover delegate（让 `showNativeHover: true` 走 `setupNativeHover` 的纯 `title` 路径 → 天然不闪），但全产物搜索三个符号**命中均为 0**。原因：`standaloneCodeEditor` 里 `setBaseLayerHoverDelegate(hoverService)` 仅在 `getBaseLayerHoverDelegate()` 一处被消费，而后者有 no-op 默认值 → 打包器判为死代码删除。开发版 ESM 源码里 `setBaseLayerHoverDelegate` 存在（`hoverDelegate2.js`），**产物里没有** | 外部注入这条路**不通**。若必须消除闪烁，只能 patch `node_modules/monaco-editor/min`（产物链路：`min` →`copy-static.mjs:40`→ `dist/renderer/vendor/monaco`，**patch 会生效**）。自检与文档都不得再假设"能换 delegate" |
| **Monaco 会把 hover 内容的 `white-space` 写成内联样式** | 查找框关闭按钮的提示被折成两行、反复闪烁（用户反馈四轮）。真凶：`hoverWidget.js` 对**字符串**类型的 hover 内容写死 `contentsElement.style.whiteSpace = 'pre-wrap'`。内联声明压过任何普通样式表规则 → 前几轮在此加的 `white-space` **全部无效**，表现得"这按钮很邪乎"。而折行会让浮层尺寸变化 → 鼠标相对位置随之变化 → `MOUSE_LEAVE` 触发 `hideHover(false, e.fromElement===targetElement)` → hover 反复隐藏重建 = 闪 | 用 `!important` 覆盖（CSS 规范允许样式表 `!important` 覆盖元素**内联的非 `!important`** 声明），并**必须限定范围**：`.monaco-hover .hover-contents:not(:has(*))` —— Monaco 对字符串内容让 `.hover-contents` 是**叶子节点**（只含 textNode），markdown/富内容会 append 子元素。这样只圈定纯文本提示，不影响编辑器里的变量悬停与多行预览 |
| **判断浮动元素会不会"闪"，看尺寸是否稳定，而不是看代码逻辑** | 折行/内容变化 → 浮层尺寸变 → 鼠标相对浮层的位置变 → `MOUSE_LEAVE`/`MOUSE_OVER` 来回触发 → 反复隐藏重建。用户提供的两张对比截图是决定性证据：`Previous Match (Shift+Enter)`（27 字符）一行横排正常；`Close (Escape)`（14 字符）**更短却折行**并闪烁 ⇒ **折行与文本长度无关**，是浮层被挤在视口右缘、可用宽度不足 | 诊断浮层类问题：① 量**最终可观测量**（宽度/高度/行数），不要数"重建次数"这类中间信号；② 用"更长的那一个正常、更短的这一个异常"来反推，能立刻排除"文本太长"的假设 |
| **绝对定位元素上不要用 `min-width` 兜宽度** | 想让浮动按钮不被压窄，写了 `min-width: 44px`。但绝对定位元素上 `min-width` 只是**下限**：父级更宽时元素仍会被拉伸，宽度不稳定 | 用 `width: max-content` —— 宽度**完全由内容决定**，不受父容器挤压。配 `white-space: nowrap` 一起用（前者治"被压窄"，后者治"逐字换行"） |
| **否定式自检断言（`!re.test(...)`）会造假绿灯** | 正则一旦写错就恒为 `true`，表现为"永远 PASS"，比漏检更危险。本轮实测踩到：`.selection-copy{display:none}` 这个**被禁的写法就写在 CSS 注释的说明里**，正则命中了注释 → 误报（与 U1 的"注释里写着错误写法"是同一个坑）。另一处：V4 的 `/custom-hover/` 会误伤探针里 `bubble.getAttribute('custom-hover')` 这个**只读诊断**写法 | 匹配前**先剥注释**（CSS 用 `/\/\*[\s\S]*?\*\//g`，JS 另加行注释）；断言要区分**读/写**（拦 `setAttribute('custom-hover')` 而不是 `/custom-hover/`）；并把每条规则的布尔中间量用独立脚本打印出来核对 —— `tools/verify-bubble-selfrules.mjs` / `-offline.mjs` |
| **普通 JS（不走 `tsc`）里引用不存在的变量 → Monaco 回调静默吞掉异常** | `setupSelectionCopyBubble` 里写的是裸 `editor.getSelection()` / `editor.getModel()`，而**该函数并没有 `editor` 这个绑定**（同名的只是别的函数的局部变量，不构成闭包）。`getPosition()` 由 Monaco 在自己的渲染循环里回调，抛出的 `ReferenceError` **被内部吞掉、外部毫无报错**，表现只是"按钮永远不出现"。语法完全合法，L2 的 `node:vm` 语法解析查不出来 | 用 **TypeScript 编译器做真实作用域分析**：`tools/check-renderer-scope.mjs`（`allowJs` + `checkJs`，只看诊断 2304/2552），已接入 `npm run build`，报告供自检 V6 读取。实测对旧版精确报出 9 处 `Cannot find name 'editor'`、修复后 0 |
| **`ContentWidget.getPosition()` 里的异常是"静默失败"** | 该回调在 Monaco 的渲染循环内执行，**任何异常都不会冒泡到我们的代码**，也不会有控制台报错可见（取决于版本），只会表现为"widget 不出现" | 别在这种回调里做可能失败的操作；`getPosition()` 只读状态、只返回 `null` 或锚点，不做 DOM 操作、不做网络/IO。构建期用作用域检查兜底 |

| **依赖异步对象的初始化不能写成顶层 IIFE** | `setupSelectionCopyBubble` 写成顶层 IIFE 时同步执行，而 `state.editor` 要等 `window.require` 异步回调才赋值 → 守卫判断 `if (!state.editor) return` **静默 return**，按钮永远不出现，且代码就在文件里、看起来完全正常（用户实测：选中后没有浮动复制按钮） | 改成具名函数，在 `initMonaco` 的 `require` 回调里、`state.editor` 赋值之后调用；加幂等字段防回调重入。**自检必须断言"执行前提"，光断言"代码存在"完全无效** |
| **`min-height` 与 `max-height` 写成同值会钉死高度** | 输入框 CSS 写 `min-height: 88px; max-height: 88px`，JS 的 auto-grow 设的是内联 `height`，而 **CSS 的 min/max-height 钳制优先级高于内联 `height`** → `grow()` 形同虚设，粘贴内容不撑开（用户实测） | 两端拉开：CSS 与 JS 各写一份上下限（`44px` / `220px`）并**用自检断言两者一致**；`min ≠ max` 也要单独断言 |
| **auto-grow 归零时只清 `height` 不够** | `el.style.height = 'auto'` 后 `scrollHeight` 仍被 `min-height` 顶起，量到的不是真实内容高度 | 归零时连 `minHeight = '0px'`、`maxHeight = 'none'` 一起放开，量完再写回 |
| **flex 子项缺 `min-height: 0` 就不会收缩** | `.editor-wrap` 是 `flex: 1` 但默认 `min-height: auto`，输入框一撑高就把编辑器顶出视口、底部被裁（用户实测："输入框底部有点溢出"） | 中间层需要收缩的 flex 子项（`.editor-wrap` / `.monaco`）写 `min-height: 0` |
| **`min-height: 0` 配 `flex-shrink: 0` 是无效组合** | `.prompt-bar` 写了 `flex: 0 0 auto` + `min-height: 0`，但 **flex-shrink: 0 直接禁止收缩**，`min-height` 根本轮不到起作用 → 视口一紧张就不缩，把底部边框顶出可视范围。现象有欺骗性：**「启动时底部溢出，拖一下窗口就恢复」** —— 恢复靠的是浏览器重排，不是任何 JS 逻辑在起作用，很容易误判成"测量时机问题"去改 JS | 改成 `flex: 0 1 auto`（放开收缩） |
| **「可收缩」改成 `min-height: 0` 又过头 → 切掉自身内容** | 上一条修完后写 `min-height: 0`，本区被压到**低于自身内容高度**；而 `.prompt-shell` 当时是 `overflow: hidden`，于是输入框下沿被**裁掉一条**（用户截图："底部输入框溢出了一部分"）。同一个区域在两个方向上都踩过 | 结尾区**可缩，但下限取内容自然高度**（`min-height: 82px` = padding 8 + shell(10+44+10) + padding 10）；需要让高度时优先压 `.layout`（能一路压到 0）。自检 R6 断言 `min-height ≥ 内容自然高度` |
| **外壳 `overflow: hidden` 把"差几像素"变成"可见切边"** | 加 `overflow: hidden` 本想"收缩时不顶破圆角"，但它让**任何**小的尺寸误差都变成用户看得见的缺口 —— 最难查的正是这种"只差 4px"的裁切 | 宁可让内容明显溢出（可被立刻发现），也不静默裁切。自检 R6b 断言外壳**不含** `overflow: hidden` |
| **`height = scrollHeight` 少算元素自身 padding** | `scrollHeight` **不含元素自身的 padding**，而 `box-sizing: border-box` 下 `style.height` 是**含 padding** 的总高。`.requirement` 有 `padding: 2px 0`，直写 `scrollHeight` 就矮 4px —— 这正是"底部缺一条"的直接成因 | `contentH = scrollHeight + BOX_PAD`（常量 `BOX_PAD` 与 CSS padding 成对维护）。自检 R6c 断言计算式含 `+ BOX_PAD` |
| **断言读 CSS 时必须先去掉注释** | 新增的 R6b 断言"外壳不含 `overflow: hidden`"，而**注释里为了说明历史正好写出了这个词** → 断言被自己的说明文字误伤，报出假失败 | 断言前先 `stripCssComments()` 去掉 `/* … */` 再匹配。凡是"断言某个写法**不存在**"的检查都要注意这点 |
| **JS auto-grow 不能只在启动时量一次** | 脚本**同步执行**时 flex 布局尚未稳定、字体未就位，此时量到的 `scrollHeight` 不可靠，写死的内联 `height` 就是错的 → 初始页面观感错乱，只有触发重排才纠正 | 用 `ResizeObserver` **跟随实际宽度持续校正**，首次测量延到 `requestAnimationFrame` 之后。**防自激**：RO 观察的元素正是自己改height 的那个，必须在回调里只比较宽度（宽度没变就 return），否则 height → RO → height 成死循环 |
| **窗口显示前测的 `getContentSize()` 不可信** | `new BaseWindow(...)` 之后立刻量内容区，此刻**窗口还没显示**，边框/缩放/DPI 适配都未最终确定 → 四个视图按错尺寸定bounds，而 **bounds 不会自动跟随视口** → 编辑器底部被切掉。**「拖一下窗口就恢复」是误认**：那只是触发了 `win.on('resize', relayout)` | 显示完成后重算：挂 `win.once('show')` + `win.once('resized')` + `did-finish-load` 三处，任一到即`relayout()`（幂等，重复无副作用）。⚠️ **`BaseWindow` 没有 `'ready-to-show'`**（那是 `BrowserWindow` 的），且 macOS 上 `resize` 与 `resized` 是两个事件，后者才代表尺寸真的定了 |
| **自检里用正则匹配 `dist/**/*.js` 的编译产物** | `tsc` 会把 `CHANNELS` 编译成 `contract_1.CHANNELS`，正则漏匹配导致假失败 | 匹配时允许可选的命名空间前缀：`\.send\(\s*(?:contract_1\.)?CHANNELS\.` |
| **局部替换由原文唯一匹配定位，IDE 计算行号** | 明确替换用 SEARCH/REPLACE，新内容允许增减长度；多个原区间需唯一且不重叠，预览冻结完整原文 | computeApply 只统一换行，ReturnPathService 复核全文基线；自己的应用与撤销重算剩余位置，外部变化拒绝。完整规范见 return-path-and-format-contract.md，测试与 verify:range 验证 |
| **"用户描述的现象"可能与代码实际行为相反，先复现再动手** | 用户描述"覆盖了全部区域"，而代码实际是"**该覆盖的行没被覆盖掉**（多写了→重复）"。两者在屏幕上看起来很像，但修法完全不同。若按字面去查"为什么会整文件替换"，会一头扎进错误方向 | 任何"范围/位置不对"的反馈，先用**真实原文 + 真实回复**在隔离脚本里跑一遍 `parseModelReply` → mode 构造 → `computeApply`，把中间量（range / mode / 结果全文）逐行打印出来核对。**先证明哪个环节出错，再改代码** |
| **子串属性选择器 `[class*="x"]` 会静默命中语言标注等无关类名** | `[class*="markdown"]` 同时命中 `<code class="language-markdown">` 与 `<div class="ds-markdown-title">`。取"文档序最后一个"时会选中 `<code>`（更深、更靠后、内部无 `<pre>`）→ 采集结果为空，且**不报任何错**。同理 `[class*="code"]` 会命中 `language-*` 与各种 wrapper | 用子串选择器后**必须按 `tagName` 黑白名单过滤**（排除 `PRE`/`CODE`），并**优先选满足结构前提的候选**（此处 = 真正含 `<pre>` 的那个），无命中再回退到宽松候选。诊断脚本要打印"选中了哪个节点、它的 tagName 与子节点数"，否则空结果无法归因 |
| **采集/定位类判据必须直接表达语义本身，别用代理指标** | 旧策略用"markdown 容器里 `<pre>` 最多"来近似"最新回复"。单回复会话里偶然正确，多轮对话里所有回复各 1 个 `<pre>` → 平局停在 DOM 第一个 = **最旧的回复**；且"pre 最多"本身与新鲜度无关。更迷惑的是路径标题用整页扫描取到了**最新**的 → 形成"旧代码 + 新标题"的错配，看起来像对了 | "最新"直接表达为**文档序最后**（`querySelectorAll` 反向遍历）；线索（`### 文件：` / `### 操作：`）**只在已定位的容器内**提取，绝不整页扫描。结构性常量（如策略数）改动时，**先 grep 自检里的硬编码断言**（本轮 `>= 4` 因降为 3 套而失效） |
| **给模型看的提示词模板里，绝不要写出裸的三反引号** | 模板是**自然语言**，不是渲染后的文档。早期在说明里写「.py 用 ` ```python `、.ts 用 ` ```typescript `」，模型把它读成**代码块开头**，而这段说明后面没有配对的闭合围栏 → 模型输出出现"有开头没结尾"的代码块（用户实测："第一次输出没有 ``` 结尾"）。**反直觉**：人看这段说明毫无歧义，模型却按围栏语法解析 | 一律改用「三反引号 + python」这类**文字描述**；并显式写明「围栏**必须成对**：代码写完后必须再写一行三反引号闭合」。⚠️ **判据要随演进升级**：后来模板改为"五反引号包住示例"（示例里必须出现三/四反引号才直观），"零反引号"就不再成立 —— 真正的不变量是「**每段围栏都必须与同长度的另一段配对**」。用单测 + 自检 F3b + 离线断言 X1 锁死。**推论：凡是写进提示词的字符，都要按"模型会怎么解析它"来审，而不是按"人怎么读它"** |
| **多条并列规则若互相冲突、又没给优先级，模型只会折中** | 旧模板同时给了「语言标注跟**文件类型**走（.md→markdown）」与「含反引号就用四反引号」，两条**并列无优先级**。当"文件是 .md"+"只改纯代码行"同时成立时，模型只能自己权衡，结果两头不讨好（用户实测：让 AI 改 .md 里内嵌代码块时格式翻车）。**这类缺陷的根因不是"规则写得不够多"，而是"规则之间没有关系"** —— 再加十条同层规则只会更乱 | **把"要模型推理的规则"换成"要模型照抄的事实"**：新原则 = **输入片段长什么样，输出就照抄同样的围栏结构**（语言标注照抄、围栏行照抄、成对闭合、长度自适应）。模型不必推理"文件类型/含不含围栏行"，只需对齐输入 —— 规则更少、遵守率更高。**推论：当你想给提示词加规则时，先问"这条能不能改成让它照抄某个已存在的东西"** |
| **同一动作有多个入口时，状态必须由一处统一广播** | 应用有两个入口（预览面板按钮 / 编辑器工具条）。走面板入口时面板自己知道；走编辑器入口时落盘在主进程，而面板是**另一个渲染进程**（ADR-0002）→ 面板一直显示可应用的假状态（用户实测："左侧编辑器应用后，右侧状态没有同步更新"）。**这类缺陷不会报错，只是"看起来没生效"** | 状态变更由**主进程在成功那一刻统一广播**（`preview:applied`），而不是让各入口各自标记。撤销也要广播复位。跨视图的单向通知一律走 `webContents.send`（`oneWayChannels` 名单同步登记），并注意 `tsc` 会把 `CHANNELS.x` 编译成 `contract_1.CHANNELS.x`——在 dist 产物里搜断言必须容忍命名空间前缀 |

## 左侧编辑器与目录树的当前行为

| 项 | 取值 |
|---|---|
| 可编辑性 | **默认可编辑**（不设 `readOnly`）；Ctrl+S 保存 |
| 未保存标记 | 文件头右侧**白点**（有改动才显示）+ 工具栏 `● 未保存` |
| 自动换行 | `wordWrap: 'on'`（长行不再横向滚动） |
| 字体 / 行高 | Cascadia Code → Consolas → 等宽回退；字号 14 / 行高 22 |
| 可读性辅助 | 缩进参考线、括号配色、当前行高亮、行号宽度自适应、统一深色滚动条 |
| 目录树交互 | 点击文件夹原地展开／收起；手动刷新保留有效展开状态，切换根目录清空；点击文件打开或激活已有标签并高亮，切换保留草稿 |
| 目录树显隐 | 编辑器顶部条左侧**图标按钮**（高亮=当前可见）+ `Ctrl+B` |
| 变更列显隐 | 自身收起按钮关闭；网页工具条分栏图标与视图菜单恢复/切换 |

> 操作按区域归属：目录树和复制在编辑器、采集在网页顶栏、应用与撤销在变更列。

| **跨容器自己算 Monaco 坐标必然错位 —— 一律用 `IContentWidget`** | 浮层曾挂在编辑器**外部**的 `.editor-wrap` 上，用 `getTopForLineNumber()` / `getOffsetForColumn()` 自己算 `style.left/top`。这两个 API 返回的是**编辑器视口内**坐标，而编辑器自己是独立滚动容器 —— 一滚动两套坐标系就脱节。叠加 `wordWrap`：`end.lineNumber` 是**逻辑行**，但该行可能折成多个**视觉行**，取到的是**第一视觉行**的 top。结果是代码文件"歪着出现"、**markdown 长段落干脆不出现**（用户两次反馈"文本文件没有复制按钮"）。前两轮分别归因于`getPositionAt` 参数类型、原生 `title`，都只修到表象 | 定位**整个交给 Monaco**：用 `editor.addContentWidget()` 注册浮层，`getPosition()` 只返回 `{ position, preference }`（锚在选区末端的行尾 = 用户要的"右端行右上角"），滚动时只调 `editor.layoutContentWidget()`。配套三条：`preference: [ABOVE, BELOW]` 让 Monaco 自己选不遮挡的一侧；`suppressMouseDown: true` 防止点按钮时编辑器抢焦点导致选区丢失（否则复制到的是整篇文件）；显隐走 class，**一个 `style` 都不写** |
| **`title` 闪烁的根因不是「写多了次」，是「在高频事件里重排 DOM」** | 原生 tooltip 在元素位置/样式**发生任何变化**时失效并重新计时。此前 `place()` 已加了"位置未变就return"，闪烁依旧——因为查找过程中 `onDidChangeCursorSelection` 本来就频繁触发，位置**一直在变**。此时任何一次 `style` 写入都会让旁边查找框的 `Close (Escape)` 面板反复重建（用户两次反馈"仍然有闪烁"）。**只优化写入次数治不了这个** | 断掉因果链，而不是减少次数：改用 `IContentWidget` 后**完全不写 style**，重排不再发生。同时浮层自身也不用 `title`（改 `aria-label`），避免它自己成为下一个闪烁源 |
| **删按钮时别把能力一起删掉** | 「保存 (Ctrl+S)」按钮按用户意见移除时，若连 `el.btnSave` 的引用与监听一并清掉，容易顺手把 `Ctrl+S` 的快捷键注册也弄丢 | 按钮移除与快捷键注册是**两件事**：后者注册在 Monaco 上（`KeyMod.CtrlCmd \| KeyCode.KeyS`），必须保留。自检 U5 断言「按钮没了 **且** 快捷键还在」 |
| **自检的"通道清单"是手工维护的，漏一条就误报"未注册"** | `ipc.ts` 里 `registerFileIpc()` 返回一个通道数组供自检 E1 核对（Electron **没有**公开的"已注册通道"查询接口，只能这样声明）。后加 `ui:step-diff` 时只改了 `contract.ts`、没同步这个数组 → E1 报"未注册"，而 `index.ts` 早注册了。**断言失败要先分清是"实现缺了"还是"清单漂了"**，否则会去改本来正确的业务代码 | 三处清单必须同步：`contract.ts`（常量）、`ipc.ts` 返回数组（双向通道）、`selfTest.ts` 的 `oneWayChannels`（主进程 → 渲染进程的单向通道，只有 `webContents.send` 没有 `handle`）。另：多渲染进程后 E2 不能只扫 `preload.js` —— `preview:active-diff` 属于**预览面板**的桥，编辑器 preload 里没有它是正确的。**每个 preload 一起扫**（`preloadFiles`），通道名前缀也要覆盖 `preview:` / `ui:` |
| **`const` 没有提升：自检里的"源码读取"必须放在 try 块最前** | Y 组（提示词面板）要用 `mainTs`/`preloadTs`，而这两行原本写在 Q 组附近（Y 组之后）。运行到 Y 组时 `const` 还在 TDZ，直接抛 `ReferenceError` → **整份自检报告退化成一条 FAIL**，看起来像"面板全错" | 所有 `fs.readFileSync(...src...)` 的**源码读取集中到 try 块开头**，后续分组只消费变量。这类"变量声明顺序"错误在 `tsc` 里看不出来（类型都对，只是运行时顺序不对） |
| **用户可改的配置，必须保证"空值 = 回落默认"** | 提示词里的「输出格式要求」是**让一键同步成立的那份约定**。若允许用户保存成空串，提示词里就少了这一段，模型输出无法被解析 —— 而这**不会有任何报错**，表现为"复制提示词后 AI 的输出识别不出来"，排查成本极高 | 双层兜底：① `SettingsStore.load()` 里空串**视同未设置**；② `savePromptSpec` 里空内容**视同恢复默认**（面板文案同步说明）。核心是 `resolveFormatSpec(customs, variant)`（`customs` 是**按版本**的 `{ short, full }`）：空白一律回落内置默认。另：`getFormatSpec()` 保持**纯粹**（不读设置），自定义只经 `resolveFormatSpec` 注入，测试因此不需要准备设置文件 |
| **"恢复默认"不能一键直接落库** | 用户辛苦写的格式约定若被一次误点瞬间清空，且不可撤销 | 「恢复默认」只把默认全文**载入编辑框**，仍需再点「保存」才生效；取消/关闭即什么都没变。自检 Y4 直接读 `resetToDefault()` 的函数体，断言它是"写编辑框"而不是"调 `bridge.reset()`" |

> 目录树早期实现是"每次列一层、整表替换"，没有返回上级的途径，已被判定为交互缺陷
> （见审计 P2-13）。改为可展开结构后与主流编辑器一致。

## 底部需求输入区的当前行为

| 项 | 取值 |
|---|---|
| 布局 | 上方文本框占满宽度，下方紧凑操作栏：版本、权限、自动采集、设置和复制；窄列换行 |
| 外壳 | 单层低对比边框，聚焦时高亮，不叠加外圈描边 |
| 高度 | 文本框最小 44px、最大 220px；上限随视口与操作栏实际高度收缩。输入、粘贴、拖入、缩放和操作栏换行后重算，超出上限滚动 |
| 高度预算 | 输入区最多占视口高度 48%，为操作栏及内边距预留空间；工具面板随输入高度收缩并保留编辑空间，长输入不裁切底部控件 |
| 版本切换 | 「简洁 / 完整」分段控件，点击按钮或聚焦容器后按 Space / Enter 切换；主进程持久化 `formatSpecVariant`，重启后恢复 |
| 开关改什么 | 复制提示词时使用的输出格式要求；简洁为 6 个示例，完整为 13 个示例；两版自定义互不影响 |
| 自定义标记 | 当前版本有非空自定义提示词时显示小圆点，悬停说明；主进程保存、清空、恢复默认与切换后广播布尔状态 |
| 提示词设置 | 操作栏齿轮打开工具设置浮层，其中提示词编辑按钮打开原有独立视图；菜单入口与 Ctrl+Shift+P 保留 |
| 复制反馈 | 固定宽度的紧凑按钮，成功暂显「已复制」；失败提示原因并恢复可操作，需求为空时聚焦输入框 |
| 状态一致性 | 启动读取真实状态；切换或复制期间阻止重复操作；切换失败保留实际版本，状态未知时禁止复制 |

输入区行为由 `src/renderer/promptComposer.js` 唯一负责，`renderer.js` 初始化并接入信息栏。
工具面板、浮层与高度预算由 `src/renderer/toolPanelLayout.js` 管理，纯摘要由 `src/renderer/toolResultPresentation.js` 管理；权限、执行状态与结果复制接线见 `docs/capabilities/tool-harness.md`。目录树宽度在窄列时钳制，为编辑器保留空间。
`ui:get-prompt-status` 查询版本及两版自定义布尔值，`ui:prompt-status` 推送相同结构；编辑器不读取提示词全文。
复制仍由主进程组装并写入系统剪贴板，由用户自己粘贴到 AI 网页并发送。

## 代码入口

- 主进程：`src/main/index.ts`、`src/main/fileService.ts`、`src/main/ipc.ts`、`src/main/selfTest.ts`
- 预加载：`src/main/preload.ts`（编辑器）、`src/main/previewPreload.ts`（预览面板）、`src/main/webbarPreload.ts`（网页区工具条）
- 渲染进程：`src/renderer/`（`index.html` 编辑器 / `preview.*` 预览面板 / `webbar.*` 网页区工具条 / `promptComposer.js` 输入区行为）
- 纯逻辑（可单测）：`src/shared/`
- 脚本：`scripts/install-electron.mjs`、`scripts/copy-static.mjs`

## 网页嵌入方式选型（Electron 三种方式对比）

| 方式 | 进程关系 | 结论 |
|---|---|---|
| `<iframe>` | 同渲染进程，依赖目标站点 CSP 允许 | **排除**。共享父页面环境，痕迹脏 |
| `<webview>` 标签 | 跨进程 iframe（OOPIF），需开 `webviewTag` | **排除**。Electron 官方明确不推荐（"undergoes dramatic architectural changes"），WebView API 不保证长期可用 |
| **`WebContentsView`** | 由主进程创建与控制，不在 DOM 内 | **采用**。`BaseWindow` + `contentView.addChildView`；天然独立进程与独立 session，符合 ADR-0002 的进程隔离要求 |

注：`BrowserView` 已标记 Deprecated，迁移目标即 `WebContentsView`。参考 Electron 官方 [Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)。

**可行性已获旁证**：Obsidian 的核心插件 Web viewer 基于 Chromium webview 标签，实测可正常加载 `chat.deepseek.com`——说明该站点**未通过 `X-Frame-Options` / CSP `frame-ancestors` 禁止嵌入**。但这只证明"能嵌进去"，**不证明"不会被识别"**；识别风险由 P1 Gate 判定（已通过）。

## 依赖安装注意

`pnpm install` 默认拦截 `postinstall`，因此 Electron 二进制不会被下载。首次需执行：

```powershell
pnpm install
node scripts/install-electron.mjs   # 走镜像；或从 tools/ 复制已有二进制
```
