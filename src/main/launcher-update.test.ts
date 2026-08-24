import { describe, expect, it } from 'vitest'
import { installedLauncherRoot, silentLauncherUpdateArgs } from './launcher-update'

describe('launcher kernel update handoff', () => {
  it('resolves an installed versioned shell back to its install root', () => {
    expect(installedLauncherRoot('E:\\apps\\DeepBlueDeepSeekHarness\\shells\\0.10.24\\launcher.exe'))
      .toBe('E:\\apps\\DeepBlueDeepSeekHarness')
  })

  it('does not silently install from a development or unpacked build', () => {
    expect(installedLauncherRoot('E:\\repo\\release\\win-unpacked\\launcher.exe')).toBeUndefined()
  })

  it('keeps the NSIS destination argument last', () => {
    expect(silentLauncherUpdateArgs('E:\\apps\\DeepBlueDeepSeekHarness')).toEqual([
      '/S',
      '/AUTOSTART',
      '/D=E:\\apps\\DeepBlueDeepSeekHarness'
    ])
  })
})
