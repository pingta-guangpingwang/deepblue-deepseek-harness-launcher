import type { LauncherSnapshot, PageId } from '../../shared/types'

const ANALYTICS_ENDPOINT = 'https://ailishishu.com/ailishishu-stats/api/launcher-analytics.php'

type LauncherAnalyticsEvent = 'session_started' | 'module_open' | 'feature_click'

export interface LauncherFeature {
  id: string
  label: string
}

const featurePatterns: Array<{ pattern: RegExp; feature: LauncherFeature }> = [
  { pattern: /检查更新|重新检测更新|检测更新/, feature: { id: 'check_updates', label: '检查更新' } },
  { pattern: /安装全部更新|开始更新|立即更新/, feature: { id: 'apply_updates', label: '安装模块更新' } },
  { pattern: /启动 Harness|一键启动|启动服务/, feature: { id: 'start_harness', label: '启动 Harness' } },
  { pattern: /停止 Harness|停止服务/, feature: { id: 'stop_harness', label: '停止 Harness' } },
  { pattern: /快速修复|自动修复|修复环境/, feature: { id: 'repair_environment', label: '修复运行环境' } },
  { pattern: /刷新环境|重新检测环境/, feature: { id: 'refresh_environment', label: '刷新环境检测' } },
  { pattern: /选择.*工作区|更换.*工作区|打开工作区/, feature: { id: 'choose_workspace', label: '选择工作区' } },
  { pattern: /选择.*安装位置|更换.*安装位置|存放位置/, feature: { id: 'choose_storage', label: '选择安装位置' } },
  { pattern: /创建.*快捷方式|修复.*快捷方式/, feature: { id: 'create_shortcuts', label: '创建快捷方式' } },
  { pattern: /保存设置/, feature: { id: 'save_settings', label: '保存设置' } },
  { pattern: /端口设置|修改端口/, feature: { id: 'open_port_settings', label: '修改 Harness 端口' } },
  { pattern: /登录 AI历史书|立即登录|登录后/, feature: { id: 'account_login', label: '登录 AI历史书' } },
  { pattern: /退出 AI历史书|退出登录/, feature: { id: 'account_logout', label: '退出登录' } },
  { pattern: /刷新目录|重新同步|同步.*目录|刷新新闻|刷新游戏|刷新职业|刷新皮肤|刷新宠物/, feature: { id: 'refresh_catalog', label: '刷新在线目录' } },
  { pattern: /取消收藏/, feature: { id: 'favorite_remove', label: '取消收藏' } },
  { pattern: /收藏/, feature: { id: 'favorite_add', label: '收藏' } },
  { pattern: /加入安装列表|加入列表|稍后安装/, feature: { id: 'queue_resource', label: '加入安装列表' } },
  { pattern: /复制.*地址|复制.*提示词|复制.*内容|复制/, feature: { id: 'copy_content', label: '复制内容' } },
  { pattern: /试玩|开始游戏|进入游戏/, feature: { id: 'play_game', label: '启动游戏试玩' } },
  { pattern: /查看.*详情|阅读详情|阅读全文/, feature: { id: 'view_detail', label: '查看内容详情' } },
  { pattern: /完整课程|浏览器学习/, feature: { id: 'open_course', label: '打开完整课程' } },
  { pattern: /测试多模态|识图测试|测试连接/, feature: { id: 'test_model', label: '测试模型连接' } },
  { pattern: /查询余额|刷新用量|查看用量/, feature: { id: 'refresh_model_usage', label: '查看模型用量' } },
  { pattern: /添加模型|添加平台|连接模型/, feature: { id: 'add_model', label: '添加模型连接' } },
  { pattern: /设为当前|切换模型|使用此模型/, feature: { id: 'activate_model', label: '切换当前模型' } },
  { pattern: /保存模型|保存连接/, feature: { id: 'save_model', label: '保存模型连接' } },
  { pattern: /移除模型|删除连接/, feature: { id: 'remove_model', label: '移除模型连接' } },
  { pattern: /应用到.*桌面/, feature: { id: 'apply_desktop', label: '应用到电脑桌面' } },
  { pattern: /应用到.*Harness|应用皮肤|应用宠物/, feature: { id: 'apply_harness', label: '应用到 Harness' } },
  { pattern: /停止动态桌面|停止桌面宠物/, feature: { id: 'stop_desktop', label: '停止桌面外观' } },
  { pattern: /高清预览|预览/, feature: { id: 'preview_asset', label: '预览商店资源' } },
  { pattern: /下载/, feature: { id: 'download_asset', label: '下载资源' } },
  { pattern: /删除|移除/, feature: { id: 'remove_item', label: '移除内容' } },
  { pattern: /导入宠物|导入/, feature: { id: 'import_pet', label: '导入宠物' } },
  { pattern: /安装插件|安装 Skill|安装资源|^安装$|安装到/, feature: { id: 'install_item', label: '安装内容' } },
  { pattern: /卸载插件|卸载/, feature: { id: 'uninstall_item', label: '卸载内容' } },
  { pattern: /重启 Harness|立即重启/, feature: { id: 'restart_harness', label: '重启 Harness' } },
  { pattern: /回滚/, feature: { id: 'rollback_version', label: '回滚 Harness 版本' } }
]

let sessionId = ''
let sessionStarted = false
let lastOpenedModule = ''

function getSessionId(): string {
  if (sessionId) return sessionId
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    sessionId = crypto.randomUUID().replace(/-/g, '')
  } else {
    sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  }
  return sessionId
}

export function classifyLauncherFeature(rawLabel: string): LauncherFeature | undefined {
  const label = rawLabel.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!label || /^\d+$/.test(label)) return undefined
  return featurePatterns.find((entry) => entry.pattern.test(label))?.feature
}

export function trackLauncherAnalytics(
  event: LauncherAnalyticsEvent,
  module: PageId,
  snapshot: LauncherSnapshot,
  feature?: LauncherFeature
): void {
  if (event === 'session_started') {
    if (sessionStarted) return
    sessionStarted = true
  }
  if (event === 'module_open') {
    if (lastOpenedModule === module) return
    lastOpenedModule = module
  }
  const payload = JSON.stringify({
    event,
    module,
    feature: feature?.id,
    featureLabel: feature?.label,
    launcherVersion: snapshot.launcherVersion,
    uiVersion: snapshot.launcherUiVersion || 'bundled',
    distribution: snapshot.distributionMode,
    session: getSessionId()
  })

  try {
    const body = new Blob([payload], { type: 'text/plain;charset=UTF-8' })
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ANALYTICS_ENDPOINT, body)) return
  } catch {
    // Fall through to fetch; analytics must never interrupt a launcher action.
  }
  void fetch(ANALYTICS_ENDPOINT, {
    method: 'POST',
    mode: 'cors',
    credentials: 'omit',
    keepalive: true,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: payload
  }).catch(() => undefined)
}
