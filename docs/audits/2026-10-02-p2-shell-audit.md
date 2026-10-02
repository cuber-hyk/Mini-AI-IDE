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
| P2-7 | Medium | **open** | **UI 目视与右侧网页加载未验证**：执行沙箱限制子进程对外网络，Electron 内的对外请求会挂起，因此无法在此环境确认"启动后是否直接进入已登录状态"与界面观感 | 沙箱内首次运行 `loadURL` 无 `did-finish-load`（与 P0b 同一现象） | docs/plans/2026-10-02-mini-ai-ide-poc.md（P2） | — | 待用户在普通 PowerShell 运行 `npm start`：① 是否免登录直接进入聊天页；② 左侧编辑器与右侧网页是否并排；③ 打开目录/读文件/保存是否正常；④ 是否出现「使用环境异常」告警 | 由用户实操后关闭 |

## 结论

1. **P2 的实现契约全部可执行验证**：28 项自检 + 53 项单测全通过，类型检查通过。
2. **本轮发现的三个 High/Medium 陷阱都属于"报告说成功、实际没生效"这一类**（P2-1/2/3），
   即最容易导致后续基于错误前提继续开发的问题。它们已被固化为自检项，不再依赖人工记忆。
3. **唯一未决项是 P2-7（Medium, open）**：UI 与真实网页加载需用户在非沙箱环境确认。
   这不影响代码正确性，但影响"用户是否真的能开始用"。

> **后续步骤**：P3（回程解析与应用）尚未开始。P2-7 关闭前不建议进入 P3 的 UI 部分；
> 但 P3 的纯解析逻辑（围栏切分 / 路径行 / diff 计算）可独立开发与单测。
