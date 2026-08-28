import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('Windows guided installer', () => {
  it('builds standard NSIS executables with a beginner-friendly install flow', async () => {
    const script = await readFile(new URL('./build-nsis-installer.ps1', import.meta.url), 'utf8')
    const variantScript = await readFile(new URL('./build-windows-variants.ps1', import.meta.url), 'utf8')
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const bootstrap = await readFile(new URL('./bootstrap/installer.nsi', import.meta.url), 'utf8')
    const bootstrapBuilder = await readFile(new URL('./build-bootstrap-installer.ps1', import.meta.url), 'utf8')
    const customInstaller = await readFile(new URL('./installer-custom.nsh', import.meta.url), 'utf8')

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
      include: 'scripts/installer-custom.nsh',
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      allowElevation: false,
      runAfterFinish: true,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true
    })
    expect(bootstrap).toContain('078eda7a-bb67-538c-a4c8-0b0ff5470883')
    expect(bootstrap).toContain('"InstallLocation" "$INSTDIR"')
    expect(bootstrap).toContain('StrCpy $INSTDIR $LegacyInstallRoot')
    expect(bootstrapBuilder).toContain('$hasGiteeParts')
    expect(bootstrapBuilder).toContain('StrCpy $DownloadStatus "PENDING"')
    expect(bootstrapBuilder).not.toContain("throw 'The generated launcher shell does not contain signed Gitee parts.'")
    expect(customInstaller).toContain('ReadRegStr $R1 HKCU "Software\\DeepBlue\\DeepSeekHarnessLauncher" "InstallRoot"')
    expect(customInstaller).toContain('WriteRegStr HKCU "Software\\DeepBlue\\DeepSeekHarnessLauncher" "InstallRoot" "$INSTDIR"')
  })
})
