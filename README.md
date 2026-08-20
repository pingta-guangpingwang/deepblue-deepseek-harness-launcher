# 深蓝DeepSeekHarness启动器

深蓝DeepSeekHarness启动器是面向中国国内新手用户的 DeepSeek Harness 桌面整合启动器。Windows 保留完整离线版作为断网与疑难设备兜底；新的联网发行链把 UI 壳、Node、Harness 和插件包管理器拆成独立的内容寻址模块，不要求用户预先配置 Git、Node 或系统环境变量，也不再让每次小更新重复下载完整环境。

配套驾驭工程教学：[https://ailishishu.com/learn/deepseek-harness/](https://ailishishu.com/learn/deepseek-harness/)

安全与信任：[代码签名政策](docs/CODE_SIGNING_POLICY.md) · [隐私说明](PRIVACY.md) · [安全问题报告](SECURITY.md)

> 当前状态：Windows x64 0.10.6 公测版。不到 1 MB 的联网引导器、差异化模块更新确认与进度、安装后自动重启、可独立更新的签名模型目录、可选程序与资源位置、快捷方式修复、完整离线兜底、真实 Harness Web 启动、启动器与 Harness 网页模型/密钥双向同步、AI历史书原生能力中心、同源新闻阅读、63 款免费签名皮肤和 56 个可互动宠物均已验证。

> 模块化发行状态：签名目录 schema 2、多渠道探测与回退、断点下载、SHA-256、受限解包、不可变安装、原子切换与回滚已经落地；真实制品已从空目录安装并启动 Node 24.16.0、Harness 0.1.0-rc.6、pnpm 11.22.0 与 Harness Web。UI 壳同时携带经过同一严格校验的运行模块目录副本；运行目录、UI 壳与三个运行模块均使用 GitHub 主线路和 OSS 应急线路，GitHub 失败时自动切换，平时不消耗 OSS 大文件流量。

## 已实现

- 环境检测：验证内置 Node.js 24、Harness 核心、pnpm 与在线源。
- 一键启停：从用户选择的工作区启动 `dsh web`，等待服务就绪并打开浏览器。
- 独立用户数据：首次启动可确认或更换 Node、Harness、插件、皮肤、宠物与 `DSH_HOME` 的存放位置；以后可在设置中安全迁移，旧位置保留为恢复副本。
- 版本管理：新版本安装到并行目录；更新前备份用户数据；已安装版本可回滚。
- 模块化运行时：Node、Harness 与 pnpm 使用签名清单独立安装；界面显示每个模块、实际字节、所用渠道和总进度，下载前探测渠道，失败自动切换，校验失败不激活，旧版本保留为回滚点。
- 国内网络：GitHub 承担开源模块主分发，OSS只托管小引导器与签名目录；npm 依赖在 npmmirror 与 npm 官方源之间回退，完整离线版由百度网盘兜底。
- 更新安全：远程版本、插件和模型目录必须通过 Ed25519 签名；启动器整合包下载后校验 SHA-256。
- 插件管理：调用 Harness 官方 `dsh plugin --profile web add/update/remove` 流程，并把配置的 npm 国内源传给 pnpm。
- 模型目录：国内平台优先，覆盖 DeepSeek、千问、豆包、Kimi、智谱、千帆、腾讯 TokenHub、MiniMax、阶跃、硅基流动和百川；已知平台直接勾选 2026-08-18 核对的官方模型，不再手填模型参数；不下载模型权重，用户主动保存的 API Key 只进入 Windows 安全存储。
- 皮肤商店：从无需登录的 Gitee 签名目录按页加载免费皮肤，支持高清图、轻动态背景和视频壁纸；原媒体只在点击应用时下载，本地按 SHA-256 缓存并一键应用到 Harness。
- 宠物商店：提供透明帧动画、悬停回应、点击动作、双击爱心、主动问候、拖动定位和位置记忆的网页伙伴；支持静态、GIF、动态 WebP 与本机自定义导入，宠物媒体按需下载，不打进安装包。
- AI历史书融合目录：新闻双击后在原生弹窗阅读；提示词、Skill、工作流、知识库、AI 工具和智能体使用独立页签，并显示源码、Stars、热度、评分和用户评价。
- 受控能力安装：资源先进入安装列表；Skill 安装到 Harness 原生目录并默认关闭模型自动调用，其他内容写入 DSH 本机能力库，不执行任意远程仓库代码。
- 账号同步：左下角登录入口使用加密 HttpOnly 会话；收藏跨网站与设备同步，评价公开可看但发表评论必须登录。
- 日志诊断：展示组件、源站、任务和 Harness 进程输出，提供快速修复入口。
- 引导安装：下载 EXE 后双击即可安装，可选择程序安装目录，显示系统进度，自动创建桌面与开始菜单快捷方式并启动应用；快捷方式缺失时可在设置中修复。
- 界面预览：独立 Vite 入口可在浏览器中检查桌面与窄屏布局；Electron 内通过安全的 preload IPC 调用系统能力。

## 开发

要求 Node.js 24。

```powershell
npm install --registry=https://registry.npmmirror.com
npm run dev
```

只预览界面，不启动 Electron：

```powershell
npm run dev:web
```

质量检查：

```powershell
npm run typecheck
npm test
npm run test:runtime
npm run test:plugin
npm run test:version
npm run build
npm run modules:build
npm run modules:smoke
```

`test:runtime` 会使用整合包同款的内置 Node.js 和 `@deepseek-ai/dsh` 启动真实 Web 服务，收到 HTTP 200 后清理进程。

## 打包

Windows 安装程序必须在 Windows x64 上构建；macOS 需要在对应 macOS 构建机上生成独立应用包。这样 `node` npm 包才会带入目标平台的 Node.js 可执行文件。

```powershell
# Windows 小型联网引导器 + 完整离线兜底包
npm run dist:win
```

```sh
# macOS DMG + ZIP
npm run dist:mac
```

构建结果写入 `release/`。生产公钥和发布地址已配置。当前 Windows 0.10.6 安装器尚未取得公开受信任的 Authenticode 签名，Windows 可能显示“未知发布者”；项目正在申请 SignPath Foundation 的开源免费代码签名，获批前不会把 Ed25519 更新目录签名冒充 Windows 发布者签名。正式对外分发还需补充：

1. Windows Authenticode 代码签名（优先申请 SignPath Foundation 开源免费签名）；
2. Apple Developer ID 签名和 notarization；
3. 独立的 macOS 构建机和实际设备验收。

`dist:win` 生成不到 1 MB 的联网引导 EXE、内容寻址 UI 壳/运行模块，以及供百度网盘兜底的完整离线 EXE。两种安装器都允许选择程序位置；首次进入启动器还会确认运行资源位置。用户会看到 Node、Harness 等模块各自的渠道、字节进度和总加载进度。界面壳安装成功后才创建桌面与开始菜单快捷方式。安装程序不调用隐藏 PowerShell，不绕过执行策略，也不会写入 GitHub Token 或 DeepSeek API Key。

## 国内发布源建议

启动器将不同职责拆开，避免 OSS 带宽和源码仓库被重复大包拖垮：

| 资源 | 主位置 | 备用位置 |
| --- | --- | --- |
| 源码、说明 | GitHub | Gitee（仓库建成后） |
| Ed25519 schema-2 远程签名清单 | OSS `release-v2` | GitHub Release 附件 |
| Windows 小型联网安装器 | OSS | GitHub Releases |
| UI 壳、Node、Harness、pnpm 内容寻址模块 | GitHub Releases | Gitee/OSS 有真实公开制品后再加入 |
| 完整离线包 | 百度网盘 | 不占用 OSS 日常流量 |
| npm 插件依赖 | npmmirror | npm 官方源 |

默认配置会探测 [GitHub 原仓库](https://github.com/pingta-guangpingwang/deepseek-harness)、[Gitee 国内镜像](https://gitee.com/wanggp123/deepseek-harness)、OSS 签名清单和 npmmirror。大文件 URL 由签名清单提供，所以以后更换版本文件不需要重新编译旧启动器。

当前 Windows x64 联网引导器约 0.70 MB；它不携带 Electron、Node 或 Harness。首次安装时 GitHub 下载约 82.2 MB UI 壳，第一次真正启动 Harness 时再下载约 35.4 MB Node 和 41.5 MB Harness；只有使用插件管理时才下载约 6.6 MB pnpm。旧版单文件 BAT 因会触发安全软件的脚本投递器启发式规则而停止分发。

- 在线轻量版永久直链：`https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/download/deepblue-deepseek-harness-launcher-win-x64-online.exe`
- 完整离线版：由下载页提供百度网盘兜底，不再发布 OSS 永久大文件直链。

永久直链保持不变并覆盖为最新稳定版；签名更新清单仍引用按版本保存的对象，便于校验与回滚。

## 目录

```text
src/main/       Electron 主进程、运行时、进程和更新控制
src/preload/    受限 IPC 桥
src/renderer/   React 桌面界面与浏览器预览
src/shared/     主进程和界面共享的数据类型
skin-store/     Gitee 皮肤仓库源文件、签名目录、原创 CC0 素材与贡献规范
pet-store/      Gitee 宠物仓库源文件、签名目录、原创 CC0 素材与贡献规范
bundled-plugins/启动器随附的 Harness 壁纸运行插件
resources/      应用图标、正式发布时放置的更新公钥
scripts/        运行时冒烟、图标生成、清单签名
docs/design/    视觉概念图
docs/qa/        桌面与窄屏验收截图
docs/operations 发布清单示例和运维说明
```

更详细的运行时和更新设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，正式发版步骤见 [docs/operations/RELEASE.md](docs/operations/RELEASE.md)。

## 安全说明

- 0.2.0 单文件自解压 BAT 已停止分发；Defender 会通过 AMSI 把其隐藏 PowerShell、自释放二进制行为识别为脚本投递器。不要关闭 Defender 或添加排除项，迁移说明见 [0.2.0 Windows BAT security advisory](docs/operations/SECURITY-ADVISORY-0.2.0.md)。
- 不要把 GitHub Token、DeepSeek API Key 或签名私钥提交进仓库。
- DeepSeek API Key 由 Harness 自己的 Settings → Models 管理；启动器只传递 `DSH_HOME` 和本地运行参数。
- 第三方插件是受信任可执行代码。目录签名只能保证“目录来自发布者”，不能替代插件代码审查。
- 签名私钥只应存在于离线发布机或受保护的 CI Secret；整合包只带公钥。

## Code signing policy

本项目的 Windows 正式版必须由公开仓库的 GitHub 托管构建产生，经过测试、人工批准和 Authenticode 签名后才允许替换稳定下载地址。免费代码签名计划使用 SignPath Foundation：**Free code signing provided by SignPath.io, certificate by SignPath Foundation**。完整角色、来源验证、隐私和发布要求见[代码签名政策](docs/CODE_SIGNING_POLICY.md)。

## License

MIT
