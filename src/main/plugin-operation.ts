import type { PluginOperationState } from '../shared/types'

const ANSI_PATTERN = /\x1b(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g
const SECRET_PATTERN = /\b(?:sk|ak)-[a-z0-9_-]{8,}\b/gi
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi

export function cleanPluginOutput(value: string): string[] {
  return value
    .replace(ANSI_PATTERN, '')
    .split(/[\r\n]+/)
    .map((line) => line.trim().replace(SECRET_PATTERN, (secret) => `${secret.slice(0, 3)}***`).replace(URL_CREDENTIAL_PATTERN, '$1***@'))
    .filter(Boolean)
}

function boundedProgress(current: number, next: number, ceiling = 96): number {
  return Math.min(ceiling, Math.max(current, next))
}

export function updatePluginProgress(current: PluginOperationState, line: string): PluginOperationState {
  const lower = line.toLowerCase()
  const progress = lower.match(/progress:\s*resolved\s+(\d+),\s*reused\s+(\d+),\s*downloaded\s+(\d+),\s*added\s+(\d+)/i)
  let status = current.status
  let nextProgress = current.progress
  let message = current.message

  if (progress) {
    const resolved = Number(progress[1] || 0)
    const downloaded = Number(progress[3] || 0)
    const added = Number(progress[4] || 0)
    if (added > 0) {
      status = 'installing'
      nextProgress = boundedProgress(current.progress, 72 + Math.min(20, added * 2))
      message = `正在写入插件组件（已添加 ${added} 项）`
    } else if (downloaded > 0) {
      status = 'downloading'
      const ratio = resolved > 0 ? downloaded / resolved : 0
      nextProgress = boundedProgress(current.progress, 35 + Math.round(Math.min(1, ratio) * 35), 78)
      message = `正在下载依赖（${downloaded} / ${Math.max(resolved, downloaded)}）`
    } else {
      status = 'resolving'
      nextProgress = boundedProgress(current.progress, 18 + Math.min(18, Math.round(resolved / 3)), 38)
      message = `正在解析依赖（${resolved} 项）`
    }
  } else if (/download|fetch|tarball|registry/.test(lower)) {
    status = 'downloading'
    nextProgress = boundedProgress(current.progress, current.progress + 3, 78)
    message = '正在下载插件与依赖'
  } else if (/postinstall|preinstall|build|link|added|dependencies:|packages:/.test(lower)) {
    status = 'installing'
    nextProgress = boundedProgress(current.progress, Math.max(72, current.progress + 3), 96)
    message = '正在写入并校验插件文件'
  } else if (/resolv|lockfile|workspace/.test(lower)) {
    status = 'resolving'
    nextProgress = boundedProgress(current.progress, current.progress + 2, 40)
    message = '正在解析插件依赖'
  } else {
    nextProgress = boundedProgress(current.progress, current.progress + 1, status === 'installing' ? 96 : 82)
  }

  const files = [...current.files]
  if (files.at(-1) !== line) files.push(line)
  if (files.length > 120) files.splice(0, files.length - 120)
  return { ...current, status, progress: nextProgress, message, currentFile: line, files }
}

export function pluginActionLabel(action: 'install' | 'update' | 'remove'): string {
  return action === 'remove' ? '卸载' : action === 'update' ? '更新' : '安装'
}
