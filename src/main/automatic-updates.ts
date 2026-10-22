import type { DistributionMode, RuntimeModuleUpdateItem, SignedCatalogPayload } from '../shared/types'

export function automaticHotUpdateKey(items: RuntimeModuleUpdateItem[], state: {
  verifiedCatalog: boolean; setupRequired: boolean; kernelPending: boolean; busy: boolean; dependenciesCurrent: boolean
}): string | undefined {
  if (!items.length || !state.verifiedCatalog || state.setupRequired || state.kernelPending || state.busy || !state.dependenciesCurrent) return undefined
  if (items.some(item => !['launcher-ui', 'package-manager', 'agent-host'].includes(item.id))) return undefined
  return items.map(item => item.id + ':' + item.nextVersion).sort().join('|')
}

export function chooseKernelInstaller(artifacts: NonNullable<SignedCatalogPayload['launcher']>['artifacts'], platform: string, arch: string, distribution: DistributionMode) {
  const targets = artifacts.filter(artifact => artifact.platform === platform && artifact.arch === arch)
  return targets.find(artifact => artifact.distribution === 'offline') || targets.find(artifact => artifact.distribution === distribution) || targets.find(artifact => !artifact.distribution)
}
