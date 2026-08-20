import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { modelProviderTemplates } from '../src/shared/model-provider-catalog.ts'

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
payload.launcher = {
  version: packageJson.version,
  notes: [
    '修复签名目录对象临时不可读时首次安装报“未提供插件包管理器”；UI 壳现内置严格校验过的运行模块目录并继续从内容寻址的 GitHub 制品安装',
    '修复 0.10.4 在线壳遗漏主进程运行依赖导致启动时报 ERR_MODULE_NOT_FOUND；0.10.5 会按构建产物自动发现并打齐依赖闭包',
    '首次启动先确认运行资源位置，再开始拉取 Node、Harness 与按需模块；程序安装位置和大型运行资源可以分别放在不同磁盘',
    '设置页新增运行资源安全迁移、目录打开和桌面/开始菜单快捷方式检测修复；迁移成功后保留原位置作为安全副本',
    'Windows 完整安装器改为引导安装，可选择程序目录；在线轻量引导器继续提供目录选择并只下载启动器 UI 壳',
    '环境加载页新增 Node 与 Harness 分模块进度、真实下载字节和总加载进度，校验、解压与启用阶段不再混成一条进度',
    '每个签名模块下载前检测 GitHub 与 OSS 两条真实渠道；GitHub 不可用、下载失败或校验失败时自动切换 OSS 应急镜像',
    '在线安装器缩小为不到 1 MB：优先从 GitHub 获取界面壳，失败时自动改走 OSS；Node、Harness 与包管理器同样按功能分模块安装',
    '所有模块均校验固定字节数与 SHA-256，并通过 staging 原子切换；失败会保留或恢复上一版本',
    '完整离线包改由百度网盘兜底，不再让普通用户每次从 OSS 下载 150 MB 整包',
    '启动器与 Harness 网页共用可写凭据文件：任一端修改 DeepSeek 密钥后，另一端会实时同步显示',
    '启动器切换 DeepSeek Flash/Pro 会更新 Harness 全局默认模型，网页修改提供商配置也会同步回启动器',
    'AI 新闻详情与 AI历史书网页使用同一条完整新闻接口，直接呈现摘要、公开来源正文和来源链接',
    '新闻列表与详情删除通用的“为什么值得看、对谁有影响、现在可以做什么”模板，避免两端内容不一致',
    '提示词、Skill、工作流、知识库、AI 工具与智能体卡片改为单击打开启动器原生详情',
    '已知模型平台改为勾选 2026-08-18 核对的官方模型目录，不再要求手填名称、接口地址和模型 ID',
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
