import { describe, expect, it } from 'vitest'
import { appearanceProfileWithArchive } from './appearance-profile'

describe('appearance web profile repair', () => {
  it('replaces a stale installer-local tarball without touching other plugins', () => {
    const repaired = appearanceProfileWithArchive({
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepblue/dsh-skin-runtime'] } },
      dependencies: {
        '@deepblue/dsh-skin-runtime': 'file:C:/old-install/resources/deepblue-dsh-skin-runtime-0.4.0.tgz',
        'another-plugin': '1.2.3'
      }
    }, 'C:\\new install\\deepblue-dsh-skin-runtime-0.6.0.tgz')

    expect(repaired.dependencies).toEqual({
      '@deepblue/dsh-skin-runtime': 'file:C:/new install/deepblue-dsh-skin-runtime-0.6.0.tgz',
      'another-plugin': '1.2.3'
    })
    expect(repaired.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepblue/dsh-skin-runtime'])
  })
})
