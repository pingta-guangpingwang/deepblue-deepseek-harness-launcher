import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('guided installation and storage setup', () => {
  it('lets both Windows installers choose a program directory and creates shortcuts', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    const bootstrap = await readFile(new URL('../../scripts/bootstrap/installer.nsi', import.meta.url), 'utf8')
    expect(packageJson.build.nsis).toMatchObject({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true
    })
    expect(bootstrap).toContain('!insertmacro MUI_PAGE_DIRECTORY')
    expect(bootstrap).toContain('CreateShortcut "$DESKTOP\\深蓝DeepSeekHarness启动器.lnk"')
    expect(bootstrap).toContain('CreateShortcut "$SMPROGRAMS\\深蓝DeepSeekHarness启动器\\深蓝DeepSeekHarness启动器.lnk"')
  })

  it('requires first-run confirmation before online modules start and preserves old data on migration', async () => {
    const controller = await readFile(new URL('./controller.ts', import.meta.url), 'utf8')
    const renderer = await readFile(new URL('../renderer/src/App.tsx', import.meta.url), 'utf8')
    expect(controller).toContain('if (this.config.settings.storageSetupCompleted) this.beginOnlinePreparation()')
    expect(controller).toContain("const stagingRoot = `${targetRoot}.migrating-${Date.now()}`")
    expect(controller).toContain("throw new Error('新位置不能放在当前运行资源目录内部")
    expect(controller).toContain('复制后校验失败')
    expect(controller).toContain("task.detail = '迁移完成；原位置保留为安全副本'")
    expect(controller).not.toContain('await rm(currentRoot')
    expect(renderer).toContain('先确认运行资源放在哪里')
    expect(renderer).toContain('onKeyDown={keepFocusInside}')
    expect(renderer).toContain('修复快捷方式')
  })
})
