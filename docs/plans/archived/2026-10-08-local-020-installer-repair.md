---
artifact_type: plan
status: archived
created: 2026-10-08
updated: 2026-10-08
owner: 胡运宽
design_system_impact: none
---

# 本地0.2.0安装包修复

用户要求先修复0.2.0安装包。保持本地版本0.2.0，输出release-0.2.0-repaired，保留原发布附件，不上传或替换GitHub Release、不安装覆盖用户程序、不改用户配置。

原安装包与本地原包asar哈希一致，正常启动exit2，ToolStore拒绝用户数据中的load_skill；只读复核去掉该1条记录后原验证通过。当前源码包含Skills和首轮采集修复，工具记录无需清空。

1. 编译、类型/图标检查；使用现有builder配置与本地Electron，在独立新目录build NSIS/Portable及更新清单，publish never。
2. 包内版本、依赖/关键代码、图标和安装附件hash/blockmap一致性校验。
3. 实际新包隔离自检；在隔离用户数据副本验证已有load_skill历史能够读取，权限/记录不重置，原数据不动；正常启动检验必须报告是否实测。
4. 保存诊断与说明，归档计划，提供本地安装包。不提交、合并、发布或自行安装。


结果：独立目录生成NSIS116941582 bytes、Portable116571915 bytes、blockmap122042 bytes与latest.yml359 bytes。verifyReleaseArtifacts和图标嵌入通过；asar内版本0.2.0、js-yaml4.3.2含在生产依赖，249个非vendor src/dist与当前文件逐字节一致，生成证据修复代码在包内。

新包正常启动使用--user-data-dir隔离副本，带120条实际ledger及load_skill记录，15秒后仍运行，编辑器和官网sign_in页加载成功；rules/config和ledger数量保留，复制而非修改原用户数据。随后只结束此次测试启动进程。新包--self-test退出0、PASS、failures为空。包一致性校验覆盖NSIS、blockmap、Portable与更新元数据；没有运行安装器，不能宣称实际覆盖安装通过，官网采集仍未实测。

修复包说明随产物保存，原release与release-0.2.0文件未替换；未提交、合并、上传或替换GitHub附件。相同版本仅用于用户要求的本地修复包，软件内更新不会把它识别为更高版本。
