---
artifact_type: capability
status: current
updated: 2026-10-15
owner: 胡运宽
source_of_truth: [src/renderer/workspaceNavigation.js, docs/adr/2026-10-07-workspace-ui-shell-layout.md, docs/adr/2026-10-02-filesystem-permission-model.md, src/main/fileService.ts, src/main/fileManagement.ts, src/main/workspaceService.ts, src/main/workspaceController.ts, src/main/editorSession.ts, src/main/settings.ts, src/shared/contract.ts, src/main/preload.ts, src/renderer/editorWorkspace.js, src/renderer/editorTabs.js, src/renderer/fileExplorer.js, src/renderer/fileIcons.js, src/renderer/fileExplorer.css, test/workspaceService.test.ts, test/fileManagement.test.ts, test/workspaceController.test.ts, test/fileExplorer.test.ts, test/fileIcons.test.ts, test/editorSession.test.ts, test/editorWorkspace.test.ts, test/fileService.test.ts, src/main/filePreview.ts, src/main/filePreviewZoom.ts, src/main/workspaceFileDrag.ts, docs/adr/2026-10-11-native-workspace-file-drag.md, test/workspaceFileDrag.test.ts, tools/verify-workspace-file-drag.cjs, src/main/filePreviewIpc.ts, src/main/docxArchive.ts, src/shared/filePreview.ts, src/shared/imageDimensions.ts, src/renderer/filePreview.js, src/renderer/filePreview.css, test/filePreview.test.ts, test/filePreviewZoom.test.ts, test/filePreviewIpc.test.ts, test/filePreviewRenderer.test.ts, test/imageDimensions.test.ts, tools/verify-file-preview.cjs, src/main/tools/aiTempDirectory.ts, test/aiTempDirectory.test.ts, tools/measure-directory-list.ts, tools/verify-file-tree-refresh.cjs]
---

# 能力：本地文件访问

文件树F2和右键重命名共用原位名称编辑：保留目标行图标、缩进和顺序，文件默认选中最后一个扩展名前的主体，文件夹全选；Enter提交，Esc或失焦取消，名称未变不调用磁盘。输入事件不触发行打开/展开，中文组字确认不提交。重名和非法名称沿用主进程校验、不覆盖目标，错误留在原位供修改；提交中只读、防重复，成功沿用改名事件迁移路径与未保存缓冲。项目重置撤回旧输入，失焦不抢回编辑器焦点。

目录树单个文件行通过系统原生拖拽可交给官网附件输入区、本地需求框或其他系统接收方，包含 TXT/Markdown/代码等普通文本以及图片、PDF、Word；不转换扩展名或字节，拖出磁盘版本，目录不可拖出。`workspaceFileDrag.ts` 只允许编辑器主 frame 请求当前项目相对路径，校验根代次、真实路径、普通文件与非文件链接，取得非空系统图标后复核身份再 `startDrag`。用户直接拖入官网仅添加附件，实际格式/大小/接收由官网处理，不自动发送；网页无新增桥或 DOM 写入。原生操作返回不表示上传成功，错误显示本地。规则见原生文件拖拽 ADR；本地需求框统一 Files 入口仍受原有附件限制。
右侧文件标签支持本地只读附件预览：PNG/JPEG/WebP/GIF 可缩放和适应窗口；PDF 可翻页、缩放；新版 Word `.docx` 展示文字、表格和图片，复杂排版可能与 Word 不同。旧版 `.doc` 显示系统应用打开入口。文本继续由 Monaco 编辑，附件不产生脏状态或保存写入，切换文件保留文本草稿；关闭、删除或切项目释放预览资源。

附件控制栏固定到底部，不随正文滚动：左侧只读标识和 PDF 翻页/页码，右下角缩小、比例下拉、放大及更多。比例下拉包含适应宽度、适应窗口和常用百分比；图片默认适应窗口，PDF/Word 默认适应宽度，固定百分比不随面板尺寸改变。Word 的适应窗口按首个渲染页尺寸计算，不表示精确分页；近似排版说明通过可聚焦图标提示。更多菜单提供系统应用打开，可用键盘操作、Escape/外部点击关闭，切文档也关闭；错误状态另保留直接打开入口。最窄 240px 文件正文内底栏仍为单行。

改名保留同类型附件标签；扩展名改为另一预览类型或文本时关闭旧的只读标签并提示重新打开，新打开按新类型读取。文本标签及草稿不因扩展名变化自动转换或丢弃。

图片/PDF/Word 正文支持 Ctrl＋滚轮缩放，向上放大、向下缩小，按 1.25 倍步幅切换为 10%–400% 手动比例并同步底栏。`src/main/filePreviewZoom.ts` 仅监听 editor 的原生 `zoom-changed`，将当前鼠标的屏幕 DIP 坐标按窗口/view 位置和 UI 缩放换算，经 `ui:file-preview-zoom` 单向通知编辑器主 frame。预览 owner 命中可见已加载正文才缩放，工具栏、菜单覆盖区、错误/未加载文件不响应；普通滚动不经过该入口。Word iframe 仍无脚本、同源或文件桥；不修改外壳或官网缩放。坐标取原生通知时的当前鼠标位置。

预览字节仅由 `src/main/filePreview.ts` 经 `FileService.resolveSafePath` 读取，PDF/DOCX单文件上限128 MiB、图片32 MiB，读取前后核对目录版本、真实路径和文件身份。图片尺寸上限 4000 万像素；DOCX 容器上限 5000 条目、实际展开 100 MiB（独立于外层128 MiB上限），不支持加密或 ZIP64。损坏、超限、格式不匹配显示具体原因并可用系统应用打开，不截断后伪装成功。

`src/renderer/filePreview.js` 管理渲染、异步代次及释放。PDF.js、docx-preview 与字体/CMap/解码资源在构建时随包分发。PDF主模块及资源表只在首次打开PDF时加载；JSZip、docx-preview和DOMPurify只在首次打开Word时通过现有Monaco AMD加载器加载，模块导出由预览owner持有，不依赖全局UMD变量。并发打开复用加载Promise，成功后复用；失败后再次打开仅为失败库分配新的本地模块ID重试，不重置加载器或改写全局define。加载期间切换或关闭继续受预览代次核验，迟到任务不覆盖当前文档；普通编辑与图片不加载这些专用组件。`connect-src 'none'` 保持不变。PDF 仅绘制页面，不运行文档脚本；单页 canvas 限 1600 万像素及 8192 单边。Word 禁用 altChunk，净化 HTML 后放进无脚本、无同源权限的 sandbox iframe，禁止导航、外部图片及资源，无 IPC/文件桥。预览不提交官网或上传附件。

通用工具有独立授权路径，详见 `tool-harness.md`；完全访问或明确批准可访问项目外目标，工具不能扩大本能力的编辑器文件 IPC 根目录。

`get_ai_temp_dir` 由主进程在当前项目真实根目录下管理 `.mini-ai-ide/ai-temp/<task_id>/`，不向官网提供文件桥。复用前后验证归属标记、真实路径与链接边界，不认领未知目录，不修改全局 cwd，不自动删除文件。用户负责保护与清理临时内容；局部 Git 忽略并不保证保密或安全删除。

> 本节记录当前行为；测试数量与结果以当次运行报告为准。

## 职责

让用户在编辑器里打开并编辑本地文本文件。编辑器上下文由用户复制；正式文件读取工具按预选权限返回真实结果，开启自动继续时可作为当前整批结果回传，关闭或暂停时由用户粘贴发送（见 `human-machine-boundary`）。

**关键边界**：DeepSeek 网页端不能直接访问本地磁盘。文件读取由 IDE 按边界执行；唯一附件例外是用户主动本地需求中本次明确选择的文件，由主进程校验并读取后，经 `WebComposerSender` 送入 DeepSeek 官方上传控件。网页不获得路径、文件桥或任意文件读取能力；工具结果和 automatic 仍不上传附件。

## 权限模型（已实现）

- 文件系统访问**仅限主进程**（见 ADR-0002）。
- 编辑器渲染进程通过 `contextBridge` 暴露的窄接口请求**纯文本结果**。
- 主进程对每个请求做 `path.resolve` 归一化，同时用 `realpath` 校验目标与根目录的真实路径；缺失目标逐级校验最近存在的祖先，阻止链接／junction 指向根目录外。AI 新增还拒绝根目录下的链接父级；根目录本身可以是合法 junction。
- 单次`listDir`在过滤/排序/截断后，最多同时校验4个条目；每项仍调用完整`resolveSafePath`，不缓存或共享父路径校验。结果按原排序交付，不按完成先后排列；单个消失或越界项跳过，不用第501项补齐。根目录修订变化后停止领取后续条目，等已在途检查结束再返回失败与空列表，切换后再切回同一路径也不能恢复旧结果。这是单次列举的限制，不新增全局IPC并发策略。
- 网页视图**没有任何**文件 IPC 通道。
- 新目录通过系统选择对话框取得；最近目录仅按主进程已有历史的索引打开，渲染进程不能自行指定任意根目录。
  `fs:set-root-internal` 仅供主进程内部/自检使用，**不暴露给 preload**（自检 D3 专门验证它被拒绝）。

## 目录生命周期

- `WorkspaceService` 负责根目录验证、恢复、最近记录和工作区注册列表，`WorkspaceController` 是项目导航、顶部按钮、文件菜单、最近目录及关闭目录的统一入口。左侧 `workspaceNavigation.js` 按主进程列表索引切换或移除项目，不接受任意路径。
- 启动仅恢复上次成功打开的目录；`recentRoots` 最近 5 项按成功打开时间排序，`workspaceRoots` 常驻列表按加入顺序保存、不受 5 项限制，均按 Windows 路径大小写不敏感去重。没有工作区列表字段的设置从上次目录与最近目录初始化；显式空列表保持为空。原目录失效时进入空白状态并提示重新选择；不恢复文件或光标。
- 添加项目通过系统选择目录；移除仅取消工作区注册，不删除磁盘文件，也不清空最近记录。移除活动项目先执行未保存确认，再关闭当前根；取消或保存失败保持原项目与列表。一次只激活一个本地项目，切换不绑定或切换官网会话，不实现后台 AI 并行。
- 设置以临时文件写入后原子替换，成功后才更新内存和根目录。取消、目录验证失败或持久化失败不切换原目录；关闭目录清空恢复记录，保留历史。
- 关闭标签检查该文件，切换／关闭目录和退出检查所有未保存标签，提供“保存／放弃／取消”。保存失败或取消保留缓冲；放弃只有在后续操作成功时才替换或清空缓冲。
- 目录操作、文件操作和 AI 写盘串行执行；保存回执允许在离开确认等待期间完成。请求捕获根目录或版本，旧目录读写结果不得复用到新目录。
- 切换目录清空 AI 批次、片段基线与撤销快照；改名／删除只使受影响路径及后代路径失效，其他记录保留。存在 AI 记录时，切换前明确提示影响。

## 多文件编辑

- 每个打开文件拥有独立 Monaco model；一个编辑器实例切换 model，保留草稿、撤销栈、光标与滚动位置。重复打开激活已有标签，Windows 路径键统一斜杠并忽略大小写。
- 标签显示文件名、完整路径提示和未保存点，提供关闭、方向键／Home／End 切换及 Delete 关闭。关闭当前标签后激活相邻标签，最后一个关闭后显示空白页。
- 超长名称在标签最大宽度内收缩省略，关闭按钮独立占位，不与相邻标签重叠；标签栏保持横向滚动。离线真实布局验证为 `node tools/verify-editor-tabs.cjs`（先构建），只使用内存文件列表、不读取或关闭真实文件。
- 保存请求明确指定文档路径；后台标签的保存不切换当前标签。保存失败或保存期间继续输入保留未保存状态。
- AI 写盘检查所有打开文档中的目标草稿，按用户设置询问或采用已选策略；继续时以 AI 基于磁盘 A 生成的 C 替换草稿 B，停止则保留 A/B。成功写回刷新对应模型，不切换当前标签。
- 改名同步所有受影响标签的路径并保留草稿；删除关闭受影响标签，其余标签保留。目录切换释放旧模型；异步旧读写结果不可覆盖新目录。

## IPC 契约

| 通道 | 参数 | 返回 |
|---|---|---|
| `fs:choose-root` | 无 | `{ root, recentRoots, workspaceRoots, revision, ok, canceled?, error? }` |
| `fs:get-root` | 无 | `{ root, recentRoots, workspaceRoots, revision }` |
| `fs:recent-roots` | 无 | 主进程保存的最近目录数组 |
| `fs:open-recent-root` | `index: number` | 目录操作结果 |
| `fs:close-root` | 无 | 目录操作结果 |
| `fs:open-workspace` | `index: number` | 打开主进程注册列表中的项目 |
| `fs:remove-workspace` | `index: number` | 移除注册；不删除磁盘文件 |
| `fs:list-dir` | `relPath: string` | `{ ok, entries[], truncated, error? }` |
| `fs:read-file` | `relPath: string` | `{ ok, text?, encoding?, fellBack?, meta?, tooLarge?, limit?, error? }` |
| `fs:read-file-preview` | `relPath, root` | `{ ok: true, kind, mimeType, bytes, relPath }` 或 `{ ok: false, error }`；仅编辑器主 frame，必须是当前项目 |
| `fs:start-workspace-file-drag` | `relPath, root` | `{ ok, error? }`；仅编辑器主 frame，当前项目单个普通文件交给原生拖放，不返回绝对路径或内容 |
| `ui:file-preview-zoom` | 主进程 → 编辑器主 frame | `{ direction: 'in'/'out', x, y }`；原生滚轮缩放通知，无页面调用入口 |
| `fs:slice-file` | `relPath, startLine, endLine` | `{ ok, text?, startLine?, endLine?, totalLines?, error? }` |
| `fs:write-file` | `relPath, text, root` | `{ ok, relPath?, byteLength?, error? }` |
| `fs:create-entry` | `parent, name, isDirectory, root` | `{ ok, relPath?, isDirectory?, error? }` |
| `fs:rename-entry` | `relPath, name, root` | 文件操作结果，成功含旧／新路径 |
| `fs:trash-entry` | `relPath, root` | 文件操作结果，成功含旧路径 |
| `fs:delete-entry` | `relPath, root` | 独立永久删除，原生确认后返回文件操作结果 |
| `fs:reveal-entry` | `relPath, root` | 验证目标后在资源管理器中显示 |
| `fs:open-entry` | `relPath, root` | 验证目标后用系统默认应用打开文件或目录 |
| `fs:copy-entry-path` | `relPath, relative: boolean, root` | 验证目标后复制绝对／相对路径 |
| `fs:root-changed` | （主进程 → 编辑器） | 根目录、最近记录、工作区列表、版本 |
| `fs:file-changed` | （主进程 → 编辑器）`filePath, updated/created/deleted, revision` | AI 更新重读目标，创建／删除同步标签和文件树，拒绝旧目录事件 |
| `fs:entry-changed` | （主进程 → 编辑器） | 改名／删除事件、路径、目录标记和版本 |
| `editor:confirm-leave` | 可选 `path, root`（无参数检查所有文档） | `{ ok }`，是否允许离开 |
| `editor:state` | （编辑器 → 主进程）`{ root, path, documents: [{ path, dirty }] }` | 单向编辑状态上报 |
| `editor:request` / `editor:reply` | 保存请求 `{ id, kind: save, path }`／回执 ID 和成功布尔值 | 离开确认的保存回执 |
| `ui:copy-numbered-snippet` | `{ root, relPath, text, startLine }` | 片段复制结果；目录或当前文件已变化则拒绝，不写入旧片段记忆 |

写入和文件管理的 `root` 必须等于当前根目录。文件管理与编辑状态通道仅接受本地编辑器主 frame；网页没有对应 preload。复制路径和资源管理器定位也由主进程验证当前根、真实路径与目标存在性，不接受任意系统路径；空白菜单以根目录为目标，相对根路径复制为 `.`。完整类型以 `src/shared/contract.ts` 为准。

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
| 目录列表 | 文件树显示点文件，跳过 `node_modules`/`.git`/`dist` 等目录；目录在前按名称排序；单目录上限 500 条并标记 `truncated` |
| 写入 | 仅 `write-file` 通道；同样过白名单与大小上限；**只由用户在编辑器里明确保存时触发** |
| 新建 | 文件树顶部或右键入口；选中文件夹内创建、选中文件的父目录内创建、无选中或空白处右键则根目录内创建；排他创建，不覆盖已有目标 |
| AI 新增 | `apply_changes` 在预选权限与草稿校验通过后直接执行；目标必须不存在，排他创建文件及缺失父目录，失败回滚本次空目录；撤销核对创建时文件身份（dev/ino/birthtimeMs）和内容，只删除本次文件及空目录，同名同内容外部替换也拒绝，保留记录供重试 |
| AI 更新 | 明确替换／覆盖全文仅更新已有目标，writeFile 的预期原文参数复核打开文件的内容和身份，r+ 不重建消失目标；不提供跨进程锁保证 |
| 名称 | 树内输入，Enter 确认、Esc 取消；拒绝 Windows 非法字符、保留名称、尾随点／空格、重名及过长名称 |
| 改名 | F2 或右键；同步所有打开文件及文件夹后代文件的保存路径，保留草稿；不覆盖已存在目标 |
| 移入回收站 | 保留独立入口，原生确认后调用 `shell.trashItem`，失败可见且不改为永久删除；成功后关闭受影响标签，其他标签保留 |
| 永久删除 | 独立“永久删除…”入口；先处理目标及文件夹后代草稿，原生确认展示路径、文件夹全部内容范围及不进回收站后果；取消不删，确认后复核目标身份与目录版本，失败可见 |
| 管理边界 | 不允许改名／删除工作区根目录；永久删除、定位和复制拒绝根目录下链接及链接祖先；用户选择的根目录自身可为合法 junction。删除普通目录内链接仅移除链接，不递归到外部目标 |
| 图标与菜单 | 本地 SVG 按特殊文件名与扩展名区分常见类型，未知类型通用，文件夹区分开合；菜单按创建、定位／默认应用打开／路径复制和改名／两种删除分组，键盘导航跳过分隔线 |
| 刷新 | 手动重读全部展开目录；已知创建、删除、改名只重读最近可见父目录，未显示的新多级路径从已显示祖先核查。复用未变化节点，保留有效展开、选中、焦点与自然滚动锚点；不覆盖等待期间用户转移的焦点或滚动，没有持续文件系统监听 |

**实现说明**：GBK 解码使用 Node 自带的 `TextDecoder('gbk')`（本机 ICU 为 full），**不引入 iconv-lite** 等第三方依赖。

## 测试覆盖

| 测试文件 | 覆盖 |
|---|---|
| `test/encoding.test.ts` | UTF-8 合法性（7 类非法序列）、BOM、GBK 回退、二进制拒绝、空文件 |
| `test/pathGuard.test.ts` | `..` 穿越、绝对路径越界、前缀相似目录（`project` vs `project2`）、大小写不敏感、NUL、目录过滤与截断 |
| `test/limits-and-ua.test.ts` | 元信息统计、上限判定、分片边界、文本扩展名判定、UA 规则 |
| `test/fileService.test.ts` | 真实文件系统集成：列目录 / 读写 / 回退 / 拒绝 / 越界 / 超限 / 多级新增 / 同名冲突 / 链接 / 新增撤销与回滚 |
| `test/workspaceService.test.ts` | 恢复、最近 5 项、独立常驻工作区、移除不删除、关闭、失效目录、设置写入失败与测试隔离 |
| `test/fileManagement.test.ts` | 新建、改名、重名不覆盖、回收站独立、永久删除、身份过期、链接／junction 与根目录切换 |
| `test/workspaceController.test.ts` | 编辑器主 frame、当前根、主进程路径复制／定位、草稿与原生确认取消、两种删除隔离 |
| `test/editorSession.test.ts`、`test/editorWorkspace.test.ts` | 多文件切换、后台保存及确认、失败保留缓冲、延迟读取、输入变化及所有标签改名删除 |
| `test/filePreview.test.ts`、`test/filePreviewIpc.test.ts`、`test/imageDimensions.test.ts`、`test/filePreviewRenderer.test.ts` | 二进制原样读取、真实路径与主 frame 权限、格式/尺寸/ZIP 限额、过时渲染、翻页和释放 |
| `tools/verify-file-preview.cjs` | `pnpm run verify:files`：隔离临时文件、真实 Electron 离线图片/PDF/DOCX 渲染与截图，不操作官网 |
| `test/fileExplorer.test.ts`、`test/fileIcons.test.ts` | 菜单目标、分组键盘导航、旧目录隔离、类型映射和静态 SVG 安全 |
| `src/main/workspaceProbe.ts` | `pnpm run verify:workspace`：隔离设置和临时文件，验证真实 Electron 本地交互、AI 跨目录失效及系统回收站，不操作官方网页 |

## 代码入口

- `src/main/fileService.ts`、`src/main/fileManagement.ts` — 主进程内文件读写、条目管理与权限检查
- `src/main/filePreview.ts`、`filePreviewIpc.ts`、`docxArchive.ts` — 附件受限读取、专用主 frame IPC、Word 容器校验
- `src/shared/filePreview.ts`、`imageDimensions.ts`、`src/renderer/filePreview.js`、`filePreview.css` — 类型路由、图片尺寸、只读呈现与资源生命周期
- `src/main/workspaceService.ts`、`src/main/workspaceController.ts`、`src/main/settings.ts` — 目录状态、交互入口与持久化
- `src/main/editorSession.ts`、`src/renderer/editorWorkspace.js` — 离开确认、保存回执与编辑缓冲
- `src/renderer/editorTabs.js` — 标签呈现、关闭入口与键盘导航
- `src/renderer/fileExplorer.js`、`fileIcons.js`、`fileExplorer.css` — 文件树、静态类型图标、名称输入与右键菜单
- `src/shared/encoding.ts`、`src/shared/pathGuard.ts`、`src/shared/limits.ts` — 纯逻辑（可单测）


## 编辑输入与真实正文快照

editorWorkspace 持有模型对应的按需全文快照：追加等长度变化只需长度即可立即确定未保存状态，等长修改仍精确比较实际全文，支持撤销及手动恢复原文。相同标签状态不重复报告或渲染；这不延迟首次未保存反馈。state.currentText 仍在读取时返回最新真实全文，保存、切换及离开确认先同步快照；保存期间继续编辑保留最新草稿，不以旧保存回执覆盖。只读附件不生成编辑脏状态。

## 目录列举测量

`pnpm exec tsx tools/measure-directory-list.ts --output=报告路径`只在自身临时目录测量普通条目/点文件/过滤目录、根及五层路径、10/100/500/600条各3样本。记录真实磁盘耗时、完整校验调用数、峰值在途及排序/截断的完整结果；不覆盖已有报告，不读取用户项目或执行工具。目录数据集不等于GUI刷新/FPS测量。

树状态由`fileExplorer.js`统一持有。`refresh(reset, changedPath)`在项目reset时清理旧记录与请求身份；省略变化路径时重读全部展开目录，给定文件/目录变化路径时只重读最近已显示且展开的父目录。行按路径和类型复用，已删除/变类型子树移除，改名迁移展开及选择路径；本地创建成功主动刷新，改名/删除以主进程事件刷新一次，AI创建/删除经renderer已有项目修订核验后进入同一owner。主进程仍是排序、500项截断和安全校验的唯一事实来源，不由树界面推算磁盘条目。

目录请求身份拒绝同目录迟到结果，不同父目录互不取消；已折叠/移除的容器、旧项目及切回同名项目均不能接纳旧结果。被新请求取代的递归刷新停止后续读取；单目录读取失败保留原内容并显示原因，手动刷新继续检查其他展开分支。复用事件复核当前节点归属，不以最初渲染时的代次操作。`node tools/verify-file-tree-refresh.cjs`使用真实Chromium DOM、生产脚本与样式、内存目录桥离线检查读取/节点创建次数和交互，不接触官网或用户项目，也不等同真实磁盘/IPC耗时或FPS。
