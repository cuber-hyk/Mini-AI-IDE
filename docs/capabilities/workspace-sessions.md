---
artifact_type: capability
status: current
updated: 2026-10-23
owner: agent
source_of_truth: [src/shared/workspaceSessions.ts, src/main/workspaceSessionStore.ts, src/main/workspaceSessions.ts, src/main/webPlatformController.ts, src/main/workspaceController.ts, src/main/editorSession.ts, src/main/index.ts, src/main/preload.ts, src/renderer/workspaceNavigation.js, src/renderer/workspaceNavigation.css, src/renderer/editorWorkspace.js, test/workspaceSessionStore.test.ts, test/workspaceSessions.test.ts, test/workspaceSessionNavigation.test.ts, test/workspaceSessionsUi.test.ts, test/editorSession.test.ts, test/workspaceController.test.ts, test/editorWorkspace.test.ts, tools/verify-workspace-sessions.cjs]
---

# 项目绑定网页会话

ADR：[本地项目显式绑定官网会话并双向同步](../adr/2026-10-23-workspace-session-bindings.md)。

## 绑定与展示

左侧按“项目 → 平台·本地账号备注 → 已绑定会话”紧凑树形展示。项目折叠按钮与项目切换按钮分开，空项目无展开入口或空白正文，空分组不展示。绑定入口是项目行内链接图标，当前项目常显，其他项目悬停/键盘聚焦显示，不可用时悬停说明原因。项目行与会话行的省略号菜单分别提供“从工作区移除（保留本地文件）”与“解除绑定（保留官网会话）”；菜单支持键盘、Escape和点击外部关闭，状态更新时关闭旧菜单并防止旧动作操作变更后的条目。搜索匹配项目路径、原始会话标题与平台账号。当前选中由实际活动网页身份与当前项目共同决定，查询/操作旧回执不能覆盖较新广播。

每个已注册项目行内具名“绑定当前网页会话到项目”链接图标是建立关联的唯一入口。启动、网页导航、标题变化、创建/首发对话和切换项目均不绑定。普通正式 DeepSeek `/a/chat/s/<id>`、ChatGPT `/c/<id>` 才能绑定；首页、编码占位、登录页、GPTs/特殊工作区与未知地址不接纳。标题取绑定时的原生页面标题；通用或空标题用会话 ID 占位，之后不自动改名。列表仅在显示时省略与当前分组平台一致的明确末尾后缀（如 ` - DeepSeek`），完整原文仍供悬停、可访问名称及搜索使用，不回写绑定记录。

身份为平台、本地账号编号、正式会话 ID。同身份只归属一个项目，无修改归属入口；解除绑定只移除本地记录，不导航、修改或删除官网会话。不读取官网历史侧栏、正文、认证、页面存储或网络接口。账号编号代表浏览器资料槽，不证明真实登录身份。

主进程 `WorkspaceSessionStore` 将版本化记录保存在应用 userData 的 `workspace-sessions.json`；不放进 Chromium 分区或本地项目。仅存本地绑定 ID、项目绝对路径、标题与会话身份。临时文件原子替换成功后才更新内存；损坏文件保留并报告，会话工具活动停用，不静默清空。

## 双向切换

- 点击项目名称只改变本地目录，沿用原未保存保护，不导航官网。若网页已绑定其他项目，显示不匹配并阻止网页工具在错误目录执行。
- 点击具体会话经过工具/后台进程/发送忙门禁、目录离开保护和原平台 owner，选中对应账号并在复用的原生视图中加载规范官网地址。新视图首次直接加载目标会话，不先请求首页；不接收任意 URL 或分区。网络等待允许顶栏切往其他平台。
- 官网切换会话不拦截、不回退。独立于 automatic 的活动页主 frame 导航监听同步选中；未绑定会话清除选中、保留项目与现有工具流程，不创建关联。
- 官网进入其他已注册项目的已绑定会话时，先撤回旧采集和待发送，等本地忙任务结束，通过原保存 IPC 静默保存所有脏标签，全部真实回执成功后才切根目录。无正常保存或确认提示；保存失败、超时、期间新增未保存文本或目标过期均保留当前项目及草稿，显示失败/不匹配原因，不允许错误项目工具运行。
- 目录恢复、手动项目选择或静默保存迟到不能反向导航官网；连续导航、平台/账号变更使旧切换失效，后台视图和子 frame 事件不污染当前状态。

`WorkspaceSessions` 协调元数据、活动页和目录生命周期；主入口仅接线。静默保存归 `EditorSession.saveAll`，串行项目切换归 `WorkspaceController.openSessionWorkspace`，正文与保存仍归 `editorWorkspace.js`，不新增文件写入通道。工具停用/重绑复用 integration，正常恢复建立历史基线，不重跑历史请求，不恢复旧结果或附件回传资格；automatic 配置不因导航修改。

## 进程接口与验证

四个请求仅编辑器主 frame 可调用：零参数查询、已注册项目索引绑定、已有绑定 ID 打开及解绑；状态单向广播到编辑器。官网、顶栏、预览和子 frame 无此控制入口，不获得本地文件路径桥或任意导航能力。

测试按身份/持久化、会话协调、平台组合、保存与界面 owner 覆盖。`node tools/verify-workspace-sessions.cjs` 使用真实 Electron 本地编辑器/IPC/保存 owner、临时项目及模拟官网来源，验证本地行为和窄栏布局；不代表真实官网导航、草稿保持或登录验收。
