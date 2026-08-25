import type { RuntimeModuleId, RuntimeModuleRelease, RuntimeModuleUpdateItem, RuntimeModuleUpdateStatusItem } from '../shared/types'

export const RUNTIME_MODULE_LABELS: Record<RuntimeModuleId, string> = {
  'node-runtime': 'Node.js 运行环境',
  'harness-core': 'DeepSeek Harness 核心',
  'package-manager': 'pnpm 插件环境',
  'terminal-native': '终端原生组件',
  'launcher-ui': '启动器 UI 壳'
}

export function runtimeModulePlan(
  target: RuntimeModuleRelease,
  catalog: RuntimeModuleRelease[],
  platform: string,
  arch: string
): Array<{ release: RuntimeModuleRelease; bytes: number }> {
  const plan: Array<{ release: RuntimeModuleRelease; bytes: number }> = []
  const visited = new Set<string>()
  const visit = (release: RuntimeModuleRelease): void => {
    if (visited.has(release.id)) return
    visited.add(release.id)
    for (const dependencyId of release.dependencies) {
      const dependency = catalog.find((candidate) => candidate.id === dependencyId)
      if (dependency) visit(dependency)
    }
    const artifact = release.artifacts.find((candidate) => candidate.platform === platform && candidate.arch === arch)
    if (artifact) plan.push({ release, bytes: artifact.size })
  }
  visit(target)
  return plan
}

/**
 * Compares the trusted signed catalog with active local modules. Missing optional
 * modules stay on-demand. The Electron kernel remains on its separate bootstrap
 * path, while the renderer-only launcher-ui module is installed atomically and
 * becomes active by reloading the existing BrowserWindow without relaunching
 * Electron or stopping Harness.
 */
export function planRuntimeModuleUpdates(
  catalog: RuntimeModuleRelease[],
  currentVersions: Partial<Record<RuntimeModuleId, string>>,
  platform: string,
  arch: string
): RuntimeModuleUpdateItem[] {
  return catalog.flatMap((release) => {
    const currentVersion = currentVersions[release.id]
    if (!currentVersion || currentVersion === release.version) return []
    const artifact = release.artifacts.find((candidate) => candidate.platform === platform && candidate.arch === arch)
    if (!artifact) return []
    return [{
      id: release.id,
      label: RUNTIME_MODULE_LABELS[release.id],
      currentVersion,
      nextVersion: release.version,
      size: artifact.size,
      required: release.required
    }]
  })
}

export function describeRuntimeModuleUpdates(
  catalog: RuntimeModuleRelease[],
  currentVersions: Partial<Record<RuntimeModuleId, string>>,
  platform: string,
  arch: string
): RuntimeModuleUpdateStatusItem[] {
  return catalog.map((release) => {
    const currentVersion = currentVersions[release.id]
    const artifact = release.artifacts.find((candidate) => candidate.platform === platform && candidate.arch === arch)
    if (!currentVersion) {
      return {
        id: release.id,
        label: RUNTIME_MODULE_LABELS[release.id],
        nextVersion: release.version,
        size: artifact?.size,
        required: release.required,
        disposition: release.required ? 'manual' : 'on-demand',
        message: release.required ? '本机未检测到该必需模块，请执行快速修复' : '未安装，使用相关功能时再按需获取'
      }
    }
    if (currentVersion === release.version) {
      return {
        id: release.id,
        label: RUNTIME_MODULE_LABELS[release.id],
        currentVersion,
        nextVersion: release.version,
        size: artifact?.size,
        required: release.required,
        disposition: 'current',
        message: '已是签名目录中的最新版本'
      }
    }
    return {
      id: release.id,
      label: RUNTIME_MODULE_LABELS[release.id],
      currentVersion,
      nextVersion: release.version,
      size: artifact?.size,
      required: release.required,
      disposition: artifact ? 'automatic' : 'manual',
      message: artifact ? '可由启动器独立下载并热更新' : '签名目录没有适用于当前系统的模块包'
    }
  })
}
