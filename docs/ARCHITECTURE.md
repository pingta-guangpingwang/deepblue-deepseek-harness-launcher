# 启动器架构

## 目标

启动器的默认体验是“下载后双击即可安装并启动”，系统上有没有 Git、Node.js 或 pnpm 都不应成为第一关。在线轻量版首次运行自动安装 Harness；完整离线版把 Harness 作为断网兜底直接带入安装程序。

## Windows 发布层

Windows 发行文件是标准 NSIS 引导安装 EXE。安装程序显示进度并允许用户选择程序目录，创建桌面与开始菜单快捷方式，并在完成后启动 Electron 应用；不使用 BAT 或隐藏 PowerShell 自释放载荷。快捷方式缺失时，正式安装版可从设置页按当前可执行文件重建。Electron 任务界面继续提供 Harness 安装、更新、修复和启动进度。发布文件通过签名清单中的 SHA-256 校验，macOS 仍需原生应用包。

Electron Builder 默认按普通依赖收集模块，但 Harness 的可组合插件还通过生产 peer dependencies 提供运行时能力。发布脚本根据 `package-lock.json` 把非开发 peer packages 同步到离线安装目录，再从同一目录裁剪出只保留 Node.js 与 pnpm 的在线版，避免离线安装后缺少 Cordis 插件。

## 运行时层次

```text
Electron 桌面应用
├─ Renderer：React 界面，不具备 Node.js 权限
├─ Preload：只暴露白名单 IPC
└─ Main
   ├─ 配置与任务状态
   ├─ 模型路由、加密密钥与 Token 用量聚合
   ├─ 新闻 / 游戏公开发现目录
   ├─ Harness 进程管理
   ├─ 源站检测与签名目录
   └─ 下载、SHA-256、版本切换与备份

固定配置目录（Electron userData）
└─ launcher.json              保存资源根位置，保证迁移后下次仍能定位

用户选择的运行资源目录（默认 Electron userData）
├─ model-secrets.json         Electron safeStorage 密文，不含可读 Key
├─ harness-data/              DSH_HOME
├─ backups/                   更新前备份
├─ runtime/versions/<version> 在线安装的新 Harness
├─ runtime/modules/
│  ├─ node-runtime/<version>  不可变 Node 模块
│  ├─ harness-core/<version>  不可变 Harness 模块
│  ├─ package-manager/<ver>   首次使用插件时才安装
│  └─ state.json              active / previous 原子指针
├─ skins/                     皮肤缓存与活动配置
├─ pets/                      宠物缓存、自定义资源与活动配置
└─ logs/

安装目录
├─ Electron
├─ node_modules/node/bin      目标平台 Node.js 24
├─ node_modules/pnpm          pnpm 11.22.0
└─ node_modules/@deepseek-ai/dsh  仅完整离线版
```

## 模块化联网发行

联网入口不再把所有环境重复塞进同一个 EXE。发布构建先生成 Electron UI 壳，再从同一份已验收的 Windows 目录拆出三个 tar.gz 运行模块：

| 模块 | 当前实测下载量 | 何时下载 |
| --- | ---: | --- |
| `node-runtime` 24.16.0 | 35.4 MB | 首次安装 Harness |
| `harness-core` 0.1.0-rc.6 | 41.5 MB | 首次安装 Harness |
| `package-manager` 11.22.0 | 6.6 MB | 首次安装皮肤插件或管理插件 |

这些数字是 2026-08-20 从正式 Windows 打包目录生成并经真实启动冒烟得到的制品大小，不是产品预算。后续 Harness 自己支持更细的依赖 profile 后，可以再把终端原生依赖和模型 SDK 拆为按需模块；在此之前不通过随意删除依赖换取表面体积。

签名目录 schema 2 对模块 ID、平台、架构、压缩格式、下载与解压大小、SHA-256、依赖关系、镜像主机、路径前缀和可执行探针做闭集校验。启动时只比较已经安装的模块；发现版本差异后先列出模块、旧/新版本与总下载量，用户确认后才下载。每个模块下载前会探测签名清单中的公开渠道，按清单优先级尝试可用渠道；下载中途失败会切换到下一渠道。当前大模块的实际公开渠道只有 GitHub Releases；OSS 仅托管小引导器与签名目录，Gitee 或 OSS 大模块在真实文件可匿名下载后才会加入，不能仅凭一个占位 URL 宣称可用。任务状态同时呈现各模块的渠道、阶段、真实字节以及按模块大小加权的总进度。支持断点续传，但跨镜像仍重新做完整摘要校验。压缩包只允许相对文件/目录，不允许绝对路径、`..`、符号链接或其他特殊条目。安装先进入 `.staging`，单模块探针通过后原子改名并更新 `state.json`；任一后续模块失败时按相反顺序恢复本轮已经切换的模块，整批成功后自动重启启动器。

Electron 完整离线版继续保留为百度网盘兜底。新的小型联网安装器只负责取得并校验 UI 壳；UI 壳再按签名清单安装环境模块。这样启动器界面更新、Harness 更新和 pnpm 更新彼此独立，用户也不必为一个文案或新闻模块变化重新下载一百多 MB。签名清单还携带经过严格字段校验的模型提供方模板；新增模型 ID、说明或官方端点时只需更新并重签小目录，启动器壳不变。已经由用户保存的连接不会被远程目录静默覆盖。

## 启动流程

1. 主进程读取固定配置，恢复用户选择的运行资源根目录。
2. 首次使用先确认资源目录；用户选择新位置时写入临时目录，复制受管资源并完成切换，旧位置作为安全副本保留。
3. 资源位置确认后才开始在线运行模块准备，并定位内置或已更新的 Harness。
4. 环境检查验证 Node、pnpm 和 `@deepseek-ai/dsh/lib/bin.js`。
5. 用户选择工作区，端口默认为 `3080`。
6. 启动器设置独立 `DSH_HOME`，从工作区执行 `node <dsh-bin> web --port <port>`。
7. 主进程同时读取 stdout/stderr 并轮询本地 HTTP。
8. 服务返回成功后状态切到“运行中”，根据设置打开系统浏览器。
9. 停止时终止完整进程树，界面保留诊断日志。

## Harness 更新

完整离线版的内置版本始终是离线兜底。在线轻量版启动后检查源站并自动使用 pnpm 安装进 `runtime/versions/<version>`；健康检测已经判定不可用的 npmmirror 会被跳过，包下载失败时按 npmmirror、npm 官方源的顺序回退。成功后才原子写入活动版本配置。旧目录不覆盖，因此回滚只需要切换活动版本。

DeepSeek Harness 当前处于预发行阶段，没有旧磁盘格式兼容承诺。启动器在切换版本前复制 `harness-data/` 到 `backups/<timestamp>`；正式发布还应补充备份数量回收和备份恢复界面。

## 多源与签名

源列表有四个逻辑角色：

- GitHub：源码和内容寻址大模块的当前主分发；Gitee 仓库有真实公开制品后再作为国内模块镜像；
- OSS：不到 1 MB 的联网引导器和 schema-2 签名清单，不承担大模块与完整离线包日常分发；
- npmmirror/npm 官方源：Harness npm 发布包和插件依赖。

远程 `release-v2/launcher-manifest.json` 包含 `payload` 与 Ed25519 `signature`。它使用独立的 `runtime-production-v2-1` 公钥，与旧皮肤/宠物信任根隔离；主进程还会拒绝错误 keyId。任何字段被修改都会验签失败，任何模块还必须同时匹配签名清单中的固定字节数和 SHA-256。

npm 最新版本查询可在没有发布清单时工作，但它只新增可安装 Harness 版本，不会更新插件目录、模型目录或启动器整合包 URL。

## AI 工具与模型路由

插件按钮调用 Harness 官方 profile 管理命令，而不是启动器自己改 `cordis.patch.yml`：

```text
dsh plugin --profile web add <package>
dsh plugin --profile web update <package>
dsh plugin --profile web remove <package>
```

能力中心把提示词、Skill、工作流、知识库、AI 工具和智能体拆为独立入口。公开条目先进入本机安装列表；只有 Skill 会在用户再次确认后写入 `$DSH_HOME/skills/<safe-id>/SKILL.md`，启动器重写可信 frontmatter 并默认 `disable-model-invocation: true`。提示词、工作流、知识库和其他资料写入 `$DSH_HOME/library/ailishishu/<safe-id>`，不会下载或执行仓库代码。真正的 Harness 插件仍只通过官方 profile 管理命令安装。

模型页不是权重下载器。`launcher.json` 只保存提供方、Base URL、模型 ID 和活动选择；API Key 经 Electron `safeStorage` 加密后单独写入 `model-secrets.json`。启动器合并写入 `$DSH_HOME/settings.yaml` 时只写 `apiKeyEnv` 引用，并保留不属于启动器的既有设置和手工提供方。启动 Harness 时，主进程在内存中解密 Key 并只注入子进程环境。

DeepSeek 官方连接默认提供 Flash / Pro 两个选择。国内目录预置通义千问/百炼、豆包/火山方舟、Kimi、智谱、百度千帆、腾讯 TokenHub、MiniMax、阶跃星辰、硅基流动和百川；海外目录提供 OpenAI、Anthropic、Gemini，自定义区可接任意兼容网关。未添加平台只在“添加模型”弹窗中分页出现，选择平台后进入独立参数弹窗；模板只保存经过官方文档核对的基础地址，不代表账号已有权限。用户填写账号实际可用的模型 ID 并保存成功后，连接才加入主页面和全局模型切换器。

用量统计只读取 `$DSH_HOME/sessions/**/*.jsonl` 中持久化的 `assistant/message` 事件，按 `message.source.provider/model` 聚合 `inputTokens`、`outputTokens` 和缓存 Token。启动器不根据 Token 估算金额；服务商余额、优惠和账单通过官方页面查看。

多模态实测由 Renderer 读取一张不超过 10 MiB 的 JPG、PNG、WebP 或 GIF，并通过受限 IPC 交给主进程。主进程从 `safeStorage` 解密所选连接的 Key，按 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 或 Google `generateContent` 协议构造一次请求；请求 45 秒超时、不跟随重定向、响应上限 2 MiB且不自动重试。图片、提示词和回答都不写入日志或磁盘，Renderer 只收到文字结果、状态、耗时和服务商返回的 Token 字段。

## 公开发现目录

主进程以受限超时并行读取 AI历史书公开新闻、游戏、提示词、Skill、工作流、知识库、工具、智能体和职业 JSON API。Renderer 只收到经过字段白名单和 HTTPS URL 校验的数据；断网或接口失败会明确显示在线目录状态，不影响 Harness 本地启动。新闻摘要、影响对象和行动建议由原生弹窗展示，原始来源只用于查证。收藏不写入本地启动器配置：登录后由主进程持有短期 Bearer，调用 AI历史书统一收藏和评论接口；退出、登录过期或账号切换时立即清除当前账号视图，评论写操作必须登录。

新闻和公开资源的详情在启动器内阅读；只有新闻原始来源、工具官网、长课程以及真正开始游戏时才打开受控外部目标。账号登录使用受信 BrowserWindow 与 Chromium HttpOnly 会话，启动器不接收或保存网站明文密码。

## 皮肤商店

皮肤目录托管在公开 Gitee 仓库，访问 raw 文件不需要用户登录。目录固定每页 20 项；启动器只在进入商店时同步签名清单，在当前页懒加载缩略图，并在用户点击应用时下载原媒体。缓存文件以 SHA-256 命名，命中且长度、摘要都一致时直接复用。

目录使用独立 Ed25519 公钥验证。清单只接受图片、动画图片、视频、作者与许可证信息以及受限的焦点、遮罩、模糊和表面透明度；不接受远程 CSS、JavaScript 或其他可执行内容。图片限制 25 MiB，视频限制 80 MiB，下载后再次核对字节数、MIME 和 SHA-256。

启动器首次启动 Harness 前，通过官方 `dsh plugin --profile web add` 安装随包提供的 `@deepblue/dsh-skin-runtime` 本地 tarball。插件 Host 端只读取启动器写入的活动皮肤配置，并在环回 Web 服务上提供固定的 config/media/poster 路由；配置响应会按缓存文件名为媒体 URL 增加内容版本参数，因此浏览器可长期缓存素材，同时在切换皮肤后立即取得新内容。浏览器端通过 `theme` 服务叠加半透明语义色，并注册到 `shell.overlay`。本机文件路径不会返回给浏览器。视频使用 muted/loop/playsInline，页面隐藏时暂停；系统要求减少动态效果时禁用视频和图片漂移动画。

## 宠物商店

宠物目录同样位于无需登录的公开 Gitee 仓库，固定每页 20 项并使用独立 Ed25519 公钥验证。目录只声明 PNG、JPG、WebP 或 GIF 媒体、SHA-256、许可证、显示宽度、三种待机动作、三种点击动作和短对话；原媒体限制 12 MiB，不允许远程脚本或样式。

用户点击应用后启动器才下载媒体并写入活动宠物配置。`@deepblue/dsh-skin-runtime` Host 端通过固定环回路由提供唯一活动媒体，并按当前缓存文件名输出内容版本参数，避免浏览器复用上一只宠物的 immutable 缓存；浏览器端将宠物挂载到 `document.body`，支持指针拖动、点击气泡、位置本地存储、移动端尺寸限制与减少动态效果。用户导入的图片复制到启动器用户数据目录并生成本地缩略图，不上传到商店或其他服务。

## 跨平台打包

依赖 `node@24.16.0` 会在 npm install 时取得当前平台/架构的可执行文件。因此发行包必须在目标系统构建，不能在 Windows 上假装产出可运行的 macOS 离线包。建议 CI matrix：

- Windows 11 x64 → 标准 NSIS 一键安装 EXE；
- macOS 14 arm64 → DMG/ZIP；
- macOS 14 x64 → DMG/ZIP。

Windows 安装 EXE 是稳定的用户入口；应用运行时、Harness 用户数据与下载缓存彼此分离。
