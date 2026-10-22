import { describe, expect, it } from 'vitest'
import { automaticHotUpdateKey, chooseKernelInstaller } from './automatic-updates'
import type { RuntimeModuleUpdateItem, SignedCatalogPayload } from '../shared/types'

const ui = { id: 'launcher-ui', nextVersion: 'ui-0123456789abcdef' } as RuntimeModuleUpdateItem
const idle = { verifiedCatalog: true, setupRequired: false, kernelPending: false, busy: false, dependenciesCurrent: true }

describe('automatic update policy', () => {
  it('automatically applies content-addressed hot modules only when the app is idle and catalog verified', () => {
    expect(automaticHotUpdateKey([ui], idle)).toBe('launcher-ui:ui-0123456789abcdef')
    for (const field of ['setupRequired', 'kernelPending', 'busy'] as const) expect(automaticHotUpdateKey([ui], { ...idle, [field]: true })).toBeUndefined()
    expect(automaticHotUpdateKey([ui], { ...idle, verifiedCatalog: false })).toBeUndefined()
    expect(automaticHotUpdateKey([ui], { ...idle, dependenciesCurrent: false })).toBeUndefined()
    expect(automaticHotUpdateKey([], idle)).toBeUndefined()
  })
  it('does not automatically stop a core runtime or treat a hash version as semver', () => {
    for (const id of ['harness-core', 'node-runtime', 'terminal-native']) expect(automaticHotUpdateKey([{ ...ui, id } as RuntimeModuleUpdateItem], idle)).toBeUndefined()
    expect(automaticHotUpdateKey([{ ...ui, nextVersion: 'ui-ffffffffffffffff' }], idle)).not.toBe(automaticHotUpdateKey([ui], idle))
  })
  it('downloads the complete signed installer for in-app upgrades while retaining old single-installer catalogs', () => {
    const online = { platform: 'win32', arch: 'x64', distribution: 'online', url: 'https://trusted/online.exe' }, offline = { ...online, distribution: 'offline', url: 'https://trusted/offline.exe' }
    const artifacts = [online, offline] as NonNullable<SignedCatalogPayload['launcher']>['artifacts']
    expect(chooseKernelInstaller(artifacts, 'win32', 'x64', 'online')).toBe(offline)
    expect(chooseKernelInstaller([artifacts[0]!], 'win32', 'x64', 'online')).toBe(online)
    expect(chooseKernelInstaller(artifacts, 'darwin', 'arm64', 'online')).toBeUndefined()
  })
})
