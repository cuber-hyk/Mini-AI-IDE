---
artifact_type: capability
status: current
updated: 2026-10-02
owner: 胡运宽
source_of_truth:
  - docs/adr/2026-10-02-filesystem-permission-model.md
  - docs/plans/2026-10-02-mini-ai-ide-poc.md
  - src/main/fileService.ts
  - src/shared/encoding.ts
  - src/shared/pathGuard.ts
---

# 能力：本地文件访问

> 状态说明：**P2 已实现并通过单测（53 项）与启动自检**。本节记录当前事实。

## 职责

让用户在编辑器里打开并编辑本地文本文件；文件内容是否被送去给模型，由用户自己复制粘贴决定——**程序不参与出程**（见 `human-machine-boundary`）。

**关键边界**：DeepSeek 网页端读不到本地文件。本项目**不试图让模型自动读取本地文件**；网页层永远不接触磁盘、不上传附件。

## 权限模型（已实现）

- 文件系统访问**仅限主进程**（见 ADR-0002）。
- 编辑器渲染进程通过 `contextBridge` 暴露的窄接口请求**纯文本结果**。
- 主进程对每个请求做 `path.resolve` 归一化，并校验落在用户显式打开的根目录之内；越界直接拒绝。
- 网页视图**没有任何**文件 IPC 通道。
- **唯一取得路径的入口**是系统目录选择对话框（`fs:choose-root`）；渲染进程不能自行指定任意根目录。
  `fs:set-root-internal` 仅供主进程内部/自检使用，**不暴露给 preload**（自检 D3 专门验证它被拒绝）。

## IPC 契约（已冻结）

| 通道 | 参数 | 返回 |
|---|---|---|
| `fs:choose-root` | 无 | `{ root }` |
| `fs:get-root` | 无 | `{ root }` |
| `fs:list-dir` | `relPath: string` | `{ ok, entries[], truncated, error? }` |
| `fs:read-file` | `relPath: string` | `{ ok, text?, encoding?, fellBack?, meta?, tooLarge?, limit?, error? }` |
| `fs:slice-file` | `relPath, startLine, endLine` | `{ ok, text?, startLine?, endLine?, totalLines?, error? }` |
| `fs:write-file` | `relPath, text` | `{ ok, relPath?, byteLength?, error? }` |
| `fs:root-changed` | （主进程 → 渲染进程） | `{ root }` |

> **沙箱约束（重要）**：preload 在 `sandbox: true` 下**不能 `require` 相对路径模块**，因此
> `src/main/preload.ts` 中的通道名是**内联字面量**。启动自检 E1/E2 会比对"契约通道 /
> 已注册通道 / preload 字面量"三者，一旦漂移即 FAIL。

## 处理规则（已实现）

| 事项 | 规则 |
|---|---|
| 编码 | 先识别 BOM（UTF-8 / UTF-16LE / BE）；无 BOM 时做**严格 UTF-8 校验**（拒绝孤立续字节、截断、过长编码、代理区、超范围）；失败则回退 GBK/GB18030 |
| 二进制 | 含 NUL 字节即判定为二进制并拒绝，返回原因 |
| 大小 | 单次读取上限 **200,000 字符**；超限只返回元信息（字符数 / 行数）并要求用户显式确认后分片读取 |
| 分片 | 按行切片（1 起、闭区间、越界自动收敛） |
| 目录列表 | 隐藏点文件、跳过 `node_modules`/`.git`/`dist` 等；目录在前按名称排序；单目录上限 500 条并标记 `truncated` |
| 写入 | 仅 `write-file` 通道；同样过白名单与大小上限；**只由用户在编辑器里明确保存时触发** |

**实现说明**：GBK 解码使用 Node 自带的 `TextDecoder('gbk')`（本机 ICU 为 full），**不引入 iconv-lite** 等第三方依赖。

## 测试覆盖

| 测试文件 | 覆盖 |
|---|---|
| `test/encoding.test.ts` | UTF-8 合法性（7 类非法序列）、BOM、GBK 回退、二进制拒绝、空文件 |
| `test/pathGuard.test.ts` | `..` 穿越、绝对路径越界、前缀相似目录（`project` vs `project2`）、大小写不敏感、NUL、目录过滤与截断 |
| `test/limits-and-ua.test.ts` | 元信息统计、上限判定、分片边界、文本扩展名判定、UA 规则 |
| `test/fileService.test.ts` | 真实文件系统集成：列目录 / 读写 / 回退 / 拒绝 / 越界 / 超限 / 子目录 |

## 代码入口

- `src/main/fileService.ts` — 主进程文件服务（唯一持有 `fs` 的模块）
- `src/shared/encoding.ts`、`src/shared/pathGuard.ts`、`src/shared/limits.ts` — 纯逻辑（可单测）
