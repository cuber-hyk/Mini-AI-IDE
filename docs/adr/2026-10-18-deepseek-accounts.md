---
artifact_type: adr
status: accepted
created: 2026-10-18
updated: 2026-10-18
owner: agent
source_of_truth: [src/shared/deepseekAccounts.ts, src/main/deepseekAccounts.ts, src/main/deepseekAccountViews.ts, src/main/webPlatformController.ts, src/main/webPlatformView.ts, src/main/tools/integration.ts, src/main/tools/harness.ts, src/renderer/deepseekAccounts.js, test/deepseekAccounts.test.ts, test/deepseekAccountSwitch.test.ts, test/toolPlatformActivity.test.ts]
---

# DeepSeek 账号采用独立持久会话

## Context

用户已确认需要在本应用中保存多个 DeepSeek 账号，首次登录后直接切换，避免反复退出登录。现有正式默认资料必须保留；官网权限与工具运输仍限活动网页。官方登录失效或验证要求由官网决定，应用不承诺永久免登录。

## Decision

- 默认账号固定 `default` 并沿用 `persist:postcheck`；附加账号编号 `account-N` 映射至 `persist:postcheck-ds-N`，不包含用户备注或真实身份，不与 ChatGPT 的 `persist:postcheck-02` 重合。编号仅创建时分配并保存，启动及切换均复用，不重命名、迁移或清理原分区。
- `deepseek-accounts.json` 存本地备注与下一个编号，不含凭据；损坏或保存失败明确报错，保留原文件。账号不是已验证的官网身份，仅代表独立浏览器会话。首次在对应官网手动登录，已退出账号不自动恢复。
- `DeepSeekAccountViews` 缓存懒创建的原生视图；应用启动使用默认账号。网页没有 preload、文件桥或任意 IPC，UA 沿用真实内核规则；新增视图与默认 DeepSeek 一样不开放程序登录弹窗入口。
- `WebPlatformController` 是平台与账号切换的唯一 owner。只接受本地顶栏主 frame 的已有 ID 或受限备注；不接受分区、路径、URL。执行/后台进程/发送时拒绝，准备前后均核验，统一撤回待运输并重新绑定工具采集与发送。失败恢复原账号及视图；已保存的新账号仍可在列表重选，不以失败删除资料。
- 加载、错误、导航修订与只读就绪观察以视图身份隔离。同平台切账号仍递增活动代次，旧来源结果仅保留复制；`bindWeb` 清除旧工具选择，新历史只作基线，旧批及附件不补发。
- 账本防重放在附加账号加入稳定 ID 作用域，默认账号及 ChatGPT 保留原作用域，避免升级后重放旧记录。官网 URL 仍作为网页来源/运输核验，不能用账号作用域替换运输地址。

## Alternatives Considered

- 在单一分区中替换令牌/页面存储：无法完整隔离浏览器会话，扩大凭据接触与生命周期复杂度，未采用。
- 每次切换重建临时会话：不能保存账号登录状态，不满足目标。

## Consequences

每个已打开账号保留独立原生网页及浏览器存储，有相应内存/磁盘成本；隐藏账号不获得采集或发送资格。首版只添加/选择，不删除资料、不自动检测身份或更新登录。备注为本地标签，用户自行辨认官网账号。真实多账号登录、过期及官网风控须在应用中人工验收；离线原生验证只证明分区存储隔离与重启保持。
