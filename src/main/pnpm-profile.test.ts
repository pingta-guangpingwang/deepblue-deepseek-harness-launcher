import { describe, expect, it } from 'vitest'
import { pnpmProfileEnvironment } from './pnpm-profile'

describe('pnpm web profile compatibility', () => {
  it('reuses the existing absolute pnpm store for plugin hot updates', () => {
    expect(pnpmProfileEnvironment('"storeDir": "C:\\\\Users\\\\student\\\\AppData\\\\Local\\\\pnpm\\\\store\\\\v11"')).toEqual({
      npm_config_store_dir: 'C:\\Users\\student\\AppData\\Local\\pnpm\\store\\v11',
      pnpm_config_store_dir: 'C:\\Users\\student\\AppData\\Local\\pnpm\\store\\v11'
    })
  })

  it('does not accept a relative or malformed store path', () => {
    expect(pnpmProfileEnvironment('storeDir: ../shared-store')).toEqual({})
    expect(pnpmProfileEnvironment('not: [valid')).toEqual({})
  })
})
