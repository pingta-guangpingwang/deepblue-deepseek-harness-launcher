import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('Windows guided installer', () => {
  it('builds standard NSIS executables with a beginner-friendly install flow', async () => {
    const script = await readFile(new URL('./build-nsis-installer.ps1', import.meta.url), 'utf8')
    const variantScript = await readFile(new URL('./build-windows-variants.ps1', import.meta.url), 'utf8')
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

    expect(script).toContain('--win nsis')
    expect(script).toContain('--prepackaged')
    expect(script).toContain("[IO.Path]::GetExtension($outputFull) -ne '.exe'")
    expect(script).not.toContain('ExecutionPolicy Bypass')
    expect(script).not.toContain('__DEEPBLUE_PAYLOAD')
    expect(variantScript).toContain('sync-runtime-peers.mjs')
    expect(variantScript).toContain('npm run modules:smoke')
    expect(variantScript).toContain('npm run shell:build')
    expect(variantScript).toContain('npm run bootstrap:smoke')
    expect(variantScript).not.toContain('prune-online-package.mjs')
    expect(packageJson.build.nsis).toMatchObject({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      allowElevation: false,
      runAfterFinish: true,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true
    })
  })
})
