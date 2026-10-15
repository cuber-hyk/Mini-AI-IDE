---
artifact_type: audit
status: active
created: 2026-10-13
updated: 2026-10-15
scope: "Mini-AI-IDE 启动、编辑输入、分栏布局、文件树、文档预览、工具结果与自动采集性能"
source_of_truth: code
---

# Mini-AI-IDE 性能探索性审查报告

- 日期：2026-10-13
- 对象：Windows 桌面项目 Mini-AI-IDE（Electron 44.5.1、Chromium 152、Monaco Editor 0.57.0、TypeScript 5.9.3）
- 审查方式：八批 mini-ai-tools 源码读取、文本检索、构建产物大小查询，未启动应用、未运行构建/测试、未修改源码。
- 证据界限：以下“已确认”表示静态调用链已存在，不代表已测出卡顿、CPU 或内存占用。文件大小为磁盘体积，不代表全部在启动时加载或驻留内存。
- 仓库状态：2026-10-13 最终核查显示当前分支为 `codex/chatgpt-multi-message-collection`；本审计文件为未跟踪的新增文件，仓库另有其他未提交变更。本次没有修改这些其他文件。

## Scope

- **审计对象**：Mini-AI-IDE 的 Windows Electron 桌面应用，覆盖启动关键路径、Monaco 编辑状态、工作区布局、预览资源、工具状态与历史存储、目录操作及官网回复变化监听。
- **审计性质**：基于前八批真实只读工具结果的探索性静态性能审计；本次为现有审计补齐 Dev Flow 元数据，不重新执行性能评测。
- **非目标**：不实施性能修复、不修改产品源码、不以静态分析推断真实帧率或内存泄漏、不削弱安全与正确性约束。
- **持久化决定**：persistent_audit: yes；本报告涉及多个模块、具有后续优化和回归验证需求，保存在 `docs/audits/` 并保持 `active`。

## Audit Questions

1. 哪些操作会在高频交互中产生重复 IPC、同步 I/O、对象复制或 DOM 重建？
2. 首次可编辑时间是否受到可延迟的初始化或附件专用资源影响？
3. 文件树、工具历史和网页回复监听是否存在随数据规模增长的潜在成本？
4. 哪些设计属于安全、可靠性或兼容性硬边界，优化时必须保留？
5. 后续修复需要哪些性能基线和回归测试？

## Fact Sources

- **Code**：`src/main/index.ts`、`settings.ts`、`workspaceLayoutController.ts`、`fileService.ts`、`editorSession.ts`、`tools/store.ts`、`tools/integration.ts`、`tools/replyChangeWatcher.ts`、`tools/autoCollector.ts`、`src/renderer/renderer.js`、`editorWorkspace.js`、`workspaceLayout.js`、`fileExplorer.js`、`filePreview.js`、`toolHarness.js`、`index.html`、`scripts/copy-static.mjs` 与 `package.json`；具体行号见下文各项发现。
- **Tests**：审查了相关测试位置与现有约束；重点回归入口为 `test/workspaceLayoutController.test.ts`、`test/editorSession.test.ts`、`test/editorWorkspace.test.ts`、`test/editorTabs.test.ts`、`test/fileService.test.ts`、`test/filePreviewRenderer.test.ts`、`test/replyChangeWatcher.test.ts`、`test/toolStore.test.ts`；本轮未执行测试。
- **Repository guidance**：`AGENTS.md`、`CONTEXT.md`、`docs/ai/context-map.md`；本次遵循 `/dev-audit` 技能约束，并参考现有活跃审计的元数据与字段结构。
- **Read-only observations**：八批工具结果中的源码读取、文件检索和 `dist/renderer` 构建产物磁盘大小查询。未记录运行时性能基线。
- **Evidence rule**：源码调用链存在属于已确认静态事实；性能影响规模、真实故障与优化收益仍需独立实测。

## 1. 结论与优先级

最值得优先优化的是**拖拽布局时的主进程同步持久化和菜单重建**，其次是**Monaco 每次键入时的全文读取与文档状态同步**。启动方面既存在每次从开发启动器重新构建的问题，也存在编辑器首屏前串行初始化辅助视图和工具服务的问题。PDF/Word 预览依赖、工具结果大对象渲染和目录安全检查是后续优化机会。

| ID | 优先级 | 热点 | 证据级别 | 优化目标 |
| --- | --- | --- | --- | --- |
| PERF-01 | P0 | 拖拽频繁 IPC、同步写盘和菜单重建 | 调用链确认 | 流畅拖拽、仅最终提交偏好 |
| PERF-02 | P0 | 每次输入读取全文并上报标签 | 调用链确认 | 降低输入主线程工作量 |
| PERF-03 | P1 | 日常开发启动触发完整构建 | 脚本确认 | 区分构建与启动 |
| PERF-04 | P1 | 主编辑器加载前依次初始化其他视图及工具 | 顺序确认 | 缩短首次可编辑时间 |
| PERF-05 | P1 | PDF/Word 预览资源提前加载 | 引用和体积确认 | 按文件类型延迟加载 |
| PERF-06 | P1 | 工具结果状态变化时全量序列化与 DOM 重建 | 调用链确认 | 增量更新、延迟生成详情 |
| PERF-07 | P2 | 工具记录每次变更克隆并重写完整 JSON | 调用链确认 | 减少随历史增长的负载 |
| PERF-08 | P2 | 文件树多级刷新与单目录逐项安全验证 | 调用链确认 | 大目录稳定响应 |
| PERF-09 | P2/待测 | 官网高频 DOM 变化监听 | 机制确认，实际压力待测 | 仅在 Profile 指向后调整 |

**优先级是实施顺序建议，不是已复现的线上故障等级。**

## Findings

以下发现使用稳定 ID，供后续 `/dev-plan` 的 `covered_findings` 引用。`Status` 遵循 `open`、`planned`、`resolved`、`verified`；原始审查时均为 `open`；当前PERF-01/02已完成离线与用户现场验收，标记verified，其他项仍为 `open`。原有 P0/P1/P2 表示建议处理优先级，非已测量的故障严重度。

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| PERF-01 | P0 | verified | 拖动分栏时重复触发布局、同步设置写盘和原生菜单重建 | `workspaceLayout.js:55-71`；`workspaceLayoutController.ts:40-83`；`settings.ts:209-218`；`index.ts:252-254,755-857` | docs/plans/archived/2026-10-13-interaction-performance.md | 3b210aa；已包含于v0.4.0 | 夹具600移动/60帧：写盘600→1、菜单600→0、布局600→61；回归通过 | 用户确认拖拽、重启宽度恢复通过；已验证 |
| PERF-02 | P0 | verified | Monaco 输入变化执行全文取值、脏状态检查及标签状态上报 | `renderer.js:496-501,575-581`；`editorWorkspace.js:13-26`；`workspaceController.ts:121-127` | docs/plans/archived/2026-10-13-interaction-performance.md | 3b210aa；已包含于v0.4.0 | 真实Monaco百万字符/20标签/100次追加：全文读取100→0、报告100→1；草稿回归通过 | 用户确认编辑/撤销/保存/切换通过；未声称输入P95 |
| PERF-03 | P1 | open | 源码启动入口先执行完整构建 | `package.json:9-12`；`scripts/copy-static.mjs:22-47,63-73` | none；待 `/dev-plan` | none | 启动脚本确认；冷/热启动时间待测 | 未关闭；生产安装版影响未确认 |
| PERF-04 | P1 | open | 编辑器页面加载前存在辅助页面与工具初始化串行等待 | `index.ts:449,500-522,572-574,859-883,920` | none；待 `/dev-plan` | none | 调用顺序确认；首次可编辑时间与竞态回归待测 | 未关闭；须保留 IPC 注册和加载重试 |
| PERF-05 | P1 | verified | PDF 资源表与 Word 依赖提前进入编辑器启动脚本链 | `index.html:170-176`；`filePreview.js:5-7`；只读构建产物大小记录 | docs/plans/archived/2026-10-15-preview-tool-performance.md | codex/20261015-preview-tool-performance；用户批准合并 | AMD预览22项与原生预览最终64项通过；首屏延期4,020,854字节专用脚本，真实加载故障后重开与Monaco共存通过 | 实现及原生验证闭合，用户批准当前分支合并；未新增真人实测，不声称启动提速比例 |
| PERF-06 | P1 | verified | 工具结果变化时重新序列化结果并重建整个结果 DOM | `toolHarness.js:135-191,268-279,386` | docs/plans/archived/2026-10-15-preview-tool-performance.md | codex/20261015-preview-tool-performance；用户批准合并 | UI42项、原生240项通过；50次克隆整批序列化50→0，20次其他行进度节点创建3200→0，焦点/选区保持 | 实现及原生验证闭合，用户批准当前分支合并；原IPC与逐字段比较仍存在 |
| PERF-07 | P2 | open | 工具历史数据变更采用全量克隆及 JSON 重写 | `tools/store.ts:84-119,163-169` | none；待 `/dev-plan` | none | 静态持久化机制确认；不同历史规模的耗时待测 | 未关闭；禁止破坏持久化去重 |
| PERF-08 | P2 | open | 文件树刷新与单目录逐项安全路径校验可能累积等待时间 | `fileExplorer.js:34-99`；`fileService.ts:121-156`；`test/fileService.test.ts:72-80` | none；待 `/dev-plan` | none | 按需展开及串行校验已确认；大型目录性能待测 | 未关闭；必须保留符号链接与越界保护 |
| PERF-09 | P2 | open | 官网大量 DOM 变化时的监听开销需通过采样判断 | `tools/replyChangeWatcher.ts:135-173,269-303`；`tools/autoCollector.ts:37-82` | none；待性能证据后决定 | none | 已确认事件驱动和 150ms 合并；未证明空闲高 CPU | 未关闭；仅性能采样支持后才考虑改动 |

下列各节保存原始审查的完整代码证据、优化建议与回归边界；本表是唯一的生命周期状态登记入口。

## 2. 详细问题、证据与建议

### PERF-01：拖拽布局时主进程重复做昂贵工作（P0）

证据：`src/renderer/workspaceLayout.js:55-71` 的拖拽移动事件调用 `setWorkspaceLayout`；`src/main/workspaceLayoutController.ts:40-55` 每次计算布局、设置多个 `WebContentsView` 的 bounds 并广播状态，`:57-83` 调用 `settings.update` 和 `changed`；`src/main/settings.ts:209-218` 的保存路径包括同步 `mkdirSync`、`writeFileSync`、`renameSync`；`src/main/index.ts:252-254` 将 `changed` 连接到 `buildApplicationMenu()`，后者在 `:755-857` 重建原生菜单。该链路可在指针移动期间重复发生，并可能与 `workspace-layout-changed` 的 Monaco 布局计算叠加。

建议：在渲染端使用 `requestAnimationFrame` 合并指针更新；在主进程区分临时显示布局和最终持久化布局，拖动中只更新预览宽度，`pointerup`/取消拖动时确认最终状态，确保最终宽度安全提交。宽度数值变化不应每次重建菜单；菜单仅在影响菜单状态时更新。处理在途 IPC 返回和 chromeState 广播的顺序，防止旧响应覆盖新状态；按主进程权威状态同步。

回归边界：保留 `show`/`resized`/`did-finish-load` 几何校正（`src/main/index.ts:316-355`）、主进程布局白名单和 frame 检查（`workspaceLayoutController.ts:107-156`）、隐藏后宽度恢复、Diff 临时拓宽及平台切换。已有 `test/workspaceLayoutController.test.ts` 覆盖上述多种状态；新增断言“连续 100 次移动至多一次持久化提交”“最终宽度重启后正确”“中断拖动不丢状态”。

### PERF-02：Monaco 输入事件执行全文比较与全标签报告（P0）

证据：`src/renderer/renderer.js:496-501` 的 `onDidChangeModelContent` 每次调用 `editor.getValue()`；`:575-581` 执行 dirty 检查并调用 `editorWorkspace.report()`；`src/renderer/editorWorkspace.js:13-26` 扫描全部打开文档，构造标签数据并调用 `bridge.reportEditorState` 与标签渲染；`src/main/preload.ts:115` 采用 fire-and-forget `ipcRenderer.send`，**发送的是路径、dirty 等标签元数据，不是完整文档正文**；`src/main/workspaceController.ts:121-127` 读取并更新 `EditorSession`。`src/renderer/editorTabs.js` 已有签名相等时跳过 DOM 重建的保护，不能误称每一键均重建标签 DOM。

建议：先减少无状态变化时的 `reportEditorState` 和标签渲染；在 dirty 状态改变、文档切换、保存完成及离开确认之前确保主进程获得准确状态。再评估按模型版本/快照进行延迟全文取值和降低字符串分配；必须保证“撤销到原文即干净”、保存期间继续输入、多个草稿关闭及目录切换行为正确。`src/main/editorSession.ts:27-51` 的未保存离开保护和保存回执不可削弱。`test/editorTabs.test.ts`、`test/editorWorkspace.test.ts` 和编辑器会话测试应覆盖回归。

### PERF-03：启动入口每次先构建（P1）

证据：`package.json:9-12` 中 `start` 为 `npm run build && electron .`；Windows 启动器调用该入口。构建包含 TypeScript 编译、`scripts/copy-static.mjs` 的递归静态资源复制及检查。复制脚本 `:47` 复制整个 Monaco AMD 发行目录，`:63-73` 将 PDF 字体、CMap、WASM 转为 Base64 的资源 JS。这些发生在 Electron 正式运行之前。

建议：区分“显式重建 + 启动”与“使用已验证构建产物启动”。确保首次安装、源文件或依赖改变时仍进行完整构建；不能以运行陈旧 `dist` 为代价。该建议主要适用于当前源码启动器，不要外推为已证明安装包每次都编译。

### PERF-04：编辑器被排在辅助初始化之后加载（P1）

证据：`src/main/index.ts:449` 先 `await loadLocalView(promptView, 'prompt.html')`；`:500-522` 等待 `createToolIntegration()`，该流程在 `src/main/tools/integration.ts:151` 等待 `ToolStore.ready()`；之后 `index.ts:572-574` 加载 webbar 与 preview；`index.ts:859-883` 恢复工作区，`:920` 才加载编辑器 `index.html`。目标官网加载在 `:1120`，**不应声称其网络请求阻塞编辑器首屏**。

建议：分解“IPC 与核心状态已就绪”“编辑器可交互”“辅助页面和工具后台就绪”三个里程碑，评估将不影响编辑器最小功能的加载推迟。但必须先完成编辑器页面会立即调用的 IPC handler 注册，并维持根目录恢复早于主页面加载的时序。`index.ts:357-390` 为多视图 `ERR_FAILED (-2)` 设置的加载重试曾解决实际问题，禁止直接改为无保护的全并行加载。可评估仅诊断模式需要的 `selfTest`、`workspaceProbe`、`layoutProbe`、`diagnose` 模块按需导入（`index.ts:35-46`）。

### PERF-05：附件资源进入主编辑器启动脚本链（P1）

证据：`src/renderer/index.html:170-176` 同步加载 `jszip.min.js`、`docx-preview.min.js`、`purify.min.js` 和 `filePreviewPdfResources.js`；`src/renderer/filePreview.js:5-7` 的 PDF.js 主模块已经按需动态加载。第八批只读磁盘统计：`dist/renderer/filePreviewPdfResources.js` **3,818,661 字节（约 3.64 MiB）**；`pdf.mjs` 860,818 字节；`pdf.worker.mjs` 2,229,713 字节；Monaco editor 主模块 2,472,349 字节；TS worker 文件约 6.7–7.0 MB，不能据此认定 worker 在当前 `file://` 模式下被执行或常驻。

建议：将 PDF 字体资源表及 Word 专用依赖改为首次打开对应附件时初始化，缓存加载 Promise 并支持失败恢复与快速切换取消。维持当前无网络 `connect-src 'none'`、PDF 字体与 CMap 的本地可用性、DOCX 内容消毒和 iframe 安全策略。评估首屏收益时测量脚本解析时间和堆占用，不能将文件大小直接当作内存释放量。

### PERF-06：工具结果展示不按条目增量更新（P1）

证据：`src/renderer/toolHarness.js:135-191` 对 `state.results` 全量 `JSON.stringify` 生成签名，签名变化后 `results.replaceChildren()` 并重建全部结果 DOM，每项详情又格式化 `JSON.stringify(result, null, 2)`；`toolHarness.js:268-279,386` 在状态广播时触发展示更新。已有签名相等的跳过保护，但任一实际结果更新会重建全列表。

建议：按 `(batch_id, request_id)` 维护稳定节点；只更新状态变化的结果，未展开时不生成完整详细 JSON，展开时按需生成并释放不可见大内容。保留原始工具结果的完整性、复制/发送结果、取消按钮与展开状态；任何文件正文和命令输出都必须继续用 `textContent` 安全显示，不能切换到不可信 HTML。

### PERF-07：工具历史存储随记录增长而全量克隆、全量保存（P2）

证据：`src/main/tools/store.ts:109-119` 的 `mutate()` 在事务队列中 `structuredClone(this.data)`；`:163-169` 每次完整 `JSON.stringify(data)` 并写临时文件、重命名。`store.ts:84-98` 的跨重启去重 ledger 不自动淘汰，上限 10,000；这是防止旧回复再次产生副作用的重要保护。

建议：先测单次 `reserve`/`updateResult` 的数据规模与耗时，再决定是否采用分段记录或增量索引。禁止为节省空间而未经设计地删除去重记录；仍须保持持久化原子性和坏文件时的失败关闭策略。

### PERF-08：文件树与路径校验（P2）

证据：`src/renderer/fileExplorer.js:34-99` 只对展开目录递归加载，不是默认扫描整个项目；刷新会重建显示与展开节点。`src/main/fileService.ts:121-156` 列目录后对每个显示条目**串行**调用 `resolveSafePath`，该操作含根目录/路径组件真实文件系统校验；每目录最多返回 500 条。`test/fileService.test.ts:72-80` 明确要求 `.gitignore`、`.editorconfig` 可见、`.git` 目录跳过，不能简单套用共享 `pathGuard.ts` 的默认隐藏点文件策略。

建议：优先做局部树刷新、减少已展开节点的重复读取；验证后再考虑有限并发的安全检查或单次父目录验证结果复用。必须保留根目录修订版本、越界拒绝、junction/符号链接处理、文件身份检查及并发切换保护。已有 `test/fileService.test.ts` 的链接、目录切换、新增与撤销用例是必要回归集。

### PERF-09：官网 DOM 监听只在高负载时值得继续优化（P2/待测）

证据：`src/main/tools/replyChangeWatcher.ts:135-173` 使用 `MutationObserver` 筛选相关节点并以 150ms 合并通知；`:269-303` 通过变化事件的 Promise 等待，而不是空闲持续轮询。`src/main/tools/autoCollector.ts:37-82` 有并发重入合并与禁用保护。因此**排除“常驻高频 setInterval 轮询”作为已确认问题**。

建议：仅在 CPU Profile 明确显示官网流式 DOM 查询过重时优化匹配范围、选择器缓存和来源跟踪；保留生成结束判据、历史回复排除、会话变化防重放和只读隔离，不应为了降低 CPU 任意开启网页后台节流。

## 3. 不应为追求性能破坏的约束

1. 主进程唯一拥有文件系统能力；本地编辑器和官网网页保持沙箱、窄 IPC、进程隔离。不能简单合并 WebContentsViews。
2. 官网 `backgroundThrottling: false` 与自动采集可靠性相关，不建议在未验证条件下修改。
3. `file://` 环境下 Monaco Worker 的限制已有明确说明（`src/renderer/renderer.js:1-10`）；磁盘中的 TS worker 文件大不等于被启动。
4. `window` 首次显示及 DPI 修正、同分区多视图加载重试、IPC handler 注册先于页面加载，都有明确的兼容性依据。
5. 编辑器草稿保护、工具授权、文件身份/符号链接防护、工具批次去重和跨重启恢复为优先级更高的正确性约束。
6. PDF/DOCX 预览须保持离线资源、渲染取消机制、最大渲染像素约束和不可信内容消毒。

## 4. 建议实施顺序与验收

| 阶段 | 改动范围 | 主要验收 |
| --- | --- | --- |
| A | 布局拖拽节流、最终一次写盘、菜单更新去重 | 连续拖动流畅；写盘次数显著降低；重启恢复精确 |
| B | Monaco dirty / 标签状态变化检测与 IPC 去重 | 输入延迟下降；撤销、保存、切换、关闭均准确 |
| C | PDF/Word 资源懒加载 | 不打开附件时不解析预览专用大脚本，离线预览功能不变 |
| D | 启动入口拆分、IPC 与首屏顺序重整 | 冷/热启动至 Monaco 可编辑时间下降，无加载竞态 |
| E | 工具结果增量 DOM、目录局部刷新 | 大结果/大目录的耗时、DOM 分配下降 |
| F | 工具 ledger 与回复监听定量优化 | 有测量证据且保持去重与自动采集语义 |

测量建议：在**相同机器、相同数据集、相同窗口大小**下取多轮中位数与 P95；分别采集启动命令到窗口可见及 Monaco 可输入、200k 字符文件连续输入、20 个标签切换、持续 2 秒分栏拖拽、500 条目录与多层展开、长命令输出/大批次结果、官网空闲和流式回复期间 CPU 与工作集。可使用 Chromium Performance/Heap、Electron `app.getAppMetrics()`、`performance.mark()` 与内部 IPC/磁盘写次数计数。目标帧预算可参考 60Hz 的约 16.7ms，但本审查没有任何实测帧耗时或提升比例。

现有回归测试重点：`test/workspaceLayoutController.test.ts`、`test/editorTabs.test.ts`、`test/editorWorkspace.test.ts`、`test/fileService.test.ts`、`test/filePreviewRenderer.test.ts`、`test/replyChangeWatcher.test.ts`、`test/toolStore.test.ts`。本轮均未执行，故不宣称当前测试通过。

## 5. 审查状态

- 已完成：第 1–8 批静态源码与只读产物检查，形成上述性能风险、否定性发现和分阶段优化建议。
- 未完成：应用运行时计时、实际 CPU/内存/帧率采样、修复效果实测。
- 修改范围：仅创建并补全本审计报告的文档内容，**不表示任何 PERF 项已实施**；未修改产品源码或配置。
- 总体建议：先处理 PERF-01 和 PERF-02，再按数据决定启动、预览、工具结果及文件树优化的深度；每阶段保留独立回归与基线对比。

## Open Questions

- 在相同机器和样本下，拖拽主线程阻塞究竟有多少来自磁盘同步 I/O、菜单重建、视图几何更新和 IPC 广播？
- 不同文档大小与已打开标签数量下，每次键入的主要开销是否由 Monaco 全文取值和 dirty 检查主导？
- 启动时的工具 ledger 加载和预览资源解析各占多少时间？在保持多视图加载重试及 IPC 注册顺序时，可以安全推迟哪些初始化？
- 工具历史规模、结果正文大小、目录项目数及官网流式 DOM 变化达到什么条件后才具有可重复的性能影响？

## ADR Gate

- **Needed**：暂不创建 ADR。
- **Reason**：本次只整理既有性能审计，没有确定跨模块的新持久化方案或不可逆架构决策。若后续选择变更工具 ledger 存储协议、启动生命周期或视图通信协议，应由 `/dev-distill` 重新执行 ADR gate，而不是在本报告中直接裁决。

## Verification

- **Completed**：前八批真实只读源码检查和构建产物大小查询；本次读取当前报告及仓库指导文件，核对了现有 `apply_changes` 的局部替换结构。
- **Not run**：运行时基准、CPU Profile、Heap Snapshot、拖拽帧率、冷/热启动计时、构建、类型检查及自动化回归测试。
- **Completed document verification**：第 020 批 `read_file` 返回 `done`，文件共 192 行；人工核对 YAML 边界和六项必填字段，以及 PERF-01 至 PERF-09 九项发现的九列表格字段，均已存在。
- **Not verified**：未使用专用 YAML 解析器验证语法，也未运行性能基准或自动化测试。

## Git Visibility

- **Checked**：第 020 批 `git status --short --branch --untracked-files=all` 执行成功，退出码为 0。
- **Result**：`?? docs/audits/2026-10-13-performance-exploratory-audit.md`；Git 可以看到该文件，文件未被忽略，但尚未 `git add` 或提交。
- **Other changes**：当前分支 `codex/chatgpt-multi-message-collection` 还有其他已修改及未跟踪文件，均不属于本次文档修复范围。

## Closeout

本审计保持 `status: active`：PERF-01/02已完成原先现场验收；PERF-05/06经实现、原生与自动化验证及用户批准当前分支合并，均为 `verified`，对应计划已归档。PERF-03/04/07/08/09保持 `open`，后续按用户授权与测量决定；启动计时不是PERF-04已优化的证据。本次未发布。

## 已批准实施范围（2026-10-13）

用户已授权实施 PERF-01、PERF-02，并增加当前主题的平台加载反馈；对应计划为 docs/plans/archived/2026-10-13-interaction-performance.md。两项已完成计划及现场验收，其他 PERF-03 至 PERF-09 保持 open，不纳入本轮实现。前文静态审查结论保留为原始证据；运行时验证及收益以实施计划的后续记录为准。

## 实施验证补充

PERF-01、PERF-02已实施并完成自动化、原生离线验证与独立评审，详见owner plan的次数对比和证据限制；用户已确认现场验收全部通过。其他七项没有实施，不因本轮成功而关闭。加载反馈改善等待界面，不证明官网网络或实际渲染速度提升。


## 当前版本完成情况复核（2026-10-15）

核对基线：master / 5286f26，package.json为0.4.0，本地v0.4.0标签指向同一提交；3b210aa是该标签的祖先，当前产品源码与标签无差异。用户已确认发布最新版；本次未查询远端Release资产或运行安装包，不把本地标签当作远端资产核验。

- PERF-01、PERF-02：保持verified。当前workspaceLayout.js仍按requestAnimationFrame合并移动，workspaceLayoutController保留临时布局/最终保存和菜单语义去重；editorWorkspace仍按需取全文、按状态签名报告。布局、编辑缓冲、标签和未保存保护53项针对性回归全部通过，0失败/取消/跳过。
- 当前次数夹具：600次移动/60帧的优化路径为写盘1次、菜单0次、布局61次、广播183次；百万字符/20标签/100次追加，全文读取100→0、状态报告和标签渲染100→1，显式取快照后读取1次。此处输入基准使用模型替身；历史计划另有真实Monaco证据，不将本次夹具称为原生输入延迟或FPS测量。
- PERF-03：仍open。package.json的start仍先完整build；此项针对源码启动，不能作为安装版启动慢的解释。
- PERF-04：仍open。index.ts依次等待promptView、createToolIntegration、webBarView、previewView，再加载editorView；工具integration仍等待store.ready。首次可编辑时间尚无本次实测。
- PERF-05：仍open。index.html仍直接引入jszip、docx-preview、purify及filePreviewPdfResources；filePreview.js中的PDF主模块已有动态import，不能误记为PDF整体已懒加载或完全未懒加载。
- PERF-06：仍open。toolHarness.js的renderResults仍对整批结果JSON.stringify生成签名，变化后replaceChildren并为每项生成完整详细JSON。新版面板的排布、摘要与计时改进不等于增量结果渲染。
- PERF-07：仍open。ToolStore.mutate仍克隆全部data，再完整JSON序列化、临时写入和原子重命名；去重记录上限及不淘汰规则保留。
- PERF-08：仍open。文件树refresh仍重建当前展开结构，FileService.list仍逐项await resolveSafePath；未测量大型目录时延，不削弱链接/越界防护。
- PERF-09：仍open且须先测量。监听仍为MutationObserver与150ms事件合并；本次自动采集有限恢复解决可靠性问题，不构成CPU、内存或流式DOM性能优化的验证。

结论：原九项清单完成并验收两项，其余七项尚无实施计划；两项完成数不能换算为总体性能提升百分比。当前审计继续active，沿用PERF-01至PERF-09作为唯一发现登记，不新建重复清单。建议下一阶段先处理预览专用依赖按需加载（PERF-05）与工具结果按条目更新/展开时生成详情（PERF-06）；首次可编辑时序（PERF-04）先建立里程碑计时。PERF-07/08按规模测量，PERF-09仅在Profile证实热点后改动。

本次只更新本报告，不修改产品代码、安装包、用户数据或权限，不提交或推送。未运行全量测试、构建、原生GUI、CPU/堆采样或安装版冷/热启动基准；以上未测项目不宣称通过。


## 后续实施跟踪（2026-10-15）

用户同意开始预览资源按需加载与工具结果增量渲染，PERF-05/06由docs/plans/archived/2026-10-15-preview-tool-performance.md承接，最终实现、原生验证和独立评审通过。2026-10-15用户批准当前分支提交合并，未补充真人现场测试，两项按现有验证证据标记verified、计划归档；先前“七项无计划”为实施前快照。PERF-04仅增加离线启动计时，不调整顺序或认定已优化。PERF-03/07/08/09尚未实施，整体审计继续active。
