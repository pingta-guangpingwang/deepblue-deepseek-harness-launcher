import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { modelProviderTemplates } from '../src/shared/model-provider-catalog.ts'
import { bundledVersions } from '../src/main/catalog.ts'

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
payload.launcher = {
  version: packageJson.version,
  notes: [
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
