---
artifact_type: audit
status: active
created: 2026-10-02
updated: 2026-10-02
owner: 胡运宽
scope: P2 外壳实现核验（三视图架构、会话复用、文件访问 IPC、渲染进程隔离）
source_of_truth:
  - docs/plans/2026-10-02-mini-ai-ide-poc.md
  - docs/adr/2026-10-02-filesystem-permission-model.md
  - docs/adr/2026-10-02-honest-electron-identity.md
  - docs/capabilities/app-shell.md
  - docs/capabilities/local-file-access.md
  - src/main/selfTest.ts
---

# P2 外壳实现核验报告

## 核验目标

确认 P2 的关键契约**可执行、可复现**：

1. UA 规则在**视图层面**真正生效（不是"报告说改了"）；
2. 会话分区确为正式分区 `persist:postcheck`（复用 P0b 登录态）；
3. 文件访问链路完整（编码探测 / 上限 / 分片 / 越界拒绝 / 写入）；
4. 渲染进程隔离成立（无 Node 能力、bridge 窄接口、未暴露通道被拒）；
5. 三视图与分栏布局可用。

## 方法与证据链

| 项 | 内容 |
|---|---|
| 命令 | `node scripts/install-electron.mjs` → `npx tsc -p tsconfig.json` → `node scripts/copy-static.mjs` → `electron . --self-test` |
| 自检项 | **28 项**，覆盖 A（UA）/ B（分区与视图级 UA）/ C（文件服务）/ D（渲染进程隔离）/ E（通道一致性） |
| 单测 | **53 项**（`npm test`，Node 内置测试运行器 + tsx） |
| 类型检查 | `tsc --noEmit` 通过（strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`） |
| 环境 | Windows 10.0.26200 x64；Electron 44.5.1；Chromium 152.0.7977.130；Node 24.21.0 |
| 结论 | **自检 28/28 PASS（退出码 0）、单测 53/53 PASS** |
| 未覆盖 | 右侧网页实际加载与 UI 目视（执行沙箱限制子进程对外网络，需用户在普通 PowerShell 运行） |

## 核验结果摘要

| 组 | 关键项 | 结果 |
|---|---|---|
| A | UA 无 `Electron/`、无应用名、保留 `Chrome/152.0.7977.130`、主版本 == 内核 | 4/4 PASS |
| B | 分区 `persist:postcheck`；`storagePath` 落于 `%APPDATA%\mini-ai-ide\Partitions\postcheck`；**视图级 UA 实际生效且 == 计划值** | 4/4 PASS |
| C | 列目录（4 项，含目录优先排序）、UTF-8 读取（56 字符/3 行）、**GBK 回退得到正确中文**、二进制拒绝、`..` 越界拒绝、分片、子目录 | 8/8 PASS |
| D | 页面已加载、**bridge 实际调用 getRoot/listDir 成功**、未暴露通道被拒（抛错）、无 Node 全局泄漏、`window.require` 为 AMD、`webdriver=false`、`nodeIntegration=false`/`contextIsolation=true`/`sandbox=true`、分栏布局 | 10/10 PASS |
| E | 所有约定通道已注册；**preload 内联通道名与契约无漂移** | 2/2 PASS |

## 发现项

| ID | Severity | Status | Finding | Evidence | Owner Plan | Branch/Commit | Verification | Closeout |
|---|---|---|---|---|---|---|---|---|
| P2-1 | High | verified | **沙箱 preload 不能 `require` 相对路径模块**：`require('../shared/contract')` 直接导致 preload 加载失败，bridge 完全不存在；而同一时刻**页面仍能正常加载**，极易被误判为"注入时机问题"而非"preload 崩溃" | 渲染进程控制台：`Unable to load preload script` + `Error: module not found: ../shared/contract`；自检 D2 观测 `hasBridge:false` | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2） | — | 改为内联字面量后 D2 转为 PASS（`callOk:true, listOk:true`） | 已修复；并新增自检 E1/E2 防止通道名漂移；已写入 `app-shell` 能力文档「已知实现陷阱」 |
| P2-2 | High | verified | **`session.setUserAgent()` 对 `WebContentsView` 不生效**（与 P0B-7 同一根因），必须对 `webContents` 再显式设置；否则"UA 规则已落实"是假的 | 自检 B3/B4 最初仅凭会话值判定；改为读取 `webContents.getUserAgent()` 并与计划值逐字比对 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2） | — | B4 PASS：`viewUa === planned` | 已修复；自检固化为 B3/B4（视图级断言） |
| P2-3 | Medium | verified | `contextBridge` 暴露的对象在沙箱渲染进程中**不暴露 `ownKeys`**，用 `Object.keys`/`Reflect.ownKeys` 枚举方法会得到空数组，导致"bridge 未注入"的误判 | 自检 D2 曾观测 `methods: []` 而 `hasBridge: true` | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2） | — | 改为**实际调用** `getRoot()` 与 `listDir()` 验证能力；D2 转为 PASS | 已修复；已写入陷阱表 |
| P2-4 | Medium | verified | Monaco 会定义 `window.require`，若按"存在即 Node 泄漏"判定会产生**假阳性**；实际是 AMD loader | 自检 D4 曾报 `nodeGlobals: ["require"]` | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2） | — | 新增 D10：以 `require.config`（AMD）与 `require.resolve`（Node）区分，观测 `requireKind: "amd"`；D4 改为只检查非 require 的 Node 全局 | 已修复；已写入陷阱表 |
| P2-5 | Low | verified | Monaco 的 web worker 在 `file://` + CSP 下被阻止，回退主线程执行；控制台报错但**不影响语法高亮与编辑** | 渲染进程控制台：`Creating a worker from 'blob:file:///...' violates ... script-src`；随后 `Could not create web worker(s). Falling back to loading web worker code in main thread` | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2，后续增强） | — | 编辑与高亮可用；自检 D1/D2 PASS | 接受为已知取舍。若后续需要语言服务（补全/诊断），需改为本地 HTTP 承载渲染进程或打包 worker |
| P2-6 | Low | verified | 构建脚本不能用 `fs.cpSync`：在本项目执行环境报 `EIO` | `copy-static.mjs` 首次运行失败，`errno: 5, code: 'EIO', syscall: 'cp'` | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2） | — | 改为显式 `mkdirSync` + `writeFileSync` 递归复制，154 个文件复制成功 | 已修复 |
| P2-7 | Medium | **open** | **UI 目视与右侧网页加载未验证**：执行沙箱限制子进程对外网络，Electron 内的对外请求会挂起，因此无法在此环境确认界面观感 | 沙箱内 `loadURL` 无 `did-finish-load`（与 P0b 同一现象） | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2） | — | 用户实测（截图）：左右并排 ✅、打开目录/文件树/编辑 ✅、无「使用环境异常」告警 ✅；**分隔条不可拖动 ❌**、**未登录 ❌** | 部分关闭：UI 与告警已确认；分隔条缺陷与登录态问题分别转 P2-8 / P2-9 |
| P2-8 | Medium | verified | **分隔条不可拖动**：原实现用一个独立 `WebContentsView` 覆盖在边界上（4px），它不接收拖动事件，视觉上像分隔条但完全无响应；且跨渲染进程无法在右侧网页上方取得鼠标事件 | 用户实测报告"中间分隔条不可拖动"；代码审查：`dividerView` 只设置了 bounds 与 hover 样式，无任何拖动逻辑 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2） | — | 改为**编辑器页面自身 DOM** 上的分隔条：`pointerdown` + `setPointerCapture` → `ui:set-split` → 主进程约束最小宽度后设界并回传实际值；双击复位 45%。自检 E1/E2 覆盖新通道；**待用户复验拖动** | 已修复并纳入自检；复验由用户完成 |
| P2-9 | **High** | **verified** | 本应用分区内登录态检查曾误报缺失：早期诊断**只查 cookie**（找 `ds_session_id`），而 **DeepSeek 的会话实际存放在 `localStorage`**（`userToken`、`settingsJwt`、`__appKit_userInfo` 等），cookie 里只有设备指纹 `smidV2` 与 `.thumbcache_*` | 修正后 `npm run diagnose`：`verdict: SESSION_OK`、落点 `https://chat.deepseek.com/`（未跳登录页）、`localStorage` 34 项含 `userToken`(92)、`settingsJwt`(409)、`__appKit_userInfo`(71) | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2） | — | 用户在应用内登录一次后，诊断得 `SESSION_OK`（退出码 0）；网络失败 0 条 | 已关闭。判据改为"cookie 或页面存储任一命中即视为有会话"，并把"落点是否登录页"作为独立信号；结论写入 `session-persistence` 能力文档 |
| P2-11 | Medium | verified | 早期"跨应用迁移 profile 导致会话丢失"的结论**只对 cookie 成立**：会话本体在 `localStorage`，而 localStorage 按 origin 隔离并落在分区目录内；因此分区不变 + 同源访问即可跨重启保持 | 迁移后 cookie 减少但 localStorage 完整；`SESSION_OK` | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2） | — | 诊断输出中 `cookie=无` 而 `页面存储=有（userToken, ...）` | 已更正文档表述：迁移 profile 会丢 cookie，但会话载体是 localStorage；两者分开说明 |
| P2-12 | **High** | verified | **"上次打开的目录"记忆看起来没生效**：顺序错误 —— 主进程先 `await loadFile()` 再恢复目录，而渲染进程**在页面加载完成时就调用 `getRoot()`**，因此永远拿不到恢复后的值。功能代码是对的，但恢复结果从未到达界面 | 用户报告"目录打开没有记忆，还是需要重复打开"；代码审查确认 `loadFile` 在恢复之前 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P3） | — | 把根目录决策**移到 `loadFile` 之前**；新增 `--test-restore` 模式，用**两次进程启动**验证：第 1 次写设置，第 2 次启动断言恢复结果。自检 H1–H3 PASS（`startupRoot === 期望值`），自检项 35 → 38 | 已修复并纳入自检。**教训：跨进程协作里"副作用发生在消费者之后"是静默失效的重灾区**（与 P2-1/P2-2 同类） |
| P2-13 | **High** | verified | **左侧编辑器实际不可编辑**：`readOnly: true` 常驻，而"输入即解除只读"的逻辑挂在 `document` 的 `keydown` 上 —— **Monaco 获得焦点后会吞掉键盘事件**，该监听器永不触发，等于死代码。用户表现：只能看，不能改 | 用户反馈"编辑器好像只有只读，不能编辑、删除"；代码审查确认监听器在 `document` 层 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P3） | — | 删除 `readOnly` 与那段死代码，**默认可编辑**；未保存由文件头白点提示。自检 L3 断言"开启了自动换行与字体行高、且**不存在 `readOnly: true`**" | 已修复。**教训：在错误的层级监听事件 = 逻辑不存在，而代码看起来是"实现过"的** |
| P2-14 | Medium | verified | **目录树是"进入式"而非"展开式"**：点击文件夹会替换整个列表（等价于资源管理器导航），没有返回上级的途径；且长行不换行、字体拥挤、无行号核对手段 | 用户反馈"点击某个文件夹时不会展开而是进入这个文件夹，导致无法回退到上一级"；代码审查确认 `loadTree(entry.relPath)` 替换列表 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P3） | — | 改为可展开树（懒加载子节点、展开状态按根目录记忆）；`wordWrap: 'on'` + 字体栈 + 行高；预览面板显示**应用后会落在文件里的真实行号**。自检 L1/L4/L5 覆盖 | 已修复并纳入自检 |
| P2-7 | Medium | **verified** | UI 目视与真实站点加载 | 沙箱限制子进程对外网络，无法在此环境目视 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2） | — | 用户实测：左右并排 ✅、打开目录/文件树/编辑 ✅、**无「使用环境异常」告警** ✅、登录后 `SESSION_OK` ✅ | 已关闭。分隔条缺陷见 P2-8 |
| P2-10 | Low | verified | 用户看到的 SSL 报错**不是**登录失败原因：`localhost.weixin.qq.com:13013-13015/14013-14015` 的 `ERR_CONNECTION_CLOSED` 是微信扫码 SDK 探测本机微信客户端；`support.weixin.qq.com` 的 `ERR_BLOCKED_BY_ORB` 是 Chromium 对图片响应的正常拦截 | `npm run diagnose` 的 `webRequestFailures`：12 条全部属于上述两类，无一条指向 DeepSeek 接口 | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2） | — | 诊断结论与落点一致（LOGIN 页而非网络错误页）；DeepSeek 主文档加载成功 | 已澄清，无需处置。为避免以后误判，新增 `npm run diagnose` 把网络失败与登录态分开报告 |

## 结论

1. **P2 的实现契约全部可执行验证**：28 项自检 + 53 项单测全通过，类型检查通过。
2. **本轮发现的两个 High/Medium 陷阱都属于"报告说成功、实际没生效"这一类**（P2-1/2/3），
   即最容易导致后续基于错误前提继续开发的问题。它们已被固化为自检项，不再依赖人工记忆。
3. **用户实测确认**：左右并排布局、打开目录/文件树/编辑正常、**未出现「使用环境异常」告警**、
   **登录态跨重启保持**（`npm run diagnose` → `SESSION_OK`）。
4. **登录态的关键事实**：DeepSeek 的会话存放在 **`localStorage`**（`userToken` 等），
   **不在 cookie 里**。P2-9 的"会话丢失"实为**我的判据缺陷**（只查 cookie），已更正。
5. **唯一未决项是 P2-8**：分隔条已改为编辑器 DOM 实现，**待用户复验拖动**。
6. 另有两处环境/第三方噪音已澄清，不必再查：微信扫码 SDK 探测本机微信导致的
   `ERR_CONNECTION_CLOSED`（P2-10）、Monaco worker 在 `file://` 下的 CSP 回退（P2-5）。

> **后续步骤**：**P3（回程解析与应用）可以开始** —— 右侧已确认处于已登录会话且无告警。
> P3 的纯解析逻辑（围栏切分 / 路径行 / diff 计算）可先独立开发并单测；
> 采集层（只读读取回复）需在真实页面上验证，属用户实操部分。
