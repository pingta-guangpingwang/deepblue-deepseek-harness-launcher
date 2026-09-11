# 2026-09-11：智能体一次授权与原生项目全量同步

已发布：两个网站接口 + Host/UI 热更新。0.10.35 内核、现有在线安装入口和 Node/Harness/pnpm 依赖保持不变；没有重发或覆盖不可变安装包。

## 版本与来源

- Launcher 功能提交：`02d4aad294a5984ead0d11b2fc8c093467c8c00a`。
- 网站功能提交：`891179e`；集成提交 `8ca9acd30cbb93f6ec292e7ff34cfac9ed86c74c`。保留远端无关工具目录更新，生产只部署下述两个 PHP 文件。
- Host：`1.0.0+959b71ba7db1`；278146 字节；SHA-256 `0dc72e26ea1e23ca4d922304b05af9a3187d3398930c13a4c603ec9859047395`。
- UI：`ui-8592a61d157c49f8`；847661 字节；归档 SHA-256 `0ec7026615e69b504439fa5443836f6c102898109056a0db685d55187c9598ef`。
- 签名更新清单 SHA-256：`ac53b200f3bb24f43bbb09624e9238bd876e479983d1d163b46cbea48fee7a3e`；前一清单 `42056ba1842b92e3cccdfaacbfde772e8d5886269f0c5ace283307c466d96f28`。
- 网站 releaseId：`prod-20260911-agent-scope`；`agent-connector.php`、`agent-hub-common.php`。发布清单 SHA-256 `5587535bad97361ed2b1e4618cfb3a9977d6c10880cedf960c05cd2d0cf988d2`。

## 验收

- OSS 两个归档完整读取哈希一致；GitHub 两个 Release 资产的服务器 SHA-256、大小及匿名 HEAD 通过。正式目录 Ed25519 签名验证通过。
- 网站生产 PHP 7.4 语法检查、部署前备份、部署后两个文件哈希核对通过。匿名访问仍返回 401；未改动账号和数据库。
- 启动器全量测试：269 通过，1 项既有跳过。连接器回归及新增范围测试通过。
- 实际 0.10.35 二进制 + 隔离新用户目录，从正式在线目录下载并热激活两个新模块；35 项显示、主动关联复制、错误 JSON 修复、心跳自动校验及真实 Codex CLI `--version` 握手通过，页面错误 0。
- 用户实际安装目录也已通过正式更新流程切换到上述版本；本机显示 Codex 44 项。模型凭据文件哈希及主题设置不变。验收前启动器关闭，验收后恢复关闭状态。

## 使用与边界

连接一个智能体时只授权一次，之后该适配器原生索引中的新增项目自动纳入同步。旧绑定登录后可点一次“升级为智能体自动同步”；保留原显式项目身份和历史。项目不再按 200 项截断，网站快照仍受 2 MiB 字节保护，超限明确报错。

实际安装版账号检查结果为 `signed_out`，需要用户重新登录。未绕过登录，未把这次本机目录显示当作已完成真实账号的云端全量同步。TRAE 远程执行仍不支持；未声称所有第三方智能体均已在另一台实体电脑上验证。

## 运维证据

- 本地模块 receipts：`release/release-agent-scope-{artifacts,pointers}-receipt.json`。
- 隔离公开更新验收：`output/playwright/public-agent-scope-1789089451548/result.json`。
- 实际安装版验收：`E:/ObsidianRes/obRes1/AIlishishu/ops/output/published-agent-scope-installed/report.json`。
- 生产备份：`/www/server/ailishishu-release-backups/prod-20260911-agent-scope`。保留所有旧模块；未执行回滚。
