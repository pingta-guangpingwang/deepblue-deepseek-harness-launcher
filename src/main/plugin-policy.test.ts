import { describe, expect, it } from 'vitest'
import { pluginAllowedBuilds, pluginOperationTimeoutMs, pluginPnpmArguments, profileHasActivePlugin } from './plugin-policy'

describe('plugin install policy', () => {
  it('allows only the reviewed cloudflared build for remote pairing', () => {
    expect(pluginAllowedBuilds('@linxin666/dsh-remote-web-ui')).toEqual(['cloudflared'])
    expect(pluginPnpmArguments('install', '@linxin666/dsh-remote-web-ui@latest', '@linxin666/dsh-remote-web-ui')).toEqual([
      'add',
      '@linxin666/dsh-remote-web-ui@latest',
      '--allow-build=cloudflared'
    ])
    expect(pluginPnpmArguments('install', '@linxin666/dsh-client-ui-task-board@latest', '@linxin666/dsh-client-ui-task-board')).toEqual([
      'add',
      '@linxin666/dsh-client-ui-task-board@latest'
    ])
  })

  it('does not treat a dependency-only half install as an active plugin', () => {
    const halfInstalled = {
      dependencies: { '@linxin666/dsh-remote-web-ui': '0.3.5' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
    }
    expect(profileHasActivePlugin(halfInstalled, '@linxin666/dsh-remote-web-ui', true)).toBe(false)
    expect(profileHasActivePlugin({
      ...halfInstalled,
      dsh: { profile: { bundles: [...halfInstalled.dsh.profile.bundles, '@linxin666/dsh-remote-web-ui'] } }
    }, '@linxin666/dsh-remote-web-ui', true)).toBe(true)
  })

  it('allows the reviewed binary download more time without relaxing other plugins', () => {
    expect(pluginOperationTimeoutMs('@linxin666/dsh-remote-web-ui')).toBe(12 * 60_000)
    expect(pluginOperationTimeoutMs('@linxin666/dsh-client-ui-task-board')).toBe(5 * 60_000)
  })
})
