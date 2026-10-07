---
artifact_type: capability
status: current
updated: 2026-10-05
owner: 胡运宽
source_of_truth: [docs/adr/2026-10-02-filesystem-permission-model.md, src/main/fileService.ts, src/main/fileManagement.ts, src/main/workspaceService.ts, src/main/workspaceController.ts, src/main/editorSession.ts, src/main/settings.ts, src/shared/contract.ts, src/main/preload.ts, src/renderer/editorWorkspace.js, src/renderer/editorTabs.js, src/renderer/fileExplorer.js, test/workspaceService.test.ts, test/fileManagement.test.ts, test/editorSession.test.ts, test/editorWorkspace.test.ts, test/fileService.test.ts]
---

# 能力：本地文件访问

通用工具有独立授权路径，详见 `tool-harness.md`；完全访问或明确批准可访问项目外目标，工具不能扩大本能力的编辑器文件 IPC 根目录。

> 本节记录当前行为；测试数量与结果以当次运行报告为准。

## 职责

让用户在编辑器里打开并编辑本地文本文件；文件内容是否被送去给模型，由用户自己复制粘贴决定——**程序不参与出程**（见 `human-machine-boundary`）。

**关键边界**：DeepSeek 网页端读不到本地文件。本项目**不试图让模型自动读取本地文件**；网页层永远不接触磁盘、不上传附件。

## 权限模型（已实现）

- 文件系统访问**仅限主进程**（见 ADR-0002）。
- 编辑器渲染进程通过 `contextBridge` 暴露的窄接口请求**纯文本结果**。
- 主进程对每个请求做 `path.resolve` 归一化，同时用 `realpath` 校验目标与根目录的真实路径；缺失目标逐级校验最近存在的祖先，阻止链接／junction 指向根目录外。AI 新增还拒绝根目录下的链接父级；根目录本身可以是合法 junction。
- 网页视图**没有任何**文件 IPC 通道。
- 新目录通过系统选择对话框取得；最近目录仅按主进程已有历史的索引打开，渲染进程不能自行指定任意根目录。
  `fs:set-root-internal` 仅供主进程内部/自检使用，**不暴露给 preload**（自检 D3 专门验证它被拒绝）。

## 目录生命周期

- `WorkspaceService` 负责根目录验证、恢复和最近记录，`WorkspaceController` 是顶部按钮、文件菜单、最近目录及关闭目录的统一入口。
- 启动仅恢复上次成功打开的目录；最近 5 项按成功打开时间排序、Windows 路径大小写不敏感去重。原目录失效时进入空白状态并提示重新选择；不恢复文件或光标。
- 设置以临时文件写入后原子替换，成功后才更新内存和根目录。取消、目录验证失败或持久化失败不切换原目录；关闭目录清空恢复记录，保留历史。
- 关闭标签检查该文件，切换／关闭目录和退出检查所有未保存标签，提供“保存／放弃／取消”。保存失败或取消保留缓冲；放弃只有在后续操作成功时才替换或清空缓冲。
- 目录操作、文件操作和 AI 写盘串行执行；保存回执允许在离开确认等待期间完成。请求捕获根目录或版本，旧目录读写结果不得复用到新目录。
- 切换目录清空 AI 批次、片段基线与撤销快照；改名／删除只使受影响路径及后代路径失效，其他记录保留。存在 AI 记录时，切换前明确提示影响。

## 多文件编辑

- 每个打开文件拥有独立 Monaco model；一个编辑器实例切换 model，保留草稿、撤销栈、光标与滚动位置。重复打开激活已有标签，Windows 路径键统一斜杠并忽略大小写。
- 标签显示文件名、完整路径提示和未保存点，提供关闭、方向键／Home／End 切换及 Delete 关闭。关闭当前标签后激活相邻标签，最后一个关闭后显示空白页。
- 保存请求明确指定文档路径；后台标签的保存不切换当前标签。保存失败或保存期间继续输入保留未保存状态。
- AI 写盘检查所有打开文档中的目标草稿，拒绝覆盖未保存内容；成功写回刷新对应已保存模型，不切换当前标签。
- 改名同步所有受影响标签的路径并保留草稿；删除关闭受影响标签，其余标签保留。目录切换释放旧模型；异步旧读写结果不可覆盖新目录。

## IPC 契约

| 通道 | 参数 | 返回 |
|---|---|---|
| `fs:choose-root` | 无 | `{ root, recentRoots, revision, ok, canceled?, error? }` |
| `fs:get-root` | 无 | `{ root, recentRoots, revision }` |
| `fs:recent-roots` | 无 | 主进程保存的最近目录数组 |
| `fs:open-recent-root` | `index: number` | 目录操作结果 |
| `fs:close-root` | 无 | 目录操作结果 |
| `fs:list-dir` | `relPath: string` | `{ ok, entries[], truncated, error? }` |
| `fs:read-file` | `relPath: string` | `{ ok, text?, encoding?, fellBack?, meta?, tooLarge?, limit?, error? }` |
| `fs:slice-file` | `relPath, startLine, endLine` | `{ ok, text?, startLine?, endLine?, totalLines?, error? }` |
| `fs:write-file` | `relPath, text, root` | `{ ok, relPath?, byteLength?, error? }` |
| `fs:create-entry` | `parent, name, isDirectory, root` | `{ ok, relPath?, isDirectory?, error? }` |
| `fs:rename-entry` | `relPath, name, root` | 文件操作结果，成功含旧／新路径 |
| `fs:trash-entry` | `relPath, root` | 文件操作结果，成功含旧路径 |
| `fs:root-changed` | （主进程 → 编辑器） | 根目录、历史、版本 |
| `fs:file-changed` | （主进程 → 编辑器）`filePath, updated/created/deleted, revision` | AI 更新重读目标，创建／删除同步标签和文件树，拒绝旧目录事件 |
| `fs:entry-changed` | （主进程 → 编辑器） | 改名／删除事件、路径、目录标记和版本 |
| `editor:confirm-leave` | 可选 `path, root`（无参数检查所有文档） | `{ ok }`，是否允许离开 |
| `editor:state` | （编辑器 → 主进程）`{ root, path, documents: [{ path, dirty }] }` | 单向编辑状态上报 |
| `editor:request` / `editor:reply` | 保存请求 `{ id, kind: save, path }`／回执 ID 和成功布尔值 | 离开确认的保存回执 |
| `ui:copy-numbered-snippet` | `{ root, relPath, text, startLine }` | 片段复制结果；目录或当前文件已变化则拒绝，不写入旧片段记忆 |
| `ui:copy-whole-file` | `{ root, relPath, text }` | 复制当前 Monaco 全文上下文，包含未保存内容；目录或当前文件已变化则拒绝 |

写入和文件管理的 `root` 必须等于当前根目录。新增管理与编辑状态通道仅接受本地编辑器发送者；网页没有对应 preload。完整类型以 `src/shared/contract.ts` 为准。

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
| 新建 | 文件树顶部或右键入口；选中文件夹内创建、选中文件的父目录内创建、无选中或空白处右键则根目录内创建；排他创建，不覆盖已有目标 |
| AI 新增 | 明确操作“新建”和路径的完整内容以空原文只读预览；目标必须不存在，应用排他创建文件及缺失父目录，失败回滚本次空目录；撤销核对创建时文件身份（dev/ino/birthtimeMs）和内容，只删除本次文件及空目录，同名同内容外部替换也拒绝，保留记录供重试 |
| AI 更新 | 明确替换／覆盖全文仅更新已有目标，writeFile 的预期原文参数复核打开文件的内容和身份，r+ 不重建消失目标；不提供跨进程锁保证 |
| 名称 | 树内输入，Enter 确认、Esc 取消；拒绝 Windows 非法字符、保留名称、尾随点／空格、重名及过长名称 |
| 改名 | F2 或右键；同步所有打开文件及文件夹后代文件的保存路径，保留草稿；不覆盖已存在目标 |
| 删除 | 原生确认后仅调用 `shell.trashItem`，失败可见且不改为永久删除；成功后关闭受影响标签，其他标签保留 |
| 管理边界 | 不允许改名／删除工作区根目录；链接条目提示用系统资源管理器管理 |
| 刷新 | 手动刷新文件树，保留仍有效的展开、选中及焦点；无自动监听 |

**实现说明**：GBK 解码使用 Node 自带的 `TextDecoder('gbk')`（本机 ICU 为 full），**不引入 iconv-lite** 等第三方依赖。

## 测试覆盖

| 测试文件 | 覆盖 |
|---|---|
| `test/encoding.test.ts` | UTF-8 合法性（7 类非法序列）、BOM、GBK 回退、二进制拒绝、空文件 |
| `test/pathGuard.test.ts` | `..` 穿越、绝对路径越界、前缀相似目录（`project` vs `project2`）、大小写不敏感、NUL、目录过滤与截断 |
| `test/limits-and-ua.test.ts` | 元信息统计、上限判定、分片边界、文本扩展名判定、UA 规则 |
| `test/fileService.test.ts` | 真实文件系统集成：列目录 / 读写 / 回退 / 拒绝 / 越界 / 超限 / 多级新增 / 同名冲突 / 链接 / 新增撤销与回滚 |
| `test/workspaceService.test.ts` | 恢复、最近 5 项、关闭、失效目录、设置写入失败与测试隔离 |
| `test/fileManagement.test.ts` | 新建、改名、大小写改名、重名不覆盖、回收站失败、外部 junction 与延迟根目录切换 |
| `test/editorSession.test.ts`、`test/editorWorkspace.test.ts` | 多文件切换、后台保存及确认、失败保留缓冲、延迟读取、输入变化及所有标签改名删除 |
| `test/fileExplorer.test.ts` | 空白处根菜单、键盘菜单、行菜单冒泡、延迟旧目录结果隔离 |
| `src/main/workspaceProbe.ts` | `pnpm run verify:workspace`：隔离设置和临时文件，验证真实 Electron 本地交互、AI 跨目录失效及系统回收站，不操作官方网页 |

## 代码入口

- `src/main/fileService.ts`、`src/main/fileManagement.ts` — 主进程内文件读写、条目管理与权限检查
- `src/main/workspaceService.ts`、`src/main/workspaceController.ts`、`src/main/settings.ts` — 目录状态、交互入口与持久化
- `src/main/editorSession.ts`、`src/renderer/editorWorkspace.js` — 离开确认、保存回执与编辑缓冲
- `src/renderer/editorTabs.js` — 标签呈现、关闭入口与键盘导航
- `src/renderer/fileExplorer.js` — 文件树、名称输入、右键菜单与最近目录
- `src/shared/encoding.ts`、`src/shared/pathGuard.ts`、`src/shared/limits.ts` — 纯逻辑（可单测）
