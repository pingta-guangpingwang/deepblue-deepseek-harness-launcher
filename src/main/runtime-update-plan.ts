import type { RuntimeModuleId, RuntimeModuleRelease, RuntimeModuleUpdateItem } from '../shared/types'

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
