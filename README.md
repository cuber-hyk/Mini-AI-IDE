# Mini-AI-IDE

面向 Windows 的轻量 AI 辅助编辑器：用 Monaco 编辑本地文件，在内嵌 DeepSeek 网页中手动与 AI 对话，再把回复中的文件修改采集回来，预览并确认后应用。

界面从左到右是 **编辑器与文件树、AI 网页、变更列表**。使用网页版账号登录，无需在应用里配置模型 API Key。

## 功能

- **本地编辑**：多文件标签、独立草稿与撤销栈、代码高亮、查找和保存。
- **目录管理**：恢复上次打开的目录、最近 5 个目录、新建文件／文件夹、改名、移入回收站和手动刷新。文件树空白处可右键操作根目录。
- **AI 上下文**：复制选区或全文，保留当前编辑内容、缩进、空白及末尾换行；需求输入区提供简洁／完整两版提示词，可分别自定义。
- **回程预览**：采集最新回复，按目录／文件展示操作，在编辑器中显示内联差异，支持逐条或全部应用。
- **精确修改**：局部修改根据 SEARCH 原文唯一匹配定位，新增或删除内容后自动调整后文；新建与覆盖全文使用明确操作。
- **写入保护**：拦截不匹配、重复匹配、重叠操作、未保存草稿和预览后的外部改动；AI 写入可在当前会话中撤销。
- **可调整布局**：拖动分隔条，独立收起网页与变更列，记忆面板宽度。

## 使用 EXE

适用平台为 **Windows 10／11 x64**。打包产物自带运行时，使用者无需安装 Node.js 或 pnpm。

| 产物 | 使用方式 |
|---|---|
| `Mini-AI-IDE-Setup-<版本>-x64.exe` | 双击安装，可选择安装目录；随后通过桌面或开始菜单快捷方式启动 |
| `Mini-AI-IDE-Portable-<版本>-x64.exe` | 免安装，双击启动 |

网页版登录与对话需要联网。当前打包配置未配置代码签名，Windows 可能显示未知发布者提示。这里未提供预设下载链接；自行打包时产物位于 `release/`。

### 第一次使用

1. 打开应用并选择要编辑的项目目录。
2. 在中间网页中手动登录 DeepSeek。
3. 打开文件，选择需要修改的代码，通过“复制上下文”复制选区或全文。
4. 在底部输入需求，选择简洁或完整格式，点击“复制提示词”；将提示词和原文上下文手动粘贴到网页，发送给 AI。
5. 回复完成后点击“采集回复”。在右侧选择条目，核对左侧编辑器里的差异。
6. 点击对应的应用／创建／覆盖按钮，或使用“全部应用”。需要回退时点击变更列的“撤销”。

本地手工编辑通过 `Ctrl+S` 保存。AI 应用前如果目标标签有未保存内容，需要先保存。目录切换会清空原目录的 AI 批次和撤销记录；启动只恢复目录，不恢复已打开标签或光标。

程序只读采集网页，不自动粘贴、发送或执行回复里的命令。普通命令、图示和代码示例放入默认折叠的“其他内容（只读）”，不参与应用。

## AI 回复格式

每个修改块都需明确声明文件路径和操作，紧接完整代码围栏。**围栏至少四个反引号**；内容中含同样长的围栏时，外层继续加长。路径相对于打开的项目目录，语言标签只用于显示。

| 操作 | 内容 | 目标要求 |
|---|---|---|
| `替换` | 非空 SEARCH 原文与 REPLACE 新内容 | 已有文件中原文唯一匹配 |
| `新建` | 完整新文件内容 | 文件不存在，缺失父目录会创建 |
| `覆盖全文` | 完整文件内容 | 文件已经存在 |

### 局部替换

SEARCH 逐字复制已有原文，REPLACE 可以增加或减少行数，**不需要 AI 计算行号**。例如：

> `````text
> ### 文件：src/greet.ts
> ### 操作：替换
> ````typescript
> <<<<<<< SEARCH
> export function greet() {
>   return "hello";
> }
> =======
> export function greet() {
>   return "你好";
> }
> >>>>>>> REPLACE
> ````
> `````

空 REPLACE 表示删除 SEARCH 内容；插入则在 REPLACE 中保留真实上下文并添加内容。一个块可以有多对替换，各对必须在同一原文中唯一匹配且不重叠。依赖上一操作生成内容的修改，应在下一轮对话中处理。

### 新建文件

> `````text
> ### 文件：src/util/format.ts
> ### 操作：新建
> ````typescript
> export function formatDate(d: Date): string {
>   return d.toISOString().slice(0, 10);
> }
> ````
> `````

### 覆盖全文

> `````text
> ### 文件：README.txt
> ### 操作：覆盖全文
> ````text
> 项目说明
> 这里是文件的完整新内容。
> ````
> `````

新建和覆盖全文都直接提供完整正文，不包装 SEARCH／REPLACE。缺失路径／操作、残缺围栏、零次或多次匹配均会阻塞对应操作。旧 `### 范围` 行号格式不可应用；已自定义提示词的用户需手动更新，或在提示词设置中“恢复默认”后保存。详细规则见 [回程协议说明](docs/capabilities/return-path-and-format-contract.md)。

## 从源码运行

准备 Windows x64、Node.js 和 pnpm，在项目根目录执行：

```powershell
pnpm install
pnpm run setup:electron
pnpm start
```

`setup:electron` 检查并安装 Electron 二进制，解决仅安装 JS 依赖却缺少 `electron.exe` 的情况。`pnpm start` 会先编译并复制 Monaco 等本地资源，再启动应用。

完成依赖安装后，也可以双击根目录的 [启动IDE.bat](启动IDE.bat)。它与命令行启动使用同一入口，启动失败时保留窗口显示错误；BAT 是源码启动工具，不能代替 EXE 的内置运行时。

依赖版本以 [package.json](package.json) 和 [pnpm-lock.yaml](pnpm-lock.yaml) 为准。当前技术栈为 Electron、TypeScript、Monaco Editor；渲染进程通过受限 IPC 访问本地文件。

## 打包 Windows EXE

在完成源码依赖与 Electron 安装后执行：

```powershell
pnpm run package:win
```

脚本编译代码、检查类型和图标，然后使用 electron-builder 生成 Windows x64 的 NSIS 安装包及免安装 EXE。产物输出至 `release/`，版本取自 `package.json`。

只生成可直接运行的解包目录：

```powershell
node scripts/package-win.mjs --dir
```

入口位于 `release/win-unpacked/Mini-AI-IDE.exe`；分发解包版时需保留整个目录，不能只拷贝这个 EXE。

**当前脚本在 `release/` 非空时会拒绝继续打包。** 重打包前关闭正在运行的产物，备份需要保留的版本，再由你手动清理输出目录。脚本不会自动删除旧产物。检测到已安装的本地 Electron 时会复用它；首次打包可能需要下载构建工具。

打包配置见 [electron-builder.config.cjs](electron-builder.config.cjs)，执行入口见 [scripts/package-win.mjs](scripts/package-win.mjs)。

## 开发验证

| 命令 | 用途 |
|---|---|
| `pnpm run typecheck` | TypeScript 类型检查 |
| `pnpm test` | 单元与临时文件集成测试 |
| `pnpm run build` | 编译、复制静态资源并检查 renderer 作用域 |
| `pnpm run self-test` | 离线启动自检 |
| `pnpm run verify:workspace` | 临时目录与本地样例的真实桌面流程验证 |
| `pnpm run verify:prompt` | 两版提示词、示例和设置面板验证 |
| `pnpm run verify:range` | 精确替换位置与选区相关检查 |

## 配置与常见问题

**配置保存在哪里？** 设置保存在 `%APPDATA%\mini-ai-ide\settings.json`，包括最近目录、布局和自定义格式要求。网页版登录态保存在应用用户数据中的持久会话分区。免安装版也使用用户数据目录；“免安装”不代表不保存配置。安装版卸载配置为保留用户数据。

**启动提示缺少 Electron？** 在源码根目录重新执行 `pnpm run setup:electron`；失败时检查脚本显示的网络或下载错误。EXE 使用者无需执行此步骤。

**采集到的操作无法应用？** 查看条目详情中的原因，核对文件路径、明确操作和完整围栏。SEARCH 不存在时重新复制准确原文；多次匹配时增加上下文。预览后文件已变化，需要重新采集核对；不要改成猜行号或忽略空白。

**如何撤回 AI 修改？** 使用变更列的“撤销”。记录只在内存中保存，最多 20 次，不跨重启；应用后文件又被编辑时会拒绝用旧快照覆盖。撤销不能代替 Git 或文件备份。

**重启后没有恢复文件标签？** 当前只恢复上次成功打开的目录及最近目录列表。原目录不存在时提示重新选择；关闭目录后不再自动恢复它。

**网页改版后采集失败？** 采集依赖已渲染的网页结构，查看变更列的“诊断信息”辅助定位。离线样例通过不保证任意网页版本都可采集；程序不通过逆向 API 补采。

## 项目结构与文档

```text
src/main/                  主进程：窗口、IPC、目录、文件读写、采集与应用
src/renderer/              本地 UI：编辑器、网页工具条、变更列表、提示词设置
src/shared/                纯逻辑：协议、原文匹配、差异、编码与路径校验
scripts/                   静态资源、Electron 安装与打包脚本
test/                      测试与回复样例
build/                     图标等打包构建资源（由 tools/gen-icon.mjs 生成）
assets/                    设计素材源文件（应用图标的设计稿）
dist/                      编译结果（生成）
release/                   Windows 打包产物（生成）
docs/                      当前能力说明、架构决策及开发过程记录
```

- [CHANGELOG](CHANGELOG.md)：用户可见变更。
- [Windows 打包](docs/capabilities/windows-packaging.md)：产物、配置要点与图标生成链路。
- [本地文件访问](docs/capabilities/local-file-access.md)：目录、标签、保存和权限边界。
- [回程协议](docs/capabilities/return-path-and-format-contract.md)：解析、预览、应用与撤销。
- [应用外壳](docs/capabilities/app-shell.md)：进程与布局、运行和打包说明。
- [设计约定](DESIGN.md)：当前 UI 规则。
- [AGENTS.md](AGENTS.md) 与 [上下文路由](docs/ai/context-map.md)：参与开发时的工程约束与阅读入口。

程序不自动向网页写入内容，不代理模型业务请求，不授予网页本地文件访问能力。精确匹配保证可验证的定位，无法判断 AI 代码是否满足需求；应用前仍需核对差异，尤其是覆盖全文。
