---
artifact_type: capability
status: current
updated: 2026-10-02
owner: 胡运宽
source_of_truth:
  - docs/adr/2026-10-02-honest-electron-identity.md
  - docs/adr/2026-10-02-filesystem-permission-model.md
  - docs/plans/2026-10-02-mini-ai-ide-poc.md
---

# 能力：应用外壳与进程架构

> 状态说明：**P2 骨架已实现；自检 128 项、单测 153 项**。本节记录当前事实。
> 自检命令：`npm run self-test`（构建 + `electron . --self-test`，不联网）。
> 运行时探针：`npm run ui-probe`（编辑器状态 / 几何）、`npm run ui-probe:bubble`（选区浮层按钮是否真的出现）。
> 断言条数以 `src/main/selfTest.ts` 中 `add(` 的调用数为准（一轮前 122，本轮 V 组 +6）。
> `npm run build` 会顺带跑 `tools/check-renderer-scope.mjs`，对 `renderer.js` 做真实作用域分析。

## 当前技术栈（已落地）

| 项 | 值 |
|---|---|
| 运行时 | Electron **44.5.1**（Chromium 152.0.7977.130 / Node 24.21.0） |
| 语言 | TypeScript 5.9.3（strict，含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`） |
| 包管理 | pnpm（**依赖 postinstall 的二进制需单独安装**，见下） |
| 编辑器 | Monaco Editor 0.57.0（AMD 发行版，从 `node_modules` 复制到 `dist`） |
| 测试 | Node 内置测试运行器 + tsx（153 项单测，`npm test`） |
| 打包器 | **无**（`tsc` + 静态复制脚本） |

## 进程契约

现在共 **4 个 `WebContentsView`**（此前 3 个，网页区顶部工具条是本轮新增的）：

| 进程 | 职责 | 硬性约束 |
|---|---|---|
| **main** | 窗口与分栏布局、IPC 路由、本地文件读取、会话分区配置、启动自检 |绝不发起或代理大模型相关网络请求；**绝不向网页写入任何内容** |
| **editor renderer**（`persist:editor-ui`） | Monaco 渲染、文件树、编辑与保存、需求输入区 | `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`；无文件系统能力；CSP `connect-src 'none'` |
| **webview renderer**（`persist:postcheck`） | 加载目标平台网页 | 顶级独立视图（`WebContentsView`）；程序**只读不写** |
| **webbar renderer**（`persist:editor-ui`） | 网页区顶部 30px 工具条（网页可见）/ **右边缘竖把手**（网页隐藏）：网页与预览的显隐开关 | 只能发"切换显隐"意图；不能读写文件、不能碰网页。**永不隐藏**——它是"把网页叫回来"的常驻入口 |
| **preview renderer**（`persist:editor-ui`） | 右下角回程预览：变更列表 + 逐条应用 + 撤销 | 同上；落盘只经主进程三向校验 |

## 布局规则（三区 + 网页区顶栏 / 右边缘把手）

```
网页可见：
┌──────────────┬─────────────────────────┐
│              │  网页区工具条 (30px)      │  ← 网页/预览的显隐开关
│  编辑器       ├─────────────────────────┤
│  （含目录树） │  网页（DeepSeek，只读）   │
│              ├─────────────────────────┤
│              │  回程预览（变更列表）      │
├──────────────┴─────────────────────────┤
│  需求输入框（默认 4 行，高度自适应）        │
└────────────────────────────────────────┘

网页隐藏（编辑器占满全宽）：
┌───────────────────────────────────┐
│                             ┌─┤
│    编辑器                     │ │ ← 右边缘把手：静置 5px 窄条，
│                               └─┤   hover / 刚隐藏后展开 28px
├───────────────────────────────────┤
│  需求输入框                │
└───────────────────────────────────┘
```

- **`webVisible=false` 时编辑器占满整个窗口**，右列内容区（网页/预览）全部隐藏。
  - 原因：右列没有任何内容视图时，按原布局会露出 `BaseWindow` 的**白底**（用户实测："隐藏 AI 网页就是变白吗？"）。
  - 预览面板随网页一并隐藏：它属于"网页区"，网页不在时其显隐入口也不存在。
- ⚠️ **网页区工具条视图永不销毁、永不隐藏**。网页隐藏时它贴到**窗口右边缘**变成竖把手：
  - 静置 `HANDLE_BAR_PEEK = 5px` 窄条，hover / 刚隐藏后展开到 `HANDLE_BAR_WIDTH = 28px`（图标 + 竖排「AI 网页」文字）；
  - 刚隐藏后**3 秒**保持展开并高亮（`just-hidden`），让用户知道入口在哪——否则 5px 窄条很容易被当成窗口边框；
  - 把手是**覆盖**在右侧一小条上，**不占布局宽度**，因此编辑器仍能占满 `width`；
  - **为什么必须这样**：早期实现把开关放进网页区顶部，网页隐藏时工具条跟着隐藏，用户点完隐藏就**再也回不来**（本项目已犯过一次，见下方陷阱表）。
- **网页显隐的三个入口**全部汇聚到 `setWebVisible()`，保证几何、菜单勾选、三个渲染进程状态一致：
  1. 网页可见时：顶部工具条的「隐藏」图标按钮；
  2. 网页隐藏时：右边缘把手的「展开」按钮；
  3. **View 菜单的「AI 网页」勾选项**（兜底，应用级 UI 永远不会被隐藏）+ `CmdOrCtrl+Shift+A`。

  编辑器的 `Ctrl+Shift+A` 走 IPC，最终也落到同一个 handler。菜单因为带勾选状态，改动后会`buildApplicationMenu()` 重建。
- 目录树开关在**编辑器顶部条左侧**（不放进 sidebar 内部——侧栏隐藏时按钮会跟着消失，用户再也点不回来）。
- 快捷键 `Ctrl+B`（目录树）与 `Ctrl+Shift+A`（网页）保留，编辑器获得焦点时也生效。

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
| **Monaco 的 hover 面板是自绘 DOM，不是原生 `title`** | 查找框关闭按钮的提示反复闪烁（用户三次反馈）。真凶：`MenuEntryActionViewItem.updateLabel()` 经 `localize(1726,"{0} ({1})",...)` 生成 `"Close (Escape)"`，而它挂在 **AltKeyTracker** 上 —— `n!==this._wantsAltCommand && (..., this.updateLabel(), this.updateTooltip(), ...)`，**每次 alt/ctrl/shift/meta 状态变化**都重画；`updateTooltip()` 走 `setupManagedHover(...)`，Monaco 会给节点打 `custom-hover="true"` 渲染**自绘容器**，每次重画 dispose 旧容器再建新的 → 视觉上就是闪。**据此确认：第一轮怪 `getPositionAt` 的 NaN、第二轮把 `title` 改 `aria-label`，两轮都打偏了**（那个面板不来自 `title`） | 不 patch Monaco。`freezeFindWidgetHover()` 挂 `MutationObserver` 蹲查找框出现，查到带 `custom-hover` 标记的 action 项就**移除该标记**（自绘 hover 的开关）并把现有 `aria-label` 写进 `title` → 原生 title 由浏览器托管、不随重排销毁重建，不再闪，且悬停仍能看到 "Close (Esc)" |
| **高频回调里重排 DOM 会连累旁边控件的自绘 hover** | 在 `onDidChangeCursorSelection` / `onDidScrollChange` 里做 DOM 重排，会让相邻控件的自绘 hover 反复重建 —— 这是"闪烁"的通用成因，不止查找框一处 | **高频回调里只做状态更新与 `layoutContentWidget()`，不 appendChild / 不写 style**。自检 V4 把这条写成规则 |
| **否定式自检断言（`!re.test(...)`）会造假绿灯** | 正则一旦写错就恒为 `true`，表现为"永远 PASS"，比漏检更危险。本轮实测踩到：`.selection-copy{display:none}` 这个**被禁的写法就写在 CSS 注释的说明里**，正则命中了注释 → 误报（与 U1 的"注释里写着错误写法"是同一个坑） | 匹配前**先剥注释**（CSS 用 `/\/\*[\s\S]*?\*\//g`，JS 另加行注释）；并把每条规则的布尔中间量用独立脚本打印出来核对 —— `tools/verify-bubble-selfrules.mjs` / `-offline.mjs` |
| **普通 JS（不走 `tsc`）里引用不存在的变量 → Monaco 回调静默吞掉异常** | `setupSelectionCopyBubble` 里写的是裸 `editor.getSelection()` / `editor.getModel()`，而**该函数并没有 `editor` 这个绑定**（同名的只是别的函数的局部变量，不构成闭包）。`getPosition()` 由 Monaco 在自己的渲染循环里回调，抛出的 `ReferenceError` **被内部吞掉、外部毫无报错**，表现只是"按钮永远不出现"。语法完全合法，L2 的 `node:vm` 语法解析查不出来 | 用 **TypeScript 编译器做真实作用域分析**：`tools/check-renderer-scope.mjs`（`allowJs` + `checkJs`，只看诊断 2304/2552），已接入 `npm run build`，报告供自检 V6 读取。实测对旧版精确报出 9 处 `Cannot find name 'editor'`、修复后 0 |
| **`ContentWidget.getPosition()` 里的异常是"静默失败"** | 该回调在 Monaco 的渲染循环内执行，**任何异常都不会冒泡到我们的代码**，也不会有控制台报错可见（取决于版本），只会表现为"widget 不出现" | 别在这种回调里做可能失败的操作；`getPosition()` 只读状态、只返回 `null` 或锚点，不做 DOM 操作、不做网络/IO。构建期用作用域检查兜底 |

| **依赖异步对象的初始化不能写成顶层 IIFE** | `setupSelectionCopyBubble` 写成顶层 IIFE 时同步执行，而 `state.editor` 要等 `window.require` 异步回调才赋值 → 守卫判断 `if (!state.editor) return` **静默 return**，按钮永远不出现，且代码就在文件里、看起来完全正常（用户实测：选中后没有浮动复制按钮） | 改成具名函数，在 `initMonaco` 的 `require` 回调里、`state.editor` 赋值之后调用；加幂等字段防回调重入。**自检必须断言"执行前提"，光断言"代码存在"完全无效** |
| **`min-height` 与 `max-height` 写成同值会钉死高度** | 输入框 CSS 写 `min-height: 88px; max-height: 88px`，JS 的 auto-grow 设的是内联 `height`，而 **CSS 的 min/max-height 钳制优先级高于内联 `height`** → `grow()` 形同虚设，粘贴内容不撑开（用户实测） | 两端拉开：CSS 与 JS 各写一份上下限（`44px` / `220px`）并**用自检断言两者一致**；`min ≠ max` 也要单独断言 |
| **auto-grow 归零时只清 `height` 不够** | `el.style.height = 'auto'` 后 `scrollHeight` 仍被 `min-height` 顶起，量到的不是真实内容高度 | 归零时连 `minHeight = '0px'`、`maxHeight = 'none'` 一起放开，量完再写回 |
| **flex 子项缺 `min-height: 0` 就不会收缩** | `.editor-wrap` 是 `flex: 1` 但默认 `min-height: auto`，输入框一撑高就把编辑器顶出视口、底部被裁（用户实测："输入框底部有点溢出"） | 需要收缩的 flex 子项（`.editor-wrap` / `.prompt-bar` / `.prompt-shell` / `.monaco`）**成对**写 `min-height: 0` |
| **`min-height: 0` 配 `flex-shrink: 0` 是无效组合** | `.prompt-bar` 写了 `flex: 0 0 auto` + `min-height: 0`，但 **flex-shrink: 0 直接禁止收缩**，`min-height` 根本轮不到起作用 → 视口一紧张就不缩，把底部边框顶出可视范围。现象有欺骗性：**「启动时底部溢出，拖一下窗口就恢复」** —— 恢复靠的是浏览器重排，不是任何 JS 逻辑在起作用，很容易误判成"测量时机问题"去改 JS | 改成 `flex: 0 1 auto`（放开收缩）+ `min-height: 0`；自检要**同时**断言这两条，只查 `min-height: 0` 会放过这个无效组合 |
| **JS auto-grow 不能只在启动时量一次** | 脚本**同步执行**时 flex 布局尚未稳定、字体未就位，此时量到的 `scrollHeight` 不可靠，写死的内联 `height` 就是错的 → 初始页面观感错乱，只有触发重排才纠正 | 用 `ResizeObserver` **跟随实际宽度持续校正**，首次测量延到 `requestAnimationFrame` 之后。**防自激**：RO 观察的元素正是自己改height 的那个，必须在回调里只比较宽度（宽度没变就 return），否则 height → RO → height 成死循环 |
| **窗口显示前测的 `getContentSize()` 不可信** | `new BaseWindow(...)` 之后立刻量内容区，此刻**窗口还没显示**，边框/缩放/DPI 适配都未最终确定 → 四个视图按错尺寸定bounds，而 **bounds 不会自动跟随视口** → 编辑器底部被切掉。**「拖一下窗口就恢复」是误认**：那只是触发了 `win.on('resize', relayout)` | 显示完成后重算：挂 `win.once('show')` + `win.once('resized')` + `did-finish-load` 三处，任一到即`relayout()`（幂等，重复无副作用）。⚠️ **`BaseWindow` 没有 `'ready-to-show'`**（那是 `BrowserWindow` 的），且 macOS 上 `resize` 与 `resized` 是两个事件，后者才代表尺寸真的定了 |
| **自检里用正则匹配 `dist/**/*.js` 的编译产物** | `tsc` 会把 `CHANNELS` 编译成 `contract_1.CHANNELS`，正则漏匹配导致假失败 | 匹配时允许可选的命名空间前缀：`\.send\(\s*(?:contract_1\.)?CHANNELS\.` |

## 左侧编辑器与目录树的当前行为

| 项 | 取值 |
|---|---|
| 可编辑性 | **默认可编辑**（不设 `readOnly`）；Ctrl+S 或工具栏保存 |
| 未保存标记 | 文件头右侧**白点**（有改动才显示）+ 工具栏 `● 未保存` |
| 自动换行 | `wordWrap: 'on'`（长行不再横向滚动） |
| 字体 / 行高 | Cascadia Code → Consolas → 等宽回退；字号 14 / 行高 22 |
| 可读性辅助 | 缩进参考线、括号配色、当前行高亮、行号宽度自适应、统一深色滚动条 |
| 目录树交互 | 点击文件夹**原地展开/收起**（**不是**"进入该目录"）；展开状态按根目录记忆；点击文件打开并高亮 |
| 目录树显隐 | 编辑器顶部条左侧**图标按钮**（高亮=当前可见）+ `Ctrl+B` |
| 回程预览显隐 | **仅**网页区右上角的分栏图标按钮（高亮=当前可见）+ View 菜单勾选项 |

> **显隐开关每个功能只允许一套界面入口。** 预览面板曾同时存在编辑器工具栏的
> 「回程预览」文字按钮与网页区右上角的分栏图标按钮，两者调同一个 `setPreviewPanel`、
> 连高度算法都逐行相同，纯重复且让人误以为管的是两件事（用户指出）。已删掉前者。
> 归属原则：**开关跟着它控制的那块板走** —— 预览属于右侧那一列，就不该放在编辑器顶栏。
> 网页区的「隐藏网页」按钮功能不同（控制网页显隐），不属此列。

| **跨容器自己算 Monaco 坐标必然错位 —— 一律用 `IContentWidget`** | 浮层曾挂在编辑器**外部**的 `.editor-wrap` 上，用 `getTopForLineNumber()` / `getOffsetForColumn()` 自己算 `style.left/top`。这两个 API 返回的是**编辑器视口内**坐标，而编辑器自己是独立滚动容器 —— 一滚动两套坐标系就脱节。叠加 `wordWrap`：`end.lineNumber` 是**逻辑行**，但该行可能折成多个**视觉行**，取到的是**第一视觉行**的 top。结果是代码文件"歪着出现"、**markdown 长段落干脆不出现**（用户两次反馈"文本文件没有复制按钮"）。前两轮分别归因于`getPositionAt` 参数类型、原生 `title`，都只修到表象 | 定位**整个交给 Monaco**：用 `editor.addContentWidget()` 注册浮层，`getPosition()` 只返回 `{ position, preference }`（锚在选区末端的行尾 = 用户要的"右端行右上角"），滚动时只调 `editor.layoutContentWidget()`。配套三条：`preference: [ABOVE, BELOW]` 让 Monaco 自己选不遮挡的一侧；`suppressMouseDown: true` 防止点按钮时编辑器抢焦点导致选区丢失（否则复制到的是整篇文件）；显隐走 class，**一个 `style` 都不写** |
| **`title` 闪烁的根因不是「写多了次」，是「在高频事件里重排 DOM」** | 原生 tooltip 在元素位置/样式**发生任何变化**时失效并重新计时。此前 `place()` 已加了"位置未变就return"，闪烁依旧——因为查找过程中 `onDidChangeCursorSelection` 本来就频繁触发，位置**一直在变**。此时任何一次 `style` 写入都会让旁边查找框的 `Close (Escape)` 面板反复重建（用户两次反馈"仍然有闪烁"）。**只优化写入次数治不了这个** | 断掉因果链，而不是减少次数：改用 `IContentWidget` 后**完全不写 style**，重排不再发生。同时浮层自身也不用 `title`（改 `aria-label`），避免它自己成为下一个闪烁源 |
| **删按钮时别把能力一起删掉** | 「保存 (Ctrl+S)」按钮按用户意见移除时，若连 `el.btnSave` 的引用与监听一并清掉，容易顺手把 `Ctrl+S` 的快捷键注册也弄丢 | 按钮移除与快捷键注册是**两件事**：后者注册在 Monaco 上（`KeyMod.CtrlCmd \| KeyCode.KeyS`），必须保留。自检 U5 断言「按钮没了 **且** 快捷键还在」 |
| **自检的"通道清单"是手工维护的，漏一条就误报"未注册"** | `ipc.ts` 里 `registerFileIpc()` 返回一个通道数组供自检 E1 核对（Electron **没有**公开的"已注册通道"查询接口，只能这样声明）。后加 `ui:step-diff` 时只改了 `contract.ts`、没同步这个数组 → E1 报"未注册"，而 `index.ts` 早注册了。**断言失败要先分清是"实现缺了"还是"清单漂了"**，否则会去改本来正确的业务代码 | 三处清单必须同步：`contract.ts`（常量）、`ipc.ts` 返回数组（双向通道）、`selfTest.ts` 的 `oneWayChannels`（主进程 → 渲染进程的单向通道，只有 `webContents.send` 没有 `handle`）。另：多渲染进程后 E2 不能只扫 `preload.js` —— `preview:active-diff` 属于**预览面板**的桥，编辑器 preload 里没有它是正确的。三个 preload 一起扫，通道名前缀也要加上 `preview:` |

> 目录树早期实现是"每次列一层、整表替换"，没有返回上级的途径，已被判定为交互缺陷
> （见审计 P2-13）。改为可展开结构后与主流编辑器一致。

## 底部需求输入区的当前行为

| 项 | 取值 |
|---|---|
| 默认高度 | **4 行（88px）**——此前是 22px 单行，实测"太小且不自适应" |
| 自适应 | JS 按`scrollHeight` 在 [2 行, 4 行] 伸缩；超出上限则滚动。`input` 与 `paste` 都触发 |
| 为什么设上限 | 输入区是 `flex: 0 0 auto`，无限长会把编辑器顶到没内容可看|
| 按钮 | **药丸形**「复制提示词」（此前 34px 圆形装不下五个字，必然折行） |

## 代码入口

- 主进程：`src/main/index.ts`、`src/main/fileService.ts`、`src/main/ipc.ts`、`src/main/selfTest.ts`
- 预加载：`src/main/preload.ts`（编辑器）、`src/main/previewPreload.ts`（预览面板）、`src/main/webbarPreload.ts`（网页区工具条）
- 渲染进程：`src/renderer/`（`index.html` 编辑器 / `preview.*` 预览面板 / `webbar.*` 网页区工具条）
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
