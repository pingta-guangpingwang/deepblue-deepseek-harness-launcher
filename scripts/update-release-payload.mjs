import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { modelProviderTemplates } from '../src/shared/model-provider-catalog.ts'
import { bundledPlugins, bundledVersions } from '../src/main/catalog.ts'

const root = path.resolve(import.meta.dirname, '..')
const release = path.join(root, 'release')
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const payloadPath = path.join(release, 'launcher-catalog-payload.json')
const payload = JSON.parse(await readFile(payloadPath, 'utf8'))
const runtimeModules = JSON.parse(await readFile(path.join(release, 'runtime-modules.generated.json'), 'utf8'))
const stableDownloadBaseUrl = 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/download'
const bootstrapPath = path.join(release, 'deepblue-deepseek-harness-launcher-win-x64-online-bootstrap.exe')
const bootstrapBytes = await readFile(bootstrapPath)
const bootstrapSize = (await stat(bootstrapPath)).size
const bootstrapSha256 = createHash('sha256').update(bootstrapBytes).digest('hex')

payload.schemaVersion = 2
payload.generatedAt = new Date().toISOString()
payload.runtimeModules = runtimeModules.modules
payload.modelTemplates = modelProviderTemplates
payload.harness = bundledVersions.map((entry) => ({
  ...entry,
  installed: false,
  active: false
}))
payload.plugins = bundledPlugins.map(plugin => ({ ...plugin, installed: false, updateAvailable: false }))
payload.launcher = {
  version: packageJson.version,
  notes: [
    '0.10.25 修复基础内核更新只下载不安装：校验完成后自动静默安装到现有目录、更新快捷方式并重启新内核，用户不再需要去下载文件夹手动运行安装器',
    'Live2D 发布门禁改为连续采样真实 Canvas 帧；待机必须产生至少 3 个不同画面，点击动作还必须出现新的可见帧，单纯存在 Canvas 或状态字段不再算通过',
    '0.10.24 修复宠物运行链路：像素精灵待机只循环非透明有效帧，点击、悬停和拖动会切换到对应动作行，不再因空帧出现闪烁',
    'Live2D 商店改为下载并逐文件校验完整模型包，使用 ESM 运行库直接播放待机动作；点击角色会优先触发触摸、轻点或致谢动作，不再把纹理图当宠物显示',
    'Harness 的“清透壁纸 / 恢复蒙版”按钮改为全局 Portal，空白首页与会话页右上角始终可见，不再被壁纸负层级遮住',
    '0.10.23 建立长期稳定基础内核：网页永久下载入口只在 Electron、安全边界或 IPC 协议必须升级时才替换，普通页面与交互不再发布 80 MB 整壳',
    '启动器界面拆成约 0.2 MB 的 launcher-ui 内容寻址模块；检查更新只列出变化模块，按 Gitee、OSS、GitHub 下载校验后在当前窗口原子切换，无需退出 Harness',
    '修复“检查更新点击后无反馈”：按钮显示检查中，完成后显示最新状态、检查时间或签名目录错误；模块更新呈现逐项和总进度、渠道、失败原因与回滚结果',
    'Node、Harness、包管理器和 launcher-ui 各自独立版本；只有 Node/Harness 等底层更新需要安全重启，纯 UI 与包管理器更新可直接热启用',
    '宠物商店新增“应用到电脑桌面”：静态图、GIF、动态 WebP 与像素精灵表都可作为可点击、可拖动的 Windows 桌面伙伴，状态会持久化并可从卡片、预览或托盘停止',
    '宠物卡片同步显示 Harness 与电脑桌面的使用状态；删除正在使用的资源会先安全停止对应桌面宠物，Live2D 完整模型在下载、预览和应用前逐文件校验',
    'Harness 端口支持在首页直接进入设置手动修改；保存前检查 1024—65535 范围与端口占用，运行中修改会有序停止并按新端口自动重启',
    '新增 DSH 开源生态页，参考 dsh-web-ui 与 DSH Desktop，通过 Harness 原生 web profile 机制按需安装任务看板、会话恢复、Skill 管理、Git 图谱、视觉工具等能力',
    '远程配对、SSH 与开发右侧面板按网络/系统权限明确分级，不默认安装，也不把第三方桌面壳和状态管理复制进启动器',
    '宠物商店新增两个固定 Gitee 签名源：800 只像素精灵与 230 个 Live2D 模型包；与原创动图仓合并后共 1080 项，任一目录失败不会拖垮其余来源',
    '宠物商店同步皮肤商店的全部、正在使用、我的收藏视图，并提供来源筛选、数字分页、预览、下载/删除、卡片内进度与失败原因',
    '像素精灵表会按 8 列及 9/11 行结构逐帧播放，应用到 Harness 后仍可点击互动、拖动和记忆位置；Live2D 使用完整签名模型清单和本地校验缓存播放',
    'Gitee 运行资源迁移到视频资源仓的独立 runtime-assets 分支，与皮肤目录和视频素材分支隔离；国内首选下载线路不变，同时避开旧运行仓容量上限',
    '动态桌面正式支持 GIF、动态 WebP、MP4 与 WebM：直接播放签名目录中的原媒体，不再把动图降级成首帧、把视频降级成封面',
    '新增 Windows 10/11 桌面图标后方的常驻渲染层，多显示器分别铺满；关闭主窗口后由托盘继续播放，可在皮肤卡片、高清预览或托盘一键停止',
    '动态桌面选择会安全保存在本机，下次启动自动恢复；退出启动器时停止渲染并保留底层 Windows 静态壁纸，静态高清图仍走系统原生壁纸接口',
    '发布门禁新增真实桌面连续帧验收：GIF 与视频两次截图必须出现可见像素变化，且主窗口关闭后视频仍须继续播放，否则阻断发布',
    '修复 Windows 图片壁纸“提示成功但桌面未变化”：改为直接调用 SystemParametersInfoW 系统接口，只有系统确认应用成功才返回成功；发布门禁会截图对比真实桌面，像素无明显变化即阻断发布',
    '电脑桌面操作只下载实际需要的原图、GIF 或视频文件，缓存后可直接预览、应用和停止，不重复下载',
    '兼容 Gitee 在原始 JPG 链接下返回 WebP 实际字节的情况，设置桌面时会识别真实文件头再解码，不再因扩展名与压缩格式不同失败',
    '修复启动 Harness 时偶发打开两个浏览器页面：同一启动请求会被合并，Launcher 覆盖层强制关闭 Harness 内置浏览器交接，并以启动周期令牌保证系统浏览器最多自动打开一次',
    '修复公网全新安装首次创建 Web profile 时漏掉 Harness 默认 dsh-base 与 dsh-web-app，导致外观插件等待 webServer、Harness 启动退出的问题；0.10.15 已纳入无缓存全新安装发布门禁',
    '皮肤卡片保留“应用到 Harness”和“应用到电脑桌面”双入口，并同步显示 Harness 当前皮肤、电脑桌面皮肤与动态播放状态',
    'Harness 全局右上角提供“清透壁纸 / 恢复蒙版”快捷切换；清透状态移除壁纸蒙版并把内容表面降至轻透明，选择会在本机持久保存',
    '外观插件升级到 0.7.0，新增像素精灵表运行时，并继续修复旧 web profile 的 pnpm 缓存目录不一致与失效安装包路径，旧用户可自动完成插件热升级',
    'Harness Web 统一由启动器控制是否打开浏览器，后台启动命令不再重复弹出默认浏览器窗口',
    '兼容 Gitee 原始文件服务的官方 raw.giteeusercontent.com 跳转，0.10.13 模块分片会真正走 Gitee 首选线路并继续执行逐片摘要校验',
    'Gitee 的 0.10.13 UI 壳与运行模块改为 5 MB 内容寻址分片；每片及整包均按签名目录校验，可在免费仓库限制下稳定匿名下载',
    '皮肤商店新增“全部商店、正在使用、我的收藏”三个视图；收藏保存在本机用户数据中，重启后仍可直接查看、切换或取消收藏',
    '皮肤卡片新增一键收藏入口，当前使用状态与 Harness 实际皮肤配置同步，恢复默认后会立即更新皮肤库状态',
    'Gitee 皮肤目录按媒体与缩略图 SHA-256 去重，删除无有效标题的旧素材和重复异色变体，由 837 项精炼为 680 项',
    '本期原创与新动态精品优先排序，商店首屏不再被 p0、background、live 等低信息旧条目占用',
    'DeepSeek Harness 核心同步至官方 dsh-v0.1.1-rc.2，完整接入 DeepSeek V4 Flash Vision Exp 图片输入、Files API 上传复用与内联回退管线',
    '模型目录新增 DeepSeek 官方视觉实验模型；旧版仅含 Flash/Pro 的配置会自动补齐视觉模型与图片能力参数，无需用户重新添加连接',
    '旧版签名模型目录不会再覆盖启动器内置的较新官方目录；远端独有平台与模型仍会合并保留',
    'DeepSeek 图片实测会关闭默认思考模式，把输出额度用于可见识图结果；其他 OpenAI 兼容平台保持原请求格式',
    '官方 rc.2 新增的运行时同伴依赖已完整纳入 Harness 核心模块，离线安装与热更新后均可直接启动',
    '多模态实测优先显示已由官方目录确认支持图片的模型，并继续保留对其他兼容模型的一次性真实测试',
    '皮肤商店只读取两个固定 Gitee 开源仓库：主仓承载高清图与 GIF，skins-video 分仓承载视频；680 款签名资源按需下载并逐项校验字节数与 SHA-256',
    '皮肤和宠物商店改为固定视口与自适应数字分页，窗口尺寸决定单页卡片数量，切换 1、2、3…页时不再反复上下滚动',
    '动图与视频皮肤、宠物在窗口隐藏或系统减少动态效果时自动停驻静态帧，恢复可见后继续播放，降低后台资源占用',
    '新闻、游戏、职业、AI 工具、Skill、工作流、知识库、智能体、皮肤和宠物页签每次切入都会主动刷新线上目录',
    '继续保留 Node、Harness、包管理器与启动器界面壳的拆分更新；只下载发生变化的签名模块，不重新下载整套程序',
    '运行模块和 UI 壳固定按 Gitee、OSS、GitHub 的顺序切换；Gitee 不可用或持续 15 秒无下载进度时立即走 OSS，GitHub 只作最终备用',
    '修复 Node 与 Harness 已完整安装后，按需插件包管理器仍被误判为核心缺失，导致“快速修复”错误停在 20%；安装并发结束后会重新核验真实运行环境',
    '修复签名目录对象临时不可读时首次安装报“未提供插件包管理器”；UI 壳现内置严格校验过的运行模块目录并继续从内容寻址的 GitHub 制品安装',
    '修复 0.10.4 在线壳遗漏主进程运行依赖导致启动时报 ERR_MODULE_NOT_FOUND；0.10.5 会按构建产物自动发现并打齐依赖闭包',
    '首次启动先确认运行资源位置，再开始拉取 Node、Harness 与按需模块；程序安装位置和大型运行资源可以分别放在不同磁盘',
    '设置页新增运行资源安全迁移、目录打开和桌面/开始菜单快捷方式检测修复；迁移成功后保留原位置作为安全副本',
    'Windows 完整安装器改为引导安装，可选择程序目录；在线轻量引导器继续提供目录选择并只下载启动器 UI 壳',
    '环境加载页新增 Node 与 Harness 分模块进度、真实下载字节和总加载进度，校验、解压与启用阶段不再混成一条进度',
    '每个签名模块按 Gitee、OSS、GitHub 顺序逐条检测；当前渠道不可用、持续无下载进度、下载失败或校验失败时自动切换下一条',
    '在线安装器保持不到 1 MB：优先从 Gitee 获取界面壳，失败或无进度时立即改走 OSS，最后才尝试 GitHub；Node、Harness 与包管理器同样按功能分模块安装',
    '所有模块均校验固定字节数与 SHA-256，并通过 staging 原子切换；失败会保留或恢复上一版本',
    '完整离线包改由百度网盘兜底，不再让普通用户每次从 OSS 下载 150 MB 整包',
    '启动器与 Harness 网页共用可写凭据文件：任一端修改 DeepSeek 密钥后，另一端会实时同步显示',
    '启动器切换 DeepSeek Flash/Pro 会更新 Harness 全局默认模型，网页修改提供商配置也会同步回启动器',
    'AI 新闻详情与 AI历史书网页使用同一条完整新闻接口，直接呈现摘要、公开来源正文和来源链接',
    '新闻列表与详情删除通用的“为什么值得看、对谁有影响、现在可以做什么”模板，避免两端内容不一致',
    '提示词、Skill、工作流、知识库、AI 工具与智能体卡片改为单击打开启动器原生详情',
    '已知模型平台改为勾选 2026-08-22 核对的官方模型目录，不再要求手填名称、接口地址和模型 ID',
    '继续保留国产与国际模型切换、多模态图片实测、Harness 会话用量和受控能力安装列表'
  ],
  artifacts: [{
    platform: 'win32',
    arch: 'x64',
    distribution: 'online',
    url: `${stableDownloadBaseUrl}/deepblue-deepseek-harness-launcher-win-x64-online.exe`,
    sha256: bootstrapSha256,
    size: bootstrapSize
  }]
}

await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(`Updated signed-catalog payload for launcher ${packageJson.version}.`)
