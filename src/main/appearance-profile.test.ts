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

  it('seeds the DSH web defaults before the appearance bundle on a fresh install', () => {
    const repaired = appearanceProfileWithArchive({}, 'C:\\launcher\\deepblue-dsh-skin-runtime-0.6.0.tgz')

    expect(repaired.dsh?.profile?.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepblue/dsh-skin-runtime'
    ])
    expect(repaired.dependencies).toEqual({
      '@deepblue/dsh-skin-runtime': 'file:C:/launcher/deepblue-dsh-skin-runtime-0.6.0.tgz'
    })
  })

  it('repairs an empty bundles array left by an incomplete first install', () => {
    const repaired = appearanceProfileWithArchive({
      dsh: { profile: { bundles: [] } }
    }, 'D:\\DeepBlue\\skin-runtime.tgz')

    expect(repaired.dsh?.profile?.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepblue/dsh-skin-runtime'
    ])
  })
})
