import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appearanceProfileWithArchive, installAppearanceRuntimeAtomically } from './appearance-profile'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

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

  it('atomically upgrades an existing trusted runtime without resolving unrelated profile dependencies', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'deepblue-appearance-upgrade-'))
    temporaryDirectories.push(dshHome)
    const target = path.join(dshHome, 'profiles', 'web', 'node_modules', '@deepblue', 'dsh-skin-runtime')
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: '@deepblue/dsh-skin-runtime', version: '0.8.2' }))
    await writeFile(path.join(target, 'old-runtime.txt'), 'keep until replacement succeeds')

    await installAppearanceRuntimeAtomically(dshHome, path.resolve('resources', 'plugins', 'deepblue-dsh-skin-runtime-0.8.3.tgz'), '0.8.3')

    const installed = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')) as { version: string }
    expect(installed.version).toBe('0.8.3')
    await expect(readFile(path.join(target, 'lib', 'client.js'), 'utf8')).resolves.toContain('/deepblue-pet/balance')
    await expect(readFile(path.join(target, 'old-runtime.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the previous runtime when the archive version is not the expected one', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'deepblue-appearance-rollback-'))
    temporaryDirectories.push(dshHome)
    const target = path.join(dshHome, 'profiles', 'web', 'node_modules', '@deepblue', 'dsh-skin-runtime')
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: '@deepblue/dsh-skin-runtime', version: '0.8.2' }))

    await expect(installAppearanceRuntimeAtomically(dshHome, path.resolve('resources', 'plugins', 'deepblue-dsh-skin-runtime-0.8.3.tgz'), '9.9.9')).rejects.toThrow('外观插件归档不匹配')
    expect(JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')).version).toBe('0.8.2')
  })
})
