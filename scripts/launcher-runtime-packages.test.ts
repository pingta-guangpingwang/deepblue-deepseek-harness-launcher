import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverMainRuntimePackages, runtimePackageName } from './launcher-runtime-packages.mjs'

describe('launcher shell runtime package closure', () => {
  it('distinguishes third-party packages from Electron, Node and local modules', () => {
    expect(runtimePackageName('@deepseek-ai/dsh-atomic-write')).toBe('@deepseek-ai/dsh-atomic-write')
    expect(runtimePackageName('tar/lib/create.js')).toBe('tar')
    expect(runtimePackageName('node:fs')).toBeUndefined()
    expect(runtimePackageName('electron')).toBeUndefined()
    expect(runtimePackageName('./config.js')).toBeUndefined()
  })

  it('discovers every external runtime import in the built main process', () => {
    const main = readFileSync(path.resolve(import.meta.dirname, '..', 'out', 'main', 'index.js'), 'utf8')
    const packages = discoverMainRuntimePackages(main)
    expect(packages).toContain('@deepseek-ai/dsh-atomic-write')
    expect(packages).toContain('tar')
    expect(packages).toContain('yaml')
  })
})
