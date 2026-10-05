---
artifact_type: adr
status: accepted
created: 2026-10-05
updated: 2026-10-05
owner: 胡运宽
source_of_truth: [src/main/appUpdater.ts, src/main/updateService.ts, src/main/updateInstaller.ts, electron-builder.config.cjs, test/updateService.test.ts, test/updateInstaller.test.ts]
---

# ADR-0005：公开 GitHub 更新源与软件更新网络边界

## Context

软件已具备 NSIS 和 Portable 打包能力，尚无发布和更新链路。用户确认首版支持 NSIS 安装版应用内更新，公开 GitHub Releases 作为源，Portable 暂不原地替换，并允许软件更新专用主进程网络请求。更新源与安装策略决定已安装客户端如何获得后续版本，需要稳定边界。

## Decision

- 更新源固定为公开仓库 `cuber-hyk/Mini-AI-IDE` 的正式 GitHub Releases；客户端不持有 GitHub token，不暴露任意源或 URL 输入能力。
- 使用 `electron-updater` 与现有 electron-builder NSIS 产物，版本检查与下载由主进程更新 owner 承担。该网络例外只访问更新源及 GitHub 资源分发/重定向，不处理模型业务、工作区文本或文件上传。
- 编辑器 CSP、渲染进程权限、AI 网页独立会话与零注入边界保持不变。
- 每次正常启动检查一次，本地更新浮层可手动检查，帮助菜单打开同一入口；下载和安装分别由用户明确点击确认。关闭程序不自动安装。
- 安装前串行复用工作区离开确认，保存失败/取消阻止安装；应用标识、设置目录、固定网页会话分区保持稳定。
- 首版仅安装版支持更新；Portable、解包目录、开发模式和自检/诊断/探针不执行安装版更新。
- 更新库只负责检查、下载和校验；主进程明确等待 NSIS 安装包成功创建进程后才退出，避免上游预先排程退出使启动失败时窗口关闭。失败保留应用，不通过 shell 或自动提权重试启动。
- 发布 NSIS exe、构建生成的 `latest.yml` 与 `.blockmap`，Portable 作为额外独立下载项。版本、散列、大小与实际产物一致；tag 必须对应构建源码。

## Alternatives

- 自有更新服务器：可控制下载可达性，需要额外服务和维护，当前没有必要。
- 软件内下载后打开安装向导：用户步骤更多，现有 NSIS 可直接使用标准更新链路。
- Portable 原地替换：需外部替换进程、路径权限与失败恢复机制，用户已确认不在首版实现。

## Consequences

- 无需用户打开 GitHub 页面即可更新，但客户端仍需访问 GitHub 及其下载域名。
- 修改更新源或安装身份需考虑已安装客户端的过渡；不要随意更改 appId、productName、userData 和会话分区。
- 首版仍是未签名 Windows 产物。SHA-512 验证用于检查下载内容与清单一致，不构成发布者身份认证；不宣称通过 Authenticode 签名验证。
- 发布前验证下载失败、未保存内容保护和真实安装升级；不得通过跳过这些验证声称升级可用。

## References

- `AGENTS.md`
- `docs/capabilities/application-update.md`
- `electron-builder.config.cjs`
- https://www.electron.build/v26/docs/features/auto-update/
