import { describe, expect, it } from 'vitest'
import { planRuntimeModuleUpdates, runtimeModulePlan } from './runtime-update-plan'
import type { RuntimeModuleRelease } from '../shared/types'

function release(id: RuntimeModuleRelease['id'], version: string, dependencies: RuntimeModuleRelease['dependencies'] = []): RuntimeModuleRelease {
  return {
    id,
    version,
    dependencies,
    required: id !== 'terminal-native',
    installWhen: id === 'launcher-ui' ? 'launcher' : id === 'harness-core' ? 'harness' : 'bootstrap',
    artifacts: [{
      platform: 'win32', arch: 'x64', format: 'tar.gz', sha256: 'a'.repeat(64), size: id === 'harness-core' ? 48_000_000 : 6_000_000, unpackedSize: 80_000_000,
      mirrors: [{ id: 'github', url: `https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/runtime-v1/${id}.tar.gz` }]
    }]
  }
}

describe('signed runtime update planning', () => {
  const catalog = [
    release('node-runtime', '24.17.0'),
    release('harness-core', '0.1.0-rc.7', ['node-runtime']),
    release('terminal-native', '1.2.0'),
    release('launcher-ui', '0.10.4')
  ]

  it('lists only installed modules whose signed version changed', () => {
    const updates = planRuntimeModuleUpdates(catalog, {
      'node-runtime': '24.16.0',
      'harness-core': '0.1.0-rc.6',
      'launcher-ui': '0.10.3'
    }, 'win32', 'x64')
    expect(updates.map((item) => item.id)).toEqual(['node-runtime', 'harness-core'])
    expect(updates[1]).toMatchObject({ currentVersion: '0.1.0-rc.6', nextVersion: '0.1.0-rc.7', size: 48_000_000 })
  })

  it('keeps optional missing modules on demand and never hot-swaps the running UI shell', () => {
    const updates = planRuntimeModuleUpdates(catalog, { 'launcher-ui': '0.10.3' }, 'win32', 'x64')
    expect(updates).toEqual([])
  })

  it('orders dependencies before the target in an install plan', () => {
    expect(runtimeModulePlan(catalog[1]!, catalog, 'win32', 'x64').map((item) => item.release.id)).toEqual(['node-runtime', 'harness-core'])
  })
})
