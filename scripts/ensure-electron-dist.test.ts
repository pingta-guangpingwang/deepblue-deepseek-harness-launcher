import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { electronExecutableRelativePath, ensureElectronDist, verifyElectronDist } from './ensure-electron-dist.mjs'

const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'electron-dist-ensure-'))
  roots.push(root)
  await mkdir(path.join(root, 'node_modules', 'electron'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { electron: '43.4.0' } }))
  await writeFile(path.join(root, 'node_modules', 'electron', 'package.json'), JSON.stringify({ name: 'electron', version: '43.4.0' }))
  await writeFile(path.join(root, 'node_modules', 'electron', 'install.js'), '// pinned fixture installer\n')
  return root
}

async function writeDistribution(root: string, options: { version?: string; binary?: boolean } = {}): Promise<void> {
  const electronRoot = path.join(root, 'node_modules', 'electron')
  await mkdir(path.join(electronRoot, 'dist'), { recursive: true })
  await writeFile(path.join(electronRoot, 'dist', 'version'), `${options.version || 'v43.4.0'}\n`)
  await writeFile(path.join(electronRoot, 'path.txt'), 'electron.exe')
  if (options.binary !== false) await writeFile(path.join(electronRoot, 'dist', 'electron.exe'), 'fixture')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Electron distribution ensure step', () => {
  it('maps every supported platform to the official package layout', () => {
    expect(electronExecutableRelativePath('win32')).toBe('electron.exe')
    expect(electronExecutableRelativePath('linux')).toBe('electron')
    expect(electronExecutableRelativePath('darwin')).toBe('Electron.app/Contents/MacOS/Electron')
    expect(() => electronExecutableRelativePath('plan9')).toThrow('not available')
  })

  it('fails verification when a clean npm install has no downloaded distribution', async () => {
    const root = await fixture()
    await expect(verifyElectronDist({ projectRoot: root, env: { ELECTRON_INSTALL_PLATFORM: 'win32', ELECTRON_INSTALL_ARCH: 'x64' } }))
      .rejects.toThrow('Electron distribution version is missing')
  })

  it('runs only the pinned local installer on demand and verifies its result', async () => {
    const root = await fixture()
    await writeDistribution(root, { binary: false })
    const env = { ELECTRON_INSTALL_PLATFORM: 'win32', ELECTRON_INSTALL_ARCH: 'x64', ELECTRON_MIRROR: 'https://example.invalid/' }
    const runInstaller = vi.fn(async (context) => {
      expect(context.env).toBe(env)
      await writeFile(path.join(context.distRoot, 'electron.exe'), 'fixture')
    })
    const probeVersion = vi.fn(async () => '43.4.0')
    const result = await ensureElectronDist({
      projectRoot: root,
      env,
      runInstaller,
      probeVersion
    })
    expect(runInstaller).toHaveBeenCalledOnce()
    expect(probeVersion).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ version: '43.4.0', platform: 'win32', arch: 'x64' })
  })

  it('does not invoke the installer when the pinned distribution is already valid', async () => {
    const root = await fixture()
    await writeDistribution(root)
    const runInstaller = vi.fn()
    const probeVersion = vi.fn(async () => '43.4.0')
    await expect(ensureElectronDist({
      projectRoot: root,
      env: { ELECTRON_INSTALL_PLATFORM: 'win32', ELECTRON_INSTALL_ARCH: 'x64' },
      runInstaller,
      probeVersion
    })).resolves.toMatchObject({ version: '43.4.0' })
    expect(runInstaller).not.toHaveBeenCalled()
    expect(probeVersion).toHaveBeenCalledOnce()
  })

  it('fails before installation when the installed package does not match the exact pin', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'node_modules', 'electron', 'package.json'), JSON.stringify({ name: 'electron', version: '43.3.0' }))
    const runInstaller = vi.fn()
    await expect(ensureElectronDist({ projectRoot: root, runInstaller })).rejects.toThrow('does not match pinned 43.4.0')
    expect(runInstaller).not.toHaveBeenCalled()
  })

  it('re-verifies and rejects an invalid distribution after the installer exits', async () => {
    const root = await fixture()
    const runInstaller = vi.fn(async () => writeDistribution(root, { version: 'v43.3.0' }))
    await expect(ensureElectronDist({
      projectRoot: root,
      env: { ELECTRON_INSTALL_PLATFORM: 'win32', ELECTRON_INSTALL_ARCH: 'x64' },
      runInstaller,
      probeVersion: vi.fn(async () => '43.4.0')
    })).rejects.toThrow('installer completed without a valid win32-x64 distribution')
    expect(runInstaller).toHaveBeenCalledOnce()
  })

  it('is wired before every electron-builder packaging command', async () => {
    const manifest = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../package.json', import.meta.url), 'utf8')))
    expect(manifest.scripts['electron:ensure']).toBe('node scripts/ensure-electron-dist.mjs')
    expect(manifest.scripts.test.startsWith('npm run electron:ensure && vitest run')).toBe(true)
    for (const name of ['package', 'dist:win', 'dist:mac']) {
      const command = manifest.scripts[name]
      expect(command.indexOf('npm run electron:ensure')).toBeGreaterThanOrEqual(0)
      expect(command.indexOf('npm run electron:ensure')).toBeLessThan(command.indexOf('electron-builder'))
    }
  })
})
